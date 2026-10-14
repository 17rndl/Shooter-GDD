// Zero-asset audio: tiny WebAudio synth (SFX + a procedural music loop) so the
// build has juice with no files. Nothing touches WebAudio before unlock() (the
// first user gesture), so autoplay policy never sees a context created early.
//
//   SFX voices ──────────────────────────────> sfxBus ───┐
//   pad / bass / arp ──> musicFilter (lowpass) ─┐        ├─> master (0.25) ─> out
//   kick, hat (highpass), clap (bandpass) ──────┴> musicBus ┘
//
// Drums bypass the lowpass so hats stay crisp while the tonal layers are dark.

export type Sfx =
  | 'multiply' | 'add' | 'bad' | 'hit' | 'break' | 'win' | 'lose' | 'coin' | 'click'
  | 'tick' | 'heartbeat' | 'spark' | 'cheer';

/** 0 menu/reward/lose, 1 run, 2 boss. */
export type MusicIntensity = 0 | 1 | 2;

const SPARK_MIN_GAP_MS = 50; // spark fires per bullet impact — cap it at 20/s

const MASTER_GAIN = 0.25;
const MUSIC_GAIN = 0.5; // the loop sits under the SFX
const FADE_TC = 0.08; // setTargetAtTime constant: ~95% of the way in 0.24 s
const FADE_OUT_SEC = 0.35; // keep feeding notes into a fade-out this long, then stop
const NOISE_SEC = 1;

// Lookahead scheduler: a coarse JS timer queues notes slightly ahead on the
// sample-accurate audio clock, so timer jitter never reaches the groove.
const TICK_MS = 25;
const LOOKAHEAD_SEC = 0.12;
const LATE_SEC = 0.05; // woke this far behind (throttled tab): skip ahead, never play the backlog
const START_DELAY_SEC = 0.05;
const MAX_STEPS_PER_TICK = 8; // bounds the loop if the clock ever misbehaves

const BPM = 116;
const BOSS_TEMPO = 1.06;
const STEPS_PER_BAR = 16;
const LOOP_STEPS = 64; // 4 bars on a 16th grid: C - G - Am - F
const CUTOFF_HZ = [900, 2200, 5200]; // music lowpass per intensity: the boss opens it up
const CUTOFF_TC = 0.25;

const PAD_VOL = 0.045;
const BASS_VOL = 0.14;
const ARP_VOL = 0.055;
const ARP_HI_VOL = 0.04;
const KICK_VOL = 0.5;
const HAT_VOL = 0.1;
const CLAP_VOL = 0.3;

const hz = (midi: number): number => 440 * Math.pow(2, (midi - 69) / 12);
// one row per bar; voicings picked for smooth voice leading round the loop
const PAD = [[60, 64, 67], [59, 62, 67], [60, 64, 69], [60, 65, 69]].map((r) => r.map(hz));
const BASS = [36, 43, 45, 41].map(hz);
const ARP = [[72, 76, 79, 84], [71, 74, 79, 83], [72, 76, 81, 84], [72, 77, 81, 84]].map((r) => r.map(hz));
const ARP_ORDER = [0, 1, 2, 3, 2, 1, 2, 3]; // cycled twice per bar

const noop = (): void => {};

export class AudioService {
  private ctx: AudioContext | null = null;
  private master: GainNode | null = null;
  private sfxBus: GainNode | null = null;
  private musicBus: GainNode | null = null;
  private musicFilter: BiquadFilterNode | null = null;
  private hatFilter: BiquadFilterNode | null = null;
  private clapFilter: BiquadFilterNode | null = null;
  private noise: AudioBuffer | null = null; // generated once; hats, claps and the cheer all read it
  private failed = false; // no WebAudio here: stop retrying on every play()
  private unlocked = false;
  private suspended = false;
  private sfxOn = true;
  private musicOn = true;
  private lastSpark = -Infinity;

