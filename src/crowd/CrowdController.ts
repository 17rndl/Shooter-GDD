import * as THREE from 'three';
import { UnitInstancer } from './UnitInstancer';
import { clamp, damp, phyllotaxis, type Vec2 } from '../util/MathUtil';
import { screenToWorldX } from '../core/WorldSpace';
import type { GameConfig } from '../data/types';
import type { ParticlePool } from '../combat/ParticlePool';

// The player crowd. `count` is the single source of truth for power; the
// rendered instances are a capped, decoupled visualization of it.

// Birth ripple: a newly visible instance scales in over GROW_TIME with a small
// overshoot, staggered by index so growth washes outward through the
// phyllotaxis instead of the whole crowd snapping in at once.
const GROW_TIME = 0.25;
const GROW_STAGGER = 0.012;
const GROW_STAGGER_MAX = 0.4;
const BACK_C1 = 2.2; // easeOutBack tuned to peak at ~1.15
const BACK_C3 = BACK_C1 + 1;
const BORN_LONG_AGO = -1e3; // birth stamp meaning "already fully grown"
const MAX_POPS_PER_CALL = 12; // a boss sweep must not spew hundreds of puffs

export class CrowdController {
  count = 0;
  readonly centroid: Vec2 = { x: 0, z: 0 };
  particles: ParticlePool | null = null;
  private targetX = 0;
  private steerVel = 0;

  private instancer: UnitInstancer;
  private readonly cfg: GameConfig;
  private jitterX: Float32Array;
  private jitterZ: Float32Array;
  private bobPhase: Float32Array;
  private birth: Float32Array;
  private lastX: Float32Array;
  private lastY: Float32Array;
  private lastZ: Float32Array;
  private laidOut = 0;
  private prevVisible = 0;
  private unitColor: number;
  private scratch: Vec2 = { x: 0, z: 0 };

  // bonus stats from upgrades (multipliers), set by GameManager
  damageMul = 1;
  fireRateMul = 1;
  private lossAccum = 0;

  constructor(cfg: GameConfig, scene: THREE.Scene, color = 0x4ea3ff) {
    this.cfg = cfg;
    this.unitColor = color;
    const cap = cfg.crowd.maxVisibleUnits;
    this.instancer = new UnitInstancer(cap, color, cfg.crowd.unitRadius);
    scene.add(this.instancer.mesh);

    this.jitterX = new Float32Array(cap);
    this.jitterZ = new Float32Array(cap);
    this.bobPhase = new Float32Array(cap);
    this.birth = new Float32Array(cap);
    this.lastX = new Float32Array(cap);
    this.lastY = new Float32Array(cap);
    this.lastZ = new Float32Array(cap);
    for (let i = 0; i < cap; i++) {
      this.jitterX[i] = (Math.random() - 0.5) * 0.12;
      this.jitterZ[i] = (Math.random() - 0.5) * 0.12;
      this.bobPhase[i] = Math.random() * Math.PI * 2;
      this.birth[i] = BORN_LONG_AGO;
    }
  }

  reset(count: number): void {
    this.count = count;
    this.centroid.x = 0;
    this.centroid.z = 0;
    this.targetX = 0;
    this.steerVel = 0;
    this.lossAccum = 0;
    // a fresh run starts fully grown; only later gains ripple in
    this.birth.fill(BORN_LONG_AGO);
    this.prevVisible = this.visibleCount;
    this.laidOut = 0; // last-known positions belong to the previous run
  }

  /**
   * Normalized [0,1] screen-X input → target world X. The camera mirrors world
   * X on screen; screenToWorldX owns that flip, so dragging to the screen-right
   * moves the crowd screen-right.
   */
  steerNormalized(t01: number): void {
    const { minX, maxX } = this.cfg.track;
    this.targetX = screenToWorldX(clamp(t01, 0, 1), minX, maxX);
  }

  setTargetX(x: number): void {
    this.targetX = clamp(x, this.cfg.track.minX, this.cfg.track.maxX);
  }

  advance(dz: number): void {
    this.centroid.z += dz;
  }

  get visibleCount(): number {
    return Math.min(this.count, this.cfg.crowd.maxVisibleUnits);
  }

  /**
   * Above the instance cap the crowd can't get wider, so it gets *bigger*:
   * 0 at the cap, 1 at ten times it. Keeps 1000 units reading heavier than 100.
   */
  get visualSwell(): number {
    const cap = this.cfg.crowd.maxVisibleUnits;
    if (this.count <= cap) return 0;
    return clamp(Math.log10(this.count / cap), 0, 1);
  }

  /** Sub-linear total DPS so size matters but never trivializes the game. */
  effectiveDPS(): number {
    const c = this.cfg.combat;
    if (this.count <= 0) return 0;
    return (
      Math.pow(this.count, c.dpsExponent) *
      c.perUnitDamage *
      this.damageMul *
      (c.fireRate * this.fireRateMul)
    );
  }

