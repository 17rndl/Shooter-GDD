#!/usr/bin/env node
// ---------------------------------------------------------------------------
// §15 balance harness. Replays every level headlessly at a fixed 1/60s step
// under two deterministic policies — BEST (every good gate, dodges, clears
// objectives) and WORST (every bad gate, fights everything, rams, passive at
// the boss) — and asserts the GDD rule: BEST beats the boss with margin, WORST
// dies before the finish.
//
// The formulas below MUST mirror src/ (WorldSpace, Motion, CrowdController, EnemyCrowd,
// GatePair, Blade, Boss, Pickup, GameManager). If a mechanic changes there, change it here too.
//
// After the authored levels it sweeps the daily challenge: 182 consecutive days of
// generateDaily (src/data/LevelGenerator.ts), each held to the same rule. Every level,
// authored or generated, must also pass the game's own validateLevel without a warning.
// BALANCE_LEVEL_DIR=<dir> replays the levels in <dir> instead of public/levels.
// ---------------------------------------------------------------------------
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { validateLevel } from '../src/data/LevelRepository.ts';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const DT = 1 / 60;
const MAX_SIM_TIME = 900; // seconds of in-game time before we call a run stalled
// The policies steer this far beyond engageRange so the (damped) steer lands
// before the object is in weapons range — a real player reacts on sight.
const LOOKAHEAD = 8;
const DODGE_MARGIN = 0.05; // clearance a dodge must beat, absorbing count drift

const SURVIVOR_FLOOR = 0.4; // BEST must keep this share of its standoff crowd
const MIN_BOSS_SECONDS = 5; // ...and the boss must last this long

// ---------------------------------------------------------------------- config
const num = (v, d) => (typeof v === 'number' && Number.isFinite(v) ? v : d);
const obj = (v) => (v && typeof v === 'object' ? v : {});

const cfg = JSON.parse(readFileSync(join(ROOT, 'public', 'config.json'), 'utf8'));
const TRACK = cfg.track;
const CROWD = cfg.crowd;
const rawCombat = obj(cfg.combat);
const rawBoss = obj(cfg.boss);
const rawGates = obj(cfg.gates);
const rawBarricade = obj(cfg.barricade);
const rawPickup = obj(cfg.pickup);

const COMBAT = {
  perUnitDamage: rawCombat.perUnitDamage,
  fireRate: rawCombat.fireRate,
  dpsExponent: rawCombat.dpsExponent,
  laneWidthPerUnit: rawCombat.laneWidthPerUnit,
  laneWidthMax: rawCombat.laneWidthMax,
  engageRange: rawCombat.engageRange,
  playerUnitHp: num(rawCombat.playerUnitHp, 3),
  enemyUnitHp: num(rawCombat.enemyUnitHp, 3),
  enemyPerUnitDamageFactor: num(rawCombat.enemyPerUnitDamageFactor, 0.85),
  enemyDamageFactor: num(rawCombat.enemyDamageFactor, 0.5),
  // split-fire keys; fallbacks are the shipped contract values
  maxSplitTargets: num(rawCombat.maxSplitTargets, 3),
  splitFalloff: num(rawCombat.splitFalloff, 1.0),
};
const BOSS = {
  standoff: num(rawBoss.standoff, 6.5),
  cooldown: num(rawBoss.cooldown, 2.4),
  cooldownMin: num(rawBoss.cooldownMin, 1.1),
  telegraphTime: num(rawBoss.telegraphTime, 1.05),
  telegraphTimeMin: num(rawBoss.telegraphTimeMin, 0.6),
  hitFraction: num(rawBoss.hitFraction, 0.16),
  bandHalf: num(rawBoss.bandHalf, 1.5),
  firstTelegraphDelay: num(rawBoss.firstTelegraphDelay, 1.5),
  chipFractionPerSecond: num(rawBoss.chipFractionPerSecond, 0.01),
  chipMinUnitsPerSecond: num(rawBoss.chipMinUnitsPerSecond, 1),
  // slam keys; fallbacks are the shipped contract values
  slamTelegraphScale: num(rawBoss.slamTelegraphScale, 0.8),
  slamHitScale: num(rawBoss.slamHitScale, 1.25),
  // crossfire keys; fallbacks are the shipped contract values
  crossfireGapHalf: num(rawBoss.crossfireGapHalf, 1.1),
  crossfireTelegraphScale: num(rawBoss.crossfireTelegraphScale, 1.15),
  crossfireHitScale: num(rawBoss.crossfireHitScale, 0.8),
};
const GATES = {
  damagePerTick: num(rawGates.damagePerTick, 12),
  mulCap: num(rawGates.mulCap, 4),
  addCap: num(rawGates.addCap, 99),
  decayFloor: num(rawGates.decayFloor, 1),
};
const RAM_FACTOR = num(rawBarricade.ramFactor, 0.8);
const PICKUP = { halfWidth: num(rawPickup.halfWidth, 0.6) };
const ENGAGE = COMBAT.engageRange;

// Attack names Boss understands. Anything else in a level's `attacks` array is
// skipped, exactly as the entity does, and an empty result falls back to sweep.
const BOSS_ATTACKS = new Set(['sweep_fire', 'slam', 'crossfire']);

