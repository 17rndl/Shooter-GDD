import * as THREE from 'three';
import { UnitInstancer } from '../crowd/UnitInstancer';
import { NumberPlate } from '../util/Label';
import { phyllotaxis, type Vec2 } from '../util/MathUtil';
import { motionX, type MotionDef } from '../core/Motion';
import type { GameConfig, Segment } from '../data/types';

const ENEMY_COLOR = 0xff8a3d;

// Mirror of the player crowd: a count that auto-fires at the player. Resolved as
// a DPS race in the overlap lane (see CombatSystem).

export class EnemyCrowd {
  readonly group = new THREE.Group();
  /** Authored centre. `x` is where the squad stands now; they differ only with motion. */
  readonly baseX: number;
  x: number;
  readonly z: number;
  readonly fireRate: number;
  count: number;
  private hp: number;
  alive = true;

  private cap: number;
  private instancer: UnitInstancer;
  private plate: NumberPlate;
  private jitter: Float32Array;
  private phase: Float32Array;
  private scratch: Vec2 = { x: 0, z: 0 };
  private punch = 0;
  private readonly cfg: GameConfig;
  private readonly motion: MotionDef | undefined;

  constructor(seg: Segment, cfg: GameConfig, scene: THREE.Scene) {
    this.cfg = cfg;
    this.baseX = seg.x ?? 0;
    this.x = this.baseX;
    this.motion = seg.motion;
    this.z = seg.z;
    this.count = seg.count ?? 10;
    this.fireRate = seg.fireRate ?? 4;
    this.hp = this.count * cfg.combat.enemyUnitHp;

    this.cap = Math.min(this.count, 80);
    this.instancer = new UnitInstancer(Math.max(1, this.cap), ENEMY_COLOR, cfg.crowd.unitRadius);
    this.group.add(this.instancer.mesh);

    this.jitter = new Float32Array(this.cap);
    this.phase = new Float32Array(this.cap);
    for (let i = 0; i < this.cap; i++) {
      this.jitter[i] = (Math.random() - 0.5) * 0.12;
      this.phase[i] = Math.random() * Math.PI * 2;
    }

    this.plate = new NumberPlate(1.3, '#ffb37a');
    this.plate.mesh.position.set(this.x, 1.6, this.z);
    this.group.add(this.plate.mesh);
    scene.add(this.group);
  }

  /**
   * Moves the squad to where its sweep puts it at run time `t`. update() lays
   * the units out around `x` every frame (and pivots the punch on it), so only
   * the plate, built at a fixed spot, needs moving here.
   */
  track(t: number): void {
    if (!this.motion) return;
    this.x = motionX(this.baseX, this.motion, t);
    this.plate.mesh.position.x = this.x;
  }

  private get visible(): number {
    return Math.min(this.count, this.cap);
  }

  overlapsLane(centerX: number, half: number): boolean {
    const myHalf = Math.max(0.4, this.cfg.crowd.formationSpacing * Math.sqrt(this.count) * 0.5);
    return Math.abs(centerX - this.x) <= half + myHalf;
  }

  enemyDPS(): number {
    if (this.count <= 0) return 0;
    const c = this.cfg.combat;
    // enemies hit a bit softer than the player per unit
    return Math.pow(this.count, c.dpsExponent) * (c.perUnitDamage * c.enemyPerUnitDamageFactor) * this.fireRate;
  }

  takeDamage(d: number): void {
    if (!this.alive) return;
    if (this.punch < 0.35) this.punch = 1; // re-arm once decayed so sustained fire flinches, not bulges
    this.hp -= d;
    this.count = Math.max(0, Math.ceil(this.hp / this.cfg.combat.enemyUnitHp));
    if (this.hp <= 0) {
      this.count = 0;
      this.alive = false;
    }
  }

  update(dt: number, time: number, cam: THREE.Camera): void {
    if (this.punch > 0) this.punch = Math.max(0, this.punch - dt * 8);
    const n = this.visible;
    const groundY = this.instancer.groundY;
    for (let i = 0; i < n; i++) {
      phyllotaxis(i, this.cfg.crowd.formationSpacing, this.scratch);
      const x = this.x + this.scratch.x + this.jitter[i];
      const z = this.z + this.scratch.z;
      const bob = Math.sin(time * 8 + this.phase[i]) * 0.04;
      this.instancer.setInstance(i, x, groundY + bob, z, 0);
    }
    this.instancer.setVisibleCount(n);
    this.instancer.commit();
    this.plate.set(String(this.count));
    this.plate.faceCamera(cam);
    if (!this.alive) { this.group.visible = false; return; } // dead: no punch, group is hidden
    // Instances carry absolute world coords, so a bare group scale would slide the
    // formation away from the origin — pull the pivot back onto (x, 0, z). The plate
    // rides in this group, so counter-scale it: the punch must never grow the label.
    const s = 1 + 0.06 * this.punch;
    this.group.scale.setScalar(s);
    this.group.position.set(this.x * (1 - s), 0, this.z * (1 - s));
    this.plate.mesh.scale.setScalar(1 / s);
  }

  dispose(scene: THREE.Scene): void {
    scene.remove(this.group);
    this.instancer.dispose();
    this.plate.dispose();
  }
}
