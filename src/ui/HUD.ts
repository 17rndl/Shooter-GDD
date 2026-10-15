// Thin DOM controller for the heads-up display. Game logic stays in systems;
// this just reflects state and fires button callbacks.

import { clamp } from '../util/MathUtil';

const COIN_COUNT_DURATION = 1.0; // seconds for the reward coin roll-up
const COIN_TICK_INTERVAL = 0.06; // seconds between onCoinTick calls during it

/** What a daily clear paid, for the reward ceremony. */
export interface DailyRewardInfo {
  /** First clear of its day: only that one pays the bonus and moves the streak. */
  firstClear: boolean;
  /** Consecutive days cleared, this one included. */
  streak: number;
  /** Coins banked on top of the level's own (0 on a repeat clear). */
  bonus: number;
}

export interface RewardCeremonyOpts {
  survivors: number;
  mult: number;
  coins: number;
  best: number;
  isNewBest: boolean;
  /** Defaults to LEVEL CLEAR! */
  title?: string;
  /** The primary button; defaults to NEXT LEVEL. */
  nextText?: string;
  /** A daily run's payout line under the coins. */
  daily?: DailyRewardInfo | null;
  onNext: () => void;
  onDouble: () => void;
  onShop: () => void;
}

/** The menu's DAILY CHALLENGE card. */
export interface DailyCardOpts {
  /** 'MON' ... 'SUN'. */
  weekday: string;
  /** 1 (Monday) ... 7 (Sunday): that many of the 7 pips light up. */
  difficulty: number;
  /** Live clear streak; 0 once it has lapsed. */
  streak: number;
  /** Today's best peak crowd; 0 = not played yet today. */
  best: number;
  cleared: boolean;
  /** Coins today's first clear adds to the level's own; 0 once cleared. */
  bonus: number;
  onPlay: () => void;
}

export interface OverlayOpts {
  title: string;
  body?: string;
  extraHTML?: string;
  /** Rendered into the extra area, after extraHTML. */
  daily?: DailyCardOpts;
  btnText: string;
  onBtn: () => void;
  btn2Text?: string;
  onBtn2?: () => void;
  btn3Text?: string;
  onBtn3?: () => void;
}

const PIPS = 7;

function el<K extends keyof HTMLElementTagNameMap>(tag: K, className: string, text?: string): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  e.className = className;
  if (text !== undefined) e.textContent = text;
  return e;
}

export class HUD {
  private app = document.getElementById('app')!;
  private levelLabel = document.getElementById('level-label')!;
  private coins = document.getElementById('coins')!;
  private progressFill = document.getElementById('progress-fill')!;
  private countEl = document.getElementById('crowd-count')!;
  private vignette = document.getElementById('vignette')!;
  private popups = document.getElementById('popups')!;
  private hint = document.getElementById('hint')!;
  private overlay = document.getElementById('overlay')!;
  private overlayTitle = document.getElementById('overlay-title')!;
  private overlayBody = document.getElementById('overlay-body')!;
  private overlayExtra = document.getElementById('overlay-extra')!;
  private overlayBtn = document.getElementById('overlay-btn') as HTMLButtonElement;
  private overlayBtn2 = document.getElementById('overlay-btn2') as HTMLButtonElement;
  private overlayBtn3 = document.getElementById('overlay-btn3') as HTMLButtonElement;
  private overlayBtns = [this.overlayBtn, this.overlayBtn2, this.overlayBtn3];
  /** The daily card's PLAY button while the menu shows one; locked with the overlay buttons. */
  private dailyBtn: HTMLButtonElement | null = null;
  private gear = document.getElementById('gear') as HTMLButtonElement;

  private flashEl: HTMLDivElement;
  private bossWrap: HTMLDivElement;
  private bossFill: HTMLDivElement;

  /** Fired every time the *displayed* count ticks over an integer. */
  onCountTick: ((value: number, rising: boolean) => void) | null = null;
  /** Fired repeatedly while the reward coin total counts up. */
  onCoinTick: (() => void) | null = null;
  /** The gear / pause button was tapped. */
  onGear: (() => void) | null = null;

