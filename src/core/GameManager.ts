import * as THREE from 'three';
import type { GameConfig, GameState, LevelDefinition, Segment, SkinDef } from '../data/types';
import { loadConfig } from '../data/ConfigLoader';
import { FetchLevelRepository, wrapsFor, type ILevelRepository } from '../data/LevelRepository';
import { clamp } from '../util/MathUtil';
import { Track } from '../world/Track';
import { CrowdController } from '../crowd/CrowdController';
import { BulletPool } from '../combat/BulletPool';
import { ParticlePool } from '../combat/ParticlePool';
import { InputSystem } from '../systems/InputSystem';
import { QualityManager } from '../systems/QualityManager';
import type { QualityTier } from '../systems/QualityPolicy';
import { HUD, type OverlayOpts } from '../ui/HUD';
import { ShopPanel } from '../ui/ShopPanel';
import { SettingsPanel } from '../ui/SettingsPanel';
import { SaveService } from '../services/SaveService';
import { AudioService, type MusicIntensity } from '../services/AudioService';
import { AdGate, AdServiceStub, type RewardKind } from '../services/AdService';
import { IapServiceStub, type IIapService } from '../services/IapService';
import type { IHapticsService } from '../services/HapticsService';
import { isNative, platform } from '../platform/Platform';
import { createLifecycle, type IAppLifecycle } from '../platform/AppLifecycle';
import { createHaptics } from '../platform/NativeHaptics';
import { GatePair, type GateResult } from '../entities/GatePair';
import { Barricade } from '../entities/Barricade';
import { EnemyCrowd } from '../entities/EnemyCrowd';
import { ObjectiveNode } from '../entities/ObjectiveNode';
import { Boss } from '../entities/Boss';
import { Finish } from '../entities/Finish';
import { Pickup } from '../entities/Pickup';

const BASE_FOV = 56;
const CAM_BACK = 8.5;
const CAM_HEIGHT = 6.2;
const LOOK_AHEAD = 7;
// Classic skin, also the fallback when a config colour isn't '#rrggbb'
// (ConfigLoader only warns about a malformed skin; it never fails the boot).
const DEFAULT_UNIT_COLOR = 0x4ea3ff;
const DEFAULT_TRACER_COLOR = 0xfff1a8;
// Where AUTO graphics starts before it has measured anything. Phones run the
// app at their full device pixel ratio, so the shell starts one tier down and
// climbs only if the frame rate shows it can.
const AUTO_START_TIER: QualityTier = isNative ? 'medium' : 'high';

function hexColor(css: string, fallback: number): number {
  return /^#[0-9a-f]{6}$/i.test(css) ? parseInt(css.slice(1), 16) : fallback;
}

type TargetKind = 'barricade' | 'enemy' | 'objective' | 'boss' | 'gate';
interface Target {
  kind: TargetKind;
  dist: number;
  x: number;
  z: number;
  ref: Barricade | EnemyCrowd | ObjectiveNode | Boss | GatePair;
  halfIdx: number; // 'gate' only: which door the fire is landing on
  weight: number; // share of the crowd's DPS this target receives (kept set sums to 1)
}
/** Centre -> camera-facing (-Z) face, per kind. Tracers aim here so the impact
 *  spark lands on the surface instead of buried inside a solid body. */
const FACE_OFFSET: Record<TargetKind, number> = {
  barricade: 0.35, enemy: 0, objective: 0.85, boss: 0.8, gate: 0,
};

export class GameManager {
  private renderer: THREE.WebGLRenderer;
  private scene = new THREE.Scene();
  private camera: THREE.PerspectiveCamera;
  private sun: THREE.DirectionalLight;

  private cfg!: GameConfig;
  private level!: LevelDefinition;
  private runSpeed = 0;

  private save = new SaveService();
  private audio = new AudioService();
  private haptics: IHapticsService = createHaptics();
  private readonly lifecycle: IAppLifecycle = createLifecycle();
  private quality: QualityManager;
  private ads!: AdGate;
  private iap!: IIapService;
  private levels!: ILevelRepository;
  private input: InputSystem;
  private hud = new HUD();
  private shop!: ShopPanel;
  private settings!: SettingsPanel;

  private track!: Track;
  private crowd!: CrowdController;
  private bullets!: BulletPool;
  private enemyBullets!: BulletPool;
  private particles!: ParticlePool;

  private gates: GatePair[] = [];
  private barricades: Barricade[] = [];
  private enemies: EnemyCrowd[] = [];
  private objectives: ObjectiveNode[] = [];
  private pickups: Pickup[] = [];
  /** Parallel to `pickups`: the crowd is past this one, collected or missed. */
  private pickupPassed: boolean[] = [];
  private boss: Boss | null = null;
  private finish: Finish | null = null;

  private state: GameState = 'MENU';
  private resumeState: GameState = 'PLAYING';
  private time = 0;
  private shake = 0;
  private fovPunch = 0;
  private timeScale = 1;
  private targetTimeScale = 1;
  private bulletAccum = 0;
  private enemyBulletAccum = 0;
  private peakCount = 0;
  private bossBarShown = false;
  private transitioning = false;
  private paused = false;
  private adOpen = false; // between AdGate's onAdOpen and onAdClose: the ad owns the screen
  private shopOpen = false;
  // The lifecycle's view, not document.hidden: in the native shell appStateChange
  // can report the app backgrounded before (or without) the WebView's own event.
  private appHidden = document.hidden;
  private glLost = false; // WebGL context gone: no rendering, the world holds still
  // Bumped on every overlay show/hide, so an ad that resolves late can tell
  // whether the screen whose button started it is still the one up.
  private overlayGen = 0;
  private music: MusicIntensity = 0;
  private skin: SkinDef | null = null;
  // the per-bullet spark reads this, so it is a resolved number, not a lookup
  private tracerColor = DEFAULT_TRACER_COLOR;
  private unitColor = DEFAULT_UNIT_COLOR;
  private runGen = 0;
  private enemyTracerIdx = 0;
  private tickRamp = 0;
  private heartbeatT = 0;
  private chipCueT = 0;
  private lanePreview: number[] = [];
  private lanePreviewCount = -1;
  private rewardDoubled = false;
  private pickupsCollected = 0;

  private readonly app = document.getElementById('app')!;

