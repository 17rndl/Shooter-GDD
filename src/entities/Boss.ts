import * as THREE from 'three';
import { NumberPlate } from '../util/Label';
import { clamp, lerp } from '../util/MathUtil';
import type { GameConfig, Segment } from '../data/types';

type Phase = 'cooldown' | 'telegraph';

// Level finale. A big HP sponge that periodically throws a lateral fire band the
// player must steer out of — turning the standoff into an active dodge.

const ATTACK_KINDS: readonly string[] = ['sweep_fire', 'slam'];
const SWEEP_TINT = 0xff3b30; // random band, full telegraph — read it and walk away
const SLAM_TINT = 0xff8a3d;  // tracks the crowd, winds up faster, hits harder

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
  private timer: number;
  private bandCenter = 0;
  private hasRolled = false;
  private readonly cfg: GameConfig;
  private dead = -1;
  private punch = 0;
  private readonly attacks: string[];
  private attackIndex = 0;
  private attack: string;

  constructor(seg: Segment, cfg: GameConfig) {
    this.cfg = cfg;
    this.timer = cfg.boss.firstTelegraphDelay;
    // Unknown names are dropped rather than fatal so a level can name an attack a
    // future build adds; an all-unknown list still has to fight, hence the fallback.
    const wanted = (seg.attacks ?? ['sweep_fire']).filter((a) => ATTACK_KINDS.includes(a));
    this.attacks = wanted.length > 0 ? wanted : ['sweep_fire'];
    this.attack = this.attacks[0];
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
      color: SWEEP_TINT, transparent: true, opacity: 0, depthWrite: false, side: THREE.DoubleSide,
    });
    this.telegraph = new THREE.Mesh(new THREE.PlaneGeometry(cfg.boss.bandHalf * 2, len), this.telegraphMat);
    this.telegraph.rotation.x = -Math.PI / 2;
    this.telegraph.position.set(0, 0.03, this.z - len / 2);
    this.telegraph.visible = false;
    this.group.add(this.telegraph);
  }

  hpFraction(): number {
    return clamp(this.hp / this.maxHp, 0, 1);
  }

  /** The attack currently winding up (or the one queued first, before the fight). */
  get currentAttack(): string {
    return this.attack;
  }

  /**
   * Places the next sweep band anywhere the crowd can actually stand, re-rolling
   * while it lands on top of the last one so the pattern can't be memorised —
   * the player has to read the telegraph. The very first roll of a fight has no
   * previous band, so it skips the re-roll: otherwise the resting bandCenter of
   * 0 would count as "previous" and bias the opening telegraph off-centre.
   */
  private rollBand(): void {
    const { minX, maxX } = this.cfg.track;
    const bh = this.cfg.boss.bandHalf;
    const lo = minX + bh, hi = maxX - bh;
    let x = lo + Math.random() * (hi - lo);
    if (this.hasRolled) {
      const prev = this.bandCenter;
      for (let i = 0; i < 5 && Math.abs(x - prev) < 1.0; i++) x = lo + Math.random() * (hi - lo);
    }
    this.hasRolled = true;
    this.bandCenter = x;
  }

  takeDamage(d: number): void {
    if (!this.alive) return;
    if (this.punch < 0.35) this.punch = 1; // re-arm once decayed so sustained fire flinches, not bulges
    this.hp -= d;
    if (this.hp <= 0) {
      this.hp = 0;
      this.alive = false;
      this.dead = 0;
      this.telegraph.visible = false;
    }
  }

  /**
   * Drives the attack cycle, one entry of `attacks` per telegraph, in order.
   * Returns the crowd fraction to remove this frame (>0 only on the exact frame an
   * attack resolves and the band physically overlaps the formation). `crowdHalf` is
   * the crowd's PHYSICAL half-width — not the much wider firing lane — and the loss
   * scales with the share of that width the band actually covers, so a clean dodge
   * costs nothing and a graze costs little.
   * `fighting` is false until the standoff begins; the cycle is frozen until then.
   */
  update(dt: number, time: number, cam: THREE.Camera, centroidX: number, crowdHalf: number, fighting: boolean): number {
    this.plate.set(this.alive ? String(Math.ceil(this.hp)) : '0');
    this.plate.faceCamera(cam);
    this.mesh.position.y = 1.2 + Math.sin(time * 2) * 0.06;
    if (this.punch > 0) this.punch = Math.max(0, this.punch - dt * 8);

    if (this.dead >= 0) {
      this.dead += dt;
      const k = Math.max(0, 1 - this.dead * 1.6);
      this.mesh.scale.setScalar(k); // the death collapse owns mesh.scale — punch stays out of it
      this.mat.emissiveIntensity = 1 + Math.sin(time * 30) * 0.5;
      if (k <= 0) this.group.visible = false;
      return 0;
    }
    if (!this.alive) return 0;
    this.mesh.scale.setScalar(1 + 0.06 * this.punch);

    // Not engaged yet: hold a full cooldown so the first telegraph lands one
    // firstTelegraphDelay after the fight actually starts, not after the crowd
    // finishes approaching.
    if (!fighting) {
      this.phase = 'cooldown';
      this.timer = this.cfg.boss.firstTelegraphDelay;
      this.telegraph.visible = false;
      this.telegraphMat.opacity = 0;
      this.mat.emissive.setHex(0x3a0a06);
      return 0;
    }

    const b = this.cfg.boss;
    // the wounded boss winds up and swings faster
    const hurt = 1 - this.hpFraction();
    let damageFraction = 0;
    this.timer -= dt;

    if (this.phase === 'cooldown') {
      this.mat.emissive.setHex(0x3a0a06);
      if (this.timer <= 0) {
        this.phase = 'telegraph';
        this.attack = this.attacks[this.attackIndex];
        this.attackIndex = (this.attackIndex + 1) % this.attacks.length;
        const tele = lerp(b.telegraphTime, b.telegraphTimeMin, hurt);
        if (this.attack === 'slam') {
          this.hasRolled = true; // a slam band is a real previous band for the next sweep's anti-repeat
          // Locks onto where the crowd stands the instant the wind-up starts, so
          // the only answer is to move — and it allows less time to do it.
          const bh = b.bandHalf;
          this.bandCenter = clamp(centroidX, this.cfg.track.minX + bh, this.cfg.track.maxX - bh);
          this.timer = tele * b.slamTelegraphScale;
          this.telegraphMat.color.setHex(SLAM_TINT);
        } else {
          this.rollBand();
          this.timer = tele;
          this.telegraphMat.color.setHex(SWEEP_TINT);
        }
        this.telegraph.position.x = this.bandCenter;
        this.telegraph.visible = true;
      }
    } else {
      // telegraph: pulse the strip, flash the boss
      const pulse = 0.25 + 0.4 * (0.5 + 0.5 * Math.sin(time * 22));
      this.telegraphMat.opacity = pulse;
      this.mat.emissive.setHex(0x7a1a10);
      if (this.timer <= 0) {
        // resolve: loss is proportional to how much of the formation the band covers
        const lo = Math.max(centroidX - crowdHalf, this.bandCenter - b.bandHalf);
        const hi = Math.min(centroidX + crowdHalf, this.bandCenter + b.bandHalf);
        const overlap = Math.max(0, hi - lo);
        const overlapFrac = crowdHalf > 0 ? overlap / (2 * crowdHalf) : 0;
        const bite = this.attack === 'slam' ? b.slamHitScale : 1;
        damageFraction = b.hitFraction * bite * overlapFrac;
        this.telegraph.visible = false;
        this.telegraphMat.opacity = 0;
        this.phase = 'cooldown';
        this.timer = lerp(b.cooldown, b.cooldownMin, hurt);
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