// Boss.rollBand picks a uniformly random band centre in [minX+bandHalf, maxX-bandHalf]
// and re-rolls when it lands within 1.0 of the previous one. The harness must stay
// deterministic, so it cycles this fixed sequence instead: it spans the same range,
// never repeats a neighbour, and approximates the game's random rolls closely enough
// to price the sweep. Change it only alongside boss.bandHalf / track.minX / maxX.
const BAND_SEQUENCE = [-1.5, 0.75, -0.25, 1.5, 0, -1.0, 1.25];
// The crossfire's safe-gap centres, standing in for its random roll in
// [minX+crossfireGapHalf, maxX-crossfireGapHalf] the same way.
const GAP_SEQUENCE = [0.8, -1.2, 0.0, 1.6, -0.4, -1.7, 1.1];

// Mirrors src/core/WorldSpace.ts: world +X renders on screen-left (right-handed
// Three.js, camera looking +Z), so screen fractions flip before becoming world X.
const WORLD_X_SIGN = -1;
const screenToWorldX = (t01, minX, maxX) =>
  (minX + maxX) / 2 + WORLD_X_SIGN * (t01 - 0.5) * (maxX - minX);

// ---------------------------------------------------------------- formulas
const clamp = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v);
const lerp = (a, b, t) => a + (b - a) * t;
const damp = (cur, target, smoothing, dt) => cur + (target - cur) * (1 - Math.exp(-smoothing * dt));

/** Mirrors src/core/Motion.ts motionX: where a swaying prop stands at run clock t. */
function motionX(baseX, m, t) {
  if (!m || m.amp === 0) return baseX;
  return baseX + m.amp * Math.sin(2 * Math.PI * (t / m.period + (m.phase ?? 0)));
}

const playerDPS = (c) =>
  c <= 0 ? 0 : Math.pow(c, COMBAT.dpsExponent) * COMBAT.perUnitDamage * COMBAT.fireRate;
const laneHalf = (c) => clamp(c * COMBAT.laneWidthPerUnit, 0.6, COMBAT.laneWidthMax) * 0.5;
const crowdHalf = (c) =>
  Math.max(0.3, CROWD.formationSpacing * Math.sqrt(Math.min(c, CROWD.maxVisibleUnits)) * 0.55);
const enemyHalf = (n) => Math.max(0.4, CROWD.formationSpacing * Math.sqrt(n) * 0.5);
const enemyDPS = (n, fireRate) =>
  n <= 0
    ? 0
    : Math.pow(n, COMBAT.dpsExponent) *
      COMBAT.perUnitDamage *
      COMBAT.enemyPerUnitDamageFactor *
      fireRate;
/** Units the player sheds per second under one enemy group's fire. */
const enemyUnitsPerSecond = (n, fireRate) =>
  (enemyDPS(n, fireRate) * COMBAT.enemyDamageFactor) / COMBAT.playerUnitHp;

const applyOp = (op, v, count) => {
  let after = count;
  if (op === 'add') after = count + v;
  else if (op === 'mul') after = Math.round(count * v);
  else if (op === 'sub') after = count - v;
  else if (op === 'div') after = v > 0 ? Math.floor(count / v) : count;
  return Math.max(0, after);
};

const tickedValue = (half, ticks, tickPerHit) => {
  const step = ticks * tickPerHit;
  if (half.op === 'add') return Math.min(GATES.addCap, half.value + step);
  if (half.op === 'mul') return Math.min(GATES.mulCap, half.value + step);
  return Math.max(GATES.decayFloor, half.value - step);
};

/** Width of a formation centred at x (half-width h) that a saw centred at bx covers. */
const bladeOverlap = (x, h, bx, width) =>
  Math.max(0, Math.min(x + h, bx + width / 2) - Math.max(x - h, bx - width / 2));

