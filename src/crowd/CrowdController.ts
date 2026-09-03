import * as THREE from 'three';
import { UnitInstancer } from './UnitInstancer';
import { clamp, damp, phyllotaxis, lerp, type Vec2 } from '../util/MathUtil';
import type { GameConfig } from '../data/types';

// The player crowd. `count` is the single source of truth for power; the
// rendered instances are a capped, decoupled visualization of it.

export class CrowdController {
  count = 0;
  readonly centroid: Vec2 = { x: 0, z: 0 };
  private targetX = 0;
  private steerVel = 0;

  private instancer: UnitInstancer;
  private readonly cfg: GameConfig;
  private jitterX: Float32Array;
  private jitterZ: Float32Array;
  private bobPhase: Float32Array;
  private scratch: Vec2 = { x: 0, z: 0 };

  // bonus stats from upgrades (multipliers), set by GameManager
  damageMul = 1;
  fireRateMul = 1;
  private lossAccum = 0;

  constructor(cfg: GameConfig, scene: THREE.Scene, color = 0x4ea3ff) {
    this.cfg = cfg;
    const cap = cfg.crowd.maxVisibleUnits;
    this.instancer = new UnitInstancer(cap, color, cfg.crowd.unitRadius);
    scene.add(this.instancer.mesh);

    this.jitterX = new Float32Array(cap);
    this.jitterZ = new Float32Array(cap);
    this.bobPhase = new Float32Array(cap);
    for (let i = 0; i < cap; i++) {
      this.jitterX[i] = (Math.random() - 0.5) * 0.12;
      this.jitterZ[i] = (Math.random() - 0.5) * 0.12;
      this.bobPhase[i] = Math.random() * Math.PI * 2;
    }
  }

  reset(count: number): void {
    this.count = count;
    this.centroid.x = 0;
    this.centroid.z = 0;
    this.targetX = 0;
    this.steerVel = 0;
    this.lossAccum = 0;
  }

  /**
   * Normalized [0,1] screen-X input → target world X.
   * The chase camera looks down +Z, which mirrors world X on screen, so we
   * invert here: dragging to the screen-right moves the crowd screen-right.
   */
  steerNormalized(t01: number): void {
    const { minX, maxX } = this.cfg.track;
    this.targetX = lerp(minX, maxX, 1 - clamp(t01, 0, 1));
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
    const lost = Math.min(this.count, Math.max(0, Math.floor(n)));
    this.count -= lost;
    return lost;
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

    this.layout(time);
  }

  private layout(time: number): void {
    const n = this.visibleCount;
    const { minX, maxX, width } = this.cfg.track;
    let spacing = this.cfg.crowd.formationSpacing;

    // First pass: find horizontal extent to squeeze near walls.
    let maxAbsX = 0;
    for (let i = 0; i < n; i++) {
      phyllotaxis(i, spacing, this.scratch);
      const ax = Math.abs(this.scratch.x) + Math.abs(this.jitterX[i]);
      if (ax > maxAbsX) maxAbsX = ax;
    }
    const half = width / 2 - this.cfg.crowd.unitRadius;
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
      this.instancer.setInstance(i, x, groundY + bob, z, lean);
    }
    this.instancer.setVisibleCount(n);
    this.instancer.commit();
  }

  setColor(color: number): void {
    this.instancer.setColor(color);
  }
}