  // label each overlay button had before setButtonBusy(idx, true); null == not busy
  private busyText: (string | null)[] = [null, null, null];

  // crowd-count roll-up state (driven by update())
  private countTarget = 0;
  private countShown = 0;
  private countFrom = 0;
  private countTime = 0;
  private countDur = 0; // 0 == idle
  private countPop = 1;
  private popTimer = 0;
  private danger = false;

  // reward-ceremony coin roll-up state (driven by update())
  private coinTarget = 0;
  private coinShown = -1;
  private coinTime = 0;
  private coinDur = 0; // 0 == idle
  private coinAccum = 0;
  private coinNumEl: HTMLElement | null = null;
  private coinTagEl: HTMLElement | null = null;

  constructor() {
    // screen flash
    this.flashEl = document.createElement('div');
    Object.assign(this.flashEl.style, {
      position: 'absolute', inset: '0', background: '#fff', opacity: '0',
      pointerEvents: 'none', transition: 'opacity 0.25s ease-out',
    } as CSSStyleDeclaration);
    this.app.appendChild(this.flashEl);

    // boss bar (clears the 56px top bar)
    this.bossWrap = document.createElement('div');
    Object.assign(this.bossWrap.style, {
      position: 'absolute', top: '60px', left: '12%', right: '12%', height: '14px',
      borderRadius: '999px', background: 'rgba(0,0,0,0.45)', border: '1px solid rgba(255,255,255,0.3)',
      overflow: 'hidden', display: 'none',
    } as CSSStyleDeclaration);
    this.bossFill = document.createElement('div');
    Object.assign(this.bossFill.style, {
      height: '100%', width: '100%',
      background: 'linear-gradient(90deg,#ff5a52,#ff8a3d)', transition: 'width 0.1s linear',
    } as CSSStyleDeclaration);
    this.bossWrap.appendChild(this.bossFill);
    document.getElementById('hud')!.appendChild(this.bossWrap);

    this.gear.addEventListener('click', () => this.onGear?.());
  }

  /** visibility, not display: the top bar must not reflow when the gear comes and goes. */
  setGearVisible(on: boolean): void { this.gear.style.visibility = on ? '' : 'hidden'; }

  /** Gear glyph on menus, pause glyph mid-run. index.html swaps the SVG off data-mode. */
  setGearMode(mode: 'settings' | 'pause'): void {
    this.gear.dataset.mode = mode;
    this.gear.setAttribute('aria-label', mode === 'pause' ? 'Pause' : 'Settings');
  }

  /**
   * Lock an overlay button while its async action (an ad) is in flight so it
   * can't be tapped twice. The label comes back on busy=false.
   */
  setButtonBusy(idx: 1 | 2 | 3, busy: boolean): void {
    const btn = this.overlayBtns[idx - 1];
    if (busy) {
      if (this.busyText[idx - 1] === null) this.busyText[idx - 1] = btn.textContent ?? '';
      btn.textContent = 'LOADING...';
      btn.disabled = true;
      btn.setAttribute('aria-busy', 'true');
      return;
    }
    const prev = this.busyText[idx - 1];
    if (prev !== null) btn.textContent = prev;
    this.busyText[idx - 1] = null;
    btn.disabled = false;
    btn.removeAttribute('aria-busy');
  }

  /**
   * Disable the other overlay buttons while one is busy: the game ignores their
   * taps until its ad settles, so they must not look live. Busy ones are left alone.
   */
  setButtonsLocked(locked: boolean): void {
    for (let i = 0; i < this.overlayBtns.length; i++) {
      if (this.busyText[i] === null) this.overlayBtns[i].disabled = locked;
    }
    if (this.dailyBtn) this.dailyBtn.disabled = locked;
  }

