import type { GameConfig, GateSide, LevelDefinition, Segment } from './types';

// ---------------------------------------------------------------------------
// Daily challenge: one seeded level per calendar day, stitched from the
// hand-authored chunks in public/levels/chunks.json. Pure, with type-only
// imports, so Node (the balance sim) loads this file as-is. Every random pick
// comes from mulberry32 seeded by the date key, so a day's level is identical
// on every device; weekday and day arithmetic go through Date.UTC so no
// timezone can shift them. The tables below are tuned against the sim's daily
// sweep (scripts/balance-sim.mjs): change them only with it passing.
// ---------------------------------------------------------------------------

/** A hand-authored stretch of track. Segment z is relative to the chunk start (0..length). */
export interface Chunk {
  id: string;
  tier: 1 | 2 | 3;
  length: number;
  segments: Segment[];
}

export interface ChunkLibrary {
  chunks: Chunk[];
}

/** Chunks with this id prefix only ever open a level: their first gate is priced for the 5-unit start. */
const OPENER_PREFIX = 'open_';

// Difficulty-indexed tables, [0] = difficulty 1 (Monday) ... [6] = 7 (Sunday).
/** Chunks after the opener. */
const CHUNK_COUNT = [4, 4, 5, 5, 6, 6, 7];
/** Odds of drawing a tier 1 / 2 / 3 chunk. */
const TIER_WEIGHTS: readonly (readonly number[])[] = [
  [0.7, 0.3, 0],
  [0.6, 0.4, 0],
  [0.35, 0.5, 0.15],
  [0.3, 0.45, 0.25],
  [0.15, 0.45, 0.4],
  [0.12, 0.38, 0.5],
  [0.08, 0.32, 0.6],
];
/** Chunks offering a × gate per day: the doublings are the big swing, so easy days get one and hard days ration them. */
const MIN_DOUBLERS = [1, 1, 1, 0, 0, 0, 0];
const MAX_DOUBLERS = [3, 3, 2, 2, 1, 1, 1];
const FORWARD_SPEED = [8.5, 8.75, 9.0, 9.5, 9.75, 10.0, 10.5];
/** Multiplies every scaled threat (barricade / objective hp, squad size). */
const THREAT_SCALE = [0.8, 0.85, 0.95, 1.05, 1.15, 1.25, 1.35];
/** Seconds the boss should last once the crowd reaches its standoff, at the projected crowd. */
const BOSS_SECONDS = [7, 7.5, 8, 8.5, 9.5, 10.5, 11.5];
/** The day picks one cycle per difficulty. Crossfire from difficulty 4. */
const BOSS_ATTACKS: readonly (readonly (readonly string[])[])[] = [
  [['sweep_fire']],
  [['sweep_fire', 'slam'], ['slam', 'sweep_fire']],
  [['sweep_fire', 'slam'], ['slam', 'sweep_fire', 'sweep_fire']],
  [['sweep_fire', 'crossfire'], ['crossfire', 'sweep_fire']],
  [['sweep_fire', 'slam', 'crossfire'], ['crossfire', 'slam', 'sweep_fire']],
  [['crossfire', 'slam', 'sweep_fire'], ['slam', 'crossfire', 'sweep_fire']],
  [['crossfire', 'slam', 'crossfire', 'sweep_fire'], ['crossfire', 'sweep_fire', 'crossfire', 'slam']],
];
const FINISH_LANES = [[2, 3, 5], [2, 3, 5], [2, 3, 6], [2, 4, 6], [3, 4, 6], [3, 5, 7], [3, 5, 8]];

// Chunk hp / count values are authored for a crowd this size; the generator
// scales them by the DPS ratio to the crowd the BEST line is projected to
// bring, so a chunk bites the same wherever in the level it lands.
const REF_CROWD = 100;
const MIN_THREAT_SCALE = 0.25;
const MAX_THREAT_SCALE = 4;
// Tickable gates rarely get the whole engage window of fire: the projection
// banks half the ticks the sim's BEST plans on.
const TICK_REALISM = 0.5;
/** Seconds per step when the projection plays out a squad fight. */
const FIGHT_STEP = 1 / 30;

/** Last chunk's end to the boss: its threats are out of range before the standoff. */
const BOSS_GAP = 28;
const FINISH_GAP = 30;
const TAIL = 12;

const KEY_RE = /^(\d{4})-(\d{2})-(\d{2})$/;
const pad2 = (n: number): string => (n < 10 ? `0${n}` : String(n));