  /** Half-width of the firing/damage lane — wider crowd = wider lane. */
  laneHalf(): number {
    const c = this.cfg.combat;
    const full = clamp(this.count * c.laneWidthPerUnit, 0.6, c.laneWidthMax);
    return full * 0.5;
  }

  add(n: number): void {
    this.count = Math.max(0, this.count + n);
  }

  /** Remove up to n units; returns how many were actually lost. */
  kill(n: number): number {
    const before = this.visibleCount;
    const lost = Math.min(this.count, Math.max(0, Math.floor(n)));
    this.count -= lost;
    if (lost > 0) this.popRemoved(before);
    return lost;
  }

  /**
   * Puff at the instances that just vanished — the outermost ones, since the
   * phyllotaxis fills from the centre out. Positions come from the last layout,
   * so only instances a layout has actually placed are eligible.
   */
  private popRemoved(beforeVisible: number): void {
    if (!this.particles) return;
    const hi = Math.min(beforeVisible, this.laidOut);
    const lo = Math.max(this.visibleCount, hi - MAX_POPS_PER_CALL);
    for (let i = lo; i < hi; i++) {
      this.particles.pop(this.lastX[i], this.lastY[i], this.lastZ[i], this.unitColor);
    }
  }

  /** Apply fractional damage over time; removes whole units once they accrue. */
  damage(amount: number): number {
    if (amount <= 0 || this.count <= 0) return 0;
    this.lossAccum += amount;
    const whole = Math.floor(this.lossAccum);
    if (whole > 0) {
      this.lossAccum -= whole;
      return this.kill(whole);
    }
    return 0;
  }

  update(dt: number, time: number): void {
    // smooth steering
    const prevX = this.centroid.x;
    this.centroid.x = damp(this.centroid.x, this.targetX, this.cfg.crowd.steerSmoothing, dt);
    this.steerVel = (this.centroid.x - prevX) / Math.max(dt, 1e-4);

    // Any rise in visible instances — add(), a gate multiplier, a revive — is
    // detected here rather than at each call site, so every growth path ripples.
    const vis = this.visibleCount;
    if (vis > this.prevVisible) this.stampBirths(this.prevVisible, vis, time);
    this.prevVisible = vis;

    this.layout(time);
  }

  private stampBirths(from: number, to: number, now: number): void {
    for (let i = from; i < to; i++) {
      this.birth[i] = now + Math.min((i - from) * GROW_STAGGER, GROW_STAGGER_MAX);
    }
  }

  /** Spawn-in curve: 0 before birth, easeOutBack overshoot, then settled at 1. */
  private growScale(i: number, now: number): number {
    const t = (now - this.birth[i]) / GROW_TIME;
    if (t <= 0) return 0;
    if (t >= 1) return 1;
    const u = t - 1;
    return 1 + BACK_C3 * u * u * u + BACK_C1 * u * u;
  }

  private layout(time: number): void {
    const n = this.visibleCount;
    const { minX, maxX, width } = this.cfg.track;
    const swell = this.visualSwell;
    const scaleMul = 1 + 0.25 * swell;
    const spacing = this.cfg.crowd.formationSpacing * (1 + 0.15 * swell);

    // First pass: find horizontal extent to squeeze near walls.
    let maxAbsX = 0;
    for (let i = 0; i < n; i++) {
      phyllotaxis(i, spacing, this.scratch);
      const ax = Math.abs(this.scratch.x) + Math.abs(this.jitterX[i]);
      if (ax > maxAbsX) maxAbsX = ax;
    }
    const half = width / 2 - this.cfg.crowd.unitRadius * scaleMul;
    const squeeze = maxAbsX > half ? half / maxAbsX : 1;

    const lean = clamp(-this.steerVel * 0.04, -0.25, 0.25);
    const groundY = this.instancer.groundY;

    for (let i = 0; i < n; i++) {
      phyllotaxis(i, spacing, this.scratch);
      const x = clamp(
        this.centroid.x + (this.scratch.x + this.jitterX[i]) * squeeze,
        minX,
        maxX,
      );
      const z = this.centroid.z + this.scratch.z + this.jitterZ[i];
      const bob = Math.sin(time * 9 + this.bobPhase[i]) * 0.045;
      const y = groundY + bob;
      this.lastX[i] = x;
      this.lastY[i] = y;
      this.lastZ[i] = z;
      this.instancer.setInstance(i, x, y, z, lean, this.growScale(i, time) * scaleMul);
    }
    this.laidOut = n;
    this.instancer.setVisibleCount(n);
    this.instancer.commit();
  }

  setColor(color: number): void {
    this.unitColor = color;
    this.instancer.setColor(color);
  }
}