  private clearBusy(): void {
    for (let i = 0; i < this.overlayBtns.length; i++) {
      this.busyText[i] = null;
      this.overlayBtns[i].disabled = false;
      this.overlayBtns[i].removeAttribute('aria-busy');
    }
  }

  setLevel(n: number): void { this.levelLabel.textContent = `LEVEL ${n}`; }
  /** A run off the level ladder (the daily) names itself instead of a number. */
  setLevelText(text: string): void { this.levelLabel.textContent = text; }
  setCoins(n: number): void { this.coins.textContent = String(Math.floor(n)); }
  setProgress(frac: number): void {
    this.progressFill.style.width = `${Math.max(0, Math.min(1, frac)) * 100}%`;
  }

  /**
   * The genre signature: the displayed number rolls toward `n` instead of
   * snapping, so a ×5 gate reads as a visible climb. Ease-out and never longer
   * than 0.6s so it stays snappy; the arrival punch scales with the jump.
   */
  setCount(n: number, instant = false): void {
    const v = Math.round(n);
    if (instant) {
      this.countTarget = v;
      this.countDur = 0;
      const jump = Math.abs(v - this.countShown);
      if (jump === 0) return;
      this.renderCount(v);
      this.popCount(this.popScaleFor(jump));
      return;
    }
    if (v === this.countTarget) return;
    this.countTarget = v;
    const delta = Math.abs(v - this.countShown);
    if (delta === 0) { this.countDur = 0; return; }
    this.countFrom = this.countShown;
    this.countTime = 0;
    this.countDur = clamp(0.12 + delta * 0.004, 0.12, 0.6);
    this.countPop = this.popScaleFor(delta);
  }

  /** Must be called every frame — drives the count and coin roll-ups. */
  update(dt: number): void {
    if (this.countDur > 0) {
      this.countTime += dt;
      const t = Math.min(1, this.countTime / this.countDur);
      const k = 1 - t;
      const e = 1 - k * k * k; // ease-out cubic
      this.renderCount(Math.round(this.countFrom + (this.countTarget - this.countFrom) * e));
      if (t >= 1) {
        this.countDur = 0;
        this.popCount(this.countPop);
      }
    }

    if (this.coinDur > 0) {
      this.coinTime += dt;
      this.coinAccum += dt;
      const t = Math.min(1, this.coinTime / this.coinDur);
      const k = 1 - t;
      this.renderCoins(Math.round(this.coinTarget * (1 - k * k)));
      while (this.coinAccum >= COIN_TICK_INTERVAL) {
        this.coinAccum -= COIN_TICK_INTERVAL;
        if (this.coinTarget > 0) this.onCoinTick?.();
      }
      if (t >= 1) {
        this.coinDur = 0;
        this.coinAccum = 0;
        this.revealDouble();
      }
    }
  }

  /** 1.15 for a ±1 nudge up to ~1.5 for a ±100 swing. */
  private popScaleFor(delta: number): number {
    return 1.15 + 0.35 * Math.sqrt(clamp((Math.abs(delta) - 1) / 99, 0, 1));
  }

  private renderCount(v: number): void {
    if (v === this.countShown) return;
    const rising = v > this.countShown;
    this.countShown = v;
    this.countEl.textContent = String(v);
    this.onCountTick?.(v, rising);
  }

  private popCount(scale: number): void {
    this.countEl.style.setProperty('--pop', String(scale));
    this.countEl.classList.remove('pop');
    void this.countEl.offsetWidth; // reflow to restart animation
    this.countEl.classList.add('pop');
    if (this.popTimer !== 0) clearTimeout(this.popTimer);
    this.popTimer = setTimeout(() => {
      this.popTimer = 0;
      this.countEl.classList.remove('pop');
    }, 90);
  }

  /** Red edge vignette + pulsing count: "you are about to be wiped out". */
  setDanger(on: boolean): void {
    if (on === this.danger) return;
    this.danger = on;
    this.vignette.classList.toggle('on', on);
    this.countEl.classList.toggle('danger', on);
  }

