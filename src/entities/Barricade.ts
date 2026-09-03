import * as THREE from 'three';
import { NumberPlate } from '../util/Label';
import type { Segment } from '../data/types';

// A numbered wall. Shoot its HP to zero to pass free; ram it while HP>0 and the
// crowd pays a unit penalty proportional to the HP that was left.

export class Barricade {
  readonly group = new THREE.Group();
  readonly x: number;
  readonly z: number;
  readonly halfWidth: number;
  hp: number;
  readonly maxHp: number;
  alive = true;
  passed = false;

  private box: THREE.Mesh;
  private plate: NumberPlate;
  private breaking = -1;

  constructor(seg: Segment) {
    this.x = seg.x ?? 0;
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
    this.box.position.set(this.x, h / 2, this.z);
    this.box.castShadow = true;
    this.box.receiveShadow = true;
    this.group.add(this.box);

    // red warning stripe
    const stripe = new THREE.Mesh(
      new THREE.BoxGeometry(width + 0.02, 0.18, 0.72),
      new THREE.MeshStandardMaterial({ color: 0xff5a52, emissive: 0x551210, roughness: 0.7 }),
    );
    stripe.position.set(this.x, h - 0.2, this.z);
    this.group.add(stripe);

    this.plate = new NumberPlate(1.3, '#ffffff');
    this.plate.mesh.position.set(this.x, h + 0.55, this.z);
    this.plate.set(String(Math.ceil(this.hp)));
    this.group.add(this.plate.mesh);
  }

  /** Lane overlap test for targeting. */
  overlapsLane(centerX: number, half: number): boolean {
    return Math.abs(centerX - this.x) <= half + this.halfWidth;
  }

  takeDamage(d: number): void {
    if (!this.alive) return;
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
    return Math.ceil(this.hp * 0.8);
  }

  forceBreak(): void {
    this.alive = false;
    this.hp = 0;
    this.breaking = 0;
  }

  update(dt: number, cam: THREE.Camera): void {
    this.plate.faceCamera(cam);
    if (this.breaking >= 0) {
      this.breaking += dt;
      const k = Math.max(0, 1 - this.breaking * 4);
      this.box.scale.setScalar(k);
      this.plate.mesh.visible = false;
      if (k <= 0) this.group.visible = false;
    }
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
