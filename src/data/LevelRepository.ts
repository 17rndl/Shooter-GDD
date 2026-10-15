import type { GameConfig, LevelDefinition } from './types';

// ---------------------------------------------------------------------------
// Level loading behind an interface: a manifest names the authored files, the
// progression index wraps over them (endless mode), and every file is validated
// once before the game sees it. Type-only imports so Node can unit-test this.
// ---------------------------------------------------------------------------

export interface ILevelRepository {
  /** Loads the manifest; awaited before count/load. */
  init(): Promise<void>;
  /** Authored levels in the manifest. */
  readonly count: number;
  /**
   * n = 1-based progression index (any integer); wraps over the manifest.
   * Validated and cached: callers share the returned object and must not mutate it.
   */
  load(n: number): Promise<LevelDefinition>;
}

const SEGMENT_TYPES: readonly string[] = [
  'gate_pair', 'barricade', 'enemy_crowd', 'objective_node',
  'boss', 'finish', 'coin_pickup', 'crowd_pickup', 'blade',
];
const GATE_OPS: readonly string[] = ['add', 'mul', 'sub', 'div'];
// Mirrors Boss ATTACK_KINDS. An unknown name is only a warning: Boss drops it.
const KNOWN_ATTACKS: readonly string[] = ['sweep_fire', 'slam', 'crossfire'];
const HP_TYPES: readonly string[] = ['barricade', 'objective_node', 'boss'];
// The entities that call track(): anything else would silently ignore a motion.
const MOTION_TYPES: readonly string[] = ['barricade', 'enemy_crowd', 'coin_pickup', 'crowd_pickup', 'blade'];

/** 1-based progression index → 1..count. Handles n < 1 (count must be >= 1). */
export function wrapIndex(n: number, count: number): number {
  return ((((n - 1) % count) + count) % count) + 1;
}

/** How many times the authored list has been looped (endless mode). */
export function wrapsFor(n: number, count: number): number {
  // clamped: a corrupt save with currentLevel < 1 must never scale threats down
  return Math.max(0, Math.floor((n - 1) / count));
}

const isNum = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);
const isPos = (v: unknown): v is number => isNum(v) && v > 0;
const isObj = (v: unknown): v is Record<string, unknown> =>
  !!v && typeof v === 'object' && !Array.isArray(v);

function gateSideProblem(side: unknown): string | null {
  if (!isObj(side)) return 'is not an object';
  if (typeof side.op !== 'string' || !GATE_OPS.includes(side.op)) return `op ${JSON.stringify(side.op)} is not add|mul|sub|div`;
  if (!isPos(side.value)) return `value ${JSON.stringify(side.value)} must be a finite number > 0`;
  // ×0.5 would shrink and ÷0.5 would grow: a gate's colour must not lie about its sign
  if ((side.op === 'mul' || side.op === 'div') && side.value < 1) return `${side.op} value ${side.value} must be >= 1`;
  return null;
}

function motionProblem(m: unknown): string | null {
  if (!isObj(m)) return 'is not an object';
  if (!isNum(m.amp) || m.amp < 0) return `amp ${JSON.stringify(m.amp)} must be a finite number >= 0`;
  if (!isPos(m.period)) return `period ${JSON.stringify(m.period)} must be a finite number > 0`;
  if (m.phase !== undefined && !isNum(m.phase)) return `phase ${JSON.stringify(m.phase)} must be a finite number`;
  return null;
}

/**
 * Hard errors throw ('<file>: segment <i> (<type>): <reason>') for anything the
 * game cannot run; soft problems (ordering, out-of-bounds placement, missing
 * boss/finish, unknown attack names) only warn, since the game copes with them.
 * Returns the input itself, now typed.
 */