// ---------------------------------------------------------------- world build
function buildWorld(level) {
  const w = {
    gates: [], barricades: [], enemies: [], objectives: [], pickups: [], blades: [],
    movers: [], boss: null, finish: null,
  };
  const { minX, maxX } = TRACK;
  const gateHalfW = (maxX - minX) / 4;
  // Swaying props keep their authored x as baseX and are re-placed every step;
  // like GameManager.buildLevel they start posed at clock 0.
  const sway = (seg, ent) => {
    ent.baseX = seg.x ?? 0;
    ent.motion = seg.motion;
    ent.amp = seg.motion ? seg.motion.amp : 0;
    ent.x = motionX(ent.baseX, ent.motion, 0);
    if (ent.motion) w.movers.push(ent);
    return ent;
  };

  for (const seg of level.segments) {
    switch (seg.type) {
      case 'gate_pair': {
        const halves = [];
        // JSON left/right are screen sides; door centres as GatePair places them.
        if (seg.left) halves.push({ ...seg.left, centerX: screenToWorldX(0.25, minX, maxX), halfWidth: gateHalfW, accum: 0 });
        if (seg.right) halves.push({ ...seg.right, centerX: screenToWorldX(0.75, minX, maxX), halfWidth: gateHalfW, accum: 0 });
        w.gates.push({
          z: seg.z, halves, passed: false,
          tickable: !!seg.tickable, tickPerHit: seg.tickPerHit ?? 1, aim: -1,
        });
        break;
      }
      case 'barricade':
        w.barricades.push(sway(seg, {
          z: seg.z, hp: seg.hp ?? 50,
          halfWidth: (seg.width ?? 2.0) / 2, alive: true, passed: false,
        }));
        break;
      case 'enemy_crowd': {
        const count = seg.count ?? 10;
        w.enemies.push(sway(seg, {
          z: seg.z, count, fireRate: seg.fireRate ?? 4,
          hp: count * COMBAT.enemyUnitHp, alive: true,
        }));
        break;
      }
      case 'blade': {
        const bl = sway(seg, { z: seg.z, width: seg.width ?? 1.6, kill: seg.kill ?? 0.5, passed: false });
        // the most the saw travels in one step: the crossing can land up to a
        // step after the z / runSpeed the policy predicts it at
        bl.stepTravel = bl.amp !== 0 ? Math.abs((2 * Math.PI * bl.amp) / bl.motion.period) * DT : 0;
        w.blades.push(bl);
        break;
      }
      case 'objective_node':
        w.objectives.push({
          x: seg.x ?? 0, z: seg.z, hp: seg.hp ?? 100, reward: seg.reward ?? 0,
          halfWidth: 0.8, alive: true, plan: null,
        });
        break;
      case 'coin_pickup':
      case 'crowd_pickup':
        w.pickups.push(sway(seg, {
          kind: seg.type === 'crowd_pickup' ? 'crowd' : 'coin',
          z: seg.z, value: seg.value ?? 10, taken: false,
        }));
        break;
      case 'boss': {
        const attacks = (Array.isArray(seg.attacks) ? seg.attacks : ['sweep_fire'])
          .filter((a) => BOSS_ATTACKS.has(a));
        w.boss = {
          z: seg.z, hp: seg.hp ?? 1000, maxHp: seg.hp ?? 1000, alive: true,
          attacks: attacks.length > 0 ? attacks : ['sweep_fire'],
        };
        break;
      }
      case 'finish':
        w.finish = { z: seg.z };
        break;
    }
  }
  return w;
}

/** Index of the half nearest centerX among those overlapping the firing lane. */
function overlappingHalf(gate, centerX, half) {
  let best = -1;
  let bestD = Infinity;
  for (let i = 0; i < gate.halves.length; i++) {
    const h = gate.halves[i];
    const d = Math.abs(centerX - h.centerX);
    if (d > half + h.halfWidth) continue;
    if (d < bestD) { bestD = d; best = i; }
  }
  return best;
}

/** Which half the policy wants. BEST projects the ticks it can land first. */
function chooseHalf(gate, count, policy, dps, speed) {
  if (gate.halves.length === 0) return -1;
  let best = -1;
  let bestVal = policy === 'best' ? -Infinity : Infinity;
  for (let i = 0; i < gate.halves.length; i++) {
    const h = gate.halves[i];
    let v = h.value;
    if (policy === 'best' && gate.tickable) {
      const budget = dps * (ENGAGE / speed);
      v = tickedValue(h, Math.floor(budget / GATES.damagePerTick), gate.tickPerHit);
    }
    const after = applyOp(h.op, v, count);
    if (policy === 'best' ? after > bestVal : after < bestVal) { bestVal = after; best = i; }
  }
  return best;
}

/**
 * BEST's line past a saw predicted to cross at bx: hold the current line if it
 * already clears, else the nearer side that leaves the least overlap (a wall,
 * when a side is too tight to clear).
 */
function bladeDodgeX(bl, bx, h, cx) {
  const clear = bl.width / 2 + h + DODGE_MARGIN + bl.stepTravel;
  if (Math.abs(cx - bx) >= clear) return cx;
  const lo = clamp(bx - clear, TRACK.minX, TRACK.maxX);
  const hi = clamp(bx + clear, TRACK.minX, TRACK.maxX);
  const oLo = bladeOverlap(lo, h, bx, bl.width);
  const oHi = bladeOverlap(hi, h, bx, bl.width);
  if (oLo !== oHi) return oLo < oHi ? lo : hi;
  return Math.abs(lo - cx) <= Math.abs(hi - cx) ? lo : hi;
}

/** Where the policy stands for a crossfire with its safe gap at g. */
function crossfireStandX(g, best) {
  if (best) return g; // dead centre of the gap
  // WORST plants itself in the middle of the wider danger plane
  const gh = BOSS.crossfireGapHalf;
  const loW = g - gh - TRACK.minX;
  const hiW = TRACK.maxX - (g + gh);
  return loW >= hiW ? (TRACK.minX + g - gh) / 2 : (g + gh + TRACK.maxX) / 2;
}

function hitGate(gate, i, damage) {
  if (!gate.tickable || gate.passed) return;
  const h = gate.halves[i];
  h.accum += damage;
  while (h.accum >= GATES.damagePerTick) {
    h.accum -= GATES.damagePerTick;
    h.value = tickedValue(h, 1, gate.tickPerHit);
  }
}