  constructor(canvas: HTMLCanvasElement) {
    this.renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
    // pixel ratio: QualityManager's, set below once the sun exists
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;

    this.scene.background = new THREE.Color(0x0a0e1a);
    this.scene.fog = new THREE.Fog(0x0a0e1a, 26, 72);

    this.camera = new THREE.PerspectiveCamera(BASE_FOV, 1, 0.1, 240);
    this.camera.position.set(0, CAM_HEIGHT, -CAM_BACK);

    const hemi = new THREE.HemisphereLight(0xbfd4ff, 0x202a3a, 0.9);
    this.scene.add(hemi);
    this.sun = new THREE.DirectionalLight(0xffffff, 1.4);
    this.sun.castShadow = true;
    this.sun.shadow.mapSize.set(1024, 1024);
    const sc = this.sun.shadow.camera as THREE.OrthographicCamera;
    sc.left = -8; sc.right = 8; sc.top = 12; sc.bottom = -12; sc.near = 1; sc.far = 40;
    this.scene.add(this.sun);
    this.scene.add(this.sun.target);
    // Built against the high-tier setup above; applySettings() then pushes the
    // saved graphics mode (pixel ratio, shadows) before the first frame.
    this.quality = new QualityManager(this.renderer, this.sun, this.scene, () => this.resize());

    // The save loads synchronously, so saved Sound/Music/Haptics apply before any
    // gesture can unlock audio: a tap while boot() is still fetching (or after it
    // failed) must not start music the player turned off.
    this.applySettings();
    this.input = new InputSystem(this.app);
    this.input.onFirstInput(() => {
      this.audio.unlock();
    });
    // nothing to open until boot() has built the panels (and never on a failed boot)
    this.hud.setGearVisible(false);

    // Backgrounded (tab switch, phone lock, app switcher): a live run pauses so
    // the player comes back to the pause sheet, and audio goes silent whatever
    // the state. The lifecycle folds visibility, pagehide/pageshow (bfcache) and
    // the native app state into one deduped signal. Registered here, not in
    // boot(), so a slow or failed boot still goes silent; no run can be live
    // before boot() has built the panels, so pause() is never reached early.
    this.lifecycle.onHidden(() => this.onHidden());
    this.lifecycle.onVisible(() => this.onVisible());

    // GPU reset (driver crash, too many contexts, Android trimming a background
    // app): preventDefault asks for a restore. A live run waits on the pause
    // sheet, and tick() neither renders nor simulates until the context is back.
    canvas.addEventListener('webglcontextlost', (e) => {
      e.preventDefault();
      this.glLost = true;
      this.pauseIfLive();
    });
    canvas.addEventListener('webglcontextrestored', () => {
      this.glLost = false;
      // three re-inits its GL state itself; shadow maps and material programs
      // are rebuilt from the tier, which also resizes
      this.quality.reapply();
    });

    window.addEventListener('resize', () => this.resize());
    this.resize();
  }

  async boot(): Promise<void> {
    const base = import.meta.env.BASE_URL;
    this.cfg = await loadConfig(base);
    const levels = new FetchLevelRepository(base, this.cfg);
    await levels.init();
    this.levels = levels; // assigned once count is readable

    const sdk = new AdServiceStub(this.cfg.ads.stubLatencyMs);
    this.ads = new AdGate(sdk, this.cfg.ads, {
      onAdOpen: () => {
        this.adOpen = true; // tick() holds the world still until close
        this.audio.suspend();
        this.refreshGear();
      },
      onAdClose: () => {
        this.adOpen = false;
        // closed while backgrounded: stay silent, onVisible resumes
        if (!this.appHidden) this.audio.resume();
        this.refreshGear();
      },
      adsRemoved: () => this.save.get().removeAds,
      now: () => performance.now() / 1000,
    });
    sdk.init().catch((err: unknown) => console.warn('Ad SDK init failed:', err));
    this.iap = new IapServiceStub(this.cfg.ads.stubLatencyMs);

    this.shop = new ShopPanel(this.save, this.cfg, this.audio, this.iap, () => {
      this.shopOpen = false;
      this.showMenu();
    });
    this.shop.onSkinChanged = () => this.applySkin();
    this.shop.onCoinsChanged = () => this.hud.setCoins(this.save.get().coins);
    this.settings = new SettingsPanel(this.save, this.audio, this.haptics);
    this.settings.onGraphicsChanged = (mode) => this.quality.setMode(mode, AUTO_START_TIER);
    this.hud.onGear = () => this.onGear();
    // Only once the panels exist: until then (and after a failed boot) nothing
    // claims the press, so native back leaves the app as it would a splash.
    this.lifecycle.onBack(() => this.onBack());

    this.crowd = new CrowdController(this.cfg, this.scene, DEFAULT_UNIT_COLOR);
    this.bullets = new BulletPool(this.cfg.combat.maxVisibleBullets, DEFAULT_TRACER_COLOR, this.scene);
    this.enemyBullets = new BulletPool(28, 0xff7a3d, this.scene);
    this.particles = new ParticlePool(240, this.scene);
    this.crowd.particles = this.particles;
    // tracers die into a spark puff instead of blinking out
    this.bullets.onExpire = (x, y, z) => {
      this.particles.burst(x, y, z, 3, this.tracerColor, 2.5);
      this.audio.play('spark'); // self-throttled: this fires ~100×/s at high crowd counts
    };
    this.enemyBullets.onExpire = (x, y, z) => this.particles.burst(x, y, z, 2, 0xff7a3d, 2.0);

    this.applySkin();
    this.hud.onCountTick = (_v, rising) => {
      // consecutive rising ticks climb in pitch, so a big gate reads as a run-up
      this.tickRamp = rising ? Math.min(1, this.tickRamp + 0.06) : 0;
      this.audio.play('tick', this.tickRamp);
    };
    this.hud.onCoinTick = () => this.audio.play('tick', 0.6);

    await this.loadLevel(this.save.get().currentLevel);
    this.hud.setCoins(this.save.get().coins);
    this.showMenu();

    let last = performance.now();
    const loop = (now: number) => {
      const frame = (now - last) / 1000;
      last = now;
      this.tick(Math.min(0.05, frame), frame);
      requestAnimationFrame(loop);
    };
    requestAnimationFrame(loop);
  }

  // ---------------------------------------------------------------- level load
  /**
   * Physical footprint of the formation, not the (much wider) firing lane.
   * Shared by the barricade ram test and the boss sweep so both agree on how
   * much space the crowd actually takes up.
   */
  private crowdHalf(): number {
    return Math.max(0.3, this.cfg.crowd.formationSpacing * Math.sqrt(this.crowd.visibleCount) * 0.55);
  }

  private async loadLevel(n: number): Promise<void> {
    // validated + cached by the repository: shared, so never mutated here
    this.level = await this.levels.load(n);
    this.runSpeed = this.level.forwardSpeed + this.cfg.meta.wrapSpeedStep * wrapsFor(n, this.levels.count);
    if (this.track) { this.scene.remove(this.track.group); this.track.dispose(); }
    this.track = new Track(this.cfg, this.level.length);
    this.scene.add(this.track.group);
    this.buildLevel();
    this.hud.setLevel(this.save.get().currentLevel);
  }

  /** NEXT LEVEL, or RETRY after the next level failed to load (`retry`: this clear was already counted). */
  private async advanceLevel(retry = false): Promise<void> {
    // repeat NEXT LEVEL taps would skip levels; a ×2 ad still open must finish first
    if (this.uiLocked()) return;
    this.transitioning = true;
    this.hideOverlay();
    this.refreshGear();
    const s = this.save.get();
    const from = s.currentLevel;
    try {
      s.currentLevel = from + 1;
      this.save.save(); // before the interstitial: a kill during the ad keeps the clear
      if (!retry) await this.ads.onLevelComplete(); // AdGate owns the cadence, caps and Remove Ads
      await this.loadLevel(s.currentLevel);
    } catch (err) {
      // Offline, or a level file that fails validation. Never keep it as saved
      // progress: every later boot would fail on it too. A failed fetch or check
      // rejects before loadLevel touches the scene, so MENU replays the old level.
      console.error(`Level ${from + 1} failed to load:`, err);
      s.currentLevel = from;
      this.save.save();
      this.showLoadError();
      return;
    } finally {
      this.transitioning = false;
      this.refreshGear();
    }
    this.startRun();
  }