export function validateLevel(raw: unknown, file: string, cfg: GameConfig): LevelDefinition {
  if (!isObj(raw)) throw new Error(`${file}: level is not an object`);
  if (!isNum(raw.id)) throw new Error(`${file}: id must be a finite number`);
  if (!isPos(raw.length)) throw new Error(`${file}: length must be a finite number > 0`);
  if (!isPos(raw.forwardSpeed)) throw new Error(`${file}: forwardSpeed must be a finite number > 0`);
  if (!Array.isArray(raw.segments)) throw new Error(`${file}: segments is not an array`);

  const length = raw.length;
  const { minX, maxX } = cfg.track;
  const segs: unknown[] = raw.segments;
  let prevZ = -Infinity;
  let unsortedWarned = false;
  let hasBoss = false;
  let hasFinish = false;

  for (let i = 0; i < segs.length; i++) {
    const seg = segs[i];
    if (!isObj(seg)) throw new Error(`${file}: segment ${i} (?): not an object`);
    const type = seg.type;
    const where = `${file}: segment ${i} (${String(type)})`;
    if (typeof type !== 'string' || !SEGMENT_TYPES.includes(type)) throw new Error(`${where}: unknown type`);
    if (!isNum(seg.z)) throw new Error(`${where}: z must be a finite number`);

    if (type === 'gate_pair') {
      const hasL = seg.left !== undefined && seg.left !== null;
      const hasR = seg.right !== undefined && seg.right !== null;
      if (!hasL && !hasR) throw new Error(`${where}: needs a left or right side`);
      for (const key of ['left', 'right'] as const) {
        if (seg[key] === undefined || seg[key] === null) continue;
        const problem = gateSideProblem(seg[key]);
        if (problem) throw new Error(`${where}: ${key} ${problem}`);
      }
    } else if (HP_TYPES.includes(type)) {
      if (!isPos(seg.hp)) throw new Error(`${where}: hp must be a finite number > 0`);
    } else if (type === 'enemy_crowd') {
      if (!isPos(seg.count)) throw new Error(`${where}: count must be a finite number > 0`);
    } else if (type === 'finish') {
      const lanes = seg.multiplierLanes;
      if (!Array.isArray(lanes) || lanes.length === 0 || !lanes.every(isPos)) {
        throw new Error(`${where}: multiplierLanes must be a non-empty array of finite numbers > 0`);
      }
    } else if (type === 'blade') {
      if (!isPos(seg.width)) throw new Error(`${where}: width must be a finite number > 0`);
      if (!isPos(seg.kill) || seg.kill > 1) throw new Error(`${where}: kill must be a finite number in (0, 1]`);
    } else if (!isPos(seg.value)) {
      // coin_pickup / crowd_pickup
      throw new Error(`${where}: value must be a finite number > 0`);
    }

    if (type === 'boss') {
      hasBoss = true;
      const attacks = seg.attacks;
      if (attacks !== undefined) {
        if (!Array.isArray(attacks) || !attacks.every((a) => typeof a === 'string')) {
          throw new Error(`${where}: attacks must be an array of strings`);
        }
        for (const a of attacks) {
          if (!KNOWN_ATTACKS.includes(a)) console.warn(`${where}: unknown attack "${a}" (Boss skips it)`);
        }
      }
    }
    if (type === 'finish') hasFinish = true;

    // JSON has no undefined, so a present `motion` (even null) is a real field
    if (seg.motion !== undefined) {
      if (!MOTION_TYPES.includes(type)) throw new Error(`${where}: motion is not allowed on ${type}`);
      const problem = motionProblem(seg.motion);
      if (problem) throw new Error(`${where}: motion ${problem}`);
    }

    // ---- soft: the game runs, but the author probably did not mean it
    if (seg.z < prevZ && !unsortedWarned) {
      console.warn(`${where}: segments are not sorted by z (${seg.z} after ${prevZ})`);
      unsortedWarned = true;
    }
    prevZ = Math.max(prevZ, seg.z);
    if (seg.z < 0 || seg.z > length) console.warn(`${where}: z ${seg.z} is outside [0, ${length}]`);
    if (seg.x !== undefined && !(isNum(seg.x) && seg.x >= minX && seg.x <= maxX)) {
      console.warn(`${where}: x ${String(seg.x)} is outside the track [${minX}, ${maxX}]`);
    }
    if (isObj(seg.motion) && isNum(seg.motion.amp) && seg.motion.amp > 0) {
      // |x| + amp past the half-width: the sway carries it off the track
      const x = isNum(seg.x) ? seg.x : 0;
      const amp = seg.motion.amp;
      if (Math.abs(x) + amp > (maxX - minX) / 2) {
        console.warn(`${where}: x ${x} ± amp ${amp} sweeps outside the track [${minX}, ${maxX}]`);
      }
    }
  }

  if (!hasBoss) console.warn(`${file}: no boss segment`);
  if (!hasFinish) console.warn(`${file}: no finish segment`);
  return raw as unknown as LevelDefinition;
}

/** index.json → file names. An object, not a bare array, so Unity JsonUtility can read it. */
export function parseManifest(raw: unknown): string[] {
  if (!isObj(raw) || !Array.isArray(raw.levels)) throw new Error('index.json: expected {"levels": [...]}');
  const files: unknown[] = raw.levels;
  if (files.length === 0) throw new Error('index.json: levels is empty');
  for (let i = 0; i < files.length; i++) {
    const f = files[i];
    if (typeof f !== 'string' || f.length === 0) throw new Error(`index.json: levels[${i}] is not a file name`);
  }
  return files as string[];
}

/** Reads `<baseUrl>levels/index.json` and the files it names. */
export class FetchLevelRepository implements ILevelRepository {
  private readonly baseUrl: string;
  private readonly cfg: GameConfig;
  private files: string[] | null = null;
  private initing: Promise<void> | null = null;
  private readonly cache = new Map<number, Promise<LevelDefinition>>();

  constructor(baseUrl: string, cfg: GameConfig) {
    this.baseUrl = baseUrl;
    this.cfg = cfg;
  }

  init(): Promise<void> {
    if (!this.initing) {
      const p = this.fetchJson('index.json').then((raw) => {
        this.files = parseManifest(raw);
      });
      // a failed manifest load must not stick: the next init() retries
      p.catch(() => { if (this.initing === p) this.initing = null; });
      this.initing = p;
    }
    return this.initing;
  }

  get count(): number {
    if (!this.files) throw new Error('LevelRepository: await init() before reading count');
    return this.files.length;
  }

  async load(n: number): Promise<LevelDefinition> {
    if (!Number.isInteger(n)) throw new Error(`LevelRepository: level index ${n} is not an integer`);
    await this.init();
    const idx = wrapIndex(n, this.count);
    let p = this.cache.get(idx);
    if (!p) {
      const file = (this.files as string[])[idx - 1];
      const next = this.fetchJson(file).then((raw) => validateLevel(raw, file, this.cfg));
      // cache the promise so concurrent loads share one fetch; a failure is evicted
      next.catch(() => { if (this.cache.get(idx) === next) this.cache.delete(idx); });
      this.cache.set(idx, next);
      p = next;
    }
    return p;
  }

  private async fetchJson(file: string): Promise<unknown> {
    const url = `${this.baseUrl}levels/${file}`;
    const res = await fetch(url);
    if (!res.ok) throw new Error(`${file}: HTTP ${res.status} loading ${url}`);
    try {
      return await res.json();
    } catch {
      throw new Error(`${file}: not valid JSON`);
    }
  }
}