// ---------------------------------------------------------------- the run
function runPolicy(level, policy) {
  const w = buildWorld(level);
  const speed = level.forwardSpeed;
  const best = policy === 'best';

  let c = CROWD.startingCount;
  let lossAccum = 0;
  let cx = 0;
  let cz = 0;
  let t = 0;
  let state = 'PLAYING';
  let cause = 'attrition';

  let bossPhase = 'cooldown';
  let bossTimer = BOSS.firstTelegraphDelay;
  let bossStart = -1;
  let bandIdx = 0;
  let gapIdx = 0;
  let attackIdx = 0;
  let attackKind = 'sweep_fire';
  let bandCenter = 0; // a sweep/slam band's centre, or a crossfire's safe-gap centre
  let parkX = 0; // where BEST stood for the last resolve; 0 before the first
  const cand = []; // hoisted: the in-lane targets this frame, mirrors findTargets
  const out = {
    policy, finished: false, stalled: false, death: null,
    crowdAtBoss: 0, bossTTK: 0, survivors: 0, bossKilled: false, finalCount: 0,
    sweeps: 0, sweepLoss: 0, picked: 0, trace: [],
    attacks: w.boss ? w.boss.attacks : null,
  };

  const note = (s) => out.trace.push(s);
  const kill = (n, why) => {
    const lost = Math.min(c, Math.max(0, Math.floor(n)));
    c -= lost;
    if (lost > 0) cause = why;
    return lost;
  };
  const bleed = (units, why) => {
    if (units <= 0 || c <= 0) return;
    lossAccum += units;
    const whole = Math.floor(lossAccum);
    if (whole > 0) { lossAccum -= whole; kill(whole, why); }
  };

  while (t < MAX_SIM_TIME) {
    // The run clock once this step has advanced, i.e. GameManager.runTime when
    // it re-places the movers (t += DT below rounds to exactly this value).
    const now = t + DT;
    const dps = playerDPS(c);
    const laneH = laneHalf(c);

    // ---- policy: where do we want to be? -----------------------------------
    // Movers are read at their last placed x, except where the policy commits to
    // a crossing: there it predicts the x at z / runSpeed.
    let target = 0;
    let targetZ = Infinity;
    const want = (z, x) => { if (z < targetZ) { targetZ = z; target = x; } };

    for (const e of w.enemies) {
      if (!e.alive || cz > e.z + 3 || e.z - cz > ENGAGE + LOOKAHEAD) continue;
      let x = e.x;
      if (best) {
        // a swaying squad is dodged from the wall clear of its whole sweep
        const need = laneH + enemyHalf(e.count) + DODGE_MARGIN;
        const dLo = Math.max(0, e.baseX - e.amp - TRACK.minX);
        const dHi = Math.max(0, TRACK.maxX - (e.baseX + e.amp));
        if (Math.max(dLo, dHi) > need) x = dHi >= dLo ? TRACK.maxX : TRACK.minX;
      }
      want(e.z, x);
    }
    for (const g of w.gates) {
      if (g.passed || g.z < cz || g.z - cz > ENGAGE + LOOKAHEAD) continue;
      if (g.aim < 0) g.aim = chooseHalf(g, c, policy, dps, speed);
      if (g.aim >= 0) want(g.z, g.halves[g.aim].centerX);
    }
    for (const b of w.barricades) {
      if (!b.alive || b.passed || b.z < cz || b.z - cz > ENGAGE + LOOKAHEAD) continue;
      // BEST keeps it in its lane to shoot it down; WORST lines up the ram
      want(b.z, best ? b.x : motionX(b.baseX, b.motion, b.z / speed));
    }
    if (best) {
      for (const o of w.objectives) {
        if (!o.alive || o.z < cz || o.z - cz > ENGAGE + LOOKAHEAD) continue;
        if (o.plan === null) o.plan = o.reward > 0 && o.hp / Math.max(1e-6, dps) <= ENGAGE / speed;
        if (o.plan) want(o.z, o.x);
      }
      // A static crowd pickup is banked by assumption (see the pickup pass); a
      // swaying one has to be met where it will cross.
      for (const p of w.pickups) {
        if (p.taken || p.amp === 0 || p.kind !== 'crowd' || p.z < cz || p.z - cz > ENGAGE + LOOKAHEAD) continue;
        want(p.z, clamp(motionX(p.baseX, p.motion, p.z / speed), TRACK.minX, TRACK.maxX));
      }
    }
    for (const bl of w.blades) {
      if (bl.passed || bl.z - cz > ENGAGE + LOOKAHEAD) continue;
      const bx = motionX(bl.baseX, bl.motion, bl.z / speed);
      // a close saw outranks the return fire of a squad the crowd has already passed
      if (targetZ < cz && bl.z - cz <= LOOKAHEAD) targetZ = Infinity;
      want(bl.z, best ? bladeDodgeX(bl, bx, crowdHalf(c), cx) : bx);
    }
    if (w.boss && w.boss.alive && targetZ === Infinity) target = 0; // stay in the boss's lane

    // ---- move --------------------------------------------------------------
    if (state === 'PLAYING') {
      cz += speed * DT;
      if (w.boss && w.boss.alive && cz >= w.boss.z - BOSS.standoff) {
        cz = w.boss.z - BOSS.standoff;
        state = 'BOSS';
        bossStart = t;
        out.crowdAtBoss = c;
        note(`boss@${w.boss.z} standoff with ${c}`);
      }
    }
    cx = clamp(damp(cx, target, CROWD.steerSmoothing, DT), TRACK.minX, TRACK.maxX);

    // ---- movers: placed at the run clock before combat and collision -------
    for (const m of w.movers) m.x = motionX(m.baseX, m.motion, now);

    // ---- enemy fire --------------------------------------------------------
    for (const e of w.enemies) {
      if (!e.alive) continue;
      const d = e.z - cz;
      if (d < -3 || d > ENGAGE) continue;
      if (Math.abs(cx - e.x) > laneH + enemyHalf(e.count)) continue;
      bleed(enemyUnitsPerSecond(e.count, e.fireRate) * DT, `enemy@${e.z}`);
    }

    // ---- the crowd's fire: split across the nearest few in-lane targets ----
    if (dps > 0) {
      cand.length = 0;
      const consider = (kind, ref, x, z, half, halfIdx) => {
        const d = z - cz;
        if (d < -1 || d > ENGAGE) return;
        if (Math.abs(cx - x) > laneH + half) return;
        cand.push({ kind, ref, d, halfIdx, w: 0 });
      };
      // Order mirrors GameManager.findTargets, and the sort below is stable, so
      // equal-distance ties keep the same priority they have in game.
      if (best) for (const b of w.barricades) if (b.alive) consider('barricade', b, b.x, b.z, b.halfWidth);
      for (const e of w.enemies) if (e.alive) consider('enemy', e, e.x, e.z, enemyHalf(e.count));
      if (best) for (const o of w.objectives) if (o.alive) consider('objective', o, o.x, o.z, o.halfWidth);
      // Both policies pump the in-lane tickable half: findTarget makes no
      // exception for it, so WORST decays the bad side it steers into.
      for (const g of w.gates) {
        if (g.passed || !g.tickable) continue;
        const h = overlappingHalf(g, cx, laneH);
        if (h < 0) continue;
        consider('gate', g, g.halves[h].centerX, g.z, g.halves[h].halfWidth, h);
      }
      if (w.boss && w.boss.alive) consider('boss', w.boss, 0, w.boss.z, 1.4);

      // Nearest maxSplitTargets share the DPS, weighted 1/(1+d*falloff) and
      // normalised — with a single target in range this is exactly full DPS.
      cand.sort((a, b) => a.d - b.d);
      const kept = Math.min(cand.length, Math.max(1, COMBAT.maxSplitTargets));
      let wsum = 0;
      for (let i = 0; i < kept; i++) {
        cand[i].w = 1 / (1 + Math.max(0, cand[i].d) * COMBAT.splitFalloff);
        wsum += cand[i].w;
      }
      for (let i = 0; i < kept; i++) {
        const tgt = cand[i];
        const dmg = dps * DT * (tgt.w / wsum);
        if (tgt.kind === 'gate') {
          hitGate(tgt.ref, tgt.halfIdx, dmg);
        } else if (tgt.kind === 'enemy') {
          const e = tgt.ref;
          e.hp -= dmg;
          e.count = Math.max(0, Math.ceil(e.hp / COMBAT.enemyUnitHp));
          if (e.hp <= 0) { e.hp = 0; e.count = 0; e.alive = false; note(`killed enemy@${e.z}`); }
        } else if (tgt.kind === 'barricade') {
          const b = tgt.ref;
          b.hp -= dmg;
          if (b.hp <= 0) { b.hp = 0; b.alive = false; note(`broke barricade@${b.z}`); }
        } else if (tgt.kind === 'objective') {
          const o = tgt.ref;
          o.hp -= dmg;
          if (o.hp <= 0) {
            o.hp = 0; o.alive = false;
            c += o.reward;
            note(`objective@${o.z} +${o.reward} → ${c}`);
          }
        } else {
          const b = tgt.ref;
          b.hp -= dmg;
          if (b.hp <= 0) {
            b.hp = 0; b.alive = false;
            out.bossKilled = true;
            out.bossTTK = t - bossStart;
            out.survivors = c;
            state = 'PLAYING';
            note(`boss dead in ${out.bossTTK.toFixed(1)}s with ${c}`);
          }
        }
      }
    }

    // ---- boss pressure -----------------------------------------------------
    if (state === 'BOSS' && w.boss.alive) {
      bleed(Math.max(BOSS.chipMinUnitsPerSecond, c * BOSS.chipFractionPerSecond) * DT, 'boss chip');
      const frac = clamp(w.boss.hp / w.boss.maxHp, 0, 1);
      bossTimer -= DT;
      if (bossTimer <= 0) {
        if (bossPhase === 'cooldown') {
          bossPhase = 'telegraph';
          // one attack per telegraph, cycled in authored order
          attackKind = w.boss.attacks[attackIdx++ % w.boss.attacks.length];
          bossTimer = lerp(BOSS.telegraphTime, BOSS.telegraphTimeMin, 1 - frac);
          if (attackKind === 'slam') {
            // The band locks onto the crowd where it stands when the wind-up
            // starts: BEST is parked where it took the last resolve (the wall
            // farthest from that band, or that crossfire's gap), WORST at 0.
            const startX = best ? parkX : 0;
            bandCenter = clamp(startX, TRACK.minX + BOSS.bandHalf, TRACK.maxX - BOSS.bandHalf);
            bossTimer *= BOSS.slamTelegraphScale; // shorter fuse than a sweep
          } else if (attackKind === 'crossfire') {
            bandCenter = GAP_SEQUENCE[gapIdx++ % GAP_SEQUENCE.length];
            bossTimer *= BOSS.crossfireTelegraphScale; // two planes to read: a longer fuse
          } else {
            bandCenter = BAND_SEQUENCE[bandIdx++ % BAND_SEQUENCE.length];
          }
        } else {
          // Mirrors Boss.update: the loss is the share of the formation's physical
          // width the danger covers. Against a band BEST runs for the wall farthest
          // from it (the game clamps the centroid to the track) and WORST just
          // stands still; a crossfire covers everything but its gap.
          const ch = crowdHalf(c);
          let standX;
          let overlapFrac;
          let hitScale;
          if (attackKind === 'crossfire') {
            standX = crossfireStandX(bandCenter, best);
            const gh = BOSS.crossfireGapHalf;
            const inGap = Math.max(0, Math.min(standX + ch, bandCenter + gh) - Math.max(standX - ch, bandCenter - gh));
            overlapFrac = (2 * ch - inGap) / (2 * ch);
            hitScale = BOSS.crossfireHitScale;
          } else {
            standX = best ? (bandCenter < 0 ? TRACK.maxX : TRACK.minX) : 0;
            const lo = Math.max(standX - ch, bandCenter - BOSS.bandHalf);
            const hi = Math.min(standX + ch, bandCenter + BOSS.bandHalf);
            const overlap = Math.max(0, hi - lo);
            overlapFrac = ch > 0 ? overlap / (2 * ch) : 0;
            hitScale = attackKind === 'slam' ? BOSS.slamHitScale : 1;
          }
          out.sweeps += 1;
          const dmgFrac = BOSS.hitFraction * hitScale * overlapFrac; // Boss.update's return value
          const lost = kill(Math.ceil(c * dmgFrac), `boss ${attackKind}`);
          out.sweepLoss += lost;
          if (lost > 0) note(`boss ${attackKind}@${bandCenter.toFixed(2)} -${lost} → ${c}`);
          parkX = standX;
          bossPhase = 'cooldown';
          bossTimer = lerp(BOSS.cooldown, BOSS.cooldownMin, 1 - frac);
        }
      }
    }

    // ---- gates -------------------------------------------------------------
    for (const g of w.gates) {
      if (g.passed || cz < g.z) continue;
      g.passed = true;
      if (g.halves.length === 0) continue;
      let chosen = g.halves[0];
      let bestD = Infinity;
      for (const h of g.halves) {
        const d = Math.abs(cx - h.centerX);
        if (d < bestD) { bestD = d; chosen = h; }
      }
      const before = c;
      c = applyOp(chosen.op, chosen.value, c);
      if (c === 0) cause = `gate@${g.z}`;
      note(`gate@${g.z} ${chosen.op}${chosen.value} ${before}→${c}`);
    }

    // GameManager.collisionSystem takes crowdHalf once, after the gates: the ram
    // and the pickup test read that value, the blades a fresh one after any ram.
    const stepH = crowdHalf(c);

    // ---- barricade contact -------------------------------------------------
    for (const b of w.barricades) {
      if (b.passed || cz < b.z) continue;
      b.passed = true;
      if (b.alive && Math.abs(cx - b.x) <= stepH + b.halfWidth) {
        const lost = kill(Math.ceil(b.hp * RAM_FACTOR), `barricade@${b.z}`);
        note(`rammed barricade@${b.z} -${lost} → ${c}`);
      }
      b.alive = false;
    }

    // ---- blades ------------------------------------------------------------
    // One cut on the first step the centroid reaches the saw's plane: the share
    // of the formation's width under the saw, at the saw's current x.
    for (const bl of w.blades) {
      if (bl.passed || cz < bl.z) continue;
      bl.passed = true;
      const h = crowdHalf(c);
      const frac = bladeOverlap(cx, h, bl.x, bl.width) / (2 * h);
      const lost = kill(frac > 0 ? Math.ceil(c * bl.kill * frac) : 0, `blade@${bl.z}`);
      note(`blade@${bl.z} -${lost} → ${c}`);
    }

    // ---- pickups -----------------------------------------------------------
    // Coins only ever pay out currency, so they cannot move the crowd rule.
    // A static crowd_pickup sits somewhere on a 6-wide track that BEST can always
    // reach without giving up a beat, so BEST banks every one and WORST takes none.
    // A swaying one BEST steers to intercept, so it gets GameManager's real
    // collect test against its current x.
    for (const p of w.pickups) {
      if (p.taken || cz < p.z) continue;
      p.taken = true;
      if (!best || p.kind !== 'crowd') continue;
      if (p.amp !== 0) {
        if (Math.abs(cx - p.x) > stepH + PICKUP.halfWidth) { note(`missed pickup@${p.z}`); continue; }
      } else if (p.x < TRACK.minX - PICKUP.halfWidth || p.x > TRACK.maxX + PICKUP.halfWidth) continue;
      out.picked += p.value;
      c += p.value;
      note(`pickup@${p.z} +${p.value} → ${c}`);
    }

    // ---- end states --------------------------------------------------------
    if (c <= 0) {
      out.death = { z: cz, cause };
      out.finalCount = 0;
      return out;
    }
    if (w.finish && cz >= w.finish.z) {
      out.finished = true;
      out.finalCount = c;
      return out;
    }
    t += DT;
  }
  out.stalled = true;
  out.finalCount = c;
  return out;
}