  private showLoadError(): void {
    this.showOverlay({
      title: 'LOAD FAILED',
      body: "The next level couldn't be loaded. Check your connection and try again.",
      btnText: 'RETRY',
      onBtn: () => {
        if (this.uiLocked()) return;
        this.audio.play('click'); void this.advanceLevel(true);
      },
      btn2Text: 'MENU',
      onBtn2: () => {
        if (this.uiLocked()) return;
        this.audio.play('click'); this.quitToMenu(); // back to the start line of the level just cleared
      },
    });
  }

  // ---------------------------------------------------------------- level build
  private buildLevel(): void {
    this.disposeEntities();
    for (const seg of this.level.segments) this.spawnSegment(seg);
  }

  /**
   * Endless scaling: past the authored levels every wrap makes threats bigger and
   * punishes harsher, while rewards (add/mul gates, pickup `value`) stay authored
   * so the balance curve tilts. Must copy: buildLevel re-reads `this.level` on
   * every retry, so scaling in place would compound.
   */
  private scaleSegment(raw: Segment, wraps: number): Segment {
    const f = 1 + this.cfg.meta.wrapDifficultyStep * wraps;
    const seg: Segment = { ...raw };
    if (seg.hp !== undefined) seg.hp = Math.round(seg.hp * f);
    if (seg.count !== undefined) seg.count = Math.round(seg.count * f);
    for (const key of ['left', 'right'] as const) {
      const side = seg[key];
      if (side && (side.op === 'sub' || side.op === 'div')) {
        seg[key] = { op: side.op, value: Math.round(side.value * f) };
      }
    }
    return seg;
  }

  private spawnSegment(raw: Segment): void {
    const wraps = wrapsFor(this.save.get().currentLevel, this.levels.count);
    const seg = wraps > 0 ? this.scaleSegment(raw, wraps) : raw;
    switch (seg.type) {
      case 'gate_pair': {
        const g = new GatePair(seg, this.cfg);
        this.scene.add(g.group);
        this.gates.push(g);
        break;
      }
      case 'barricade': {
        const b = new Barricade(seg, this.cfg);
        this.scene.add(b.group);
        this.barricades.push(b);
        break;
      }
      case 'enemy_crowd': {
        this.enemies.push(new EnemyCrowd(seg, this.cfg, this.scene));
        break;
      }
      case 'objective_node': {
        const o = new ObjectiveNode(seg);
        this.scene.add(o.group);
        this.objectives.push(o);
        break;
      }
      case 'boss': {
        this.boss = new Boss(seg, this.cfg);
        this.scene.add(this.boss.group);
        break;
      }
      case 'finish': {
        this.finish = new Finish(seg, this.cfg);
        this.scene.add(this.finish.group);
        break;
      }
      case 'coin_pickup':
      case 'crowd_pickup': {
        const p = new Pickup(seg, this.cfg, this.unitColor); // a squad that joins you wears your skin
        this.scene.add(p.group);
        this.pickups.push(p);
        this.pickupPassed.push(false);
        break;
      }
    }
  }

  private disposeEntities(): void {
    this.gates.forEach((g) => g.dispose(this.scene));
    this.barricades.forEach((b) => b.dispose(this.scene));
    this.enemies.forEach((e) => e.dispose(this.scene));
    this.objectives.forEach((o) => o.dispose(this.scene));
    this.pickups.forEach((p) => p.dispose(this.scene));
    this.boss?.dispose(this.scene);
    this.finish?.dispose(this.scene);
    this.gates = []; this.barricades = []; this.enemies = [];
    this.objectives = []; this.boss = null; this.finish = null;
    this.pickups = []; this.pickupPassed = [];
    // pooled slots hold refs to the entities just disposed — drop them here,
    // not per frame, so the combat scan stays allocation-free
    this.candidates.length = 0; this.candidateCount = 0;
  }

  // ---------------------------------------------------------------- run control
  private showMenu(): void {
    this.state = 'MENU';
    this.setMusic(0);
    this.hud.setHint(false);
    this.hud.bossBar(false);
    this.hud.setCoins(this.save.get().coins);
    // GDD §10: a rewarded "bonus crowd at level start", only offered when an ad can fill
    const bonus = this.cfg.ads.bonusCrowd;
    const offerBonus = bonus > 0 && this.ads.canOfferRewarded();
    this.showOverlay({
      title: 'Crowd Shooter Runner',
      body: 'Drag to steer your crowd. Pick good gates, smash through enemies, and overwhelm the boss.',
      btnText: 'TAP TO START',
      onBtn: () => {
        if (this.uiLocked()) return;
        this.audio.unlock(); this.audio.play('click'); this.startRun();
      },
      btn2Text: '🛒 SHOP',
      onBtn2: () => {
        if (this.uiLocked()) return;
        this.audio.unlock(); this.audio.play('click'); this.hideOverlay(); this.openShop(() => this.showMenu());
      },
      btn3Text: offerBonus ? `+${bonus} START CROWD (AD)` : undefined,
      onBtn3: offerBonus ? () => { void this.bonusStart(); } : undefined,
    });
    this.refreshGear();
  }

  private startRun(bonus = 0): void {
    this.runGen += 1; // invalidates ad continuations from the previous run
    this.paused = false;
    this.audio.play('click');
    this.hideOverlay();
    // rebuild for a clean slate
    this.buildLevel();
    const s = this.save.get();
    const step = this.cfg.meta.upgradeSteps;
    const start = this.cfg.crowd.startingCount + s.upgrades.startingCrowd * step.startingCrowd + bonus;
    this.crowd.reset(start);
    this.crowd.damageMul = 1 + s.upgrades.bulletPower * step.bulletPower;
    this.crowd.fireRateMul = 1 + s.upgrades.fireRate * step.fireRate;
    this.peakCount = start;
    this.bullets.clear();
    this.enemyBullets.clear();
    this.input.resetCenter();
    this.bossBarShown = false;
    this.hud.bossBar(false);
    this.tickRamp = 0;
    this.heartbeatT = 0;
    this.chipCueT = 0;
    this.lanePreviewCount = -1;
    this.pickupsCollected = 0;
    this.state = 'PLAYING';
    this.setMusic(1);
    this.hud.setHint(true);
    this.hud.setCount(this.crowd.count, true); // a fresh run must not roll up from the last one
    this.hud.setDanger(false);
    this.hud.setProgress(0);
    if (bonus > 0) {
      // the ad's units, called out on the crowd itself (the menu camera sits at the start line)
      this.popupWorld(`+${bonus}`, '#5ce06a', this.crowd.centroid.x, 1.6, this.crowd.centroid.z);
      this.audio.play('add');
    }
    this.refreshGear();
  }

