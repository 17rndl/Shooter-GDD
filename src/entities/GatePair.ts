import * as THREE from 'three';
import { NumberPlate } from '../util/Label';
import { screenToWorldX } from '../core/WorldSpace';
import type { GameConfig, GateOp, GateSide, Segment } from '../data/types';

const OP_COLOR: Record<GateOp, number> = {
  add: 0x5ce06a,
  mul: 0x4ea3ff,
  sub: 0xff5a52,
  div: 0xff5a52,
};
const OP_HEX: Record<GateOp, string> = {
  add: '#5ce06a',
  mul: '#4ea3ff',
  sub: '#ff5a52',
  div: '#ff5a52',
};
const OP_SYMBOL: Record<GateOp, string> = { add: '+', mul: '×', sub: '−', div: '÷' };

interface Half {
  side: GateSide;
  group: THREE.Group;
  plate: NumberPlate;
  panelMat: THREE.MeshStandardMaterial;
  centerX: number;
  halfWidth: number;
  shatter: number; // -1 idle, >=0 animating
}

export interface GateResult {
  op: GateOp;
  before: number;
  after: number;
  color: string;
}

export class GatePair {
  readonly group = new THREE.Group();
  readonly z: number;
  passed = false;
  readonly tickable: boolean;
  private halves: Half[] = [];
  private tickPerHit: number;
  private accum: number[] = [];
  private readonly cfg: GameConfig;

  constructor(seg: Segment, cfg: GameConfig) {
    this.cfg = cfg;
    this.z = seg.z;
    this.tickable = !!seg.tickable;
    this.tickPerHit = seg.tickPerHit ?? 1;
    const { minX, maxX } = cfg.track;
    const halfW = (maxX - minX) / 4; // each door spans half the track

    // JSON "left"/"right" are SCREEN sides: door centres sit at the quarter
    // points of the screen, and screenToWorldX handles the camera's X mirror.
    if (seg.left) this.halves.push(this.makeHalf(seg.left, screenToWorldX(0.25, minX, maxX), halfW));
    if (seg.right) this.halves.push(this.makeHalf(seg.right, screenToWorldX(0.75, minX, maxX), halfW));
    this.accum = this.halves.map(() => 0);
  }

  private makeHalf(side: GateSide, centerX: number, halfWidth: number): Half {
    const g = new THREE.Group();
    const color = OP_COLOR[side.op];
    const h = 2.2;
    const width = halfWidth * 2;

    // translucent door panel
    const panelMat = new THREE.MeshStandardMaterial({
      color,
      transparent: true,
      opacity: 0.32,
      emissive: color,
      emissiveIntensity: 0.5,
      side: THREE.DoubleSide,
      depthWrite: false,
    });
    const panel = new THREE.Mesh(new THREE.BoxGeometry(width - 0.1, h, 0.08), panelMat);
    panel.position.set(centerX, h / 2, this.z);
    g.add(panel);

    // frame: posts + top bar
    const frameMat = new THREE.MeshStandardMaterial({ color, emissive: color, emissiveIntensity: 0.6, roughness: 0.4 });
    for (const px of [centerX - width / 2 + 0.05, centerX + width / 2 - 0.05]) {
      const post = new THREE.Mesh(new THREE.BoxGeometry(0.1, h, 0.18), frameMat);
      post.position.set(px, h / 2, this.z);
      g.add(post);
    }
    const top = new THREE.Mesh(new THREE.BoxGeometry(width, 0.16, 0.18), frameMat);
    top.position.set(centerX, h, this.z);
    g.add(top);

    const plate = new NumberPlate(1.6, OP_HEX[side.op]);
    plate.mesh.position.set(centerX, h * 0.62, this.z + 0.05);
    g.add(plate.mesh);

    const half: Half = { side: { ...side }, group: g, plate, panelMat, centerX, halfWidth, shatter: -1 };
    this.refreshPlate(half);
    this.group.add(g);
    return half;
  }

  private refreshPlate(h: Half): void {
    h.plate.set(`${OP_SYMBOL[h.side.op]}${h.side.value}`);
  }

  get halfCount(): number {
    return this.halves.length;
  }

  /** Where half `i` sits, so the shooter can aim at one door instead of the pair. */
  halfTarget(i: number): { x: number; halfWidth: number } {
    const h = this.halves[i];
    return { x: h.centerX, halfWidth: h.halfWidth };
  }

  /** Index of the half nearest `centerX` among those the firing lane overlaps, else -1. */
  overlappingHalf(centerX: number, laneHalf: number): number {
    let best = -1;
    let bestD = Infinity;
    for (let i = 0; i < this.halves.length; i++) {
      const h = this.halves[i];
      const d = Math.abs(centerX - h.centerX);
      if (d > laneHalf + h.halfWidth || d >= bestD) continue;
      bestD = d;
      best = i;
    }
    return best;
  }

  /** Bullets landing on one door only: every damagePerTick nudges that half's value. */
  hit(i: number, damage: number): void {
    if (!this.tickable || this.passed) return;
    const h = this.halves[i];
    if (!h) return;
    const g = this.cfg.gates;
    const per = g.damagePerTick;
    if (per <= 0) return; // a free tick would spin the loop below forever
    this.accum[i] += damage;
    let ticked = false;
    while (this.accum[i] >= per) {
      this.accum[i] -= per;
      if (h.side.op === 'add') h.side.value = Math.min(g.addCap, h.side.value + this.tickPerHit);
      else if (h.side.op === 'mul') h.side.value = Math.min(g.mulCap, h.side.value + this.tickPerHit);
      // sub/div decay toward harmless, but never past the floor: ÷0 is a no-op, ÷1 is the real floor
      else h.side.value = Math.max(g.decayFloor, h.side.value - this.tickPerHit);
      ticked = true;
    }
    if (ticked) this.refreshPlate(h);
  }

  /** Apply the side the centroid sits on; shatter the other. Returns the math result. */
  applyFor(centroidX: number, count: number): GateResult | null {
    if (this.passed) return null;
    // an authored gate with neither side still has to latch, or it re-runs every frame
    if (this.halves.length === 0) { this.passed = true; return null; }
    this.passed = true;

    // choose nearest half to the centroid
    let chosen = this.halves[0];
    let best = Infinity;
    for (const h of this.halves) {
      const d = Math.abs(centroidX - h.centerX);
      if (d < best) { best = d; chosen = h; }
    }
    for (const h of this.halves) if (h !== chosen) h.shatter = 0;

    const before = count;
    const v = chosen.side.value;
    let after = count;
    switch (chosen.side.op) {
      case 'add': after = count + v; break;
      case 'mul': after = Math.round(count * v); break;
      case 'sub': after = count - v; break;
      case 'div': after = v > 0 ? Math.floor(count / v) : count; break;
    }
    after = Math.max(0, after);
    return { op: chosen.side.op, before, after, color: OP_HEX[chosen.side.op] };
  }

  update(dt: number, cam: THREE.Camera): void {
    for (const h of this.halves) {
      h.plate.faceCamera(cam);
      if (h.shatter >= 0) {
        h.shatter += dt;
        const k = Math.max(0, 1 - h.shatter * 3);
        h.group.scale.set(1, k, 1);
        h.panelMat.opacity = 0.32 * k;
        if (k <= 0) h.group.visible = false;
      }
    }
  }

  dispose(scene: THREE.Scene): void {
    scene.remove(this.group);
    for (const h of this.halves) h.plate.dispose();
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
