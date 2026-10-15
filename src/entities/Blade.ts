import * as THREE from 'three';
import { motionX, type MotionDef } from '../core/Motion';
import { clamp } from '../util/MathUtil';
import type { GameConfig, Segment } from '../data/types';

// A spinning saw riding a rail across the track. Indestructible and never a
// bullet target: the only answer is to steer the formation clear of its cut.
// GameManager resolves the crossing once and calls flashHit when units were
// lost; everything in here is presentation.

const STEEL = 0x3b4252;
const TOOTH_RED = 0xff3b30;
const SPARK_COLOR = 0xffd27a;
const DANGER_RANGE = 14; // the warning glow ramps in over the last stretch of approach
const SPIN_IDLE = 10;    // rad/s; a close saw spins up toward SPIN_IDLE + SPIN_DANGER
const SPIN_DANGER = 14;
const RAIL_SLOT = 0.16;  // half-gap between the two rail bars the disc rides in
const SPARKS = 20;
const SPARK_TTL_MAX = 0.6;
const SPARK_GRAVITY = 14;
const TAU = Math.PI * 2;
// update() runs every frame; spark matrices go through these, never fresh objects
const SP_M = new THREE.Matrix4();
const SP_P = new THREE.Vector3();
const SP_Q = new THREE.Quaternion();
const SP_S = new THREE.Vector3();

export class Blade {
  readonly group = new THREE.Group();
  readonly z: number;
  readonly baseX: number;
  /** Cut length along X (the disc's diameter). */
  readonly width: number;
  /** Share of the overlapped crowd one crossing removes. */
  readonly kill: number;
  /** Current centre, set by track(). */
  x: number;
  /** Set by GameManager once the crossing has resolved. */
  passed = false;

  private readonly motion: MotionDef | undefined;
  private readonly radius: number;
  private saw = new THREE.Group();     // slides along the rail
  private spinner = new THREE.Group(); // spins inside it
  private steelMat: THREE.MeshStandardMaterial;
  private teethMat: THREE.MeshStandardMaterial;
  private railGlowMat: THREE.MeshBasicMaterial;
  private footGlowMat: THREE.MeshBasicMaterial;
  private sparks: THREE.InstancedMesh;
  private sparkPos = new Float32Array(SPARKS * 3);
  private sparkVel = new Float32Array(SPARKS * 3);
  private sparkLife = new Float32Array(SPARKS);
  private sparkCursor = 0;
  private sparkTimer = 0; // > 0 while any spark may still be in flight
  private glow = 0;       // eased 0..1 danger
  private flash = 0;      // cut flash, decays
  private pulsePhase = 0; // integrated, not time * rate: the rate climbs with the danger

