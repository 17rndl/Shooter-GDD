// ---------------------------------------------------------------------------
// Lateral motion for track props (barricades, enemy squads, pickups, blades).
// Pure and import-free so Node can load this file as-is: the balance sim and
// the game must agree to the bit on where a moving prop stands at run time t.
// ---------------------------------------------------------------------------

/** A sine sweep across the track: `amp` world units either side of the authored x, one cycle per `period` s. */
export interface MotionDef {
  amp: number;
  period: number;
  /** Cycle offset in turns, so neighbouring props can sweep out of step. */
  phase?: number;
}

/**
 * World X of a prop authored at `baseX`, `t` seconds of run clock into the
 * level. Without motion (or with amp 0) the prop simply stays at `baseX`.
 */
export function motionX(baseX: number, m: MotionDef | undefined, t: number): number {
  if (!m || m.amp === 0) return baseX;
  return baseX + m.amp * Math.sin(2 * Math.PI * (t / m.period + (m.phase ?? 0)));
}
