import * as THREE from 'three';
import { NumberPlate } from '../util/Label';
import { clamp } from '../util/MathUtil';
import type { GameConfig, Segment } from '../data/types';

type Phase = 'cooldown' | 'telegraph';

// Level finale. A big HP sponge that periodically sweeps a lateral fire band the
// player must steer out of — turning the standoff into an active dodge.

export class Boss {
  readonly group = new THREE.Group();
  readonly z: number;
  hp: number;
  readonly maxHp: number;
  alive = true;

  private mesh: THREE.Mesh;
  private mat: THREE.MeshStandardMaterial;
  private plate: NumberPlate;
  private telegraph: THREE.Mesh;
  private telegraphMat: THREE.MeshBasicMaterial;

  private phase: Phase = 'cooldown';
  private timer = 1.5;
  private bandCenter = 0;
  private readonly bandHalf = 1.5;
  private side = 1;
  private readonly cfg: GameConfig;
  private dead = -1;

  // tuning
  private readonly cooldown = 2.4;
  private readonly telegraphTime = 1.05;
  private readonly hitFraction = 0.16;

  constructor(seg: Segment, cfg: GameConfig) {
    this.cfg = cfg;
    this.z = seg.z;
    this.hp = seg.hp ?? 1000;
    this.maxHp = this.hp;

    const w = 2.8, h = 2.4, d = 1.6;
    this.mat = new THREE.MeshStandardMaterial({ color: 0xc0392b, emissive: 0x3a0a06, roughness: 0.5 });
    this.mesh = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), this.mat);
    this.mesh.position.set(0, h / 2, this.z);
    this.mesh.castShadow = true;
    this.group.add(this.mesh);

    // eyes
    const eyeMat = new THREE.MeshBasicMaterial({ color: 0xfff04a });
    for (const ex of [-0.6, 0.6]) {
      const eye = new THREE.Mesh(new THREE.SphereGeometry(0.22, 10, 10), eyeMat);
      eye.position.set(ex, h * 0.62, this.z - d / 2 - 0.05);
      this.group.add(eye);
    }

    this.plate = new NumberPlate(2.4, '#ffd24a');
    this.plate.mesh.position.set(0, h + 0.7, this.z);
    this.group.add(this.plate.mesh);

    // sweep telegraph strip (points back toward the player)
    const len = 28;
    this.telegraphMat = new THREE.MeshBasicMaterial({
      color: 0xff3b30, transparent: true, opacity: 0, depthWrite: false, side: THREE.DoubleSide,
    });
    this.telegraph = new THREE.Mesh(new THREE.PlaneGeometry(this.bandHalf * 2, len), this.telegraphMat);
    this.telegraph.rotation.x = -Math.PI / 2;
    this.telegraph.position.set(0, 0.03, this.z - len / 2);
    this.telegraph.visible = false;
    this.group.add(this.telegraph);
  }

  hpFraction(): number {
    return clamp(this.hp / this.maxHp, 0, 1);
  }

  takeDamage(d: number): void {
    if (!this.alive) return;
    this.hp -= d;
    if (this.hp <= 0) {
      this.hp = 0;
      this.alive = false;
      this.dead = 0;
      this.telegraph.visible = false;
    }
  }

  /**
   * Drives the attack cycle. Returns the crowd fraction to remove this frame
   * (>0 only on the exact frame a sweep resolves and the centroid is in band).
   * `fighting` is false until the standoff begins; the cycle is frozen until then.
   */
  update(dt: number, time: number, cam: THREE.Camera, centroidX: number, laneHalf: number, fighting: boolean): number {
    this.plate.set(this.alive ? String(Math.ceil(this.hp)) : '0');
    this.plate.faceCamera(cam);
    this.mesh.position.y = 1.2 + Math.sin(time * 2) * 0.06;

    if (this.dead >= 0) {
      this.dead += dt;
      const k = Math.max(0, 1 - this.dead * 1.6);
      this.mesh.scale.setScalar(k);
      this.mat.emissiveIntensity = 1 + Math.sin(time * 30) * 0.5;
      if (k <= 0) this.group.visible = false;
      return 0;
    }
    if (!this.alive) return 0;

    // Not engaged yet: hold a full cooldown so the first telegraph lands ~1.5s
    // after the fight actually starts, not after the crowd finishes approaching.
    if (!fighting) {
      this.phase = 'cooldown';
      this.timer = 1.5;
      this.telegraph.visible = false;
      this.telegraphMat.opacity = 0;
      this.mat.emissive.setHex(0x3a0a06);
      return 0;
    }

    let damageFraction = 0;
    this.timer -= dt;

    if (this.phase === 'cooldown') {
      this.mat.emissive.setHex(0x3a0a06);
      if (this.timer <= 0) {
        this.phase = 'telegraph';
        this.timer = this.telegraphTime;
        this.side *= -1;
        const { minX, maxX } = this.cfg.track;
        this.bandCenter = this.side > 0 ? maxX * 0.5 : minX * 0.5;
        this.telegraph.position.x = this.bandCenter;
        this.telegraph.visible = true;
      }
    } else {
      // telegraph: pulse the strip, flash the boss
      const pulse = 0.25 + 0.4 * (0.5 + 0.5 * Math.sin(time * 22));
      this.telegraphMat.opacity = pulse;
      this.mat.emissive.setHex(0x7a1a10);
      if (this.timer <= 0) {
        // resolve: hit if centroid band overlaps
        if (Math.abs(centroidX - this.bandCenter) <= this.bandHalf + laneHalf) {
          damageFraction = this.hitFraction;
        }
        this.telegraph.visible = false;
        this.telegraphMat.opacity = 0;
        this.phase = 'cooldown';
        this.timer = this.cooldown;
      }
    }
    return damageFraction;
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