  private timer: ReturnType<typeof setInterval> | null = null;
  private playing = false; // the loop position is live (cleared once a fade-out completes)
  private step = 0; // 0..LOOP_STEPS-1
  private nextNoteTime = 0; // audio-clock time of `step`
  private stepDur = 60 / BPM / 4;
  private intensity: MusicIntensity = 0; // what the loop plays now
  private wantIntensity: MusicIntensity = 0; // lands on the next bar line
  private stopAt = Infinity; // audio-clock time a fade-out halts the scheduler

  get sfxEnabled(): boolean {
    return this.sfxOn;
  }

  get musicEnabled(): boolean {
    return this.musicOn;
  }

  /** Builds the graph once. Only reachable after unlock(). */
  private ensureCtx(): AudioContext | null {
    if (this.ctx) return this.ctx;
    if (this.failed || !this.unlocked) return null;
    try {
      const ctx = new AudioContext();
      const master = ctx.createGain();
      master.gain.value = MASTER_GAIN;
      master.connect(ctx.destination);
      const sfxBus = ctx.createGain();
      sfxBus.connect(master);
      const len = Math.floor(ctx.sampleRate * NOISE_SEC);
      const noise = ctx.createBuffer(1, len, ctx.sampleRate);
      const data = noise.getChannelData(0);
      for (let i = 0; i < len; i++) data[i] = Math.random() * 2 - 1;
      this.master = master;
      this.buildMusicChain(ctx);

      this.ctx = ctx;
      this.sfxBus = sfxBus;
      this.noise = noise;
      return ctx;
    } catch {
      this.failed = true;
      return null;
    }
  }

  /**
   * Fresh music filters into a fresh bus at gain 0, swapped in whenever a loop
   * fully stops. The stopped loop's pad and bass tails are scheduled up to a bar
   * ahead and stay wired to the detached old bus, so a quick re-enable can't
   * fade them back in over the new bar 1. Allocates only on start/stop.
   */
  private buildMusicChain(ctx: AudioContext): void {
    if (!this.master) return;
    this.musicBus?.disconnect();
    const musicBus = ctx.createGain();
    musicBus.gain.value = 0; // fades in when the loop starts
    musicBus.connect(this.master);
    const musicFilter = ctx.createBiquadFilter();
    musicFilter.type = 'lowpass';
    musicFilter.Q.value = 0.8;
    musicFilter.frequency.value = CUTOFF_HZ[this.wantIntensity]; // the next loop opens at its own brightness
    musicFilter.connect(musicBus);
    const hatFilter = ctx.createBiquadFilter();
    hatFilter.type = 'highpass';
    hatFilter.frequency.value = 7000;
    hatFilter.connect(musicBus);
    const clapFilter = ctx.createBiquadFilter();
    clapFilter.type = 'bandpass';
    clapFilter.frequency.value = 1400;
    clapFilter.Q.value = 0.9;
    clapFilter.connect(musicBus);
    this.musicBus = musicBus;
    this.musicFilter = musicFilter;
    this.hatFilter = hatFilter;
    this.clapFilter = clapFilter;
  }

  // Our own flags decide run/park: ctx.state lags behind queued suspend()/resume()
  // calls, which the context applies in order, so the last call always wins.
  private wake(): void {
    const ctx = this.ensureCtx();
    if (ctx) void ctx.resume().catch(noop);
  }

  /** Muted with no loop left: park the context so it stops holding the OS audio session. */
  private idle(): void {
    if (this.ctx && !this.sfxOn && !this.playing) void this.ctx.suspend().catch(noop);
  }

  /** SFX gate: no-op until unlocked, while suspended or muted, and never builds the context early. */
  private sfxCtx(): AudioContext | null {
    if (!this.sfxOn || this.suspended || !this.unlocked) return null;
    const ctx = this.ensureCtx();
    // heals an OS interruption (call, Siri) the same way the old lazy init did
    if (ctx && ctx.state !== 'running') void ctx.resume().catch(noop);
    return ctx;
  }