// ---------------------------------------------------------------- report
const LEVEL_DIR = process.env.BALANCE_LEVEL_DIR
  ? resolve(process.env.BALANCE_LEVEL_DIR)
  : join(ROOT, 'public', 'levels');

/** Manifest order (what the game plays); a sorted directory scan if there is no manifest. */
function listLevels() {
  let manifest;
  try {
    manifest = JSON.parse(readFileSync(join(LEVEL_DIR, 'index.json'), 'utf8'));
  } catch (err) {
    if (err.code !== 'ENOENT') console.warn(`index.json unreadable (${err.message}); scanning ${LEVEL_DIR}`);
  }
  const files = manifest && Array.isArray(manifest.levels) ? manifest.levels : null;
  if (files && files.length > 0 && files.every((f) => typeof f === 'string' && f.length > 0)) return files;
  if (manifest) console.warn(`index.json has no usable "levels" list; scanning ${LEVEL_DIR}`);
  return readdirSync(LEVEL_DIR).filter((f) => /^level_\d+\.json$/.test(f)).sort();
}

/**
 * LevelRepository.validateLevel, which the game runs on every level file and on each
 * day's generated level before it shows the daily card: a level it rejects never
 * plays, so a throw is a failure, and so is a soft warning (nothing ships with one).
 */