  setHint(visible: boolean): void {
    this.hint.style.display = visible ? '' : 'none';
  }

  /** NDC coords (-1..1) from camera.project → positioned popup. */
  popupNDC(text: string, color: string, ndcX: number, ndcY: number): void {
    const el = document.createElement('div');
    el.className = 'popup';
    el.textContent = text;
    el.style.color = color;
    el.style.left = `${(ndcX * 0.5 + 0.5) * 100}%`;
    el.style.top = `${(-ndcY * 0.5 + 0.5) * 100}%`;
    this.popups.appendChild(el);
    setTimeout(() => el.remove(), 950);
  }

  flash(color = '#ffffff', alpha = 0.5): void {
    this.flashEl.style.background = color;
    this.flashEl.style.opacity = String(alpha);
    requestAnimationFrame(() => requestAnimationFrame(() => (this.flashEl.style.opacity = '0')));
  }

  bossBar(show: boolean, frac = 1): void {
    this.bossWrap.style.display = show ? '' : 'none';
    this.bossFill.style.width = `${Math.max(0, Math.min(1, frac)) * 100}%`;
  }

  /**
   * The payoff beat. NEXT LEVEL is live immediately — only the ×2 offer waits
   * for the coin roll-up, so the ceremony never holds the player hostage.
   */
  showRewardCeremony(o: RewardCeremonyOpts): void {
    const bestHTML = o.isNewBest
      ? `<div class="best-badge">NEW BEST · ${o.best}</div>`
      : `<div class="best-line">Best: ${o.best}</div>`;
    this.showOverlay({
      title: o.title ?? 'LEVEL CLEAR!',
      body: `${o.survivors} survivors · ×${o.mult} lane`,
      extraHTML:
        '<div class="reward-coins">+<span id="reward-coin-num">0</span> ●' +
        '<span id="reward-coin-tag" class="coin-tag hidden">doubled!</span></div>' +
        (o.daily ? dailyRewardHTML(o.daily) : '') + bestHTML,
      btnText: o.nextText ?? 'NEXT LEVEL',
      onBtn: o.onNext,
      btn2Text: '×2 COINS (AD)',
      onBtn2: o.onDouble,
      btn3Text: '🛒 SHOP',
      onBtn3: o.onShop,
    });
    this.coinNumEl = document.getElementById('reward-coin-num');
    this.coinTagEl = document.getElementById('reward-coin-tag');
    this.overlayBtn2.classList.add('reveal');
    this.coinTarget = Math.max(0, Math.round(o.coins));
    this.coinShown = -1;
    this.coinTime = 0;
    this.coinAccum = 0;
    this.coinDur = COIN_COUNT_DURATION;
    this.renderCoins(0);
  }

  /** Rewrite the coin line without rebuilding the overlay (post rewarded-ad). */
  setRewardCoins(coins: number, doubled: boolean): void {
    this.coinDur = 0;
    this.coinAccum = 0;
    this.coinShown = -1;
    this.renderCoins(Math.max(0, Math.round(coins)));
    this.coinTagEl?.classList.toggle('hidden', !doubled);
    if (doubled) {
      // the ×2 offer is spent — never leave a live button that can be claimed twice
      this.overlayBtn2.classList.add('hidden');
      this.overlayBtn2.onclick = null;
    } else {
      this.revealDouble();
    }
  }

  private renderCoins(v: number): void {
    if (v === this.coinShown) return;
    this.coinShown = v;
    if (this.coinNumEl) this.coinNumEl.textContent = String(v);
  }

  private revealDouble(): void {
    if (!this.overlayBtn2.classList.contains('reveal')) return;
    this.overlayBtn2.classList.add('shown');
  }

