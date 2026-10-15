import * as THREE from 'three';
import { NumberPlate } from '../util/Label';
import { clamp, lerp } from '../util/MathUtil';
import type { GameConfig, Segment } from '../data/types';

type Phase = 'cooldown' | 'telegraph';

// Level finale. A big HP sponge that periodically throws a lateral fire band the
// player must steer out of — turning the standoff into an active dodge.

const ATTACK_KINDS: readonly string[] = ['sweep_fire', 'slam', 'crossfire'];
const SWEEP_TINT = 0xff3b30;     // random band, full telegraph — read it and walk away
const SLAM_TINT = 0xff8a3d;      // tracks the crowd, winds up faster, hits harder
const CROSSFIRE_TINT = 0xd04dff; // fire everywhere but one gap — find the gap and fit in it
const SAFE_TINT = 0x5ce06a;
const TELEGRAPH_LEN = 28;

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
  // crossfire: two danger planes either side of a green-outlined safe lane
  private crossfire = new THREE.Group();
  private xfMat: THREE.MeshBasicMaterial;
  private xfLo: THREE.Mesh; // world [minX, gap)
  private xfHi: THREE.Mesh; // world (gap, maxX]
  private safeLane = new THREE.Group();
  private safeFillMat: THREE.MeshBasicMaterial;
  private safeEdgeMat: THREE.MeshBasicMaterial;

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
    const len = TELEGRAPH_LEN;
    this.telegraphMat = new THREE.MeshBasicMaterial({
      color: SWEEP_TINT, transparent: true, opacity: 0, depthWrite: false, side: THREE.DoubleSide,
    });
    this.telegraph = new THREE.Mesh(new THREE.PlaneGeometry(cfg.boss.bandHalf * 2, len), this.telegraphMat);
    this.telegraph.rotation.x = -Math.PI / 2;
    this.telegraph.position.set(0, 0.03, this.z - len / 2);
    this.telegraph.visible = false;
    this.group.add(this.telegraph);

    // crossfire telegraph. The danger planes are unit-wide and scaled on X per
    // roll, since their widths change with every gap; the safe lane is fixed-size
    // and just slides.
    this.xfMat = new THREE.MeshBasicMaterial({
      color: CROSSFIRE_TINT, transparent: true, opacity: 0, depthWrite: false, side: THREE.DoubleSide,
    });
    const unitPlane = new THREE.PlaneGeometry(1, len);
    this.xfLo = flatStrip(unitPlane, this.xfMat, 0.03);
    this.xfHi = flatStrip(unitPlane, this.xfMat, 0.03);
    this.crossfire.add(this.xfLo, this.xfHi);

    const gh = cfg.boss.crossfireGapHalf;
    this.safeFillMat = new THREE.MeshBasicMaterial({
      color: SAFE_TINT, transparent: true, opacity: 0, depthWrite: false, side: THREE.DoubleSide,
    });
    this.safeEdgeMat = new THREE.MeshBasicMaterial({
      color: SAFE_TINT, transparent: true, opacity: 0, depthWrite: false, side: THREE.DoubleSide,
    });
    const fill = flatStrip(new THREE.PlaneGeometry(gh * 2, len), this.safeFillMat, 0.032);
    fill.renderOrder = 1;
    this.safeLane.add(fill);
    const edgeGeo = new THREE.PlaneGeometry(0.14, len);
    for (const ex of [-gh, gh]) {
      const edge = flatStrip(edgeGeo, this.safeEdgeMat, 0.036);
      edge.position.x = ex;
      edge.renderOrder = 2; // over the fill it straddles
      this.safeLane.add(edge);
    }
    this.crossfire.add(this.safeLane);
    this.crossfire.position.z = this.z - len / 2;
    this.crossfire.visible = false;
    this.group.add(this.crossfire);
  }

  hpFraction(): number {
    return clamp(this.hp / this.maxHp, 0, 1);
  }

  /** The attack currently winding up (or the one queued first, before the fight). */
  get currentAttack(): string {
    return this.attack;
  }

  /**
   * Places the next telegraph centre (a sweep band, or a crossfire's safe gap)
   * anywhere a feature `half` wide fits on the track, re-rolling while it lands
   * on top of the last one so the pattern can't be memorised — the player has
   * to read the telegraph. The very first roll of a fight has no previous band,
   * so it skips the re-roll: otherwise the resting bandCenter of 0 would count
   * as "previous" and bias the opening telegraph off-centre.
   */
  private rollCenter(half: number): void {
    const { minX, maxX } = this.cfg.track;
    const lo = minX + half, hi = maxX - half;
    let x = lo + Math.random() * (hi - lo);
    if (this.hasRolled) {
      const prev = this.bandCenter;
      for (let i = 0; i < 5 && Math.abs(x - prev) < 1.0; i++) x = lo + Math.random() * (hi - lo);
    }
    this.hasRolled = true;
    this.bandCenter = x;
  }

  /** Fits the two danger planes around the safe gap at bandCenter. */
  private layoutCrossfire(): void {
    const { minX, maxX } = this.cfg.track;
    const gh = this.cfg.boss.crossfireGapHalf;
    const g = this.bandCenter;
    const loW = g - gh - minX;
    const hiW = maxX - (g + gh);
    // a gap flush with an edge leaves no plane on that side, not a zero-width sliver
    this.xfLo.visible = loW > 0.01;
    this.xfLo.scale.x = Math.max(0.01, loW);
    this.xfLo.position.x = minX + loW / 2;
    this.xfHi.visible = hiW > 0.01;
    this.xfHi.scale.x = Math.max(0.01, hiW);
    this.xfHi.position.x = maxX - hiW / 2;
    this.safeLane.position.x = g;
  }

  private hideTelegraphs(): void {
    this.telegraph.visible = false;
    this.telegraphMat.opacity = 0;
    this.crossfire.visible = false;
    this.xfMat.opacity = 0;
    this.safeFillMat.opacity = 0;
    this.safeEdgeMat.opacity = 0;
  }

  takeDamage(d: number): void {
    if (!this.alive) return;
    if (this.punch < 0.35) this.punch = 1; // re-arm once decayed so sustained fire flinches, not bulges
    this.hp -= d;
    if (this.hp <= 0) {
      this.hp = 0;
      this.alive = false;
      this.dead = 0;
      this.hideTelegraphs();
    }
  }

  /**
   * Drives the attack cycle, one entry of `attacks` per telegraph, in order.
   * Returns the crowd fraction to remove this frame (>0 only on the exact frame an
   * attack resolves and the band physically overlaps the formation). `crowdHalf` is
   * the crowd's PHYSICAL half-width — not the much wider firing lane — and the loss
   * scales with the share of that width the band actually covers, so a clean dodge
   * costs nothing and a graze costs little. Crossfire inverts it: everything but
   * the safe gap is band, so the loss is the share of the formation outside it.
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
      this.hideTelegraphs();
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
        if (this.attack === 'crossfire') {
          // the gap is this attack's "band" for the anti-repeat, both ways
          this.rollCenter(b.crossfireGapHalf);
          this.layoutCrossfire();
          this.timer = tele * b.crossfireTelegraphScale;
          this.crossfire.visible = true;
        } else {
          if (this.attack === 'slam') {
            this.hasRolled = true; // a slam band is a real previous band for the next sweep's anti-repeat
            // Locks onto where the crowd stands the instant the wind-up starts, so
            // the only answer is to move — and it allows less time to do it.
            const bh = b.bandHalf;
            this.bandCenter = clamp(centroidX, this.cfg.track.minX + bh, this.cfg.track.maxX - bh);
            this.timer = tele * b.slamTelegraphScale;
            this.telegraphMat.color.setHex(SLAM_TINT);
          } else {
            this.rollCenter(b.bandHalf);
            this.timer = tele;
            this.telegraphMat.color.setHex(SWEEP_TINT);
          }
          this.telegraph.position.x = this.bandCenter;
          this.telegraph.visible = true;
        }
      }
    } else {
      // telegraph: pulse the danger, flash the boss
      const pulse = 0.25 + 0.4 * (0.5 + 0.5 * Math.sin(time * 22));
      if (this.attack === 'crossfire') {
        this.xfMat.opacity = pulse;
        // the safe lane holds steady against the pulsing fire, so it reads as calm ground
        this.safeEdgeMat.opacity = 0.9;
        this.safeFillMat.opacity = 0.14;
      } else {
        this.telegraphMat.opacity = pulse;
      }
      this.mat.emissive.setHex(0x7a1a10);
      if (this.timer <= 0) {
        let overlapFrac: number;
        let bite: number;
        if (this.attack === 'crossfire') {
          // resolve: loss is the share of the formation left outside the safe gap
          const gh = b.crossfireGapHalf;
          const g = this.bandCenter;
          const inGap = Math.max(0, Math.min(centroidX + crowdHalf, g + gh) - Math.max(centroidX - crowdHalf, g - gh));
          overlapFrac = crowdHalf > 0 ? (2 * crowdHalf - inGap) / (2 * crowdHalf) : 0;
          bite = b.crossfireHitScale;
        } else {
          // resolve: loss is proportional to how much of the formation the band covers
          const lo = Math.max(centroidX - crowdHalf, this.bandCenter - b.bandHalf);
          const hi = Math.min(centroidX + crowdHalf, this.bandCenter + b.bandHalf);
          const overlap = Math.max(0, hi - lo);
          overlapFrac = crowdHalf > 0 ? overlap / (2 * crowdHalf) : 0;
          bite = this.attack === 'slam' ? b.slamHitScale : 1;
        }
        damageFraction = b.hitFraction * bite * overlapFrac;
        this.hideTelegraphs();
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

/** A ground-hugging strip of `geo` (authored in XY, laid flat) at height `y`. */
function flatStrip(geo: THREE.PlaneGeometry, mat: THREE.Material, y: number): THREE.Mesh {
  const m = new THREE.Mesh(geo, mat);
  m.rotation.x = -Math.PI / 2;
  m.position.y = y;
  return m;
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