function validationProblems(level, label) {
  const problems = [];
  const warn = console.warn;
  console.warn = (...args) => problems.push(`validateLevel warns: ${args.join(' ')}`);
  try {
    validateLevel(level, label, cfg);
  } catch (err) {
    problems.push(`validateLevel: ${err.message}`);
  } finally {
    console.warn = warn;
  }
  return problems;
}

/** Both policies on one level, held to the §15 rule. */
function judge(level) {
  const best = runPolicy(level, 'best');
  const worst = runPolicy(level, 'worst');

  const share = best.crowdAtBoss > 0 ? best.survivors / best.crowdAtBoss : 0;
  const problems = [];
  if (!best.finished) {
    problems.push(
      best.death ? `BEST died at z=${best.death.z.toFixed(0)} (${best.death.cause})` : 'BEST never finished',
    );
  }
  if (!best.bossKilled) problems.push('BEST did not kill the boss');
  if (best.bossKilled && share < SURVIVOR_FLOOR) {
    problems.push(`BEST kept only ${(share * 100).toFixed(0)}% of its standoff crowd (need ${SURVIVOR_FLOOR * 100}%)`);
  }
  if (best.bossKilled && best.bossTTK < MIN_BOSS_SECONDS) {
    problems.push(`boss died in ${best.bossTTK.toFixed(1)}s (need ${MIN_BOSS_SECONDS}s)`);
  }
  if (!worst.death) problems.push('WORST survived to the finish');
  return { best, worst, share, problems };
}

