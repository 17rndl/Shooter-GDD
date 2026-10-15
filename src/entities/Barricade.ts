import * as THREE from 'three';
import { NumberPlate } from '../util/Label';
import { motionX, type MotionDef } from '../core/Motion';
import type { GameConfig, Segment } from '../data/types';

// A numbered wall. Shoot its HP to zero to pass free; ram it while HP>0 and the
// crowd pays a unit penalty proportional to the HP that was left.

export class Barricade {
  readonly group = new THREE.Group();
  /** Authored centre. `x` is where the wall stands now; they differ only with motion. */
  readonly baseX: number;
  x: number;
  readonly z: number;
  readonly halfWidth: number;
  hp: number;
  readonly maxHp: number;
  alive = true;
  passed = false;

  private box: THREE.Mesh;
  private stripe: THREE.Mesh;
  private plate: NumberPlate;
  private breaking = -1;
  private punch = 0;
  private readonly ramFactor: number;
  private readonly motion: MotionDef | undefined;

  constructor(seg: Segment, cfg?: GameConfig) {
    this.ramFactor = cfg?.barricade?.ramFactor ?? 0.8;
    this.baseX = seg.x ?? 0;
    this.x = this.baseX;
    this.motion = seg.motion;
    this.z = seg.z;
    const width = seg.width ?? 2.0;
    this.halfWidth = width / 2;
    this.hp = seg.hp ?? 50;
    this.maxHp = this.hp;

    const h = 1.25;
    this.box = new THREE.Mesh(
      new THREE.BoxGeometry(width, h, 0.7),
      new THREE.MeshStandardMaterial({ color: 0x6b7280, roughness: 0.9 }),
    );
    this.box.position.set(this.baseX, h / 2, this.z);
    this.box.castShadow = true;
    this.box.receiveShadow = true;
    this.group.add(this.box);

    // red warning stripe
    this.stripe = new THREE.Mesh(
      new THREE.BoxGeometry(width + 0.02, 0.18, 0.72),
      new THREE.MeshStandardMaterial({ color: 0xff5a52, emissive: 0x551210, roughness: 0.7 }),
    );
    this.stripe.position.set(this.baseX, h - 0.2, this.z);
    this.group.add(this.stripe);

    this.plate = new NumberPlate(1.3, '#ffffff');
    this.plate.mesh.position.set(this.baseX, h + 0.55, this.z);
    this.plate.set(String(Math.ceil(this.hp)));
    this.group.add(this.plate.mesh);
  }

  /**
   * Slides the wall to where its sweep puts it at run time `t`. The children
   * stay built at baseX and the group carries the offset, so the punch and
   * break scales keep pivoting on each mesh's own centre.
   */
  track(t: number): void {
    if (!this.motion) return;
    this.x = motionX(this.baseX, this.motion, t);
    this.group.position.x = this.x - this.baseX;
  }

  /** Lane overlap test for targeting. */
  overlapsLane(centerX: number, half: number): boolean {
    return Math.abs(centerX - this.x) <= half + this.halfWidth;
  }

  takeDamage(d: number): void {
    if (!this.alive) return;
    if (this.punch < 0.35) this.punch = 1; // re-arm once decayed so sustained fire flinches, not bulges
    this.hp -= d;
    if (this.hp <= 0) {
      this.hp = 0;
      this.alive = false;
      this.breaking = 0;
    }
    this.plate.set(String(Math.ceil(this.hp)));
  }

  /** Units lost if the crowd rams it with HP remaining. */
  ramPenalty(): number {
    return Math.ceil(this.hp * this.ramFactor);
  }

  forceBreak(): void {
    this.alive = false;
    this.hp = 0;
    this.breaking = 0;
  }

  update(dt: number, cam: THREE.Camera): void {
    this.plate.faceCamera(cam);
    if (this.punch > 0) this.punch = Math.max(0, this.punch - dt * 8);
    if (this.breaking >= 0) {
      this.breaking += dt;
      const k = Math.max(0, 1 - this.breaking * 4);
      // breaking owns the body scale — punch stays out of it
      this.box.scale.setScalar(k);
      this.stripe.scale.setScalar(k);
      this.plate.mesh.visible = false;
      if (k <= 0) this.group.visible = false;
      return;
    }
    // The stripe clears the box by only 0.01 per side, so it must take the same
    // scale or the punched box swallows it for as long as the wall is under fire.
    const punchScale = 1 + 0.06 * this.punch;
    this.box.scale.setScalar(punchScale);
    this.stripe.scale.setScalar(punchScale);
  }

  dispose(scene: THREE.Scene): void {
    scene.remove(this.group);
    this.plate.dispose();
    disposeTree(this.group);
  }
}

/** Free every GPU resource hanging off a subtree. Double-disposing is safe in three.js. */
function disposeTree(root: THREE.Object3D): void {
  root.traverse((o) => {
    if (!(o instanceof THREE.Mesh)) return;
    o.geometry.dispose();
    const m = o.material as THREE.Material | THREE.Material[];
    for (const mat of Array.isArray(m) ? m : [m]) {
      (mat as THREE.MeshStandardMaterial).map?.dispose();
      mat.dispose();
    }
  });
}
