// Haptics behind an interface so a native port can bind Core Haptics / Android
// VibrationEffect without touching game code. The web build uses
// navigator.vibrate (Android Chrome); iOS Safari has none, so `supported` is false.

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

export class WebHapticsService implements IHapticsService {
  enabled = true;
  readonly supported: boolean;
  private nav: Navigator | null;
  private lastAt = -Infinity;
  private lastPriority = -1;
  private busyUntil = -Infinity; // when the last fired pattern finishes buzzing

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
    const now = performance.now();
    const pr = PRIORITY[kind];
    if (pr <= this.lastPriority) {
      if (now - this.lastAt < MIN_GAP_MS) return;
      // vibrate() replaces the running pattern, so a lesser pulse would cut a boss kill mid-buzz
      if (pr < this.lastPriority && now < this.busyUntil) return;
    }
    try {
      nav.vibrate(PATTERN[kind]);
    } catch {
      return;
    }
    this.lastAt = now;
    this.lastPriority = pr;
    this.busyUntil = now + LENGTH[kind];
  }
}