  /** Menu btn3: watch an ad, start the run with cfg.ads.bonusCrowd extra units. */
  private async bonusStart(): Promise<void> {
    if (this.uiLocked()) return;
    this.audio.unlock();
    this.audio.play('click');
    if (await this.rewarded('bonus_crowd', 3)) this.startRun(this.cfg.ads.bonusCrowd);
  }

  /**
   * One rewarded ad started from overlay button `btn`, which shows LOADING...
   * while it runs. Resolves null when the run, the state or the screen moved on
   * meanwhile: the caller then grants nothing and leaves the new overlay alone.
   */
  private async rewarded(kind: RewardKind, btn: 1 | 2 | 3): Promise<boolean | null> {
    if (this.ads.busy) return null;
    const gen = this.runGen;
    const screen = this.overlayGen;
    const state = this.state;
    this.hud.setButtonBusy(btn, true);
    this.hud.setButtonsLocked(true); // uiLocked() ignores the siblings meanwhile, so they must look it
    const ok = await this.ads.showRewarded(kind);
    // a new overlay rebuilt the buttons itself (showOverlay clears busy and locks)
    if (gen !== this.runGen || screen !== this.overlayGen || state !== this.state) return null;
    this.hud.setButtonBusy(btn, false);
    this.hud.setButtonsLocked(false);
    return ok;
  }

  /** Overlay buttons ignore taps while a level change or an ad is in flight. */
  private uiLocked(): boolean {
    return this.transitioning || this.ads.busy;
  }

  private showOverlay(o: OverlayOpts): void {
    this.overlayGen += 1;
    this.hud.showOverlay(o);
  }

  private hideOverlay(): void {
    this.overlayGen += 1;
    this.hud.hideOverlay();
  }

  private openShop(returnTo: () => void): void {
    this.shopOpen = true;
    this.refreshGear();
    this.shop.open(() => {
      this.shopOpen = false;
      returnTo();
      this.refreshGear();
    });
  }

  // ---------------------------------------------------------------- pause / settings
  /**
   * Gear on the menu, pause button mid-run. Hidden on the result screens, under
   * the shop / settings / an ad, and while a level change is in flight.
   */
  private refreshGear(): void {
    const running = this.state === 'PLAYING' || this.state === 'BOSS';
    const show = (running || this.state === 'MENU')
      && !this.transitioning && !this.adOpen && !this.shopOpen && !this.settings.isOpen;
    this.hud.setGearMode(running ? 'pause' : 'settings');
    this.hud.setGearVisible(show);
  }

  private onGear(): void {
    if (this.uiLocked() || this.shopOpen || this.settings.isOpen) return;
    this.audio.unlock(); // the gear may be the player's first tap
    this.audio.play('click');
    if (this.state === 'MENU') {
      this.hideOverlay();
      this.settings.open({
        paused: false,
        onClose: () => this.showMenu(),
        onReset: () => { void this.resetProgress(); },
      });
      this.refreshGear();
    } else if (this.state === 'PLAYING' || this.state === 'BOSS') {
      this.pause();
    }
  }

  /** Freeze a live run under the pause sheet (gear tap, or the app was backgrounded). */
  private pause(): void {
    if (this.paused || (this.state !== 'PLAYING' && this.state !== 'BOSS')) return;
    this.paused = true;
    this.settings.open({
      paused: true,
      onClose: () => this.resumePlay(),
      onQuit: () => this.quitToMenu(),
    });
    this.refreshGear();
  }

  private resumePlay(): void {
    this.paused = false;
    // the steer target is left where it was: resuming must not yank the crowd sideways
    this.refreshGear();
  }

  private quitToMenu(): void {
    this.paused = false;
    this.runGen += 1;
    this.recordPeak(); // a quit still counts toward the best crowd
    this.bullets.clear();
    this.enemyBullets.clear();
    this.hud.setDanger(false);
    this.hud.bossBar(false);
    this.bossBarShown = false;
    this.timeScale = 1;
    this.targetTimeScale = 1;
    // back to the start line, as at boot: the camera eases home behind the menu
    // and a bonus-crowd popup lands on the crowd's real spawn point
    this.buildLevel();
    this.crowd.reset(0);
    this.crowd.update(0, this.time);
    this.hud.setProgress(0);
    this.showMenu();
  }

  /** Settings → RESET PROGRESS (already confirmed by the panel's second tap). */
  private async resetProgress(): Promise<void> {
    if (this.transitioning) return;
    this.transitioning = true;
    this.refreshGear();
    try {
      // Progress only: the player's preferences and a paid Remove Ads are not
      // progress (and the test store's RESTORE PURCHASES never returns anything).
      const s = this.save.get();
      const settings = { ...s.settings };
      const removeAds = s.removeAds;
      this.save.reset();
      this.save.get().settings = settings;
      this.save.setRemoveAds(removeAds); // saves the settings with it
      this.applySkin();
      this.hud.setCoins(this.save.get().coins);
      await this.loadLevel(1);
    } catch (err) {
      console.error('Reset: failed to reload level 1:', err);
    } finally {
      this.transitioning = false;
    }
    this.showMenu();
  }

  /** Backgrounded or GPU reset: a live run drops to the pause sheet, unless an ad owns the screen. */
  private pauseIfLive(): void {
    if ((this.state === 'PLAYING' || this.state === 'BOSS') && !this.paused && !this.adOpen) this.pause();
  }

  private onHidden(): void {
    this.appHidden = true;
    this.pauseIfLive();
    this.audio.suspend();
  }

  private onVisible(): void {
    this.appHidden = false;
    // A revive, bonus start or level change can take a run live while hidden (its
    // ad or fetch settled in the background): come back to the pause sheet anyway.
    this.pauseIfLive();
    if (!this.adOpen) this.audio.resume(); // an open ad resumes audio itself, on close
  }

  /**
   * Android back / web Escape. True = handled; false (only on the menu) lets
   * the native shell exit. Never skips a screen the player has to see: a result
   * screen or an ad in flight swallows it.
   */
  private onBack(): boolean {
    if (this.settings.isOpen) {
      this.settings.close(); // RESUME on the pause sheet, BACK on the menu one
      return true;
    }
    if (this.shopOpen) {
      this.shop.close(); // returns to whichever screen opened it
      return true;
    }
    // an ad loading or up, or a level change in flight: never quit from under it
    if (this.adOpen || this.uiLocked()) return true;
    if (this.state === 'PLAYING' || this.state === 'BOSS') {
      this.pause();
      return true;
    }
    return this.state !== 'MENU'; // WIN / REWARD / LOSE: only their buttons move on
  }

  /** Saved settings → live services (at construction, before any gesture can unlock audio). */
  private applySettings(): void {
    const s = this.save.get().settings;
    this.audio.setSfxEnabled(s.sound);
    this.audio.setMusicEnabled(s.music);
    this.haptics.enabled = s.haptics;
    this.quality.setMode(s.graphics, AUTO_START_TIER);
  }