  /** Call from a user gesture (first tap) to unlock audio on mobile. Safe on every tap. */
  unlock(): void {
    this.unlocked = true;
    // a fully muted player never gets a running context
    if (!this.sfxOn && !this.musicOn) return;
    const ctx = this.ensureCtx();
    if (!ctx) return;
    if (this.suspended) {
      // built inside the gesture so the later resume() is allowed; hold it until then
      void ctx.suspend().catch(noop);
      return;
    }
    void ctx.resume().catch(noop);
    if (this.musicOn) this.startMusic();
  }

  setSfxEnabled(on: boolean): void {
    this.sfxOn = on;
    if (!on) this.idle();
    else if (this.unlocked && !this.suspended) this.wake();
  }

  /** Fades the loop in/out. Before unlock() or while suspended this only records the wish. */
  setMusicEnabled(on: boolean): void {
    this.musicOn = on;
    if (on) {
      if (!this.unlocked || this.suspended) return;
      this.wake();
      this.startMusic();
      return;
    }
    const ctx = this.ctx;
    if (!this.playing || !ctx || !this.musicBus) return;
    const now = ctx.currentTime;
    if (this.suspended) {
      // frozen clock, nothing to fade: drop the loop (and its queued notes with
      // the old bus); resume() then has nothing to restart
      this.buildMusicChain(ctx);
      this.playing = false;
      return;
    }
    this.musicBus.gain.setTargetAtTime(0, now, FADE_TC);
    this.stopAt = now + FADE_OUT_SEC;
  }

  /** The layer change lands on the next bar line, never mid-note. */
  setMusicIntensity(level: MusicIntensity): void {
    this.wantIntensity = level;
  }

  /** App hidden / ad open. Idempotent and safe before unlock. */
  suspend(): void {
    if (this.suspended) return;
    this.suspended = true;
    this.clearTimer();
    if (this.ctx) void this.ctx.suspend().catch(noop);
  }

  /** Undoes suspend(). The loop picks up where it left off, resynced to the clock. */
  resume(): void {
    if (!this.suspended) return;
    this.suspended = false;
    const ctx = this.ctx;
    if (!this.unlocked || !ctx) return; // unlock() builds and starts everything later
    if (this.sfxOn || this.musicOn || this.playing) this.wake();
    if (this.playing) {
      if (this.nextNoteTime < ctx.currentTime) this.skipTo(ctx.currentTime);
      this.runTimer(); // a fade-out cut short by suspend() finishes, then halts
    } else if (this.musicOn) {
      this.startMusic();
    }
  }

  // ---- music ---------------------------------------------------------------

  /** A fresh loop from bar 1, or (still fading out) just turn it back up. */
  private startMusic(): void {
    const ctx = this.ctx;
    if (!ctx || !this.musicBus || !this.unlocked || this.suspended || !this.musicOn) return;
    const now = ctx.currentTime;
    this.stopAt = Infinity;
    this.musicBus.gain.setTargetAtTime(MUSIC_GAIN, now, FADE_TC);
    if (!this.playing) {
      this.playing = true;
      this.step = 0;
      this.nextNoteTime = now + START_DELAY_SEC;
      this.applyIntensity(now); // a fresh start is a bar line
    }
    this.runTimer();
  }

  private runTimer(): void {
    if (this.timer === null) this.timer = setInterval(this.tick, TICK_MS);
    this.tick();
  }

  private clearTimer(): void {
    if (this.timer === null) return;
    clearInterval(this.timer);
    this.timer = null;
  }

  private applyIntensity(at: number): void {
    this.intensity = this.wantIntensity;
    this.stepDur = 60 / (BPM * (this.intensity === 2 ? BOSS_TEMPO : 1)) / 4;
    this.musicFilter?.frequency.setTargetAtTime(CUTOFF_HZ[this.intensity], at, CUTOFF_TC);
  }

