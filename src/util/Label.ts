import * as THREE from 'three';

// A camera-facing plate that renders text/number via a CanvasTexture.
// Used for gate symbols, barricade HP, enemy counts, objective HP, boss name.

// Minimum gap between canvas redraws. Callers push a value every frame; each
// redraw costs a full texture re-upload, so we coalesce to ~12/s per plate.
const REDRAW_MS = 80;

export class NumberPlate {
  readonly mesh: THREE.Mesh;
  private canvas: HTMLCanvasElement;
  private ctx: CanvasRenderingContext2D;
  private texture: THREE.CanvasTexture;
  private last = '';
  private color: string;
  private lastDraw = -Infinity; // performance.now() of the last redraw
  private pending: string | null = null;

  constructor(widthWorld = 1.6, color = '#ffffff') {
    this.color = color;
    this.canvas = document.createElement('canvas');
    this.canvas.width = 256;
    this.canvas.height = 128;
    this.ctx = this.canvas.getContext('2d')!;
    this.texture = new THREE.CanvasTexture(this.canvas);
    this.texture.colorSpace = THREE.SRGBColorSpace;
    this.texture.anisotropy = 4;
    // No mip chain to rebuild on every redraw.
    this.texture.generateMipmaps = false;
    this.texture.minFilter = THREE.LinearFilter;
    const mat = new THREE.MeshBasicMaterial({
      map: this.texture,
      transparent: true,
      depthWrite: false,
    });
    const h = widthWorld * (this.canvas.height / this.canvas.width);
    this.mesh = new THREE.Mesh(new THREE.PlaneGeometry(widthWorld, h), mat);
    this.mesh.renderOrder = 10;
  }

  setColor(color: string): void {
    if (color !== this.color) {
      this.color = color;
      this.last = ''; // force redraw
      this.lastDraw = -Infinity; // ...and let it past the throttle window
    }
  }

  set(text: string): void {
    if (text === this.last) {
      this.pending = null; // display already matches, drop any deferred value
      return;
    }
    const now = performance.now();
    // '0' is terminal (dead entity) — it must never be left stale by the throttle.
    if (text !== '0' && now - this.lastDraw < REDRAW_MS) {
      this.pending = text;
      return;
    }
    this.pending = null;
    this.lastDraw = now;
    this.last = text;
    const c = this.ctx;
    c.clearRect(0, 0, 256, 128);
    c.font = '900 86px system-ui, sans-serif';
    c.textAlign = 'center';
    c.textBaseline = 'middle';
    c.lineWidth = 12;
    c.strokeStyle = 'rgba(0,0,0,0.85)';
    c.strokeText(text, 128, 68);
    c.fillStyle = this.color;
    c.fillText(text, 128, 68);
    this.texture.needsUpdate = true;
  }

  /** Billboard toward the camera (keep upright). */
  faceCamera(cam: THREE.Camera): void {
    this.mesh.quaternion.copy(cam.quaternion);
    // runs every frame, so a value parked by the throttle can never go stale
    if (this.pending !== null && performance.now() - this.lastDraw >= REDRAW_MS) this.set(this.pending);
  }

  dispose(): void {
    this.texture.dispose();
    (this.mesh.material as THREE.Material).dispose();
    this.mesh.geometry.dispose();
  }
}
