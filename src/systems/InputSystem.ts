// Single input: horizontal drag. The crowd centroid tracks the pointer's X
// across the play area (absolute mapping, per the design spec).
//
// Multi-touch: only the oldest finger still down steers. A second finger is
// remembered but ignored; if the steering finger lifts while it is still down,
// it takes over (it is now the oldest), so a thumb swap never stalls the crowd.

const MAX_HELD = 4; // waiting fingers remembered for hand-off; any beyond are ignored

export class InputSystem {
  private el: HTMLElement;
  private active = false;
  private pointerId = 0; // the steering pointer; meaningful only while active
  private target01 = 0.5;
  // #app's box, read once per drag: a per-move getBoundingClientRect allocates and can force layout
  private rectLeft = 0;
  private rectWidth = 1;
  // waiting fingers, oldest first, in fixed slots so pointermove never allocates
  private heldIds: number[] = [0, 0, 0, 0];
  private heldX: number[] = [0, 0, 0, 0];
  private heldCount = 0;
  private firstInputCb: (() => void) | null = null;
  private firedFirst = false;

  constructor(el: HTMLElement) {
    this.el = el;
    el.addEventListener('pointerdown', this.onDown, { passive: false });
    window.addEventListener('pointermove', this.onMove, { passive: false });
    window.addEventListener('pointerup', this.onUp, { passive: false });
    window.addEventListener('pointercancel', this.onCancel, { passive: false });
    el.addEventListener('lostpointercapture', this.onLostCapture);
    // a long-press would open the browser / WebView context menu mid-run
    el.addEventListener('contextmenu', (e) => e.preventDefault());
  }

  onFirstInput(cb: () => void): void {
    this.firstInputCb = cb;
  }

  private toNorm(clientX: number): number {
    return (clientX - this.rectLeft) / this.rectWidth;
  }

  private onDown = (e: PointerEvent) => {
    // UI (overlay screens, shop) sits above the play area; never steer from it.
    if (e.target instanceof HTMLElement && e.target.closest('button, #overlay')) return;
    e.preventDefault();
    if (this.active && e.pointerId !== this.pointerId) {
      this.hold(e.pointerId, e.clientX);
      return;
    }
    // (the steering id again means its pointerup never arrived: just restart from here)
    this.begin(e.pointerId, e.clientX);
    if (!this.firedFirst) {
      this.firedFirst = true;
      this.firstInputCb?.();
    }
  };

  private onMove = (e: PointerEvent) => {
    if (!this.active) return;
    if (e.pointerId === this.pointerId) {
      this.target01 = this.toNorm(e.clientX);
      return;
    }
    // track waiting fingers so a hand-off lands where that finger is now
    const i = this.heldIndex(e.pointerId);
    if (i >= 0) this.heldX[i] = e.clientX;
  };

  private onUp = (e: PointerEvent) => {
    if (!this.active) return;
    if (e.pointerId !== this.pointerId) {
      this.unhold(e.pointerId);
      return;
    }
    if (this.heldCount === 0) {
      this.active = false;
      return;
    }
    const id = this.heldIds[0];
    const x = this.heldX[0];
    this.unhold(id);
    this.begin(id, x);
  };

  // The system took the gesture away (or the capture was lost): end the drag
  // outright. Waiting fingers are usually cancelled with it, so none take over.
  private onCancel = (e: PointerEvent) => {
    if (!this.active) return;
    if (e.pointerId === this.pointerId) this.end();
    else this.unhold(e.pointerId);
  };

  private onLostCapture = (e: PointerEvent) => {
    // This bubbles from children too: touch implicitly captures to the canvas,
    // and moving that capture onto #app fires one there. Only #app's own counts.
    // After a normal pointerup the drag has already ended or moved to another id.
    if (e.target !== this.el || !this.active || e.pointerId !== this.pointerId) return;
    this.end();
  };

  private begin(id: number, clientX: number): void {
    const r = this.el.getBoundingClientRect();
    this.rectLeft = r.left;
    this.rectWidth = Math.max(1, r.width);
    this.active = true;
    this.pointerId = id;
    this.target01 = this.toNorm(clientX);
    // keeps the drag (and its pointerup) when a mouse leaves the window
    if (typeof this.el.setPointerCapture === 'function') {
      try {
        this.el.setPointerCapture(id);
      } catch {
        /* the pointer is already gone; its pointerup / cancel still ends the drag */
      }
    }
  }

  private end(): void {
    this.active = false;
    this.heldCount = 0;
  }

  private heldIndex(id: number): number {
    for (let i = 0; i < this.heldCount; i++) if (this.heldIds[i] === id) return i;
    return -1;
  }

  private hold(id: number, clientX: number): void {
    if (this.heldCount >= MAX_HELD || this.heldIndex(id) >= 0) return;
    this.heldIds[this.heldCount] = id;
    this.heldX[this.heldCount] = clientX;
    this.heldCount++;
  }

  private unhold(id: number): void {
    const i = this.heldIndex(id);
    if (i < 0) return;
    for (let j = i + 1; j < this.heldCount; j++) {
      this.heldIds[j - 1] = this.heldIds[j];
      this.heldX[j - 1] = this.heldX[j];
    }
    this.heldCount--;
  }

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
