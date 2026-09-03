// Thin DOM controller for the heads-up display. Game logic stays in systems;
// this just reflects state and fires button callbacks.

export interface OverlayOpts {
  title: string;
  body?: string;
  extraHTML?: string;
  btnText: string;
  onBtn: () => void;
  btn2Text?: string;
  onBtn2?: () => void;
  btn3Text?: string;
  onBtn3?: () => void;
}

export class HUD {
  private app = document.getElementById('app')!;
  private levelLabel = document.getElementById('level-label')!;
  private coins = document.getElementById('coins')!;
  private progressFill = document.getElementById('progress-fill')!;
  private countEl = document.getElementById('crowd-count')!;
  private popups = document.getElementById('popups')!;
  private hint = document.getElementById('hint')!;
  private overlay = document.getElementById('overlay')!;
  private overlayTitle = document.getElementById('overlay-title')!;
  private overlayBody = document.getElementById('overlay-body')!;
  private overlayExtra = document.getElementById('overlay-extra')!;
  private overlayBtn = document.getElementById('overlay-btn') as HTMLButtonElement;
  private overlayBtn2 = document.getElementById('overlay-btn2') as HTMLButtonElement;
  private overlayBtn3 = document.getElementById('overlay-btn3') as HTMLButtonElement;

  private flashEl: HTMLDivElement;
  private bossWrap: HTMLDivElement;
  private bossFill: HTMLDivElement;
  private lastCount = -1;

  constructor() {
    // screen flash
    this.flashEl = document.createElement('div');
    Object.assign(this.flashEl.style, {
      position: 'absolute', inset: '0', background: '#fff', opacity: '0',
      pointerEvents: 'none', transition: 'opacity 0.25s ease-out',
    } as CSSStyleDeclaration);
    this.app.appendChild(this.flashEl);

    // boss bar
    this.bossWrap = document.createElement('div');
    Object.assign(this.bossWrap.style, {
      position: 'absolute', top: '52px', left: '12%', right: '12%', height: '14px',
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
  }

  setLevel(n: number): void { this.levelLabel.textContent = `LEVEL ${n}`; }
  setCoins(n: number): void { this.coins.textContent = String(Math.floor(n)); }
  setProgress(frac: number): void {
    this.progressFill.style.width = `${Math.max(0, Math.min(1, frac)) * 100}%`;
  }

  setCount(n: number): void {
    if (n === this.lastCount) return;
    this.lastCount = n;
    this.countEl.textContent = String(n);
    this.countEl.classList.remove('pop');
    void this.countEl.offsetWidth; // reflow to restart animation
    this.countEl.classList.add('pop');
    setTimeout(() => this.countEl.classList.remove('pop'), 90);
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

  showOverlay(o: OverlayOpts): void {
    this.overlayTitle.textContent = o.title;
    this.overlayBody.innerHTML = o.body ?? '';
    this.overlayExtra.innerHTML = o.extraHTML ?? '';
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
  }

  hideOverlay(): void {
    this.overlay.classList.remove('show');
  }
}
