// Zero-asset audio: tiny WebAudio synth so the build has juice with no files.
// Everything is gated behind `enabled` and lazy-inits on first user gesture.

type Sfx =
  | 'multiply' | 'add' | 'bad' | 'hit' | 'break' | 'win' | 'lose' | 'coin' | 'click'
  | 'tick' | 'heartbeat' | 'spark' | 'cheer';

const SPARK_MIN_GAP_MS = 50; // spark fires per bullet impact — cap it at 20/s

export class AudioService {
  private ctx: AudioContext | null = null;
  private master: GainNode | null = null;
  private lastSpark = -Infinity;
  enabled = true;

  private ensure(): boolean {
    if (!this.enabled) return false;
    if (!this.ctx) {
      try {
        this.ctx = new AudioContext();
        this.master = this.ctx.createGain();
        this.master.gain.value = 0.25;
        this.master.connect(this.ctx.destination);
      } catch {
        return false;
      }
    }
    if (this.ctx.state === 'suspended') void this.ctx.resume();
    return true;
  }

  /** Call from a user gesture (first tap) to unlock audio on mobile. */
  unlock(): void {
    this.ensure();
  }

  private blip(freq: number, dur: number, type: OscillatorType = 'square', vol = 1): void {
    if (!this.ensure() || !this.ctx || !this.master) return;
    const t = this.ctx.currentTime;
    const osc = this.ctx.createOscillator();
    const g = this.ctx.createGain();
    osc.type = type;
    osc.frequency.setValueAtTime(freq, t);
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(vol, t + 0.01);
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    osc.connect(g);
    g.connect(this.master);
    osc.start(t);
    osc.stop(t + dur + 0.02);
  }

  /** Band-passed white noise that opens upward — the "crowd roar" bed under a cheer. */
  private noiseSwell(dur: number, vol: number): void {
    if (!this.ensure() || !this.ctx || !this.master) return;
    const t = this.ctx.currentTime;
    const len = Math.max(1, Math.floor(this.ctx.sampleRate * dur));
    const buf = this.ctx.createBuffer(1, len, this.ctx.sampleRate);
    const data = buf.getChannelData(0);
    for (let i = 0; i < len; i++) data[i] = Math.random() * 2 - 1;
    const src = this.ctx.createBufferSource();
    src.buffer = buf;
    const filt = this.ctx.createBiquadFilter();
    filt.type = 'bandpass';
    filt.Q.value = 0.8;
    filt.frequency.setValueAtTime(600, t);
    filt.frequency.exponentialRampToValueAtTime(3000, t + dur);
    const g = this.ctx.createGain();
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(vol, t + dur * 0.65);
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    src.connect(filt);
    filt.connect(g);
    g.connect(this.master);
    src.start(t);
    src.stop(t + dur + 0.02);
  }

  /** A short upward arpeggio whose pitch scales with magnitude (bigger = higher). */
  play(sfx: Sfx, magnitude = 1): void {
    switch (sfx) {
      case 'multiply': {
        const base = 440 + Math.min(magnitude, 6) * 80;
        this.blip(base, 0.08, 'square', 0.9);
        this.blip(base * 1.5, 0.1, 'square', 0.8);
        break;
      }
      case 'add':
        this.blip(520, 0.07, 'triangle', 0.7);
        break;
      case 'bad':
        this.blip(180, 0.18, 'sawtooth', 0.7);
        break;
      case 'hit':
        this.blip(120 + Math.random() * 40, 0.03, 'square', 0.25);
        break;
      case 'break':
        this.blip(90, 0.15, 'sawtooth', 0.8);
        break;
      case 'coin':
        this.blip(880, 0.05, 'triangle', 0.6);
        this.blip(1320, 0.06, 'triangle', 0.5);
        break;
      case 'win':
        [523, 659, 784, 1046].forEach((f, i) =>
          setTimeout(() => this.blip(f, 0.18, 'triangle', 0.8), i * 110),
        );
        break;
      case 'lose':
        [392, 330, 262].forEach((f, i) =>
          setTimeout(() => this.blip(f, 0.22, 'sawtooth', 0.7), i * 140),
        );
        break;
      case 'click':
        this.blip(660, 0.04, 'square', 0.5);
        break;
      case 'tick': {
        // count roll-up blip: magnitude 0..1 rides the pitch up with the jump size
        const m = magnitude < 0 ? 0 : magnitude > 1 ? 1 : magnitude;
        this.blip(600 + m * 800, 0.022, 'square', 0.16);
        break;
      }
      case 'heartbeat':
        this.blip(58, 0.14, 'sine', 0.9);
        setTimeout(() => this.blip(48, 0.16, 'sine', 0.7), 120);
        break;
      case 'spark': {
        const now = performance.now();
        if (now - this.lastSpark < SPARK_MIN_GAP_MS) break;
        this.lastSpark = now;
        this.blip(2100 + Math.random() * 700, 0.014, 'square', 0.08);
        break;
      }
      case 'cheer':
        [523, 659, 784, 988, 1175].forEach((f, i) =>
          setTimeout(() => {
            this.blip(f, 0.22, 'triangle', 0.75);
            this.blip(f * 2, 0.16, 'sine', 0.3);
          }, i * 90),
        );
        this.noiseSwell(0.8, 0.35);
        break;
    }
  }
}