  constructor(seg: Segment, cfg: GameConfig) {
    this.z = seg.z;
    this.baseX = seg.x ?? 0;
    this.x = this.baseX;
    this.width = seg.width ?? 1.6;
    this.kill = seg.kill ?? 0.5;
    this.motion = seg.motion;
    const r = this.width / 2;
    this.radius = r;

    // ---- rail: every X the cut can reach, clamped to the track ----
    const { minX, maxX } = cfg.track;
    const amp = Math.abs(this.motion?.amp ?? 0);
    const lo = clamp(this.baseX - amp - r, minX, maxX);
    const hi = clamp(this.baseX + amp + r, minX, maxX);
    const railLen = Math.max(0.3, hi - lo);
    const railX = (lo + hi) / 2;
    const railMat = new THREE.MeshStandardMaterial({ color: 0x1c2230, metalness: 0.6, roughness: 0.5 });
    const barGeo = new THREE.BoxGeometry(railLen, 0.1, 0.12);
    for (const dz of [-RAIL_SLOT, RAIL_SLOT]) {
      const bar = new THREE.Mesh(barGeo, railMat);
      bar.position.set(railX, 0.05, this.z + dz);
      bar.receiveShadow = true;
      this.group.add(bar);
    }
    // end stops mark where the sweep turns around
    const stopGeo = new THREE.BoxGeometry(0.16, 0.3, RAIL_SLOT * 2 + 0.24);
    for (const ex of [railX - railLen / 2, railX + railLen / 2]) {
      const stop = new THREE.Mesh(stopGeo, railMat);
      stop.position.set(ex, 0.15, this.z);
      stop.castShadow = true;
      this.group.add(stop);
    }
    // the whole sweep zone warms up red as the crowd closes
    this.railGlowMat = new THREE.MeshBasicMaterial({
      color: TOOTH_RED, transparent: true, opacity: 0, depthWrite: false,
    });
    const railGlow = new THREE.Mesh(new THREE.PlaneGeometry(railLen, 1.1), this.railGlowMat);
    railGlow.rotation.x = -Math.PI / 2;
    railGlow.position.set(railX, 0.015, this.z);
    this.group.add(railGlow);

    // ---- saw: carriage on the rail, disc sunk partly into the slot ----
    this.saw.position.set(this.baseX, 0, this.z);
    this.group.add(this.saw);
    // the exact footprint the cut covers right now, brighter than the rail zone
    this.footGlowMat = new THREE.MeshBasicMaterial({
      color: TOOTH_RED, transparent: true, opacity: 0, depthWrite: false,
    });
    const footGlow = new THREE.Mesh(new THREE.PlaneGeometry(this.width, 1.6), this.footGlowMat);
    footGlow.rotation.x = -Math.PI / 2;
    footGlow.position.y = 0.02;
    this.saw.add(footGlow);

    // the hub sits a little above half height: most of the disc shows, the rest reads as sunk in the slot
    this.spinner.position.y = r * 0.55 + 0.08;
    this.saw.add(this.spinner);
    this.teethMat = new THREE.MeshStandardMaterial({
      color: TOOTH_RED, emissive: TOOTH_RED, emissiveIntensity: 0.35, metalness: 0.3, roughness: 0.45,
    });
    const teeth = new THREE.Mesh(sawGeometry(r), this.teethMat);
    teeth.castShadow = true;
    this.spinner.add(teeth);
    this.steelMat = new THREE.MeshStandardMaterial({ color: STEEL, metalness: 0.75, roughness: 0.35 });
    const steel = new THREE.Mesh(faceDisc(r * 0.78, 0.14, 40), this.steelMat);
    steel.castShadow = true;
    this.spinner.add(steel);
    // a light cross on the face: a bare disc spinning reads as standing still
    const trimMat = new THREE.MeshStandardMaterial({ color: 0x9aa3b5, metalness: 0.8, roughness: 0.3 });
    const spokeGeo = new THREE.BoxGeometry(r * 1.36, Math.max(0.08, r * 0.12), 0.17);
    for (const a of [0, Math.PI / 2]) {
      const spoke = new THREE.Mesh(spokeGeo, trimMat);
      spoke.rotation.z = a;
      this.spinner.add(spoke);
    }
    this.spinner.add(new THREE.Mesh(faceDisc(r * 0.2, 0.22, 16), trimMat));

    // ---- cut sparks: a tiny private pool, parked at scale 0 until flashHit ----
    this.sparks = new THREE.InstancedMesh(
      new THREE.BoxGeometry(0.1, 0.1, 0.1), new THREE.MeshBasicMaterial({ color: SPARK_COLOR }), SPARKS,
    );
    this.sparks.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    this.sparks.frustumCulled = false; // instances live in world space, far from the mesh origin
    SP_M.makeScale(0, 0, 0);
    for (let i = 0; i < SPARKS; i++) this.sparks.setMatrixAt(i, SP_M);
    this.sparks.instanceMatrix.needsUpdate = true;
    this.sparks.visible = false;
    this.group.add(this.sparks);
  }

  /** Slides the saw to where its sweep puts it at run time `t`; the rail stays put. */
  track(t: number): void {
    if (!this.motion) return;
    this.x = motionX(this.baseX, this.motion, t);
    this.saw.position.x = this.x;
  }

  update(dt: number, _time: number, _cam: THREE.Camera, crowdZ: number): void {
    const d = this.z - crowdZ;
    const target = this.passed || d < 0 ? 0 : clamp(1 - d / DANGER_RANGE, 0, 1);
    this.glow += (target - this.glow) * Math.min(1, dt * 8);
    this.flash = Math.max(0, this.flash - dt * 3);
    const g = this.glow;
    const f = this.flash;
    // the closer the crowd, the faster the saw spins and the harder it pulses
    this.pulsePhase = (this.pulsePhase + dt * (6 + 10 * g)) % TAU;
    const pulse = 0.5 + 0.5 * Math.sin(this.pulsePhase);
    this.spinner.rotation.z = (this.spinner.rotation.z + dt * (SPIN_IDLE + SPIN_DANGER * g)) % TAU;
    this.spinner.scale.setScalar(1 + 0.1 * f);
    this.teethMat.emissiveIntensity = 0.35 + g * (0.9 + 0.6 * pulse) + f * 2;
    this.steelMat.emissive.setRGB(f * 0.8, f * 0.5, f * 0.3); // the steel flares hot on a cut
    this.railGlowMat.opacity = g * (0.1 + 0.1 * pulse);
    this.footGlowMat.opacity = g * (0.3 + 0.25 * pulse) + f * 0.5;
    if (this.sparkTimer > 0) this.updateSparks(dt);
  }

