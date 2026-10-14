// ---------------------------------------------------------------------------
// The one place that knows which way world X runs on screen.
//
// Three.js is right-handed and the chase camera looks down +Z, so world +X
// renders on SCREEN-LEFT. Input, gate doors and finish lanes are all authored
// in screen terms ("left door", "lane 1 is leftmost") and go through here.
// A left-handed engine (Unity: camera looking +Z has +X on screen-right) sets
// WORLD_X_SIGN to +1 and everything downstream stays the same.
// ---------------------------------------------------------------------------

export const WORLD_X_SIGN: 1 | -1 = -1;

/**
 * Screen fraction across the track → world X. `t01`: 0 = screen-left edge,
 * 1 = screen-right edge. Not clamped; callers that take raw input clamp first.
 * With WORLD_X_SIGN = -1 this equals lerp(minX, maxX, 1 - t01).
 */
export function screenToWorldX(t01: number, minX: number, maxX: number): number {
  return (minX + maxX) / 2 + WORLD_X_SIGN * (t01 - 0.5) * (maxX - minX);
}