  /** Equipped skin → unit body and tracer tint. An id the catalog lost falls back to skins[0]. */
  private applySkin(): void {
    const skins = this.cfg.skins;
    const id = this.save.get().equippedSkin;
    const skin = skins.find((s) => s.id === id) ?? skins[0];
    this.skin = skin;
    this.unitColor = hexColor(skin.color, DEFAULT_UNIT_COLOR);
    this.crowd.setColor(this.unitColor);
    this.tracerColor = hexColor(skin.tracer, DEFAULT_TRACER_COLOR);
    this.bullets.setColor(this.tracerColor);
  }

  private setMusic(level: MusicIntensity): void {
    this.music = level;
    this.audio.setMusicIntensity(level);
  }

  // ---------------------------------------------------------------- main tick
  /** `frameSec`: the raw, unclamped frame time, which only the quality sampler reads. */
  private tick(dtReal: number, frameSec: number): void {
    // Paused, under an ad or without a GPU context, the world holds still: no
    // sim, no particles, no entity bob, no camera drift, no slow-mo recovery.
    // Only the HUD keeps real time, so a count or coin roll-up already under
    // way still lands. (A RESUME tapped before the context is back stays frozen.)
    const frozen = this.paused || this.adOpen || this.glLost;
    const dtWorld = frozen ? 0 : dtReal;
    this.time += dtWorld;
    // ease slow-mo
    this.timeScale += (this.targetTimeScale - this.timeScale) * Math.min(1, dtWorld * 6);
    const dt = dtWorld * this.timeScale;

    if ((this.state === 'PLAYING' || this.state === 'BOSS') && !frozen) {
      // Live play only: menus and overlays are cheaper than a run and would
      // read as headroom. Unclamped, so a hitch is seen as one and skipped.
      this.quality.sample(frameSec);
      this.simulate(dt);
    }
    // Unconditional: death pops and the count roll-up must finish playing while
    // an overlay is up, not freeze mid-air.
    this.particles.update(dt);
    this.hud.update(dtReal);
    this.updateEntitiesVisual(dt);
    this.updateCamera(dtWorld);
    if (!this.glLost) this.renderer.render(this.scene, this.camera);
  }

  private simulate(dt: number): void {
    this.chipCueT = Math.max(0, this.chipCueT - dt);

    // INPUT → steer
    this.crowd.steerNormalized(this.input.value);

    // MOVEMENT (forward), unless locked in the boss standoff
    if (this.state === 'PLAYING') {
      this.crowd.advance(this.runSpeed * dt);
      if (this.crowd.centroid.x !== 0) this.hud.setHint(false);
      // enter boss standoff
      const standoff = this.cfg.boss.standoff;
      if (this.boss && this.boss.alive && this.crowd.centroid.z >= this.boss.z - standoff) {
        this.crowd.centroid.z = this.boss.z - standoff;
        this.state = 'BOSS';
        this.bossBarShown = true;
        this.hud.bossBar(true, 1);
        this.setMusic(2);
      }
    }

    this.crowd.update(dt, this.time);
    this.peakCount = Math.max(this.peakCount, this.crowd.count);

    // COMBAT
    this.combat(dt);
    // GATES
    this.gateSystem();
    // COLLISIONS (barricade ram, finish)
    this.collisionSystem();
    this.finishPreview();

    // Boss chip: the standoff bleeds the crowd every frame, so out-waiting the
    // sweep is never a strategy — you have to out-damage it.
    if (this.state === 'BOSS' && this.boss && this.boss.alive) {
      const b = this.cfg.boss;
      const chipped = this.crowd.damage(
        Math.max(b.chipMinUnitsPerSecond, this.crowd.count * b.chipFractionPerSecond) * dt,
      );
      if (chipped >= 1 && this.chipCueT <= 0) {
        this.audio.play('hit');
        this.chipCueT = 0.5; // the bleed is constant; the cue must not be
      }
    }

    // bullets
    this.bullets.update(dt);
    this.enemyBullets.update(dt);

    // HUD
    this.hud.setCount(this.crowd.count);
    const prog = clamp(this.crowd.centroid.z / this.level.length, 0, 1);
    this.hud.setProgress(prog);
    // `count < peakCount` keeps the opening beat clean: a run that starts at the
    // threshold (config startingCount 5) is not "near death" until it has actually
    // lost someone. peakCount is refreshed above, so it is always >= count here.
    const danger = this.crowd.count <= 5 && this.crowd.count < this.peakCount
      && (this.state === 'PLAYING' || this.state === 'BOSS');
    this.hud.setDanger(danger);
    if (danger) {
      this.heartbeatT -= dt;
      if (this.heartbeatT <= 0) {
        this.audio.play('heartbeat');
        this.heartbeatT = 0.9;
      }
    } else {
      this.heartbeatT = 0; // re-entering danger thumps immediately
    }
    if (this.bossBarShown && this.boss) this.hud.bossBar(this.boss.alive, this.boss.hpFraction());

    // boss death → resume to finish
    if (this.state === 'BOSS' && this.boss && !this.boss.alive) {
      this.onBossDefeated();
    }
    // game over
    if (this.crowd.count <= 0) this.onLose();
  }

  // ---------------------------------------------------------------- combat
  /** Target slots reused by findTargets; only `[0, candidateCount)` is live. */
  private candidates: Target[] = [];
  private candidateCount = 0;