/** 'YYYY-MM-DD' → [y, m, d], rejecting impossible dates like 2026-02-30. */
function parseKey(key: string): [number, number, number] {
  const m = KEY_RE.exec(key);
  if (!m) throw new Error(`daily key ${JSON.stringify(key)} is not YYYY-MM-DD`);
  const y = Number(m[1]);
  const mo = Number(m[2]);
  const d = Number(m[3]);
  const t = new Date(Date.UTC(y, mo - 1, d));
  if (t.getUTCFullYear() !== y || t.getUTCMonth() !== mo - 1 || t.getUTCDate() !== d) {
    throw new Error(`daily key ${key} is not a calendar date`);
  }
  return [y, mo, d];
}

/** The player's LOCAL calendar date, so the challenge rolls over at their midnight. */
export function dailyKey(d: Date): string {
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
}

export function previousDayKey(key: string): string {
  const [y, m, d] = parseKey(key);
  const t = new Date(Date.UTC(y, m - 1, d - 1));
  return `${t.getUTCFullYear()}-${pad2(t.getUTCMonth() + 1)}-${pad2(t.getUTCDate())}`;
}

/** 1 (Monday) ... 7 (Sunday): the week ramps up to a weekend boss. */
export function dailyDifficulty(key: string): number {
  const [y, m, d] = parseKey(key);
  return ((new Date(Date.UTC(y, m - 1, d)).getUTCDay() + 6) % 7) + 1;
}

