#!/usr/bin/env node
// ---------------------------------------------------------------------------
// §15 balance harness. Replays every level headlessly at a fixed 1/60s step
// under two deterministic policies — BEST (every good gate, dodges, clears
// objectives) and WORST (every bad gate, fights everything, rams, passive at
// the boss) — and asserts the GDD rule: BEST beats the boss with margin, WORST
// dies before the finish.
//
// The formulas below MUST mirror src/ (CrowdController, EnemyCrowd, GatePair,
// Boss, Pickup, GameManager). If a mechanic changes there, change it here too.
// ---------------------------------------------------------------------------
import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

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
const BOSS_ATTACKS = new Set(['sweep_fire', 'slam']);

// Boss.rollBand picks a uniformly random band centre in [minX+bandHalf, maxX-bandHalf]
// and re-rolls when it lands within 1.0 of the previous one. The harness must stay
// deterministic, so it cycles this fixed sequence instead: it spans the same range,
// never repeats a neighbour, and approximates the game's random rolls closely enough
// to price the sweep. Change it only alongside boss.bandHalf / track.minX / maxX.
const BAND_SEQUENCE = [-1.5, 0.75, -0.25, 1.5, 0, -1.0, 1.25];

// ---------------------------------------------------------------- formulas
const clamp = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v);
const lerp = (a, b, t) => a + (b - a) * t;
const damp = (cur, target, smoothing, dt) => cur + (target - cur) * (1 - Math.exp(-smoothing * dt));

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