  /** The crossing cut `lost` units: flash the disc and spray sparks off the cutting edge. */
  flashHit(lost: number): void {
    this.flash = 1;
    const n = Math.min(SPARKS, 6 + Math.max(0, Math.ceil(lost)));
    const r = this.radius;
    for (let k = 0; k < n; k++) {
      const i = this.sparkCursor;
      this.sparkCursor = (i + 1) % SPARKS;
      const o = i * 3;
      // from where the disc meets the floor, thrown up and back toward the camera
      this.sparkPos[o] = this.x + (Math.random() * 2 - 1) * r * 0.8;
      this.sparkPos[o + 1] = 0.2 + Math.random() * 0.3;
      this.sparkPos[o + 2] = this.z - 0.2;
      this.sparkVel[o] = (Math.random() * 2 - 1) * 2.5;
      this.sparkVel[o + 1] = 2.5 + Math.random() * 3;
      this.sparkVel[o + 2] = -(1.5 + Math.random() * 3);
      this.sparkLife[i] = 0.3 + Math.random() * (SPARK_TTL_MAX - 0.3);
    }
    this.sparkTimer = SPARK_TTL_MAX;
    this.sparks.visible = true;
  }

  private updateSparks(dt: number): void {
    this.sparkTimer -= dt;
    const pos = this.sparkPos, vel = this.sparkVel, life = this.sparkLife;
    for (let i = 0; i < SPARKS; i++) {
      if (life[i] <= 0) continue;
      life[i] -= dt;
      if (life[i] <= 0) {
        SP_M.makeScale(0, 0, 0);
        this.sparks.setMatrixAt(i, SP_M);
        continue;
      }
      const o = i * 3;
      vel[o + 1] -= SPARK_GRAVITY * dt;
      pos[o] += vel[o] * dt;
      pos[o + 1] += vel[o + 1] * dt;
      pos[o + 2] += vel[o + 2] * dt;
      if (pos[o + 1] < 0.05 && vel[o + 1] < 0) {
        pos[o + 1] = 0.05;
        vel[o + 1] *= -0.3;
      }
      const s = Math.min(1, life[i] / 0.25); // shrink out over the last quarter second
      SP_M.compose(SP_P.set(pos[o], pos[o + 1], pos[o + 2]), SP_Q, SP_S.set(s, s, s));
      this.sparks.setMatrixAt(i, SP_M);
    }
    this.sparks.instanceMatrix.needsUpdate = true;
    if (this.sparkTimer <= 0) this.sparks.visible = false;
  }

  dispose(scene: THREE.Scene): void {
    scene.remove(this.group);
    disposeTree(this.group);
    this.sparks.dispose();
  }
}

/** Saw outline (a slow rise to each tip, a sheer drop after it) as a thin plate facing ±Z. */
function sawGeometry(r: number): THREE.ExtrudeGeometry {
  const teeth = Math.round(clamp(r * 16, 10, 28));
  const rIn = r * 0.72;
  const step = TAU / teeth;
  const shape = new THREE.Shape();
  shape.moveTo(rIn, 0);
  for (let i = 0; i < teeth; i++) {
    const a = i * step;
    if (i > 0) shape.lineTo(Math.cos(a) * rIn, Math.sin(a) * rIn);
    const tip = a + step * 0.8;
    shape.lineTo(Math.cos(tip) * r, Math.sin(tip) * r);
  }
  shape.closePath();
  const geo = new THREE.ExtrudeGeometry(shape, { depth: 0.08, bevelEnabled: false });
  geo.translate(0, 0, -0.04);
  return geo;
}

/** A disc whose flat faces look along ±Z, toward the chase camera. */
function faceDisc(radius: number, thickness: number, segments: number): THREE.CylinderGeometry {
  const geo = new THREE.CylinderGeometry(radius, radius, thickness, segments);
  geo.rotateX(Math.PI / 2);
  return geo;
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