  private combat(dt: number): void {
    const c = this.cfg.combat;
    const cx = this.crowd.centroid.x;
    const cz = this.crowd.centroid.z;
    const laneHalf = this.crowd.laneHalf();
    const dps = this.crowd.effectiveDPS();

    // enemies always damage the player while in range + lane overlap
    const firing: EnemyCrowd[] = [];
    for (const e of this.enemies) {
      if (!e.alive) continue;
      const d = e.z - cz;
      if (d < -3 || d > c.engageRange) continue;
      if (!e.overlapsLane(cx, laneHalf)) continue;
      // enemy DPS is raw damage; playerUnitHp converts it into units removed
      const removed = this.crowd.damage((e.enemyDPS() * c.enemyDamageFactor * dt) / c.playerUnitHp);
      firing.push(e);
      if (removed > 0) this.audio.play('hit');
    }
    if (firing.length > 0) {
      this.enemyBulletAccum += dt;
      while (this.enemyBulletAccum > 0.05) {
        this.enemyBulletAccum -= 0.05;
        // round-robin so every firing group visibly shoots, not just the first
        const e = firing[this.enemyTracerIdx++ % firing.length];
        this.enemyBullets.spawn(e.x + (Math.random() - 0.5), 0.5, e.z, cx, cz, c.bulletSpeed * 0.7);
      }
    }

    // spread the crowd's fire over the nearest few targets ahead
    const n = this.findTargets(cx, cz, laneHalf, c.engageRange);
    if (n === 0 || dps <= 0) return;

    for (let i = 0; i < n; i++) {
      const t = this.candidates[i];
      const dmg = dps * dt * t.weight;
      if (t.kind === 'gate') {
        // shooting a tickable gate pumps the door you are aimed at, nothing else
        (t.ref as GatePair).hit(t.halfIdx, dmg);
        continue;
      }
      const ref = t.ref as Barricade | EnemyCrowd | ObjectiveNode | Boss;
      const before = (ref as any).count ?? (ref as any).hp;
      const aliveBefore = ref.alive;
      ref.takeDamage(dmg);

      // rewards / clears
      if (t.kind === 'barricade') {
        if (aliveBefore && !ref.alive) {
          // shot down, not rammed — the green/white payoff for spending fire on it
          this.audio.play('break');
          this.hud.flash('#ffffff', 0.25);
          this.shake = Math.max(this.shake, 0.2);
          this.popupWorld('BREAK', '#5ce06a', (ref as Barricade).x, 1.4, (ref as Barricade).z);
        }
      } else if (t.kind === 'objective') {
        const o = ref as ObjectiveNode;
        if (o.cleared && o.reward > 0) {
          this.crowd.add(o.reward);
          this.popupWorld(`+${o.reward}`, '#5ce06a', o.x, 1.6, o.z);
          this.audio.play('add');
          o.cleared = false; // consume
        }
      } else if (t.kind === 'enemy') {
        const e = ref as EnemyCrowd;
        if (!e.alive && before > 0) this.audio.play('break');
      }
    }

    // Visual tracers toward the targets. Density is the main read on crowd size:
    // it scales with sqrt(count) (like DPS) so 5 units trickle and 500 pour, and
    // each tracer picks a target by damage share so the split is visible.
    const interval =
      clamp(0.09 / Math.sqrt(Math.max(1, this.crowd.count) / 5), 0.008, 0.09) / this.crowd.fireRateMul;
    this.bulletAccum += dt;
    while (this.bulletAccum > interval) {
      this.bulletAccum -= interval;
      const t = this.pickWeighted(n);
      const fromX = cx + (Math.random() * 2 - 1) * Math.max(0.4, laneHalf);
      const fromZ = cz + 0.4;
      this.bullets.spawn(fromX, 0.5, fromZ, t.x, t.z - FACE_OFFSET[t.kind], c.bulletSpeed);
    }
  }

  /** One of the kept targets, drawn in proportion to its damage share. */
  private pickWeighted(n: number): Target {
    let r = Math.random();
    for (let i = 0; i < n; i++) {
      r -= this.candidates[i].weight;
      if (r <= 0) return this.candidates[i];
    }
    return this.candidates[n - 1]; // float drift left a sliver unclaimed
  }

  /** Fills the pooled slot at `candidateCount`, growing the pool only once per slot. */
  private pushCandidate(
    kind: TargetKind, ref: Target['ref'], x: number, z: number, dist: number, halfIdx: number,
  ): void {
    const t = this.candidates[this.candidateCount];
    if (t) {
      t.kind = kind; t.ref = ref; t.x = x; t.z = z; t.dist = dist; t.halfIdx = halfIdx; t.weight = 0;
    } else {
      this.candidates.push({ kind, ref, x, z, dist, halfIdx, weight: 0 });
    }
    this.candidateCount++;
  }

  /**
   * Every in-lane target ahead, nearest first, trimmed to `maxSplitTargets` and
   * weighted by 1/(1 + dist*splitFalloff) normalized over the kept set. Results
   * live in the pooled `candidates` array (reused frame to frame — the combat
   * scan must not allocate); returns how many slots are live. A single target in
   * range gets weight 1, so focused fire is unchanged.
   */
  private findTargets(cx: number, cz: number, laneHalf: number, range: number): number {
    this.candidateCount = 0;
    const consider = (
      kind: TargetKind, ref: Target['ref'], x: number, z: number, half: number,
      alive: boolean, halfIdx = 0,
    ) => {
      if (!alive) return;
      const d = z - cz;
      if (d < -1 || d > range) return;
      if (Math.abs(cx - x) > laneHalf + half) return;
      this.pushCandidate(kind, ref, x, z, d, halfIdx);
    };
    // a dodged barricade survives now, so `passed` also has to stop the crowd
    // from turning around and shooting it
    for (const b of this.barricades) consider('barricade', b, b.x, b.z, b.halfWidth, b.alive && !b.passed);
    for (const e of this.enemies) {
      const myHalf = Math.max(0.4, this.cfg.crowd.formationSpacing * Math.sqrt(e.count) * 0.5);
      consider('enemy', e, e.x, e.z, myHalf, e.alive);
    }
    for (const o of this.objectives) consider('objective', o, o.x, o.z, o.halfWidth, o.alive);
    for (const g of this.gates) {
      if (g.passed || !g.tickable) continue;
      const h = g.overlappingHalf(cx, laneHalf);
      if (h < 0) continue;
      const half = g.halfTarget(h);
      consider('gate', g, half.x, g.z, half.halfWidth, true, h);
    }
    if (this.boss) consider('boss', this.boss, 0, this.boss.z, 1.4, this.boss.alive);

    // Insertion sort by distance: only the handful of entities inside the engage
    // range reach here, and it sorts the pooled prefix in place (no slice/sort).
    const list = this.candidates;
    for (let i = 1; i < this.candidateCount; i++) {
      const t = list[i];
      let j = i - 1;
      while (j >= 0 && list[j].dist > t.dist) { list[j + 1] = list[j]; j--; }
      list[j + 1] = t;
    }

    const keep = Math.min(this.candidateCount, Math.max(1, this.cfg.combat.maxSplitTargets));
    let sum = 0;
    for (let i = 0; i < keep; i++) {
      const w = 1 / (1 + Math.max(0, list[i].dist) * this.cfg.combat.splitFalloff);
      list[i].weight = w;
      sum += w;
    }
    for (let i = 0; i < keep; i++) list[i].weight /= sum;
    return keep;
  }

  // ---------------------------------------------------------------- gates
  private gateSystem(): void {
    const cz = this.crowd.centroid.z;
    const cx = this.crowd.centroid.x;
    for (const g of this.gates) {
      if (g.passed) continue;
      if (cz >= g.z) {
        const res = g.applyFor(cx, this.crowd.count);
        if (res) this.applyGate(res, cx, g.z);
      }
    }
  }

  private applyGate(res: GateResult, x: number, z: number): void {
    this.crowd.count = res.after;
    const delta = res.after - res.before;
    const sym = res.op === 'mul' ? `×${Math.round(res.after / Math.max(1, res.before))}`
      : delta >= 0 ? `+${delta}` : `${delta}`;
    this.popupWorld(sym, res.color, x, 1.6, z);
    this.hud.setCount(this.crowd.count);

    if (res.op === 'mul' && res.after > res.before) {
      const ratio = res.after / Math.max(1, res.before);
      this.audio.play('multiply', ratio);
      this.haptics.pulse(ratio >= 3 ? 'heavy' : 'medium');
      this.hud.flash('#9fe6ff', 0.45);
      this.fovPunch = Math.min(10, 4 + ratio);
      this.shake = Math.max(this.shake, 0.25);
    } else if (res.op === 'add') {
      this.audio.play('add');
      this.haptics.pulse('light');
    } else if (res.after === res.before) {
      this.audio.play('click'); // no-op gate (e.g. a fully decayed tickable): not a punish
    } else {
      this.audio.play('bad');
      this.haptics.pulse('warn');
      this.hud.flash('#ff5a52', 0.3);
      this.shake = Math.max(this.shake, 0.2);
    }
  }

