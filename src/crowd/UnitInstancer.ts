import * as THREE from 'three';

// Thin wrapper over an InstancedMesh. One non-skinned capsule mesh, drawn once
// for the whole crowd. This is the perf backbone: count is decoupled from
// instances, and we never exceed `capacity` meshes no matter how big the crowd.

const UP = new THREE.Vector3(0, 1, 0);
const Z_AXIS = new THREE.Vector3(0, 0, 1);
// setInstance runs once per visible unit per frame (~12k/s); nothing here allocates.
const LEAN_Q = new THREE.Quaternion();

export class UnitInstancer {
  readonly mesh: THREE.InstancedMesh;
  readonly bodyHeight: number;
  readonly groundY: number;
  private scratch = new THREE.Matrix4();
  private pos = new THREE.Vector3();
  private quat = new THREE.Quaternion();
  private scl = new THREE.Vector3(1, 1, 1);

  constructor(capacity: number, color: number, radius = 0.18, length = 0.26) {
    const geo = new THREE.CapsuleGeometry(radius, length, 3, 7);
    this.bodyHeight = length + radius * 2;
    this.groundY = this.bodyHeight / 2 - radius * 0.2;
    const mat = new THREE.MeshStandardMaterial({
      color,
      roughness: 0.55,
      metalness: 0.0,
      emissive: new THREE.Color(color).multiplyScalar(0.12),
    });
    this.mesh = new THREE.InstancedMesh(geo, mat, capacity);
    this.mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    this.mesh.castShadow = true;
    this.mesh.count = 0;
    this.mesh.frustumCulled = false;
  }

  setVisibleCount(n: number): void {
    this.mesh.count = Math.max(0, Math.min(n, this.mesh.instanceMatrix.count));
  }

  /** Place instance i at world (x,y,z) with a small lean (radians around Z). */
  setInstance(i: number, x: number, y: number, z: number, lean: number, scale = 1): void {
    this.pos.set(x, y, z);
    this.quat.setFromAxisAngle(UP, 0);
    if (lean !== 0) {
      this.quat.multiply(LEAN_Q.setFromAxisAngle(Z_AXIS, lean));
    }
    this.scl.set(scale, scale, scale);
    this.scratch.compose(this.pos, this.quat, this.scl);
    this.mesh.setMatrixAt(i, this.scratch);
  }

  commit(): void {
    this.mesh.instanceMatrix.needsUpdate = true;
  }

  setColor(color: number): void {
    (this.mesh.material as THREE.MeshStandardMaterial).color.set(color);
  }

  dispose(): void {
    this.mesh.geometry.dispose();
    (this.mesh.material as THREE.Material).dispose();
    this.mesh.dispose();
  }
}
