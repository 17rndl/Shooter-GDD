// Small math helpers used across systems.

export const GOLDEN_ANGLE = 2.39996322972865332; // radians

export function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}

export function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}

/**
 * Frame-rate independent exponential smoothing ("critically-damped"ish).
 * `smoothing` is roughly "how fast" — higher snaps quicker.
 */
export function damp(current: number, target: number, smoothing: number, dt: number): number {
  const t = 1 - Math.exp(-smoothing * dt);
  return current + (target - current) * t;
}

export interface Vec2 {
  x: number;
  z: number;
}

/**
 * Phyllotaxis (sunflower) layout: returns the local offset of the i-th unit
 * around the centroid. Radius grows with sqrt(i) so a big crowd reads as big
 * without exploding in footprint.
 */
export function phyllotaxis(i: number, spacing: number, out: Vec2): Vec2 {
  const r = spacing * Math.sqrt(i);
  const theta = i * GOLDEN_ANGLE;
  out.x = r * Math.cos(theta);
  out.z = r * Math.sin(theta) * 0.6; // squash forward/back spread a touch
  return out;
}

/** Do two centered spans [aC ± aH] and [bC ± bH] overlap on one axis? */
export function spansOverlap(aC: number, aH: number, bC: number, bH: number): boolean {
  return Math.abs(aC - bC) <= aH + bH;
}

export function randRange(a: number, b: number): number {
  return a + Math.random() * (b - a);
}