const ATTACKS_WIDTH = 16;
const ATTACK_SHORT = { sweep_fire: 'sweep', crossfire: 'cross' };
/** The boss's cycle; short names only when the full ones overflow the column. */
function attacksLabel(list) {
  if (!list) return '—';
  const full = list.join('+');
  return full.length <= ATTACKS_WIDTH ? full : list.map((a) => ATTACK_SHORT[a] ?? a).join('+');
}

const rows = [];
const failures = [];
const traces = [];

for (const file of listLevels()) {
  const level = JSON.parse(readFileSync(join(LEVEL_DIR, file), 'utf8'));
  const { best, worst, share, problems } = judge(level);
  problems.push(...validationProblems(level, file));
  rows.push({
    level: file.replace(/\.json$/, ''),
    atBoss: best.crowdAtBoss,
    ttk: best.bossKilled ? `${best.bossTTK.toFixed(1)}s` : '—',
    survivors: best.bossKilled ? `${(share * 100).toFixed(0)}%` : '—',
    sweeps: best.sweeps,
    sweepLoss: best.sweepLoss,
    picked: best.picked,
    attacks: attacksLabel(best.attacks),
    worst: worst.death ? `z=${worst.death.z.toFixed(0)} ${worst.death.cause}` : 'survives',
    verdict: problems.length === 0 ? 'PASS' : 'FAIL',
  });
  traces.push({ level: file, best, worst });
  if (problems.length) failures.push(`${file}: ${problems.join('; ')}`);
}

// ---------------------------------------------------------------- daily sweep
const GENERATOR = join(ROOT, 'src', 'data', 'LevelGenerator.ts');
const CHUNKS = join(ROOT, 'public', 'levels', 'chunks.json');
const DAILY_FIRST = '2026-10-19'; // a Monday, so the sweep is 26 whole weeks
const DAILY_DAYS = 182;
const WEEKDAYS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];

const pad2 = (n) => String(n).padStart(2, '0');
const newStats = () => ({ days: 0, pass: 0, atMin: Infinity, atMax: -Infinity, shareMin: Infinity, ttkMin: Infinity });
function addStats(s, r) {
  s.days += 1;
  if (r.problems.length === 0) s.pass += 1;
  s.atMin = Math.min(s.atMin, r.best.crowdAtBoss);
  s.atMax = Math.max(s.atMax, r.best.crowdAtBoss);
  if (r.best.bossKilled) {
    s.shareMin = Math.min(s.shareMin, r.share);
    s.ttkMin = Math.min(s.ttkMin, r.best.bossTTK);
  }
}

