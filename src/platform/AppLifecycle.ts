// Background / foreground / back, one source of truth for both shells. Android
// reports one backgrounding through several channels (appStateChange on onStop,
// the WebView's visibilitychange, sometimes pagehide), so every channel feeds a
// single hidden flag and the callbacks run only when that flag actually flips.

import { App } from '@capacitor/app';
import { isNative } from './Platform';

export interface IAppLifecycle {
  /** App backgrounded / tab hidden / pagehide. Once per real transition. */
  onHidden(cb: () => void): void;
  /** Foregrounded / tab visible / pageshow from the bfcache. Once per real transition. */
  onVisible(cb: () => void): void;
  /**
   * Hardware or gesture back on native, Escape on the web (not while typing, not on
   * key auto-repeat). Handlers run in registration order until one returns true;
   * if none does on native, the app exits (Android convention).
   */
  onBack(cb: () => boolean): void;
  /** Native: close the app. Web: no-op (a page cannot close its own tab). */
  exit(): void;
}

// <input> types that take no typing, so Escape on them still means back
const NON_TEXT_INPUTS = new Set(['button', 'checkbox', 'color', 'file', 'image', 'radio', 'range', 'reset', 'submit']);

function isTextField(t: EventTarget | null): boolean {
  if (t instanceof HTMLTextAreaElement) return true;
  if (t instanceof HTMLInputElement) return !NON_TEXT_INPUTS.has(t.type);
  return t instanceof HTMLElement && t.isContentEditable;
}

const ignore = (): void => {};

class Lifecycle implements IAppLifecycle {
  private hidden = document.hidden;
  private readonly hiddenCbs: Array<() => void> = [];
  private readonly visibleCbs: Array<() => void> = [];
  private readonly backCbs: Array<() => boolean> = [];

  constructor() {
    // also the fallback on native, should a plugin event go missing
    document.addEventListener('visibilitychange', () => this.setHidden(document.hidden));
    window.addEventListener('pagehide', () => this.setHidden(true));
    window.addEventListener('pageshow', (e) => {
      if (e.persisted && !document.hidden) this.setHidden(false);
    });

    if (isNative) {
      const warn = (err: unknown): void => console.warn('App lifecycle listener failed:', err);
      App.addListener('appStateChange', (s) => this.setHidden(!s.isActive)).catch(warn);
      // registering any backButton listener turns off Capacitor's own handling,
      // which would only ever walk WebView history and never leave the app
      App.addListener('backButton', () => {
        if (!this.back()) this.exit();
      }).catch(warn);
    } else {
      window.addEventListener('keydown', (e) => this.onKeyDown(e));
    }
  }

  onHidden(cb: () => void): void { this.hiddenCbs.push(cb); }
  onVisible(cb: () => void): void { this.visibleCbs.push(cb); }
  onBack(cb: () => boolean): void { this.backCbs.push(cb); }

  exit(): void {
    if (!isNative) return;
    try {
      App.exitApp().catch(ignore);
    } catch {
      // nothing sensible left to do
    }
  }

  private setHidden(hidden: boolean): void {
    if (hidden === this.hidden) return;
    this.hidden = hidden;
    const cbs = hidden ? this.hiddenCbs : this.visibleCbs;
    for (let i = 0; i < cbs.length; i++) {
      // one throwing listener must not keep the next from silencing audio
      try {
        cbs[i]();
      } catch (err) {
        console.error(err);
      }
    }
  }

  private back(): boolean {
    const cbs = this.backCbs;
    for (let i = 0; i < cbs.length; i++) {
      try {
        if (cbs[i]()) return true;
      } catch (err) {
        console.error(err);
        return true; // a broken handler must not quit the app on the player
      }
    }
    return false;
  }

  private onKeyDown(e: KeyboardEvent): void {
    if (e.key !== 'Escape' || e.repeat || e.isComposing || e.defaultPrevented) return;
    if (isTextField(e.target)) return;
    if (this.back()) e.preventDefault();
  }
}

let shared: Lifecycle | null = null;

/** One per page: the native listeners are app-wide, so a second instance would double every back press. */
export function createLifecycle(): IAppLifecycle {
  if (!shared) shared = new Lifecycle();
  return shared;
}
