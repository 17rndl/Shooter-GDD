import * as THREE from 'three';
import { UnitInstancer } from '../crowd/UnitInstancer';
import { NumberPlate } from '../util/Label';
import { phyllotaxis, type Vec2 } from '../util/MathUtil';
import type { GameConfig, Segment } from '../data/types';

// A free reward lying on the lane: a coin trail for the meta economy, or a small
// squad that folds straight into the crowd. Never a combat target — driving over
// it is the only interaction, so it carries no HP and never soaks fire.

const COIN_GOLD = 0xffc32b;
const CROWD_BLUE = 0x4ea3ff;
const COIN_COUNT = 5;
const CROWD_COUNT = 5;
const COIN_Y = 0.55;
const COLLECT_TIME = 0.25;

export class Pickup {
  readonly group = new THREE.Group();
  readonly kind: 'coin' | 'crowd';
  readonly x: number;
  readonly z: number;
  readonly value: number;
  readonly halfWidth: number;
  collected = false;

  private plate: NumberPlate;
  private coins: THREE.Mesh[] = [];
  private instancer: UnitInstancer | null = null;
  private phase = new Float32Array(Math.max(COIN_COUNT, CROWD_COUNT));
  private fadeMats: THREE.Material[] = [];
  private scratch: Vec2 = { x: 0, z: 0 };
  private collecting = -1;
  private readonly spacing: number;

  constructor(seg: Segment, cfg: GameConfig) {
    this.kind = seg.type === 'crowd_pickup' ? 'crowd' : 'coin';
    this.x = seg.x ?? 0;
    this.z = seg.z;
    this.value = seg.value ?? 10;
    this.halfWidth = cfg.pickup.halfWidth;
    this.spacing = cfg.crowd.formationSpacing;
    // Children live in LOCAL space (unlike the combat props) so the collect pop can
    // scale the whole prop about its own centre. The scale stays uniform and the
    // group unrotated, which is what keeps the plate's billboard quaternion valid.
    this.group.position.set(this.x, 0, this.z);
    for (let i = 0; i < this.phase.length; i++) this.phase[i] = Math.random() * Math.PI * 2;

    if (this.kind === 'crowd') {
      this.instancer = new UnitInstancer(CROWD_COUNT, CROWD_BLUE, cfg.crowd.unitRadius);
      const mat = this.instancer.mesh.material as THREE.MeshStandardMaterial;
      mat.transparent = true; // armed at build time: flipping it mid-fade recompiles the shader
      this.instancer.setVisibleCount(CROWD_COUNT);
      this.group.add(this.instancer.mesh);
      this.fadeMats.push(mat);
      // Instance matrices start as identity, so lay the squad out now: the pickup
      // may be rendered before its first update and would flash as a stack.
      this.layoutUnits(0);
      this.plate = new NumberPlate(1.2, '#5ce06a');
    } else {
      const mat = new THREE.MeshStandardMaterial({
        color: COIN_GOLD, emissive: 0x6b4a00, roughness: 0.3, metalness: 0.6, transparent: true,
      });
      const geo = new THREE.CylinderGeometry(0.28, 0.28, 0.06, 16);
      for (let i = 0; i < COIN_COUNT; i++) {
        const coin = new THREE.Mesh(geo, mat);
        // z tips the disc onto its edge; with the default XYZ Euler order the y term
        // is then applied outermost, so the animated spin runs about world Y.
        coin.rotation.z = Math.PI / 2;
        coin.position.set(0, COIN_Y, (i - (COIN_COUNT - 1) / 2) * 0.5);
        coin.castShadow = true;
        this.coins.push(coin);
        this.group.add(coin);
      }
      this.fadeMats.push(mat);
      this.plate = new NumberPlate(1.2, '#ffd24a');
    }

    this.plate.mesh.position.set(0, 1.25, 0);
    this.plate.set(`+${this.value}`);
    this.group.add(this.plate.mesh);
    this.fadeMats.push(this.plate.mesh.material as THREE.Material);
  }

  /** Phyllotaxis squad layout with a gentle bob, in the group's local space. */
  private layoutUnits(time: number): void {
    const inst = this.instancer;
    if (!inst) return;
    for (let i = 0; i < CROWD_COUNT; i++) {
      phyllotaxis(i, this.spacing, this.scratch);
      const bob = Math.sin(time * 6 + this.phase[i]) * 0.05;
      inst.setInstance(i, this.scratch.x, inst.groundY + bob, this.scratch.z, 0);
    }
    inst.commit();
  }

  /** Consume the pickup. The caller banks `value`; this only plays the pop. */
  collect(): void {
    if (this.collected) return;
    this.collected = true;
    this.collecting = 0;
  }

  update(dt: number, time: number, cam: THREE.Camera): void {
    this.plate.faceCamera(cam);
    if (this.collecting >= 0) {
      this.collecting += dt;
      const k = Math.min(1, this.collecting / COLLECT_TIME);
      this.group.scale.setScalar(1 + 0.6 * k);
      const o = 1 - k;
      for (const m of this.fadeMats) m.opacity = o;
      if (k >= 1) this.group.visible = false;
      return;
    }
    if (this.instancer) {
      this.layoutUnits(time);
      return;
    }
    for (let i = 0; i < this.coins.length; i++) {
      const c = this.coins[i];
      c.rotation.y = time * 2.6 + this.phase[i];
      c.position.y = COIN_Y + Math.sin(time * 3 + this.phase[i]) * 0.06;
    }
  }

  dispose(scene: THREE.Scene): void {
    scene.remove(this.group);
    this.plate.dispose();
    this.instancer?.dispose();
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