  showOverlay(o: OverlayOpts): void {
    this.coinDur = 0;
    this.coinNumEl = null;
    this.coinTagEl = null;
    this.overlayBtn2.classList.remove('reveal', 'shown');
    this.clearBusy(); // a fresh screen never inherits a stuck LOADING... (labels are rewritten below)
    this.overlayTitle.textContent = o.title;
    this.overlayBody.innerHTML = o.body ?? '';
    this.overlayExtra.innerHTML = o.extraHTML ?? '';
    this.dailyBtn = o.daily ? this.buildDailyCard(o.daily) : null;
    // index.html tightens a menu carrying the card on short screens
    this.overlay.classList.toggle('with-card', !!o.daily);
    this.overlayBtn.textContent = o.btnText;
    this.overlayBtn.onclick = o.onBtn;
    if (o.btn2Text && o.onBtn2) {
      this.overlayBtn2.textContent = o.btn2Text;
      this.overlayBtn2.classList.remove('hidden');
      this.overlayBtn2.onclick = o.onBtn2;
    } else {
      this.overlayBtn2.classList.add('hidden');
      this.overlayBtn2.onclick = null;
    }
    if (o.btn3Text && o.onBtn3) {
      this.overlayBtn3.textContent = o.btn3Text;
      this.overlayBtn3.classList.remove('hidden');
      this.overlayBtn3.onclick = o.onBtn3;
    } else {
      this.overlayBtn3.classList.add('hidden');
      this.overlayBtn3.onclick = null;
    }
    this.overlay.classList.add('show');
    this.overlay.scrollTop = 0; // a short screen scrolls the overlay: every screen starts at its title
  }

  hideOverlay(): void {
    this.overlay.classList.remove('show');
    this.coinDur = 0; // a dismissed ceremony must not keep ticking coins
  }

  /** Appends the DAILY CHALLENGE card to the extra area; returns its PLAY button. */
  private buildDailyCard(o: DailyCardOpts): HTMLButtonElement {
    const card = el('section', o.cleared ? 'daily-card cleared' : 'daily-card');
    card.setAttribute('aria-label', 'Daily challenge');

    const head = el('div', 'daily-head');
    head.appendChild(el('span', 'daily-title', 'DAILY CHALLENGE'));
    if (o.cleared) head.appendChild(el('span', 'daily-tick', '✓ CLEARED'));
    card.appendChild(head);

    const row = el('div', 'daily-row');
    row.appendChild(el('span', 'daily-day', o.weekday));
    const pips = el('span', 'daily-pips');
    pips.setAttribute('role', 'img');
    pips.setAttribute('aria-label', `Difficulty ${o.difficulty} of ${PIPS}`);
    for (let i = 1; i <= PIPS; i++) pips.appendChild(el('i', i <= o.difficulty ? 'on' : ''));
    row.appendChild(pips);
    const stats = el('span', 'daily-stats');
    const streak = el('span', o.streak > 0 ? 'daily-streak' : 'daily-streak dim', `🔥 ${o.streak}`);
    streak.setAttribute('aria-label', `${o.streak}-day streak`);
    stats.appendChild(streak);
    stats.appendChild(el('span', o.best > 0 ? 'daily-best' : 'daily-best dim', `BEST ${o.best > 0 ? o.best : '–'}`));
    row.appendChild(stats);
    card.appendChild(row);

    const btn = el('button', 'btn gold small daily-play', 'PLAY DAILY');
    btn.type = 'button';
    if (o.bonus > 0) btn.appendChild(el('span', 'daily-bonus-tag', `+${o.bonus} ●`));
    btn.onclick = o.onPlay;
    card.appendChild(btn);

    this.overlayExtra.appendChild(card);
    return btn;
  }
}

/** The ceremony's daily line: the bonus and streak on a first clear, a quiet note on a repeat. */
function dailyRewardHTML(d: DailyRewardInfo): string {
  const streak = `🔥 ${d.streak}-day streak`;
  if (!d.firstClear) return `<div class="best-line">Already cleared today · ${streak}</div>`;
  return `<div class="daily-bonus">DAILY BONUS +${d.bonus} ●</div><div class="daily-streak-line">${streak}</div>`;
}
