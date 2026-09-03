import * as THREE from 'three';

// Pooled, capped debris. Pure juice — nothing gameplay-facing reads these, so
// the pool overwrites its oldest slot when full instead of ever growing.

interface Particle {
  x: number; y: number; z: number;
  vx: number; vy: number; vz: number;
  ax: number; ay: number; az: number; // spin axis (unit length)
  rot: number; spin: number;
  size: number;
  life: number; ttl: number;
  active: boolean;
}

const GRAVITY = 9;
const POP_LIFE = 0.35;
const POP_SIZE = 4.0; // dying unit reads as a chunk, not a spark
// update() runs over the whole pool every frame; nothing in here allocates.
const AXIS = new THREE.Vector3();

export class ParticlePool {
  readonly mesh: THREE.InstancedMesh;
  private parts: Particle[] = [];
  private cursor = 0;
  private m = new THREE.Matrix4();
  private p = new THREE.Vector3();
  private q = new THREE.Quaternion();
  private s = new THREE.Vector3();
  private col = new THREE.Color();
  private dirty = false;
  private colorDirty = false;

  constructor(capacity: number, scene: THREE.Scene) {
    const geo = new THREE.BoxGeometry(0.09, 0.09, 0.09);
    // white base so per-instance colors come through unmultiplied
    const mat = new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.95 });
    this.mesh = new THREE.InstancedMesh(geo, mat, capacity);
    this.mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    this.mesh.frustumCulled = false;
    this.mesh.count = capacity;
    this.m.makeScale(0, 0, 0);
    this.col.setHex(0xffffff);
    for (let i = 0; i < capacity; i++) {
      this.parts.push({
        x: 0, y: 0, z: 0, vx: 0, vy: 0, vz: 0,
        ax: 0, ay: 1, az: 0, rot: 0, spin: 0,
        size: 1, life: 0, ttl: 1, active: false,
      });
      this.mesh.setMatrixAt(i, this.m);
      // touch every slot once so instanceColor exists before any spawn does
      this.mesh.setColorAt(i, this.col);
    }
    this.mesh.instanceMatrix.needsUpdate = true;
    if (this.mesh.instanceColor) {
      this.mesh.instanceColor.setUsage(THREE.DynamicDrawUsage);
      this.mesh.instanceColor.needsUpdate = true;
    }
    scene.add(this.mesh);
  }

  /** Claim the next ring slot, overwriting whatever lived there. */
  private takeIndex(): number {
    const i = this.cursor;
    this.cursor = (this.cursor + 1) % this.parts.length;
    return i;
  }

  private setSpinAxis(p: Particle): void {
    const ax = Math.random() * 2 - 1;
    const ay = Math.random() * 2 - 1;
    const az = Math.random() * 2 - 1;
    const len = Math.hypot(ax, ay, az) || 1;
    p.ax = ax / len;
    p.ay = ay / len;
    p.az = az / len;
  }

  /** Scatter of sparks — impacts, gate pops, anything that wants a flourish. */
  burst(x: number, y: number, z: number, n: number, color: number, speed = 2.5): void {
    const total = Math.min(Math.max(0, Math.floor(n)), this.parts.length);
    this.col.setHex(color);
    for (let k = 0; k < total; k++) {
      const i = this.takeIndex();
      const p = this.parts[i];
      const a = Math.random() * Math.PI * 2;
      const r = speed * (0.45 + Math.random() * 0.8);
      p.x = x; p.y = y; p.z = z;
      p.vx = Math.cos(a) * r;
      p.vz = Math.sin(a) * r;
      p.vy = speed * (0.7 + Math.random() * 0.9); // upward bias
      p.rot = Math.random() * Math.PI;
      p.spin = (Math.random() - 0.5) * 12;
      p.size = 0.7 + Math.random() * 0.7;
      p.ttl = 0.25 + Math.random() * 0.2;
      p.life = p.ttl;
      p.active = true;
      this.setSpinAxis(p);
      this.mesh.setColorAt(i, this.col);
    }
    if (total > 0) this.colorDirty = true;
  }

  /** One dying unit: a body-sized chunk that hops, tumbles and shrinks away. */
  pop(x: number, y: number, z: number, color: number): void {
    const i = this.takeIndex();
    const p = this.parts[i];
    const a = Math.random() * Math.PI * 2;
    const r = 0.6 + Math.random() * 0.7;
    p.x = x; p.y = y; p.z = z;
    p.vx = Math.cos(a) * r;
    p.vz = Math.sin(a) * r;
    p.vy = 1.6 + Math.random() * 1.2;
    p.rot = Math.random() * Math.PI;
    p.spin = (Math.random() - 0.5) * 16;
    p.size = POP_SIZE;
    p.ttl = POP_LIFE;
    p.life = POP_LIFE;
    p.active = true;
    this.setSpinAxis(p);
    this.col.setHex(color);
    this.mesh.setColorAt(i, this.col);
    this.colorDirty = true;
  }

  /** Hide instance i. Written once, when the particle dies. */
  private park(i: number): void {
    this.s.set(0, 0, 0);
    this.m.compose(this.p.set(0, -50, 0), this.q.identity(), this.s);
    this.mesh.setMatrixAt(i, this.m);
    this.dirty = true;
  }

  update(dt: number): void {
    for (let i = 0; i < this.parts.length; i++) {
      const p = this.parts[i];
      if (!p.active) continue;
      p.vy -= GRAVITY * dt;
      p.x += p.vx * dt;
      p.y += p.vy * dt;
      p.z += p.vz * dt;
      p.rot += p.spin * dt;
      p.life -= dt;
      if (p.life <= 0) {
        p.active = false;
        this.park(i);
        continue;
      }
      // shallow bounce so debris settles on the track instead of sinking through
      if (p.y < 0.04 && p.vy < 0) {
        p.y = 0.04;
        p.vy *= -0.35;
      }
      const k = p.life / p.ttl;
      const sc = p.size * k;
      AXIS.set(p.ax, p.ay, p.az);
      this.q.setFromAxisAngle(AXIS, p.rot);
      this.p.set(p.x, p.y, p.z);
      this.s.set(sc, sc, sc);
      this.m.compose(this.p, this.q, this.s);
      this.mesh.setMatrixAt(i, this.m);
      this.dirty = true;
    }
    if (this.dirty) {
      this.mesh.instanceMatrix.needsUpdate = true;
      this.dirty = false;
    }
    if (this.colorDirty && this.mesh.instanceColor) {
      this.mesh.instanceColor.needsUpdate = true;
      this.colorDirty = false;
    }
  }

  dispose(): void {
    this.mesh.geometry.dispose();
    (this.mesh.material as THREE.Material).dispose();
    this.mesh.dispose();
  }
}