  // ---------------------------------------------------------------- collisions
  private collisionSystem(): void {
    const cz = this.crowd.centroid.z;
    const cx = this.crowd.centroid.x;

    const crowdHalf = this.crowdHalf();

    for (const b of this.barricades) {
      if (b.passed) continue;
      if (cz >= b.z) {
        b.passed = true;
        if (b.alive && b.overlapsLane(cx, crowdHalf)) {
          const lost = this.crowd.kill(b.ramPenalty());
          b.forceBreak();
          if (lost > 0) {
            this.popupWorld(`-${lost}`, '#ff5a52', b.x, 1.2, b.z);
            this.audio.play('break');
            this.haptics.pulse('medium');
            this.hud.flash('#ff5a52', 0.35);
            this.shake = Math.max(this.shake, 0.3);
          }
        }
        // a barricade the crowd steered around stays standing — dodging is a
        // choice you can see behind you, not a free break
      }
    }

    // Pickups: resolved once the crowd reaches their z, either way. A miss is
    // latched without collect() so it scrolls past intact instead of popping.
    for (let i = 0; i < this.pickups.length; i++) {
      if (this.pickupPassed[i]) continue;
      const p = this.pickups[i];
      if (cz < p.z) continue;
      this.pickupPassed[i] = true;
      if (Math.abs(cx - p.x) > crowdHalf + p.halfWidth) continue;
      p.collect();
      this.pickupsCollected += 1;
      if (p.kind === 'coin') {
        this.save.addCoins(p.value);
        this.hud.setCoins(this.save.get().coins);
        this.popupWorld(`+${p.value}`, '#ffd24a', p.x, 1.4, p.z);
        this.audio.play('coin');
        this.particles.burst(p.x, 0.6, p.z, 8, 0xffd24a, 3);
      } else {
        this.crowd.add(p.value);
        this.popupWorld(`+${p.value}`, '#5ce06a', p.x, 1.4, p.z);
        this.audio.play('add'); // the birth ripple fires itself off the count rise
        this.haptics.pulse('light'); // coins stay buzz-free: they are frequent, not a power change
      }
    }

    if (this.finish) {
      if (!this.finish.picked && cz >= this.finish.laneZ) {
        const mult = this.finish.pickFor(cx);
        this.popupWorld(`×${mult}`, '#ffd24a', cx, 1.6, this.finish.laneZ);
        this.audio.play('multiply', mult);
        this.hud.flash('#ffe58a', 0.4);
      }
      if (cz >= this.finish.z && this.state !== 'WIN' && this.state !== 'REWARD') {
        this.onWin(this.finish.pickedMultiplier);
      }
    }
  }

  /**
   * Live coin value under each finish lane while the crowd closes on the bank, so
   * the lane choice is a number comparison instead of a guess.
   */
  private finishPreview(): void {
    const f = this.finish;
    if (!f || f.picked) return;
    if (Math.abs(f.laneZ - this.crowd.centroid.z) > this.cfg.combat.engageRange) return;
    if (this.crowd.count === this.lanePreviewCount) return;
    this.lanePreviewCount = this.crowd.count;
    const per = this.cfg.economy.coinPerUnit + this.save.get().upgrades.income;
    // reused buffer: this runs for as long as the bank is on screen
    if (this.lanePreview.length !== f.lanes.length) this.lanePreview.length = f.lanes.length;
    for (let i = 0; i < f.lanes.length; i++) {
      this.lanePreview[i] = Math.round(this.crowd.count * per * f.lanes[i]);
    }
    f.setLanePreview(this.lanePreview);
  }

  // ---------------------------------------------------------------- visuals
  private updateEntitiesVisual(dt: number): void {
    const cam = this.camera;
    for (const g of this.gates) g.update(dt, cam);
    for (const b of this.barricades) b.update(dt, cam);
    for (const e of this.enemies) e.update(dt, this.time, cam);
    for (const o of this.objectives) o.update(dt, cam);
    for (const p of this.pickups) p.update(dt, this.time, cam);
    if (this.finish) this.finish.update(dt, cam);
    if (this.boss) {
      const frac = this.boss.update(dt, this.time, cam, this.crowd.centroid.x, this.crowdHalf(), this.state === 'BOSS');
      if (frac > 0 && this.state === 'BOSS') {
        const lost = this.crowd.kill(Math.ceil(this.crowd.count * frac));
        if (lost > 0) {
          this.popupWorld(`-${lost}`, '#ff5a52', this.crowd.centroid.x, 1.4, this.crowd.centroid.z);
          this.audio.play('bad');
          this.haptics.pulse('warn');
          this.hud.flash('#ff3b30', 0.4);
          this.shake = Math.max(this.shake, 0.4);
          this.hud.setCount(this.crowd.count);
        }
      }
    }
  }

  private updateCamera(dtReal: number): void {
    const c = this.crowd.centroid;
    // shake
    this.shake = Math.max(0, this.shake - dtReal * 1.6);
    const sh = this.shake;
    const ox = (Math.random() - 0.5) * sh;
    const oy = (Math.random() - 0.5) * sh;

    this.camera.position.x += (c.x * 0.3 + ox - this.camera.position.x) * Math.min(1, dtReal * 8);
    this.camera.position.y += (CAM_HEIGHT + oy - this.camera.position.y) * Math.min(1, dtReal * 8);
    this.camera.position.z += (c.z - CAM_BACK - this.camera.position.z) * Math.min(1, dtReal * 8);
    this.camera.lookAt(c.x * 0.18, 0.6, c.z + LOOK_AHEAD);

    // fov punch decay
    this.fovPunch = Math.max(0, this.fovPunch - dtReal * 24);
    const fov = BASE_FOV + this.fovPunch;
    if (Math.abs(fov - this.camera.fov) > 0.01) {
      this.camera.fov = fov;
      this.camera.updateProjectionMatrix();
    }

    // sun follows crowd for crisp shadows
    this.sun.position.set(c.x + 5, 14, c.z - 4);
    this.sun.target.position.set(c.x, 0, c.z + 2);

    // ease slow-mo back to normal
    if (this.targetTimeScale < 1) this.targetTimeScale = Math.min(1, this.targetTimeScale + dtReal * 1.2);
  }

  // ---------------------------------------------------------------- popups
  private v = new THREE.Vector3();
  private popupWorld(text: string, color: string, x: number, y: number, z: number): void {
    this.v.set(x, y, z).project(this.camera);
    this.hud.popupNDC(text, color, this.v.x, this.v.y);
  }