  /** Late wake: jump to the first 16th on the grid after `now`, keeping the bar position honest. */
  private skipTo(now: number): void {
    const missed = Math.ceil((now - this.nextNoteTime) / this.stepDur);
    if (missed <= 0) return;
    const toBar = (STEPS_PER_BAR - (this.step % STEPS_PER_BAR)) % STEPS_PER_BAR;
    this.nextNoteTime += missed * this.stepDur;
    this.step = (this.step + missed) % LOOP_STEPS;
    // a pending intensity change whose bar line got skipped still lands
    if (missed > toBar && this.wantIntensity !== this.intensity) this.applyIntensity(this.nextNoteTime);
  }

  private readonly tick = (): void => {
    const ctx = this.ctx;
    if (!ctx) return;
    const now = ctx.currentTime;
    if (!this.musicOn && now >= this.stopAt) {
      this.clearTimer();
      this.playing = false;
      this.buildMusicChain(ctx); // the bus is near silent now, so the swap can't click
      this.idle();
      return;
    }
    if (this.nextNoteTime < now - LATE_SEC) this.skipTo(now);
    const horizon = now + LOOKAHEAD_SEC;
    for (let n = 0; n < MAX_STEPS_PER_TICK && this.nextNoteTime < horizon; n++) {
      const t = this.nextNoteTime;
      if (this.step % STEPS_PER_BAR === 0 && this.wantIntensity !== this.intensity) this.applyIntensity(t);
      this.scheduleStep(ctx, t);
      this.nextNoteTime = t + this.stepDur;
      this.step = (this.step + 1) % LOOP_STEPS;
    }
  };

  private scheduleStep(ctx: AudioContext, t: number): void {
    const filt = this.musicFilter;
    if (!filt) return;
    const s = this.step % STEPS_PER_BAR;
    const bar = (this.step / STEPS_PER_BAR) | 0;
    const d = this.stepDur;
    const root = BASS[bar];
    if (s === 0) {
      const chord = PAD[bar];
      for (let i = 0; i < chord.length; i++) this.pad(ctx, chord[i], t, d * STEPS_PER_BAR);
    }
    if (this.intensity === 0) {
      // menu: a lazy syncopated root under the pad
      if (s === 0 || s === 8) this.tone(ctx, filt, 'square', root, t, d * 5, BASS_VOL, 0.01);
      else if (s === 6 || s === 14) this.tone(ctx, filt, 'square', root, t, d * 1.6, BASS_VOL * 0.8, 0.01);
      return;
    }
    // run: driving 8ths with an octave pop on the offbeats
    const beat = s % 4;
    if (beat === 0 || beat === 2) {
      this.tone(ctx, filt, 'square', beat === 2 ? root * 2 : root, t, d * 1.7, BASS_VOL, 0.008);
    }
    const note = ARP[bar][ARP_ORDER[s % 8]];
    this.tone(ctx, filt, 'square', note, t, d * 0.9, ARP_VOL, 0.005);
    if (beat === 0) this.kick(ctx, t);
    else if (beat === 2) this.hat(ctx, t);
    if (this.intensity === 2) {
      this.tone(ctx, filt, 'triangle', note * 2, t, d * 0.8, ARP_HI_VOL, 0.005);
      if (s === 4 || s === 12) this.clap(ctx, t);
    }
  }

  // ---- voices: one source + one gain envelope each, stop() always scheduled ----

  private tone(
    ctx: AudioContext, dest: AudioNode, type: OscillatorType,
    freq: number, t: number, dur: number, vol: number, attack: number,
  ): void {
    const osc = ctx.createOscillator();
    const g = ctx.createGain();
    osc.type = type;
    osc.frequency.setValueAtTime(freq, t);
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(vol, t + attack);
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    osc.connect(g);
    g.connect(dest);
    osc.start(t);
    osc.stop(t + dur + 0.02);
  }

