import * as THREE from 'three';
import { NumberPlate } from '../util/Label';
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
  private halves: Half[] = [];
  private tickable: boolean;
  private tickPerHit: number;
  private tickAccum = 0;

  constructor(seg: Segment, cfg: GameConfig) {
    this.z = seg.z;
    this.tickable = !!seg.tickable;
    this.tickPerHit = seg.tickPerHit ?? 1;
    const { minX, maxX } = cfg.track;
    const mid = (minX + maxX) / 2;
    const halfW = (maxX - minX) / 4; // each door spans half the track

    // Camera mirrors world X on screen, so author "left" at world +X (screen-left)
    // and "right" at world -X (screen-right) to keep JSON intuitive.
    if (seg.left) this.halves.push(this.makeHalf(seg.left, (mid + maxX) / 2, halfW));
    if (seg.right) this.halves.push(this.makeHalf(seg.right, (minX + mid) / 2, halfW));
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

  /** Called each tick while the crowd is in range (only matters if tickable). */
  tick(dt: number): void {
    if (!this.tickable || this.passed) return;
    this.tickAccum += dt;
    while (this.tickAccum >= 0.16) {
      this.tickAccum -= 0.16;
      for (const h of this.halves) {
        if (h.side.op === 'add') h.side.value = Math.min(99, h.side.value + this.tickPerHit);
        else if (h.side.op === 'mul') h.side.value = Math.min(6, h.side.value + this.tickPerHit);
        // sub/div decay toward harmless, but never past 1: ÷0 is a no-op, ÷1 is the real floor
        else h.side.value = Math.max(1, h.side.value - this.tickPerHit);
        this.refreshPlate(h);
      }
    }
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