  // ---------------------------------------------------------------- end states
  private onBossDefeated(): void {
    this.state = 'PLAYING';
    this.setMusic(1);
    this.hud.bossBar(false);
    this.bossBarShown = false;
    this.audio.play('win');
    this.haptics.pulse('heavy');
    this.hud.flash('#ffffff', 0.7);
    this.targetTimeScale = 0.35; // brief slow-mo
    this.timeScale = 0.35;
    this.shake = 0.5;
  }

  private onWin(mult: number): void {
    if (this.state === 'WIN' || this.state === 'REWARD') return;
    this.state = 'WIN';
    const surviving = this.crowd.count;
    const econ = this.cfg.economy;
    const coinPerUnit = econ.coinPerUnit + this.save.get().upgrades.income;
    let coins = Math.round(surviving * coinPerUnit * Math.max(1, mult));
    this.save.addCoins(coins);
    this.hud.setCoins(this.save.get().coins);
    this.audio.play('cheer');
    this.haptics.pulse('success');
    this.setMusic(0);
    this.hud.setDanger(false);
    const isNewBest = this.recordPeak();
    this.rewardDoubled = false;

    this.state = 'REWARD';
    this.showReward(surviving, mult, coins, isNewBest);
    this.refreshGear();
  }

  /** Persists the run's peak crowd if it beat the record; true when it did. */
  private recordPeak(): boolean {
    const s = this.save.get();
    if (this.peakCount <= s.bestPeak) return false;
    s.bestPeak = this.peakCount;
    this.save.save();
    return true;
  }

  private showReward(surviving: number, mult: number, coins: number, isNewBest: boolean): void {
    this.overlayGen += 1; // showRewardCeremony is an overlay show too
    this.hud.showRewardCeremony({
      survivors: surviving,
      mult,
      coins,
      best: this.save.get().bestPeak,
      isNewBest,
      onNext: () => {
        if (this.uiLocked()) return;
        this.audio.play('click'); void this.advanceLevel();
      },
      onDouble: () => { void this.doubleCoins(coins); },
      onShop: () => {
        if (this.uiLocked()) return;
        this.audio.play('click');
        this.hideOverlay();
        this.openShop(() => {
          this.hud.setCoins(this.save.get().coins);
          this.showReward(surviving, mult, coins, isNewBest); // replays the ceremony from the top
        });
      },
    });
    // a re-show (returning from the shop) must not re-arm an already-claimed ×2
    if (this.rewardDoubled) this.hud.setRewardCoins(coins * 2, true);
    else if (!this.ads.canOfferRewarded()) this.withdrawDoubleOffer();
  }

  /**
   * No fill: the ceremony would still reveal a ×2 button that can only fail.
   * HUD has no option to omit it, so hide it the way setRewardCoins(…, true)
   * does; the next showOverlay() rebuilds btn2 from scratch.
   */
  private withdrawDoubleOffer(): void {
    const btn = document.getElementById('overlay-btn2');
    if (!btn) return;
    btn.classList.add('hidden');
    btn.onclick = null;
  }

  private async doubleCoins(coins: number): Promise<void> {
    if (this.rewardDoubled || this.uiLocked()) return;
    this.audio.play('click');
    const ok = await this.rewarded('double_coins', 2); // null: the run moved on during the ad
    if (!ok || this.rewardDoubled) return;
    this.rewardDoubled = true;
    this.save.addCoins(coins);
    this.hud.setCoins(this.save.get().coins);
    this.audio.play('coin');
    this.hud.setRewardCoins(coins * 2, true);
  }

  private onLose(): void {
    // only a live run can be lost: the finish may already have paid out this frame
    if (this.state !== 'PLAYING' && this.state !== 'BOSS') return;
    this.resumeState = this.boss && this.bossBarShown ? 'BOSS' : 'PLAYING';
    this.state = 'LOSE';
    this.audio.play('lose');
    this.haptics.pulse('fail');
    this.setMusic(0);
    this.hud.bossBar(false);
    this.hud.setDanger(false); // simulate() stops here, so clear the vignette by hand
    this.recordPeak();
    this.showLoseOverlay();
    this.refreshGear();
  }

  private showLoseOverlay(): void {
    const canRevive = this.ads.canOfferRewarded(); // no fill: no REVIVE button to fail on
    this.showOverlay({
      title: 'OUT OF CROWD',
      body: 'Your swarm was wiped out.',
      btnText: 'RETRY',
      onBtn: () => {
        if (this.uiLocked()) return;
        this.audio.play('click'); this.startRun();
      },
      btn2Text: canRevive ? 'REVIVE (AD)' : undefined,
      onBtn2: canRevive ? () => { void this.reviveFromAd(); } : undefined,
      btn3Text: '🛒 SHOP',
      onBtn3: () => {
        if (this.uiLocked()) return;
        this.audio.play('click');
        this.hideOverlay();
        this.openShop(() => {
          this.hud.setCoins(this.save.get().coins);
          this.showLoseOverlay();
        });
      },
    });
  }

  private async reviveFromAd(): Promise<void> {
    if (this.uiLocked()) return;
    this.audio.play('click');
    if (await this.rewarded('revive', 2)) this.revive(); // null: the run moved on during the ad
  }

  private revive(): void {
    const amount = Math.max(10, Math.floor(this.peakCount * this.cfg.meta.reviveFraction));
    this.crowd.count = amount;
    this.hud.setCount(amount, true); // a revive is a hard reset, not a roll-up
    this.hideOverlay();
    if (this.resumeState === 'BOSS' && this.boss) this.hud.bossBar(true, this.boss.hpFraction());
    this.state = this.resumeState;
    this.setMusic(this.state === 'BOSS' ? 2 : 1);
    this.refreshGear();
  }

  // ---------------------------------------------------------------- debug
  debug(): Record<string, unknown> {
    return {
      state: this.state,
      count: this.crowd?.count,
      z: this.crowd ? +this.crowd.centroid.z.toFixed(1) : 0,
      x: this.crowd ? +this.crowd.centroid.x.toFixed(2) : 0,
      bossHp: this.boss ? Math.ceil(this.boss.hp) : null,
      bossAttack: this.boss ? this.boss.currentAttack : null,
      pickups: this.pickupsCollected,
      runSpeed: +this.runSpeed.toFixed(2),
      coins: this.save.get().coins,
      peak: this.peakCount,
      bestPeak: this.save.get().bestPeak,
      paused: this.paused,
      adOpen: this.adOpen,
      adBusy: this.ads ? this.ads.busy : false,
      skin: this.skin ? this.skin.id : null,
      music: this.music,
      settings: { ...this.save.get().settings },
      removeAds: this.save.get().removeAds,
      levelCount: this.levels ? this.levels.count : null,
      platform,
      tier: this.quality.tier,
      graphics: this.quality.mode,
      glLost: this.glLost,
    };
  }

  /** Test helper: drive the steer target directly (0..1). */
  debugSteer(t: number): void {
    this.input.setTargetDebug(t);
  }

  // ---------------------------------------------------------------- resize
  private resize(): void {
    const w = this.app.clientWidth || window.innerWidth;
    const h = this.app.clientHeight || window.innerHeight;
    this.renderer.setSize(w, h, false);
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
  }
}
