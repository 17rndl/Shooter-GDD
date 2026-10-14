import * as THREE from 'three';
import type { GraphicsMode } from '../data/types';
import { TIERS, autoStep, initialAutoState } from './QualityPolicy';
import type { AutoState, QualityTier } from './QualityPolicy';

// Material programs bake the shadow-map define in, so toggling shadows needs a
// recompile. Module-level so the traversal allocates no closure.
function markMaterials(o: THREE.Object3D): void {
  const m = (o as Partial<THREE.Mesh>).material;
  if (!m) return;
  if (Array.isArray(m)) {
    for (let i = 0; i < m.length; i++) m[i].needsUpdate = true;
  } else {
    m.needsUpdate = true;
  }
}

/**
 * Pushes a QualityPolicy tier into the renderer: pixel-ratio cap and shadows.
 * The renderer starts as GameManager built it, which is exactly the high tier.
 */
export class QualityManager {
  private current: QualityTier = 'high';
  private graphics: GraphicsMode = 'auto';
  private auto: AutoState = initialAutoState('high');
  // what the renderer has now, so a tier change only touches shadows when they differ
  private shadows: boolean;
  private mapSize: number;

  constructor(
    private renderer: THREE.WebGLRenderer,
    private sun: THREE.DirectionalLight,
    private scene: THREE.Scene,
    private onResize: () => void,
  ) {
    this.shadows = renderer.shadowMap.enabled && sun.castShadow;
    this.mapSize = sun.shadow.mapSize.x;
  }

  get tier(): QualityTier {
    return this.current;
  }

  get mode(): GraphicsMode {
    return this.graphics;
  }

  /** high / low pin that tier; auto starts at `autoStartTier` and adapts from there. */
  setMode(mode: GraphicsMode, autoStartTier: QualityTier = 'high'): void {
    this.graphics = mode;
    const tier = mode === 'auto' ? autoStartTier : mode;
    if (mode === 'auto') this.auto = initialAutoState(tier);
    this.apply(tier, false);
  }

  /** Once per frame of live play, with the real (unscaled) frame time. */
  sample(dtReal: number): void {
    if (this.graphics !== 'auto') return;
    const next = autoStep(this.auto, dtReal);
    if (next !== null) this.apply(next, false);
  }

  /** Re-push the current tier, e.g. after a WebGL context restore. */
  reapply(): void {
    this.apply(this.current, true);
  }

  private apply(tier: QualityTier, force: boolean): void {
    this.current = tier;
    const t = TIERS[tier];
    this.renderer.setPixelRatio(Math.min(t.pixelRatioCap, window.devicePixelRatio || 1));
    this.onResize();

    const sun = this.sun;
    const toggle = force || t.shadows !== this.shadows;
    const resize = force || t.shadowMapSize !== this.mapSize;
    if (!toggle && !resize) return;
    this.shadows = t.shadows;
    this.mapSize = t.shadowMapSize;
    this.renderer.shadowMap.enabled = t.shadows;
    sun.castShadow = t.shadows;
    sun.shadow.mapSize.set(t.shadowMapSize, t.shadowMapSize);
    // the renderer only (re)allocates a missing map; switching off frees the GPU memory
    if (sun.shadow.map) {
      sun.shadow.map.dispose();
      sun.shadow.map = null;
    }
    if (toggle) this.scene.traverse(markMaterials);
  }
}