/** FNV-1a, 32-bit. */
export function seedFrom(key: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < key.length; i++) {
    h ^= key.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

/** Uniform floats in [0, 1). */
export function mulberry32(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) | 0;
    let t = Math.imul(s ^ (s >>> 15), s | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const clamp = (v: number, lo: number, hi: number): number => (v < lo ? lo : v > hi ? hi : v);
const roundTo = (v: number, step: number): number => Math.round(v / step) * step;

function pickIndex(rng: () => number, n: number): number {
  return Math.min(n - 1, Math.floor(rng() * n));
}

/** Mirrors GatePair's arithmetic. */
function applyOp(side: GateSide, value: number, count: number): number {
  let after = count;
  if (side.op === 'add') after = count + value;
  else if (side.op === 'mul') after = Math.round(count * value);
  else if (side.op === 'sub') after = count - value;
  else if (side.op === 'div') after = value > 0 ? Math.floor(count / value) : count;
  return Math.max(0, after);
}

/** Mirrors GatePair's tick: rewards grow to their cap, penalties decay to the floor. */
function tickedValue(side: GateSide, ticks: number, perTick: number, cfg: GameConfig): number {
  const step = ticks * perTick;
  if (side.op === 'add') return Math.min(cfg.gates.addCap, side.value + step);
  if (side.op === 'mul') return Math.min(cfg.gates.mulCap, side.value + step);
  return Math.max(cfg.gates.decayFloor, side.value - step);
}

function cloneSegment(seg: Segment): Segment {
  const out: Segment = { ...seg };
  if (seg.left) out.left = { ...seg.left };
  if (seg.right) out.right = { ...seg.right };
  if (seg.motion) out.motion = { ...seg.motion };
  if (seg.attacks) out.attacks = [...seg.attacks];
  if (seg.multiplierLanes) out.multiplierLanes = [...seg.multiplierLanes];
  return out;
}

/**
 * The crowd a player taking every good gate carries along the level, as the
 * level is laid down. Saws and walls are dodged or shot down for free; the one
 * loss it books is a squad (or a flanking pair) no lane avoids, fought through.
 */
class Projection {
  count: number;
  private readonly cfg: GameConfig;
  private readonly speed: number;
  /** Squads at pendingZ, resolved once the lay-down moves past their plane. */
  private readonly pending: Segment[] = [];
  private pendingZ = -Infinity;

  constructor(cfg: GameConfig, speed: number) {
    this.cfg = cfg;
    this.speed = speed;
    this.count = cfg.crowd.startingCount;
  }

  /** Call before scaling a segment at z: settles any squad fight behind it. */
  advanceTo(z: number): void {
    if (this.pending.length > 0 && z > this.pendingZ) {
      this.fight();
      this.pending.length = 0;
    }
  }

  /**
   * A squad shoots whatever stands within its lane plus the crowd's firing lane
   * (GameManager's overlap test). If those lanes, over each squad's whole sway,
   * cover the track, the crowd has to shoot its way through the biggest squad.
   */
  private fight(): void {
    const k = this.cfg.combat;
    const { minX, maxX } = this.cfg.track;
    const laneHalf = clamp(this.count * k.laneWidthPerUnit, 0.6, k.laneWidthMax) * 0.5;
    let biggest: Segment | null = null;
    // the free stretches of track, narrowed squad by squad (at most two pieces each)
    let free: [number, number][] = [[minX, maxX]];
    for (const e of this.pending) {
      const x = e.x ?? 0;
      const amp = e.motion ? e.motion.amp : 0;
      const reach = laneHalf + Math.max(0.4, this.cfg.crowd.formationSpacing * Math.sqrt(e.count ?? 0) * 0.5);
      const lo = x - amp - reach;
      const hi = x + amp + reach;
      const next: [number, number][] = [];
      for (const [a, b] of free) {
        if (lo > a) next.push([a, Math.min(b, lo)]);
        if (hi < b) next.push([Math.max(a, hi), b]);
      }
      free = next.filter(([a, b]) => b > a);
      if (!biggest || (e.count ?? 0) > (biggest.count ?? 0)) biggest = e;
    }
    if (!biggest || free.length > 0) return;
    // Trade fire until the squad is down or the crowd is past it (the squad
    // shoots from engageRange out to 3 u behind): both sides shrink as they go.
    const fireRate = biggest.fireRate ?? 4;
    let n = biggest.count ?? 0;
    let c = this.count;
    const window = (k.engageRange + 3) / this.speed;
    for (let t = 0; t < window && n > 0 && c > 0; t += FIGHT_STEP) {
      const crowdDps = Math.pow(c, k.dpsExponent) * k.perUnitDamage * k.fireRate;
      const squadUnits = (Math.pow(n, k.dpsExponent) * k.perUnitDamage * k.enemyPerUnitDamageFactor *
        fireRate * k.enemyDamageFactor) / k.playerUnitHp;
      n -= (crowdDps * FIGHT_STEP) / k.enemyUnitHp;
      c -= squadUnits * FIGHT_STEP;
    }
    this.count = Math.max(1, Math.round(c));
  }

  dps(): number {
    const c = this.count;
    const k = this.cfg.combat;
    return c <= 0 ? 0 : Math.pow(c, k.dpsExponent) * k.perUnitDamage * k.fireRate;
  }

  /** Seconds a plane spends inside weapons range on the way in. */
  engageSeconds(): number {
    return this.cfg.combat.engageRange / this.speed;
  }

  /** Multiplier for hp authored against REF_CROWD: the ratio of the crowd's firepower to the reference's. */
  hpScale(): number {
    return clamp(Math.pow(this.count / REF_CROWD, this.cfg.combat.dpsExponent), MIN_THREAT_SCALE, MAX_THREAT_SCALE);
  }

  /** Multiplier for a squad size authored against REF_CROWD: a squad stays the same share of the crowd. */
  sizeScale(): number {
    return clamp(this.count / REF_CROWD, MIN_THREAT_SCALE, MAX_THREAT_SCALE);
  }

  pass(seg: Segment): void {
    if (seg.type === 'enemy_crowd') {
      this.pending.push(seg);
      this.pendingZ = seg.z;
    } else if (seg.type === 'gate_pair') {
      const ticks = seg.tickable
        ? Math.floor((this.dps() * this.engageSeconds() * TICK_REALISM) / this.cfg.gates.damagePerTick)
        : 0;
      let best = -1;
      for (const side of [seg.left, seg.right]) {
        if (!side) continue;
        const v = ticks > 0 ? tickedValue(side, ticks, seg.tickPerHit ?? 1, this.cfg) : side.value;
        best = Math.max(best, applyOp(side, v, this.count));
      }
      if (best >= 0) this.count = best;
    } else if (seg.type === 'crowd_pickup') {
      this.count += seg.value ?? 0;
    } else if (seg.type === 'objective_node') {
      // the BEST line only detours for a node it can clear inside the engage window
      const reward = seg.reward ?? 0;
      if (reward > 0 && (seg.hp ?? 0) / Math.max(1e-6, this.dps()) <= this.engageSeconds()) this.count += reward;
    }
  }
}

function offersMul(chunk: Chunk): boolean {
  return chunk.segments.some((s) => s.type === 'gate_pair' && (s.left?.op === 'mul' || s.right?.op === 'mul'));
}

/** A uniform pick among the first tier in `order` with an acceptable chunk. */
function pickFrom(rng: () => number, tiers: Chunk[][], order: number[], accept: (c: Chunk) => boolean): Chunk | null {
  for (const t of order) {
    const free = tiers[t - 1].filter(accept);
    if (free.length > 0) return free[pickIndex(rng, free.length)];
  }
  return null;
}

/** Weighted tier draw; difficulty tables may zero a tier out. */
function drawTier(rng: () => number, weights: readonly number[]): 1 | 2 | 3 {
  const total = weights[0] + weights[1] + weights[2];
  let r = rng() * total;
  for (let i = 0; i < 3; i++) {
    r -= weights[i];
    if (r < 0) return (i + 1) as 1 | 2 | 3;
  }
  return 3;
}

/**
 * The day's level: an opening good-gate chunk, CHUNK_COUNT tier-weighted
 * chunks, then the boss and the finish. Deterministic for (key, lib, cfg) and
 * never mutates `lib`. Chunk threats are scaled to the projected crowd, swaying
 * props are re-phased so they meet the crowd as authored, and the boss is sized
 * to last BOSS_SECONDS against the crowd the chunks can build.
 */
export function generateDaily(key: string, lib: ChunkLibrary, cfg: GameConfig): LevelDefinition {
  const difficulty = dailyDifficulty(key);
  const di = difficulty - 1;
  const rng = mulberry32(seedFrom(key));
  const speed = FORWARD_SPEED[di];

  const openers: Chunk[] = [];
  const tiers: Chunk[][] = [[], [], []];
  for (const c of lib.chunks) {
    if (c.id.startsWith(OPENER_PREFIX)) openers.push(c);
    else if (c.tier === 1 || c.tier === 2 || c.tier === 3) tiers[c.tier - 1].push(c);
  }
  if (openers.length === 0) throw new Error(`chunk library has no "${OPENER_PREFIX}*" opener`);
  if (tiers[0].length + tiers[1].length + tiers[2].length === 0) throw new Error('chunk library has no tier chunks');

  // ---- pick: no chunk twice, and never open on a tier 3 straight off the start
  const picks: Chunk[] = [openers[pickIndex(rng, openers.length)]];
  const used = new Set<string>();
  let doublers = 0;
  const count = CHUNK_COUNT[di];
  // a doubling the day is still owed lands from a seeded slot on, not always last
  const owedFrom = pickIndex(rng, count);
  for (let i = 0; i < count; i++) {
    let tier = drawTier(rng, TIER_WEIGHTS[di]);
    if (i === 0 && tier === 3) tier = 2;
    // an exhausted tier falls back to its neighbours, nearest (then easier) first
    const order = tier === 1 ? [1, 2, 3] : tier === 2 ? [2, 1, 3] : [3, 2, 1];
    const owed = i >= owedFrom && doublers < MIN_DOUBLERS[di];
    const chosen =
      (owed ? pickFrom(rng, tiers, order, (c) => !used.has(c.id) && offersMul(c)) : null) ??
      pickFrom(rng, tiers, order, (c) => !used.has(c.id) && (doublers < MAX_DOUBLERS[di] || !offersMul(c)));
    if (!chosen) break; // a tiny library runs out: a shorter level beats a repeated chunk
    used.add(chosen.id);
    if (offersMul(chosen)) doublers++;
    picks.push(chosen);
  }

  // ---- lay down
  const proj = new Projection(cfg, speed);
  const segments: Segment[] = [];
  const threat = THREAT_SCALE[di];
  let cursor = 0;
  for (const chunk of picks) {
    const ordered = chunk.segments.map(cloneSegment).sort((a, b) => a.z - b.z);
    for (const seg of ordered) {
      seg.z = cursor + seg.z;
      proj.advanceTo(seg.z);
      const hpS = proj.hpScale() * threat;
      if (seg.type === 'barricade' && seg.hp !== undefined) seg.hp = Math.max(20, roundTo(seg.hp * hpS, 5));
      else if (seg.type === 'objective_node' && seg.hp !== undefined) seg.hp = Math.max(30, roundTo(seg.hp * hpS, 5));
      else if (seg.type === 'enemy_crowd' && seg.count !== undefined) {
        seg.count = Math.max(3, Math.round(seg.count * proj.sizeScale() * threat));
      }
      if (seg.motion && seg.motion.amp !== 0) {
        // the crowd reaches this chunk cursor / speed seconds in: shift the cycle
        // back by that much so the prop is where the author put it on arrival
        const p = (seg.motion.phase ?? 0) - cursor / (speed * seg.motion.period);
        seg.motion.phase = Math.round((((p % 1) + 1) % 1) * 10000) / 10000;
      }
      proj.pass(seg);
      segments.push(seg);
    }
    cursor += chunk.length;
  }

  // ---- boss and finish
  const bossZ = cursor + BOSS_GAP;
  proj.advanceTo(bossZ);
  // the crowd opens fire from engageRange out and stops at the standoff; that
  // run-in is free damage on top of the standoff seconds
  const runIn = Math.max(0, cfg.combat.engageRange - cfg.boss.standoff) / speed;
  const bossHp = Math.max(500, roundTo(proj.dps() * (BOSS_SECONDS[di] + runIn), 50));
  const attackSets = BOSS_ATTACKS[di];
  segments.push({ z: bossZ, type: 'boss', hp: bossHp, attacks: [...attackSets[pickIndex(rng, attackSets.length)]] });
  const finishZ = bossZ + FINISH_GAP;
  segments.push({ z: finishZ, type: 'finish', multiplierLanes: [...FINISH_LANES[di]] });

  return {
    id: Number(key.replace(/-/g, '')),
    length: finishZ + TAIL,
    forwardSpeed: speed,
    segments,
  };
}
