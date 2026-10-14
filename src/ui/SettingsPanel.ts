import type { GraphicsMode } from '../data/types';
import type { SaveService } from '../services/SaveService';
import type { AudioService } from '../services/AudioService';
import type { IHapticsService } from '../services/HapticsService';

export interface SettingsOpenOpts {
  /** true = in-run pause sheet (RESUME / QUIT TO MENU); false = menu settings (BACK). */
  paused: boolean;
  onClose: () => void;
  onQuit?: () => void;
  /** Menu only: shows RESET PROGRESS (two taps within RESET_CONFIRM_MS). */
  onReset?: () => void;
}

type ToggleKey = 'sound' | 'music' | 'haptics';

const GRAPHICS: readonly { mode: GraphicsMode; label: string; caption: string }[] = [
  { mode: 'auto', label: 'AUTO', caption: 'Adapts to your device' },
  { mode: 'high', label: 'HIGH', caption: 'Sharpest, with shadows' },
  { mode: 'low', label: 'LOW', caption: 'Smoothest, no shadows' },
];

const RESET_CONFIRM_MS = 3000;
// a confirm this soon after arming is the same gesture (double-tap, double-click), not a decision
const RESET_ARM_DELAY_MS = 450;

function make<K extends keyof HTMLElementTagNameMap>(
  tag: K, className: string, text?: string,
): HTMLElementTagNameMap[K] {
  const el = document.createElement(tag);
  el.className = className;
  if (text !== undefined) el.textContent = text;
  return el;
}

// Settings sheet, doubling as the pause menu mid-run. Every toggle writes the
// save and applies live, so closing never has anything left to commit.
export class SettingsPanel {
  /** After the player picks a different graphics mode (already saved). */
  onGraphicsChanged: ((mode: GraphicsMode) => void) | null = null;

  private root: HTMLDivElement;
  private titleEl: HTMLHeadingElement;
  private switches: Record<ToggleKey, HTMLButtonElement>;
  private hapticsRow!: HTMLDivElement;
  private hapticsNote!: HTMLDivElement;
  private graphicsBtns: HTMLButtonElement[] = [];
  private graphicsNote!: HTMLDivElement;
  private resetWrap: HTMLDivElement;
  private resetBtn: HTMLButtonElement;
  private primaryBtn: HTMLButtonElement;
  private quitBtn: HTMLButtonElement;
  private opts: SettingsOpenOpts | null = null;
  private resetTimer = 0; // 0 == reset not armed
  private resetArmedAt = 0; // performance.now() of the arming tap

  constructor(
    private save: SaveService,
    private audio: AudioService,
    private haptics: IHapticsService,
  ) {
    this.root = make('div', 'panel panel-settings');
    this.root.setAttribute('role', 'dialog');
    this.root.setAttribute('aria-labelledby', 'settings-title');
    // same rule as the shop: taps here must never reach the steer input on #app
    this.root.addEventListener('pointerdown', (e) => e.stopPropagation());
    this.root.addEventListener('keydown', (e) => {
      // a held Escape that just opened this sheet (via the back handler) must not also close it
      if (e.key !== 'Escape' || e.repeat) return;
      e.preventDefault();
      e.stopPropagation();
      this.close();
    });

    this.titleEl = make('h1', 'panel-title', 'SETTINGS');
    this.titleEl.id = 'settings-title';
    this.root.appendChild(this.titleEl);

    const scroll = make('div', 'panel-scroll');
    const list = make('div', 'set-list');
    this.switches = {
      sound: this.makeToggle(list, 'sound', 'Sound FX'),
      music: this.makeToggle(list, 'music', 'Music'),
      haptics: this.makeToggle(list, 'haptics', 'Haptics'),
    };
    this.makeGraphics(list);
    scroll.appendChild(list);

    this.resetWrap = make('div', 'set-danger');
    this.resetBtn = make('button', 'btn danger', 'RESET PROGRESS');
    this.resetBtn.type = 'button';
    this.resetBtn.onclick = () => this.onResetTap();
    // a held Enter auto-repeats clicks: only a fresh key press may arm or confirm
    this.resetBtn.addEventListener('keydown', (e) => {
      if (e.repeat && (e.key === 'Enter' || e.key === ' ')) e.preventDefault();
    });
    this.resetWrap.appendChild(this.resetBtn);
    scroll.appendChild(this.resetWrap);
    this.root.appendChild(scroll);

    const actions = make('div', 'panel-actions');
    this.primaryBtn = make('button', 'btn', 'BACK');
    this.primaryBtn.type = 'button';
    this.primaryBtn.onclick = () => { this.audio.play('click'); this.close(); };
    this.quitBtn = make('button', 'btn ghost', 'QUIT TO MENU');
    this.quitBtn.type = 'button';
    this.quitBtn.onclick = () => this.quit();
    actions.append(this.primaryBtn, this.quitBtn);
    this.root.appendChild(actions);

    document.getElementById('hud')!.appendChild(this.root);
  }

  get isOpen(): boolean {
    return this.opts !== null;
  }

  open(opts: SettingsOpenOpts): void {
    this.opts = opts;
    this.root.classList.toggle('paused', opts.paused);
    this.titleEl.textContent = opts.paused ? 'PAUSED' : 'SETTINGS';
    this.primaryBtn.textContent = opts.paused ? 'RESUME' : 'BACK';
    this.quitBtn.classList.toggle('hidden', !(opts.paused && opts.onQuit));
    this.resetWrap.classList.toggle('hidden', !opts.onReset);
    this.disarmReset();
    this.sync();
    this.root.classList.add('show');
    this.primaryBtn.focus({ preventScroll: true });
  }

