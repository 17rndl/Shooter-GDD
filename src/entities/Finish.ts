import * as THREE from 'three';
import { NumberPlate } from '../util/Label';
import { lerp } from '../util/MathUtil';
import type { GameConfig, Segment } from '../data/types';

// Finish line preceded by a bank of coin-multiplier lanes (×2 / ×3 / ×5).
// Run the crowd through one to multiply the end-of-level payout.

export class Finish {
  readonly group = new THREE.Group();
  readonly z: number;
  readonly laneZ: number;
  readonly lanes: number[];
  picked = false;
  pickedMultiplier = 1;

  private cols: {
    centerX: number; mult: number; plate: NumberPlate; panel: THREE.Mesh;
    preview: NumberPlate; shattered: boolean;
  }[] = [];

  constructor(seg: Segment, cfg: GameConfig) {
    this.z = seg.z;
    this.laneZ = seg.z - 6;
    this.lanes = seg.multiplierLanes ?? [2, 3, 5];
    const { minX, maxX } = cfg.track;
    const n = this.lanes.length;

    for (let i = 0; i < n; i++) {
      const t0 = i / n, t1 = (i + 1) / n;
      // reversed so authored lane order reads left→right on the (mirrored) screen
      const centerX = lerp(maxX, minX, (t0 + t1) / 2);
      const width = (maxX - minX) / n;
      const mult = this.lanes[i];
      const hue = 0.13 - i * 0.02;
      const color = new THREE.Color().setHSL(hue, 0.9, 0.55).getHex();

      const panelMat = new THREE.MeshStandardMaterial({
        color, transparent: true, opacity: 0.3, emissive: color, emissiveIntensity: 0.5,
        side: THREE.DoubleSide, depthWrite: false,
      });
      const panel = new THREE.Mesh(new THREE.BoxGeometry(width - 0.08, 2.2, 0.08), panelMat);
      panel.position.set(centerX, 1.1, this.laneZ);
      this.group.add(panel);

      const plate = new NumberPlate(1.3, '#fff0b3');
      plate.mesh.position.set(centerX, 1.5, this.laneZ + 0.05);
      plate.set(`×${mult}`);
      this.group.add(plate.mesh);

      // coin payout this lane is worth right now; blank until setLanePreview runs
      const preview = new NumberPlate(1.0, '#ffd24a');
      preview.mesh.position.set(centerX, 0.85, this.laneZ + 0.05);
      preview.mesh.visible = false;
      this.group.add(preview.mesh);

      this.cols.push({ centerX, mult, plate, panel, preview, shattered: false });
    }

    // finish banner arch
    const archMat = new THREE.MeshStandardMaterial({ color: 0xffd24a, emissive: 0x5a4708, roughness: 0.5 });
    const span = maxX - minX + 1;
    const bar = new THREE.Mesh(new THREE.BoxGeometry(span, 0.35, 0.35), archMat);
    bar.position.set((minX + maxX) / 2, 2.6, this.z);
    this.group.add(bar);
    for (const px of [minX - 0.4, maxX + 0.4]) {
      const post = new THREE.Mesh(new THREE.BoxGeometry(0.35, 2.8, 0.35), archMat);
      post.position.set(px, 1.4, this.z);
      this.group.add(post);
    }
    // checkered line
    const line = new THREE.Mesh(
      new THREE.PlaneGeometry(span, 1.2),
      new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 1 }),
    );
    line.rotation.x = -Math.PI / 2;
    line.position.set((minX + maxX) / 2, 0.02, this.z);
    this.group.add(line);
  }

  /**
   * Coin value each lane pays right now, in authored lane order. The plates stay
   * hidden until the first call; lanes already shattered by pickFor stay hidden.
   */
  setLanePreview(values: number[]): void {
    const n = Math.min(values.length, this.cols.length);
    for (let i = 0; i < n; i++) {
      const c = this.cols[i];
      if (c.shattered) continue;
      c.preview.set(String(Math.max(0, Math.round(values[i] || 0))));
      c.preview.mesh.visible = true;
    }
  }

  pickFor(centroidX: number): number {
    if (this.picked) return this.pickedMultiplier;
    this.picked = true;
    // an authored empty multiplierLanes array would otherwise pay out NaN coins
    if (this.cols.length === 0) {
      this.pickedMultiplier = 1;
      return 1;
    }
    let best = Infinity, chosen = this.cols[0];
    for (const c of this.cols) {
      const d = Math.abs(centroidX - c.centerX);
      if (d < best) { best = d; chosen = c; }
    }
    // shatter the unchosen — by identity, since two lanes may share a value
    for (const c of this.cols) {
      if (c !== chosen) {
        (c.panel.material as THREE.MeshStandardMaterial).opacity = 0.05;
        c.plate.mesh.visible = false;
        c.preview.mesh.visible = false;
        c.shattered = true;
      }
    }
    this.pickedMultiplier = chosen.mult;
    return chosen.mult;
  }

  update(_dt: number, cam: THREE.Camera): void {
    for (const c of this.cols) { c.plate.faceCamera(cam); c.preview.faceCamera(cam); }
  }

  dispose(scene: THREE.Scene): void {
    scene.remove(this.group);
    for (const c of this.cols) { c.plate.dispose(); c.preview.dispose(); }
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
