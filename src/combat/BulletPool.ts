import * as THREE from 'three';

// Capped, pooled visual tracers. These do NOT carry damage — damage is applied
// logically in CombatSystem. Bullets are pure juice, so we can cap them hard.

interface Bullet {
  x: number; y: number; z: number;
  vx: number; vy: number; vz: number;
  life: number;
  active: boolean;
}

const DIR = new THREE.Vector3();
const FWD = new THREE.Vector3(0, 0, 1);

export class BulletPool {
  readonly mesh: THREE.InstancedMesh;
  /** Fired where a bullet dies of old age in update(). clear() never calls it. */
  onExpire: ((x: number, y: number, z: number) => void) | null = null;
  private readonly mat: THREE.MeshBasicMaterial;
  private bullets: Bullet[] = [];
  private cursor = 0;
  private m = new THREE.Matrix4();
  private p = new THREE.Vector3();
  private q = new THREE.Quaternion();
  private s = new THREE.Vector3();
  private dirty = false;

  constructor(capacity: number, color = 0xfff1a8, scene?: THREE.Scene) {
    const geo = new THREE.BoxGeometry(0.07, 0.07, 0.9);
    this.mat = new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 0.95 });
    this.mesh = new THREE.InstancedMesh(geo, this.mat, capacity);
    this.mesh.frustumCulled = false;
    this.mesh.count = capacity;
    for (let i = 0; i < capacity; i++) {
      this.bullets.push({ x: 0, y: 0, z: 0, vx: 0, vy: 0, vz: 0, life: 0, active: false });
    }
    // park all instances out of view initially
    this.m.makeScale(0, 0, 0);
    for (let i = 0; i < capacity; i++) this.mesh.setMatrixAt(i, this.m);
    this.mesh.instanceMatrix.needsUpdate = true;
    if (scene) scene.add(this.mesh);
  }

  spawn(fromX: number, fromY: number, fromZ: number, toX: number, toZ: number, speed: number): void {
    const b = this.bullets[this.cursor];
    this.cursor = (this.cursor + 1) % this.bullets.length;
    const dx = toX - fromX;
    const dzRaw = toZ - fromZ;
    const len = Math.hypot(dx, dzRaw);
    // Degenerate aim (target on top of the muzzle): fall back to a pure Z shot
    // that still points the way the target lies, so return fire never inverts.
    const short = len < 0.5;
    const ux = short ? 0 : dx / len;
    const uz = short ? (Math.sign(dzRaw) || 1) : dzRaw / len;
    b.x = fromX; b.y = fromY; b.z = fromZ;
    b.vx = ux * speed;
    b.vy = 0;
    b.vz = uz * speed;
    // No overshoot: onExpire spawns the impact spark, so the bullet must die AT
    // the aim point. Extra life would bury the burst inside/behind the target.
    b.life = Math.min(0.6, len / speed);
    b.active = true;
  }

  /** Hide instance i. Written once, when the bullet goes inactive. */
  private park(i: number): void {
    this.s.set(0, 0, 0);
    this.m.compose(this.p.set(0, -50, 0), this.q.identity(), this.s);
    this.mesh.setMatrixAt(i, this.m);
    this.dirty = true;
  }

  update(dt: number): void {
    for (let i = 0; i < this.bullets.length; i++) {
      const b = this.bullets[i];
      if (!b.active) continue;
      b.x += b.vx * dt;
      b.y += b.vy * dt;
      b.z += b.vz * dt;
      b.life -= dt;
      if (b.life <= 0) {
        b.active = false;
        this.park(i);
        // parked first: the callback may spawn, and must not find slot i live
        this.onExpire?.(b.x, b.y, b.z);
        continue;
      }
      DIR.set(b.vx, b.vy, b.vz).normalize();
      this.q.setFromUnitVectors(FWD, DIR);
      this.p.set(b.x, b.y, b.z);
      this.s.set(1, 1, 1);
      this.m.compose(this.p, this.q, this.s);
      this.mesh.setMatrixAt(i, this.m);
      this.dirty = true;
    }
    if (this.dirty) {
      this.mesh.instanceMatrix.needsUpdate = true;
      this.dirty = false;
    }
  }

  clear(): void {
    for (let i = 0; i < this.bullets.length; i++) {
      const b = this.bullets[i];
      if (!b.active) continue;
      b.active = false;
      this.park(i); // update() no longer re-parks idle slots, so do it here
    }
    if (this.dirty) {
      this.mesh.instanceMatrix.needsUpdate = true;
      this.dirty = false;
    }
  }

  /** Tints every tracer, live ones included (one shared material). */
  setColor(color: number): void {
    this.mat.color.setHex(color);
  }

  dispose(): void {
    this.mesh.geometry.dispose();
    this.mat.dispose();
    this.mesh.dispose();
  }
}