  /** Hide and hand control back via opts.onClose (RESUME / BACK / Escape). */
  close(): void {
    const o = this.opts;
    if (!o) return; // never fire onClose twice (e.g. a double resume)
    this.hide();
    o.onClose();
  }

  private hide(): void {
    this.opts = null;
    this.disarmReset();
    this.root.classList.remove('show');
  }

  private quit(): void {
    const o = this.opts;
    if (!o) return;
    this.audio.play('click');
    this.hide(); // quitting is not resuming: onClose must not run
    o.onQuit?.();
  }

  private onResetTap(): void {
    const o = this.opts;
    if (!o || !o.onReset) return;
    const now = performance.now();
    if (this.resetTimer === 0) {
      this.audio.play('click');
      this.resetBtn.textContent = 'TAP AGAIN TO CONFIRM';
      this.resetBtn.classList.add('armed');
      this.resetArmedAt = now;
      this.resetTimer = setTimeout(() => {
        this.resetTimer = 0;
        this.disarmReset();
      }, RESET_CONFIRM_MS);
      return;
    }
    if (now - this.resetArmedAt < RESET_ARM_DELAY_MS) return; // ignored silently: still armed
    this.audio.play('click');
    const onReset = o.onReset;
    this.hide();
    onReset();
  }

  private disarmReset(): void {
    if (this.resetTimer !== 0) clearTimeout(this.resetTimer);
    this.resetTimer = 0;
    this.resetBtn.textContent = 'RESET PROGRESS';
    this.resetBtn.classList.remove('armed');
  }

  private makeToggle(list: HTMLDivElement, key: ToggleKey, label: string): HTMLButtonElement {
    const row = make('div', 'set-row');
    const text = make('div', 'set-text');
    // <label for> names the switch and makes the whole label a tap target
    const lab = make('label', 'set-label', label);
    lab.htmlFor = `set-${key}`;
    text.appendChild(lab);

    const sw = make('button', 'switch');
    sw.type = 'button';
    sw.id = `set-${key}`;
    sw.setAttribute('role', 'switch');
    sw.setAttribute('aria-checked', 'false');
    sw.appendChild(make('span', 'switch-knob'));
    sw.onclick = () => this.toggle(key);

    if (key === 'haptics') {
      this.hapticsRow = row;
      this.hapticsNote = make('div', 'set-caption', 'Not supported on this device');
      this.hapticsNote.id = 'set-haptics-note';
      text.appendChild(this.hapticsNote);
    }
    row.append(text, sw);
    list.appendChild(row);
    return sw;
  }

  /** A full-width segmented control under its label, so it fits a 320 px screen. */
  private makeGraphics(list: HTMLDivElement): void {
    const row = make('div', 'set-row stack');
    const text = make('div', 'set-text');
    // a group, not a labelable control: a plain text label, not <label for>
    const lab = make('div', 'set-label', 'Graphics');
    lab.id = 'set-graphics-label';
    this.graphicsNote = make('div', 'set-caption');
    this.graphicsNote.id = 'set-graphics-note';
    text.append(lab, this.graphicsNote);

    const seg = make('div', 'seg');
    seg.setAttribute('role', 'group');
    seg.setAttribute('aria-labelledby', 'set-graphics-label');
    seg.setAttribute('aria-describedby', 'set-graphics-note');
    for (const g of GRAPHICS) {
      const b = make('button', 'seg-btn', g.label);
      b.type = 'button';
      b.setAttribute('aria-pressed', 'false');
      b.onclick = () => this.setGraphics(g.mode);
      this.graphicsBtns.push(b);
      seg.appendChild(b);
    }
    row.append(text, seg);
    list.appendChild(row);
  }

  private syncGraphics(mode: GraphicsMode): void {
    for (let i = 0; i < GRAPHICS.length; i++) {
      const on = GRAPHICS[i].mode === mode;
      this.graphicsBtns[i].setAttribute('aria-pressed', String(on));
      if (on) this.graphicsNote.textContent = GRAPHICS[i].caption;
    }
  }

  private setGraphics(mode: GraphicsMode): void {
    if (mode === this.save.get().settings.graphics) return;
    this.save.setGraphics(mode);
    this.syncGraphics(mode);
    this.audio.play('click');
    this.onGraphicsChanged?.(mode);
  }

  /** Reflect the saved settings (the save is the source of truth, not the switches). */
  private sync(): void {
    const s = this.save.get().settings;
    const hapticsOk = this.haptics.supported;
    this.setSwitch('sound', s.sound);
    this.setSwitch('music', s.music);
    this.syncGraphics(s.graphics);
    // unsupported shows OFF: the device can't buzz whatever the saved preference says
    this.setSwitch('haptics', hapticsOk && s.haptics);
    const sw = this.switches.haptics;
    sw.disabled = !hapticsOk;
    this.hapticsRow.classList.toggle('disabled', !hapticsOk);
    this.hapticsNote.classList.toggle('hidden', hapticsOk);
    if (hapticsOk) sw.removeAttribute('aria-describedby');
    else sw.setAttribute('aria-describedby', 'set-haptics-note');
  }

  private setSwitch(key: ToggleKey, on: boolean): void {
    this.switches[key].setAttribute('aria-checked', String(on));
  }

  private toggle(key: ToggleKey): void {
    if (key === 'haptics' && !this.haptics.supported) return;
    const on = !this.save.get().settings[key];
    this.save.setSetting(key, on);
    this.setSwitch(key, on);
    if (key === 'sound') this.audio.setSfxEnabled(on);
    else if (key === 'music') this.audio.setMusicEnabled(on);
    else this.haptics.enabled = on;
    // after applying, so turning sound ON clicks and turning it OFF stays silent
    this.audio.play('click');
    if (key === 'haptics' && on) this.haptics.pulse('medium');
  }
}
