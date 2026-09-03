import * as THREE from 'three';
import type { GameConfig } from '../data/types';

// Static track geometry: ground strip, side rails, and chevron stripes that
// give a sense of forward speed as the camera travels +Z.

export class Track {
  readonly group = new THREE.Group();

  constructor(cfg: GameConfig, length: number) {
    const { minX, maxX } = cfg.track;
    const width = maxX - minX;
    const zStart = -25;
    const zEnd = length + 40;
    const len = zEnd - zStart;
    const midZ = (zStart + zEnd) / 2;

    // ---- ground ----
    const groundTex = makeStripeTexture();
    groundTex.wrapS = groundTex.wrapT = THREE.RepeatWrapping;
    groundTex.repeat.set(2, len / 4);
    const ground = new THREE.Mesh(
      new THREE.PlaneGeometry(width, len),
      new THREE.MeshStandardMaterial({ map: groundTex, color: 0x2a3350, roughness: 1 }),
    );
    ground.rotation.x = -Math.PI / 2;
    ground.position.set((minX + maxX) / 2, 0, midZ);
    ground.receiveShadow = true;
    this.group.add(ground);

    // ---- grass shoulders ----
    const shoulderMat = new THREE.MeshStandardMaterial({ color: 0x1b2740, roughness: 1 });
    for (const side of [-1, 1]) {
      const sh = new THREE.Mesh(new THREE.PlaneGeometry(8, len), shoulderMat);
      sh.rotation.x = -Math.PI / 2;
      sh.position.set((minX + maxX) / 2 + side * (width / 2 + 4), -0.02, midZ);
      sh.receiveShadow = true;
      this.group.add(sh);
    }

    // ---- side rails ----
    const railMat = new THREE.MeshStandardMaterial({ color: 0x3d4a73, roughness: 0.8 });
    for (const x of [minX - 0.15, maxX + 0.15]) {
      const rail = new THREE.Mesh(new THREE.BoxGeometry(0.3, 0.6, len), railMat);
      rail.position.set(x, 0.3, midZ);
      rail.castShadow = true;
      this.group.add(rail);
    }
  }

  dispose(): void {
    this.group.traverse((o) => {
      if (o instanceof THREE.Mesh) {
        o.geometry.dispose();
        const m = o.material as THREE.Material | THREE.Material[];
        for (const mat of Array.isArray(m) ? m : [m]) {
          (mat as THREE.MeshStandardMaterial).map?.dispose(); // the ground stripe CanvasTexture
          mat.dispose();
        }
      }
    });
  }
}

function makeStripeTexture(): THREE.CanvasTexture {
  const c = document.createElement('canvas');
  c.width = c.height = 64;
  const ctx = c.getContext('2d')!;
  ctx.fillStyle = '#2f3a5c';
  ctx.fillRect(0, 0, 64, 64);
  ctx.fillStyle = '#39456a';
  ctx.fillRect(0, 0, 64, 32);
  // center dashed line
  ctx.fillStyle = 'rgba(255,255,255,0.10)';
  ctx.fillRect(30, 8, 4, 48);
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}
