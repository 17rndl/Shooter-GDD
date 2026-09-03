// Single input: horizontal drag. The crowd centroid tracks the pointer's X
// across the play area (absolute mapping, per the design spec).

export class InputSystem {
  private el: HTMLElement;
  private active = false;
  private target01 = 0.5;
  private firstInputCb: (() => void) | null = null;
  private firedFirst = false;

  constructor(el: HTMLElement) {
    this.el = el;
    el.addEventListener('pointerdown', this.onDown, { passive: false });
    window.addEventListener('pointermove', this.onMove, { passive: false });
    window.addEventListener('pointerup', this.onUp, { passive: false });
    window.addEventListener('pointercancel', this.onUp, { passive: false });
  }

  onFirstInput(cb: () => void): void {
    this.firstInputCb = cb;
  }

  private toNorm(clientX: number): number {
    const r = this.el.getBoundingClientRect();
    return (clientX - r.left) / Math.max(1, r.width);
  }

  private onDown = (e: PointerEvent) => {
    // UI (overlay screens, shop) sits above the play area; never steer from it.
    if (e.target instanceof HTMLElement && e.target.closest('button, #overlay')) return;
    e.preventDefault();
    this.active = true;
    this.target01 = this.toNorm(e.clientX);
    if (!this.firedFirst) {
      this.firedFirst = true;
      this.firstInputCb?.();
    }
  };

  private onMove = (e: PointerEvent) => {
    if (!this.active) return;
    this.target01 = this.toNorm(e.clientX);
  };

  private onUp = () => {
    this.active = false;
  };

  /** Normalized target X in [0,1]; clamped. */
  get value(): number {
    return Math.max(0, Math.min(1, this.target01));
  }

  get isActive(): boolean {
    return this.active;
  }

  resetCenter(): void {
    this.target01 = 0.5;
  }

  /** Test/debug only: force the steer target without a pointer event. */
  setTargetDebug(t: number): void {
    this.target01 = Math.max(0, Math.min(1, t));
  }
}