// ---------------------------------------------------------------- world build
function buildWorld(level) {
  const w = {
    gates: [], barricades: [], enemies: [], objectives: [], pickups: [], boss: null, finish: null,
  };
  const { minX, maxX } = TRACK;
  const mid = (minX + maxX) / 2;
  const gateHalfW = (maxX - minX) / 4;

  for (const seg of level.segments) {
    switch (seg.type) {
      case 'gate_pair': {
        const halves = [];
        // Camera mirrors world X: authored "left" sits at world +X (see GatePair).
        if (seg.left) halves.push({ ...seg.left, centerX: (mid + maxX) / 2, halfWidth: gateHalfW, accum: 0 });
        if (seg.right) halves.push({ ...seg.right, centerX: (minX + mid) / 2, halfWidth: gateHalfW, accum: 0 });
        w.gates.push({
          z: seg.z, halves, passed: false,
          tickable: !!seg.tickable, tickPerHit: seg.tickPerHit ?? 1, aim: -1,
        });
        break;
      }
      case 'barricade':
        w.barricades.push({
          x: seg.x ?? 0, z: seg.z, hp: seg.hp ?? 50,
          halfWidth: (seg.width ?? 2.0) / 2, alive: true, passed: false,
        });
        break;
      case 'enemy_crowd': {
        const count = seg.count ?? 10;
        w.enemies.push({
          x: seg.x ?? 0, z: seg.z, count, fireRate: seg.fireRate ?? 4,
          hp: count * COMBAT.enemyUnitHp, alive: true,
        });
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
        w.pickups.push({
          kind: seg.type === 'crowd_pickup' ? 'crowd' : 'coin',
          x: seg.x ?? 0, z: seg.z, value: seg.value ?? 10, taken: false,
        });
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
  let attackIdx = 0;
  let attackKind = 'sweep_fire';
  let bandCenter = 0;
  let prevBand = null; // band of the previous telegraph; null before the first
  const cand = []; // hoisted: the in-lane targets this frame, mirrors findTargets
  const out = {
    policy, finished: false, stalled: false, death: null,
    crowdAtBoss: 0, bossTTK: 0, survivors: 0, bossKilled: false, finalCount: 0,
    sweeps: 0, sweepLoss: 0, picked: 0, trace: [],
    attacks: w.boss ? w.boss.attacks.join('+') : '—',
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
    const dps = playerDPS(c);
    const laneH = laneHalf(c);

    // ---- policy: where do we want to be? -----------------------------------
    let target = 0;
    let targetZ = Infinity;
    const want = (z, x) => { if (z < targetZ) { targetZ = z; target = x; } };

    for (const e of w.enemies) {
      if (!e.alive || cz > e.z + 3 || e.z - cz > ENGAGE + LOOKAHEAD) continue;
      let x = e.x;
      if (best) {
        const need = laneH + enemyHalf(e.count) + DODGE_MARGIN;
        const dLo = Math.abs(TRACK.minX - e.x);
        const dHi = Math.abs(TRACK.maxX - e.x);
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
      want(b.z, b.x);
    }
    if (best) {
      for (const o of w.objectives) {
        if (!o.alive || o.z < cz || o.z - cz > ENGAGE + LOOKAHEAD) continue;
        if (o.plan === null) o.plan = o.reward > 0 && o.hp / Math.max(1e-6, dps) <= ENGAGE / speed;
        if (o.plan) want(o.z, o.x);
      }
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
            // starts: BEST is parked at the wall farthest from the last band
            // (it has been sitting there since that resolve), WORST at 0.
            const startX = best ? (prevBand === null ? 0 : prevBand < 0 ? TRACK.maxX : TRACK.minX) : 0;
            bandCenter = clamp(startX, TRACK.minX + BOSS.bandHalf, TRACK.maxX - BOSS.bandHalf);
            bossTimer *= BOSS.slamTelegraphScale; // shorter fuse than a sweep
          } else {
            bandCenter = BAND_SEQUENCE[bandIdx++ % BAND_SEQUENCE.length];
          }
        } else {
          // Mirrors Boss.update: the loss is the share of the formation's physical
          // width the band covers. BEST runs for the wall farthest from the band
          // (the game clamps the centroid to the track); WORST just stands still.
          const sweepX = best ? (bandCenter < 0 ? TRACK.maxX : TRACK.minX) : 0;
          const ch = crowdHalf(c);
          const lo = Math.max(sweepX - ch, bandCenter - BOSS.bandHalf);
          const hi = Math.min(sweepX + ch, bandCenter + BOSS.bandHalf);
          const overlap = Math.max(0, hi - lo);
          const overlapFrac = ch > 0 ? overlap / (2 * ch) : 0;
          const hitScale = attackKind === 'slam' ? BOSS.slamHitScale : 1;
          out.sweeps += 1;
          const lost = kill(Math.ceil(c * BOSS.hitFraction * hitScale * overlapFrac), `boss ${attackKind}`);
          out.sweepLoss += lost;
          if (lost > 0) note(`boss ${attackKind}@${bandCenter.toFixed(2)} -${lost} → ${c}`);
          prevBand = bandCenter;
          bossPhase = 'cooldown';
          bossTimer = lerp(BOSS.cooldown, BOSS.cooldownMin, 1 - frac);
        }
      }
    }

    // ---- pickups -----------------------------------------------------------
    // Coins only ever pay out currency, so they cannot move the crowd rule.
    // A crowd_pickup sits somewhere on a 6-wide track that BEST can always reach
    // without giving up a beat, so BEST banks every one and WORST takes none.
    for (const p of w.pickups) {
      if (p.taken || cz < p.z) continue;
      p.taken = true;
      if (!best || p.kind !== 'crowd') continue;
      if (p.x < TRACK.minX - PICKUP.halfWidth || p.x > TRACK.maxX + PICKUP.halfWidth) continue;
      out.picked += p.value;
      c += p.value;
      note(`pickup@${p.z} +${p.value} → ${c}`);
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

    // ---- barricade contact -------------------------------------------------
    for (const b of w.barricades) {
      if (b.passed || cz < b.z) continue;
      b.passed = true;
      if (b.alive && Math.abs(cx - b.x) <= crowdHalf(c) + b.halfWidth) {
        const lost = kill(Math.ceil(b.hp * RAM_FACTOR), `barricade@${b.z}`);
        note(`rammed barricade@${b.z} -${lost} → ${c}`);
      }
      b.alive = false;
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
const levelFiles = readdirSync(join(ROOT, 'public', 'levels'))
  .filter((f) => /^level_\d+\.json$/.test(f))
  .sort();

const rows = [];
const failures = [];
const traces = [];

for (const file of levelFiles) {
  const level = JSON.parse(readFileSync(join(ROOT, 'public', 'levels', file), 'utf8'));
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

  rows.push({
    level: file.replace(/\.json$/, ''),
    atBoss: best.crowdAtBoss,
    ttk: best.bossKilled ? `${best.bossTTK.toFixed(1)}s` : '—',
    survivors: best.bossKilled ? `${(share * 100).toFixed(0)}%` : '—',
    sweeps: best.sweeps,
    sweepLoss: best.sweepLoss,
    picked: best.picked,
    attacks: best.attacks,
    worst: worst.death ? `z=${worst.death.z.toFixed(0)} ${worst.death.cause}` : 'survives',
    verdict: problems.length === 0 ? 'PASS' : 'FAIL',
  });
  traces.push({ level: file, best, worst });
  if (problems.length) failures.push(`${file}: ${problems.join('; ')}`);
}

const cols = [
  ['level', 'level', 11],
  ['best@boss', 'atBoss', 9],
  ['boss TTK', 'ttk', 8],
  ['survivors', 'survivors', 9],
  ['attacks', 'attacks', 16],
  ['hits', 'sweeps', 5],
  ['lost', 'sweepLoss', 5],
  ['picked', 'picked', 6],
  ['worst dies', 'worst', 26],
  ['', 'verdict', 4],
];
const line = (cells) => cells.map(([v, wdt]) => String(v).padEnd(wdt)).join('  ');
console.log('\n§15 balance — BEST (every good gate) vs WORST (every bad gate)');
console.log('attacks = the kinds the level\'s boss cycles; hits/lost = boss attacks the BEST');
console.log('path faced and the units they cost it; picked = units banked from crowd pickups\n');
console.log(line(cols.map((c) => [c[0], c[2]])));
console.log(line(cols.map((c) => ['-'.repeat(c[2]), c[2]])));
for (const r of rows) console.log(line(cols.map((c) => [r[c[1]], c[2]])));

console.log('\nBEST path:');
for (const tr of traces) console.log(`  ${tr.level}: ${tr.best.trace.join(' | ')} → finish with ${tr.best.finalCount}`);

if (failures.length) {
  console.log('\nFAILURES:');
  for (const f of failures) console.log(`  ✗ ${f}`);
  console.log('');
  process.exit(1);
}
console.log('\nAll levels pass the §15 rule.\n');