  /** Swelling bar-long chord tone; overlaps the next bar a touch so the pad never gaps. */
  private pad(ctx: AudioContext, freq: number, t: number, len: number): void {
    if (!this.musicFilter) return;
    const osc = ctx.createOscillator();
    const g = ctx.createGain();
    osc.type = 'sawtooth';
    osc.frequency.setValueAtTime(freq, t);
    g.gain.setValueAtTime(0, t);
    g.gain.linearRampToValueAtTime(PAD_VOL, t + 0.25);
    g.gain.setValueAtTime(PAD_VOL, t + len - 0.12);
    g.gain.linearRampToValueAtTime(0, t + len + 0.1);
    osc.connect(g);
    g.connect(this.musicFilter);
    osc.start(t);
    osc.stop(t + len + 0.12);
  }

  private kick(ctx: AudioContext, t: number): void {
    if (!this.musicBus) return;
    const osc = ctx.createOscillator();
    const g = ctx.createGain();
    osc.type = 'sine';
    osc.frequency.setValueAtTime(160, t);
    osc.frequency.exponentialRampToValueAtTime(46, t + 0.11);
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(KICK_VOL, t + 0.004);
    g.gain.exponentialRampToValueAtTime(0.0001, t + 0.26);
    osc.connect(g);
    g.connect(this.musicBus);
    osc.start(t);
    osc.stop(t + 0.28);
  }

  private hat(ctx: AudioContext, t: number): void {
    if (!this.noise || !this.hatFilter) return;
    const src = ctx.createBufferSource();
    src.buffer = this.noise;
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(HAT_VOL, t + 0.002);
    g.gain.exponentialRampToValueAtTime(0.0001, t + 0.045);
    src.connect(g);
    g.connect(this.hatFilter);
    src.start(t, Math.random() * (NOISE_SEC - 0.1)); // random read point: no two hats identical
    src.stop(t + 0.05);
  }

  /** Three quick slaps then a short tail: the classic drum-machine clap. */
  private clap(ctx: AudioContext, t: number): void {
    if (!this.noise || !this.clapFilter) return;
    const src = ctx.createBufferSource();
    src.buffer = this.noise;
    const g = ctx.createGain();
    for (let i = 0; i < 3; i++) {
      const s = t + i * 0.011;
      g.gain.setValueAtTime(CLAP_VOL, s);
      g.gain.exponentialRampToValueAtTime(CLAP_VOL * 0.12, s + 0.009);
    }
    g.gain.setValueAtTime(CLAP_VOL * 0.85, t + 0.033);
    g.gain.exponentialRampToValueAtTime(0.0001, t + 0.2);
    src.connect(g);
    g.connect(this.clapFilter);
    src.start(t, Math.random() * (NOISE_SEC - 0.3));
    src.stop(t + 0.22);
  }

  // ---- SFX -----------------------------------------------------------------

  private blip(freq: number, dur: number, type: OscillatorType = 'square', vol = 1): void {
    const ctx = this.sfxCtx();
    if (!ctx || !this.sfxBus) return;
    this.tone(ctx, this.sfxBus, type, freq, ctx.currentTime, dur, vol, 0.01);
  }

  /** Band-passed white noise that opens upward — the "crowd roar" bed under a cheer. */
  private noiseSwell(dur: number, vol: number): void {
    const ctx = this.sfxCtx();
    if (!ctx || !this.sfxBus || !this.noise) return;
    const t = ctx.currentTime;
    const src = ctx.createBufferSource();
    src.buffer = this.noise;
    src.loop = true; // the shared buffer covers any swell length
    const filt = ctx.createBiquadFilter();
    filt.type = 'bandpass';
    filt.Q.value = 0.8;
    filt.frequency.setValueAtTime(600, t);
    filt.frequency.exponentialRampToValueAtTime(3000, t + dur);
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(vol, t + dur * 0.65);
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    src.connect(filt);
    filt.connect(g);
    g.connect(this.sfxBus);
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
