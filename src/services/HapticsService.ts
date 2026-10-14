// Haptics behind an interface so a native port can bind Core Haptics / Android
// VibrationEffect without touching game code. The web build uses
// navigator.vibrate (Android Chrome); iOS Safari has none, so `supported` is false.
// The native shell's service lives in src/platform/NativeHaptics.ts and shares
// HapticThrottle, so both builds drop exactly the same pulses.
// No runtime imports and no DOM at load: Node unit-tests this file directly.

export type HapticKind = 'light' | 'medium' | 'heavy' | 'warn' | 'success' | 'fail';

export interface IHapticsService {
  enabled: boolean;
  readonly supported: boolean;
  pulse(kind: HapticKind): void;
}

// ms; arrays alternate buzz / pause
const PATTERN: Record<HapticKind, number | number[]> = {
  light: 8,
  medium: 18,
  heavy: [28, 40, 28],
  warn: [12, 30, 12],
  success: [20, 50, 20, 50, 40],
  fail: [70, 50, 110],
};

// fail > success > heavy > warn > medium > light
const PRIORITY: Record<HapticKind, number> = {
  light: 0, medium: 1, warn: 2, heavy: 3, success: 4, fail: 5,
};

const MIN_GAP_MS = 70;

function lengthMs(p: number | number[]): number {
  if (typeof p === 'number') return p;
  let sum = 0;
  for (let i = 0; i < p.length; i++) sum += p[i];
  return sum;
}

const LENGTH: Record<HapticKind, number> = {
  light: lengthMs(PATTERN.light),
  medium: lengthMs(PATTERN.medium),
  heavy: lengthMs(PATTERN.heavy),
  warn: lengthMs(PATTERN.warn),
  success: lengthMs(PATTERN.success),
  fail: lengthMs(PATTERN.fail),
};

/**
 * Priority throttle: an equal or lesser pulse within MIN_GAP_MS of the last one is
 * dropped, and a lesser one never cuts a running pattern short — vibrate() and
 * Android's VibrationEffect both replace whatever is buzzing, so a stray 'light'
 * would truncate a boss kill. A true answer commits `kind` as the running pulse.
 */
export class HapticThrottle {
  private lastAt = -Infinity;
  private lastPriority = -1;
  private busyUntil = -Infinity; // when the last fired pattern finishes buzzing

  allow(kind: HapticKind, nowMs: number): boolean {
    const pr = PRIORITY[kind];
    if (pr <= this.lastPriority) {
      if (nowMs - this.lastAt < MIN_GAP_MS) return false;
      if (pr < this.lastPriority && nowMs < this.busyUntil) return false;
    }
    this.lastAt = nowMs;
    this.lastPriority = pr;
    this.busyUntil = nowMs + LENGTH[kind];
    return true;
  }
}

export class WebHapticsService implements IHapticsService {
  enabled = true;
  readonly supported: boolean;
  private nav: Navigator | null;
  private readonly throttle = new HapticThrottle();

  constructor() {
    const nav = typeof navigator !== 'undefined' ? navigator : null;
    this.nav = nav && typeof nav.vibrate === 'function' ? nav : null;
    this.supported = this.nav !== null;
  }

  pulse(kind: HapticKind): void {
    const nav = this.nav;
    if (!this.enabled || !nav) return;
    // browsers refuse (and log an intervention for) vibrate before the first tap
    const ua: UserActivation | undefined = nav.userActivation;
    if (ua && !ua.hasBeenActive) return;
    if (!this.throttle.allow(kind, performance.now())) return;
    try {
      nav.vibrate(PATTERN[kind]);
    } catch {
      // unreachable for these well-formed patterns; one that threw still holds its throttle slot
    }
  }
}
