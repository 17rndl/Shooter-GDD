// ---------------------------------------------------------------------------
// Render quality tiers and the auto-adapt rule, kept pure so Node can test it.
// QualityManager owns the renderer side; this only decides WHEN to change.
//
// The rule is deliberately sticky: a slow phone drops fast (one 3 s window),
// but climbing back needs a long fast streak well clear of the last drop, so
// a device hovering at the edge does not flap between tiers.
// ---------------------------------------------------------------------------

export type QualityTier = 'high' | 'medium' | 'low';

export interface TierSettings {
  /** Upper bound on renderer.setPixelRatio (the device ratio is used when lower). */
  pixelRatioCap: number;
  shadows: boolean;
  shadowMapSize: number;
}

export const TIERS: Record<QualityTier, TierSettings> = {
  high: { pixelRatioCap: 2, shadows: true, shadowMapSize: 1024 },
  medium: { pixelRatioCap: 1.5, shadows: true, shadowMapSize: 512 },
  low: { pixelRatioCap: 1, shadows: false, shadowMapSize: 512 },
};

export interface AutoState {
  tier: QualityTier;
  /** Seconds of accepted samples since init (drives the warm-up). */
  elapsed: number;
  windowTime: number;
  windowFrames: number;
  /** Seconds of consecutive fast windows. */
  fastTime: number;
  /** Seconds since the last step down (or since init). */
  sinceDown: number;
}

const MAX_SAMPLE_DT = 0.25; // longer frames are tab switches / GC hitches, not the device's pace
const WARMUP_SEC = 2; // shader compiles and asset uploads make the first frames unrepresentative
const WINDOW_SEC = 3;
const SLOW_FRAME = 1 / 45;
const FAST_FRAME = 1 / 57;
const FAST_HOLD_SEC = 10;
const UP_GUARD_SEC = 20;

const LOWER: Record<QualityTier, QualityTier> = { high: 'medium', medium: 'low', low: 'low' };
const HIGHER: Record<QualityTier, QualityTier> = { high: 'high', medium: 'high', low: 'medium' };

/**
 * sinceDown starts at 0: the starting tier counts as a fresh decision, so auto
 * never climbs within UP_GUARD_SEC of being (re)started.
 */
export function initialAutoState(tier: QualityTier): AutoState {
  return { tier, elapsed: 0, windowTime: 0, windowFrames: 0, fastTime: 0, sinceDown: 0 };
}

/**
 * Feed one real (unscaled) frame time. Mutates `s` in place and returns the new
 * tier when it changes, else null. Allocation-free; decisions happen only when
 * a WINDOW_SEC window closes, so there is at most one change per window.
 */
export function autoStep(s: AutoState, dtReal: number): QualityTier | null {
  // also rejects NaN
  if (!(dtReal > 0 && dtReal <= MAX_SAMPLE_DT)) return null;
  s.elapsed += dtReal;
  s.sinceDown += dtReal;
  if (s.elapsed <= WARMUP_SEC) return null;

  s.windowTime += dtReal;
  s.windowFrames += 1;
  if (s.windowTime < WINDOW_SEC) return null;

  const span = s.windowTime;
  const avg = span / s.windowFrames;
  s.windowTime = 0;
  s.windowFrames = 0;

  if (avg > SLOW_FRAME) {
    s.fastTime = 0;
    const next = LOWER[s.tier];
    if (next === s.tier) return null;
    s.tier = next;
    s.sinceDown = 0;
    return next;
  }

  if (avg >= FAST_FRAME) {
    // smooth enough to stay, not enough headroom to climb: the streak starts over
    s.fastTime = 0;
    return null;
  }

  s.fastTime += span;
  if (s.fastTime < FAST_HOLD_SEC || s.sinceDown < UP_GUARD_SEC) return null;
  s.fastTime = 0;
  const next = HIGHER[s.tier];
  if (next === s.tier) return null;
  s.tier = next;
  return next;
}
