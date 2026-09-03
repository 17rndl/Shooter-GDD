import * as THREE from 'three';
import { UnitInstancer } from '../crowd/UnitInstancer';
import { NumberPlate } from '../util/Label';
import { phyllotaxis, type Vec2 } from '../util/MathUtil';
import type { GameConfig, Segment } from '../data/types';

const ENEMY_COLOR = 0xff8a3d;

// Mirror of the player crowd: a count that auto-fires at the player. Resolved as
// a DPS race in the overlap lane (see CombatSystem).

export class EnemyCrowd {
  readonly group = new THREE.Group();
  readonly x: number;
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
  private readonly cfg: GameConfig;

  constructor(seg: Segment, cfg: GameConfig, scene: THREE.Scene) {
    this.cfg = cfg;
    this.x = seg.x ?? 0;
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
    this.hp -= d;
    this.count = Math.max(0, Math.ceil(this.hp / this.cfg.combat.enemyUnitHp));
    if (this.hp <= 0) {
      this.count = 0;
      this.alive = false;
    }
  }

  update(dt: number, time: number, cam: THREE.Camera): void {
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
    if (!this.alive) this.group.visible = false;
  }

  dispose(scene: THREE.Scene): void {
    scene.remove(this.group);
    this.instancer.dispose();
    this.plate.dispose();
  }
}
