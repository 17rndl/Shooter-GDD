import * as THREE from 'three';
import { NumberPlate } from '../util/Label';
import type { Segment } from '../data/types';

// A big HP pool off to the side (gun emplacement). Park firepower on it to clear
// the path and earn bonus crowd. Does not fire back in the MVP.

export class ObjectiveNode {
  readonly group = new THREE.Group();
  readonly x: number;
  readonly z: number;
  readonly halfWidth = 0.8;
  readonly reward: number;
  hp: number;
  readonly maxHp: number;
  alive = true;
  cleared = false;

  private mesh: THREE.Mesh;
  private plate: NumberPlate;
  private breaking = -1;
  private punch = 0;

  constructor(seg: Segment) {
    this.x = seg.x ?? 0;
    this.z = seg.z;
    this.hp = seg.hp ?? 100;
    this.maxHp = this.hp;
    this.reward = seg.reward ?? 0;

    const h = 1.8;
    this.mesh = new THREE.Mesh(
      new THREE.CylinderGeometry(0.7, 0.85, h, 8),
      new THREE.MeshStandardMaterial({ color: 0x8a5a2b, emissive: 0x2a1606, roughness: 0.7 }),
    );
    this.mesh.position.set(this.x, h / 2, this.z);
    this.mesh.castShadow = true;
    this.group.add(this.mesh);

    // turret cap
    const cap = new THREE.Mesh(
      new THREE.BoxGeometry(0.9, 0.4, 0.9),
      new THREE.MeshStandardMaterial({ color: 0xc77b34, roughness: 0.6 }),
    );
    cap.position.set(this.x, h + 0.1, this.z);
    this.group.add(cap);

    this.plate = new NumberPlate(1.4, '#ffd98a');
    this.plate.mesh.position.set(this.x, h + 0.7, this.z);
    this.plate.set(String(Math.ceil(this.hp)));
    this.group.add(this.plate.mesh);
  }

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
      this.cleared = true;
      this.breaking = 0;
    }
    this.plate.set(String(Math.ceil(this.hp)));
  }

  update(dt: number, cam: THREE.Camera): void {
    this.plate.faceCamera(cam);
    if (this.punch > 0) this.punch = Math.max(0, this.punch - dt * 8);
    if (this.breaking >= 0) {
      this.breaking += dt;
      const k = Math.max(0, 1 - this.breaking * 3);
      this.mesh.scale.setScalar(k); // breaking owns mesh.scale — punch stays out of it
      this.plate.mesh.visible = false;
      if (k <= 0) this.group.visible = false;
      return;
    }
    this.mesh.scale.setScalar(1 + 0.06 * this.punch);
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
