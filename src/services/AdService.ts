// Ad calls live behind two layers. IAdService is the thin SDK adapter (the stub
// here; AppLovin MAX / AdMob later). AdGate sits in front of it and owns every
// rule the game relies on — single-flight, balanced open/close, timeouts,
// frequency caps — so swapping SDKs can never change game behaviour.
// Pure TS, no DOM and type-only imports: Node unit-tests this file directly.

export type RewardKind = 'double_coins' | 'revive' | 'bonus_crowd';

export interface IAdService {
  init(): Promise<void>;
  isRewardedReady(): boolean;
  isInterstitialReady(): boolean;
  /**
   * Show a rewarded video. Resolves true if the reward should be granted. Call
   * `onShown` once the ad is actually on screen (MAX: OnAdDisplayedEvent):
   * AdGate's timeout only bounds getting it there, never the video itself.
   */
  showRewarded(kind: RewardKind, onShown?: () => void): Promise<boolean>;
  /** Show an interstitial; `onShown` as above. Frequency capping is AdGate's job, not the SDK's. */
  showInterstitial(onShown?: () => void): Promise<void>;
}

/**
 * Test flags (query string): ?adfail -> rewarded resolves false, ?adnofill -> nothing
 * is ever ready, ?adhang -> showRewarded never resolves (exercises AdGate's timeout).
 */
export class AdServiceStub implements IAdService {
  private readonly latencyMs: number;
  private readonly fail: boolean;
  private readonly noFill: boolean;
  private readonly hang: boolean;

  constructor(latencyMs: number) {
    this.latencyMs = Number.isFinite(latencyMs) && latencyMs > 0 ? latencyMs : 0;
    const search = typeof window !== 'undefined' && typeof location !== 'undefined' ? location.search : '';
    const q = new URLSearchParams(search);
    this.fail = q.has('adfail');
    this.noFill = q.has('adnofill');
    this.hang = q.has('adhang');
  }

  async init(): Promise<void> {
    const flags = [this.fail && 'adfail', this.noFill && 'adnofill', this.hang && 'adhang'].filter(Boolean);
    console.info(`[AdServiceStub] init (latency ${this.latencyMs}ms${flags.length ? `, flags: ${flags.join(' ')}` : ''})`);
  }

  isRewardedReady(): boolean {
    return !this.noFill;
  }

  isInterstitialReady(): boolean {
    return !this.noFill;
  }

  showRewarded(kind: RewardKind, onShown?: () => void): Promise<boolean> {
    if (this.hang) {
      // never shows and never settles, so AdGate's load timeout is what ends it
      console.info(`[AdServiceStub] rewarded video (${kind}) — hanging (?adhang)`);
      return new Promise<boolean>(() => {});
    }
    onShown?.();
    return this.delay().then(() => {
      const ok = !this.fail && !this.noFill;
      console.info(`[AdServiceStub] rewarded video (${kind}) — ${ok ? 'granting reward' : 'no reward'}`);
      return ok;
    });
  }

  showInterstitial(onShown?: () => void): Promise<void> {
    onShown?.();
    return this.delay().then(() => {
      console.info('[AdServiceStub] interstitial');
    });
  }

  private delay(): Promise<void> {
    return new Promise<void>((resolve) => setTimeout(resolve, this.latencyMs));
  }
}

export interface AdGateHooks {
  /** An ad is about to take the screen: pause the sim, suspend audio. */
  onAdOpen(): void;
  /** Called exactly once per onAdOpen, whatever the outcome. */
  onAdClose(): void;
  /** Remove Ads purchase: blocks interstitials only — rewarded stays opt-in. */
  adsRemoved(): boolean;
  /** Seconds, any monotonic clock. */
  now(): number;
}

export interface AdGateOptions {
  interstitialEveryLevels: number;
  interstitialMinIntervalSec: number;
  rewardedTimeoutSec: number;
}

// An ad that never calls back must not freeze the game, so a bad timeout
// config falls back to this rather than disabling the guard.
const FALLBACK_TIMEOUT_SEC = 30;
// rewardedTimeoutSec only covers getting an ad on screen: a full video plus end
// card outlasts it. Once onShown fires, this backstop is all that is left, for
// an SDK that shows an ad and then never reports it closed.
const SHOWN_BACKSTOP_SEC = 180;

type InterstitialOutcome = 'shown' | 'timeout' | 'failed';

export class AdGate {
  private readonly sdk: IAdService;
  private readonly hooks: AdGateHooks;
  private readonly every: number; // 0 = interstitials disabled
  private readonly minIntervalSec: number;
  private readonly timeoutMs: number; // guards interstitials too: either kind can hang
  private open = false;
  private clears = 0;
  private lastInterstitialAt: number | null = null;