/**
 * Every day's generated level from DAILY_FIRST on, judged like an authored one.
 * Null when the generator or the chunk library is not in the tree yet.
 */
async function dailySweep() {
  if (!existsSync(GENERATOR) || !existsSync(CHUNKS)) return null;
  const res = { buckets: WEEKDAYS.map(newStats), total: newStats(), fails: [] };
  let gen;
  let lib;
  try {
    gen = await import(pathToFileURL(GENERATOR).href);
    lib = JSON.parse(readFileSync(CHUNKS, 'utf8'));
    if (typeof gen.generateDaily !== 'function') throw new Error('it exports no generateDaily');
  } catch (err) {
    res.fails.push(`daily: cannot load the generator or chunks.json (${err.message})`);
    return res;
  }
  const libBefore = JSON.stringify(lib);
  const [y, m, d] = DAILY_FIRST.split('-').map(Number);
  for (let i = 0; i < DAILY_DAYS; i++) {
    // UTC calendar arithmetic: the keys must not depend on the machine's timezone
    const day = new Date(Date.UTC(y, m - 1, d + i));
    const key = `${day.getUTCFullYear()}-${pad2(day.getUTCMonth() + 1)}-${pad2(day.getUTCDate())}`;
    const difficulty = ((day.getUTCDay() + 6) % 7) + 1; // Monday 1 ... Sunday 7
    let r;
    try {
      const level = gen.generateDaily(key, lib, cfg);
      const invalid = validationProblems(level, `daily ${key}`);
      r = judge(level);
      r.problems.push(...invalid);
      if (JSON.stringify(gen.generateDaily(key, lib, cfg)) !== JSON.stringify(level)) {
        r.problems.push('generateDaily is not deterministic for this key');
      }
    } catch (err) {
      r = { best: { crowdAtBoss: 0, bossKilled: false }, share: 0, problems: [`generating or replaying it threw: ${err.message}`] };
    }
    if (typeof gen.dailyDifficulty === 'function' && gen.dailyDifficulty(key) !== difficulty) {
      r.problems.push(`dailyDifficulty gives ${gen.dailyDifficulty(key)}, the calendar ${difficulty}`);
    }
    addStats(res.buckets[difficulty - 1], r);
    addStats(res.total, r);
    if (r.problems.length) res.fails.push(`daily ${key} (difficulty ${difficulty}): ${r.problems.join('; ')}`);
  }
  if (JSON.stringify(lib) !== libBefore) res.fails.push('daily: generateDaily mutated the chunk library');
  return res;
}
const daily = await dailySweep();

// ---------------------------------------------------------------- print
const cols = [
  ['level', 'level', 11],
  ['best@boss', 'atBoss', 9],
  ['boss TTK', 'ttk', 8],
  ['survivors', 'survivors', 9],
  ['attacks', 'attacks', ATTACKS_WIDTH],
  ['hits', 'sweeps', 5],
  ['lost', 'sweepLoss', 5],
  ['picked', 'picked', 6],
  ['worst dies', 'worst', 26],
  ['', 'verdict', 4],
];
const line = (cells) => cells.map(([v, wdt]) => String(v).padEnd(wdt)).join('  ');
const table = (columns, records) => {
  console.log(line(columns.map((c) => [c[0], c[2]])));
  console.log(line(columns.map((c) => ['-'.repeat(c[2]), c[2]])));
  for (const r of records) console.log(line(columns.map((c) => [r[c[1]], c[2]])));
};
console.log('\n§15 balance — BEST (every good gate) vs WORST (every bad gate)');
console.log('attacks = the kinds the level\'s boss cycles; hits/lost = boss attacks the BEST');
console.log('path faced and the units they cost it; picked = units banked from crowd pickups\n');
table(cols, rows);

console.log('\nBEST path:');
for (const tr of traces) console.log(`  ${tr.level}: ${tr.best.trace.join(' | ')} → finish with ${tr.best.finalCount}`);

if (daily) {
  const fmt = (label, s) => ({
    label,
    days: s.days,
    pass: s.pass,
    atBoss: s.days > 0 ? `${s.atMin}-${s.atMax}` : '—',
    share: s.shareMin < Infinity ? `${(s.shareMin * 100).toFixed(0)}%` : '—',
    ttk: s.ttkMin < Infinity ? `${s.ttkMin.toFixed(1)}s` : '—',
  });
  const dailyRows = daily.buckets.map((s, i) => fmt(`${i + 1} (${WEEKDAYS[i]})`, s));
  dailyRows.push(fmt('total', daily.total));
  console.log(`\nDaily challenge — ${DAILY_DAYS} days from ${DAILY_FIRST}, each generated level held to the same rule\n`);
  table([
    ['difficulty', 'label', 10],
    ['days', 'days', 4],
    ['pass', 'pass', 4],
    ['best@boss', 'atBoss', 11],
    ['min survivors', 'share', 13],
    ['min boss TTK', 'ttk', 12],
  ], dailyRows);
  failures.push(...daily.fails);
} else {
  console.log('\ndaily: skipped (no generator)');
}

if (failures.length) {
  console.log('\nFAILURES:');
  for (const f of failures) console.log(`  ✗ ${f}`);
  console.log('');
  process.exit(1);
}
console.log('\nAll levels pass the §15 rule.\n');