  constructor(sdk: IAdService, opts: AdGateOptions, hooks: AdGateHooks) {
    this.sdk = sdk;
    this.hooks = hooks;
    const every = opts.interstitialEveryLevels;
    this.every = Number.isFinite(every) && every >= 1 ? Math.floor(every) : 0;
    const gap = opts.interstitialMinIntervalSec;
    this.minIntervalSec = Number.isFinite(gap) && gap > 0 ? gap : 0;
    const t = opts.rewardedTimeoutSec;
    this.timeoutMs = (Number.isFinite(t) && t > 0 ? t : FALLBACK_TIMEOUT_SEC) * 1000;
  }

  /** An ad is open (or loading) right now. */
  get busy(): boolean {
    return this.open;
  }

  canOfferRewarded(): boolean {
    return !this.open && this.ready(() => this.sdk.isRewardedReady());
  }

  /** Resolves true only if the reward was earned. Never rejects. */
  showRewarded(kind: RewardKind): Promise<boolean> {
    // not-ready never reaches the SDK, so it never pauses the game either
    if (!this.canOfferRewarded()) return Promise.resolve(false);
    return this.present<boolean>(
      (onShown) => this.sdk.showRewarded(kind, onShown).then((ok) => ok === true),
      false,
      false,
    );
  }

  /** Count a level clear and show an interstitial if the caps allow. Never rejects. */
  async onLevelComplete(): Promise<void> {
    this.clears += 1;
    if (!this.interstitialDue()) return;
    const outcome = await this.present<InterstitialOutcome>(
      (onShown) => this.sdk.showInterstitial(onShown).then(() => 'shown' as const),
      'timeout',
      'failed',
    );
    // stamp at close so the min interval is real play time, not ad time; a failed
    // show put nothing on screen, so it doesn't use up the slot
    if (outcome !== 'failed') this.lastInterstitialAt = this.safeNow();
  }

  private interstitialDue(): boolean {
    if (this.every === 0 || this.clears % this.every !== 0 || this.open) return false;
    try {
      if (this.hooks.adsRemoved()) return false;
      if (this.lastInterstitialAt !== null && this.hooks.now() - this.lastInterstitialAt < this.minIntervalSec) {
        return false;
      }
    } catch (err) {
      console.warn('[AdGate] interstitial check failed — skipping', err);
      return false;
    }
    return this.ready(() => this.sdk.isInterstitialReady());
  }

  /**
   * Runs one show with every guarantee in a single place: busy for its whole
   * lifetime, onAdOpen/onAdClose exactly once each, a load timeout that gives
   * way to a long backstop once the SDK reports the ad shown, the timer cleared
   * on settle, late SDK results dropped, and never a rejection.
   */
  private present<T>(start: (onShown: () => void) => Promise<T>, onTimeout: T, onFail: T): Promise<T> {
    this.open = true; // set before anything can call back in, so a re-entrant show sees busy
    try {
      this.hooks.onAdOpen();
    } catch (err) {
      console.error('[AdGate] onAdOpen threw', err);
    }
    return new Promise<T>((resolve) => {
      let settled = false;
      let shown = false;
      let timer: ReturnType<typeof setTimeout> | undefined;
      const finish = (value: T): void => {
        if (settled) return; // a late SDK resolve after the timeout lands here and is ignored
        settled = true;
        clearTimeout(timer);
        this.open = false;
        try {
          this.hooks.onAdClose();
        } catch (err) {
          console.error('[AdGate] onAdClose threw', err);
        }
        resolve(value);
      };
      const arm = (ms: number): void => {
        clearTimeout(timer);
        timer = setTimeout(() => {
          console.warn(shown ? '[AdGate] ad never reported closed' : '[AdGate] ad timed out');
          finish(onTimeout);
        }, ms);
      };
      // first call only: an SDK repeating it must not extend the backstop forever
      const onShown = (): void => {
        if (settled || shown) return;
        shown = true;
        arm(Math.max(this.timeoutMs, SHOWN_BACKSTOP_SEC * 1000));
      };
      arm(this.timeoutMs);
      let pending: Promise<T>;
      try {
        pending = start(onShown);
      } catch (err) {
        console.warn('[AdGate] SDK threw', err);
        finish(onFail);
        return;
      }
      Promise.resolve(pending).then(finish, (err: unknown) => {
        console.warn('[AdGate] SDK rejected', err);
        finish(onFail);
      });
    });
  }

  private ready(check: () => boolean): boolean {
    try {
      return check() === true;
    } catch {
      return false;
    }
  }

  private safeNow(): number | null {
    try {
      const t = this.hooks.now();
      return Number.isFinite(t) ? t : null;
    } catch {
      return null;
    }
  }
}
