import * as THREE from 'three';
import type { GameConfig, GameState, LevelDefinition, Segment } from '../data/types';
import { clamp } from '../util/MathUtil';
import { Track } from '../world/Track';
import { CrowdController } from '../crowd/CrowdController';
import { BulletPool } from '../combat/BulletPool';
import { InputSystem } from '../systems/InputSystem';
import { HUD } from '../ui/HUD';
import { ShopPanel } from '../ui/ShopPanel';
import { SaveService } from '../services/SaveService';
import { AudioService } from '../services/AudioService';
import { AdServiceStub, type IAdService } from '../services/AdService';
import { GatePair, type GateResult } from '../entities/GatePair';
import { Barricade } from '../entities/Barricade';
import { EnemyCrowd } from '../entities/EnemyCrowd';
import { ObjectiveNode } from '../entities/ObjectiveNode';
import { Boss } from '../entities/Boss';
import { Finish } from '../entities/Finish';

const BASE_FOV = 56;
const CAM_BACK = 8.5;
const CAM_HEIGHT = 6.2;
const LOOK_AHEAD = 7;
const AVAILABLE_LEVELS = 3;
const INTERSTITIAL_EVERY = 2; // show an interstitial every N level completions

type TargetKind = 'barricade' | 'enemy' | 'objective' | 'boss' | 'gate';
interface Target {
  kind: TargetKind;
  dist: number;
  x: number;
  z: number;
  ref: Barricade | EnemyCrowd | ObjectiveNode | Boss | GatePair;
  halfIdx?: number; // 'gate' only: which door the fire is landing on
}

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
  private ads: IAdService = new AdServiceStub();
  private input: InputSystem;
  private hud = new HUD();
  private shop!: ShopPanel;

  private track!: Track;
  private crowd!: CrowdController;
  private bullets!: BulletPool;
  private enemyBullets!: BulletPool;

  private gates: GatePair[] = [];
  private barricades: Barricade[] = [];
  private enemies: EnemyCrowd[] = [];
  private objectives: ObjectiveNode[] = [];
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
  private levelsClearedThisSession = 0;
  private transitioning = false;
  private runGen = 0;
  private enemyTracerIdx = 0;

  private readonly app = document.getElementById('app')!;

  constructor(canvas: HTMLCanvasElement) {
    this.renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
    this.renderer.setPixelRatio(Math.min(2, window.devicePixelRatio));
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

    this.input = new InputSystem(this.app);
    this.input.onFirstInput(() => {
      this.audio.unlock();
    });

    window.addEventListener('resize', () => this.resize());
    this.resize();
  }

  async boot(): Promise<void> {
    const base = import.meta.env.BASE_URL;
    this.cfg = await fetch(`${base}config.json`).then((r) => r.json() as Promise<GameConfig>);
    this.shop = new ShopPanel(this.save, this.cfg, this.audio, () => this.showMenu());

    this.crowd = new CrowdController(this.cfg, this.scene);
    this.bullets = new BulletPool(this.cfg.combat.maxVisibleBullets, 0xfff1a8, this.scene);
    this.enemyBullets = new BulletPool(28, 0xff7a3d, this.scene);

    await this.loadLevel(this.save.get().currentLevel);
    this.hud.setCoins(this.save.get().coins);
    this.showMenu();

    let last = performance.now();
    const loop = (now: number) => {
      const dtReal = Math.min(0.05, (now - last) / 1000);
      last = now;
      this.tick(dtReal);
      requestAnimationFrame(loop);
    };
    requestAnimationFrame(loop);
  }

  // ---------------------------------------------------------------- level load
  private levelPath(n: number): string {
    const wrapped = (((n - 1) % AVAILABLE_LEVELS) + AVAILABLE_LEVELS) % AVAILABLE_LEVELS + 1;
    return `${import.meta.env.BASE_URL}levels/level_${String(wrapped).padStart(3, '0')}.json`;
  }

  /** How many times the authored level list has been looped (endless mode). */
  private wrapsFor(n: number): number {
    // clamped: a corrupt save with currentLevel < 1 must never scale threats down
    return Math.max(0, Math.floor((n - 1) / AVAILABLE_LEVELS));
  }

  /**
   * Physical footprint of the formation, not the (much wider) firing lane.
   * Shared by the barricade ram test and the boss sweep so both agree on how
   * much space the crowd actually takes up.
   */
  private crowdHalf(): number {
    return Math.max(0.3, this.cfg.crowd.formationSpacing * Math.sqrt(this.crowd.visibleCount) * 0.55);
  }

  private async loadLevel(n: number): Promise<void> {
    this.level = await fetch(this.levelPath(n)).then((r) => r.json() as Promise<LevelDefinition>);
    this.runSpeed = this.level.forwardSpeed + this.cfg.meta.wrapSpeedStep * this.wrapsFor(n);
    if (this.track) { this.scene.remove(this.track.group); this.track.dispose(); }
    this.track = new Track(this.cfg, this.level.length);
    this.scene.add(this.track.group);
    this.buildLevel();
    this.hud.setLevel(this.save.get().currentLevel);
  }

  private async advanceLevel(): Promise<void> {
    if (this.transitioning) return; // repeat NEXT LEVEL taps would skip levels
    this.transitioning = true;
    this.hud.hideOverlay();
    try {
      const s = this.save.get();
      s.currentLevel += 1;
      this.save.save();
      this.levelsClearedThisSession += 1;
      if (this.levelsClearedThisSession % INTERSTITIAL_EVERY === 0) {
        await this.ads.showInterstitial();
      }
      await this.loadLevel(s.currentLevel);
      this.startRun();
    } finally {
      this.transitioning = false;
    }
  }

  // ---------------------------------------------------------------- level build
  private buildLevel(): void {
    this.disposeEntities();
    for (const seg of this.level.segments) this.spawnSegment(seg);
  }

  /**
   * Endless scaling: past the authored levels every wrap makes threats bigger and
   * punishes harsher, while rewards (add/mul gates) stay authored so the balance
   * curve tilts. Must copy: buildLevel re-reads `this.level` on every retry, so
   * scaling in place would compound.
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
    const wraps = this.wrapsFor(this.save.get().currentLevel);
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
    }
  }

  private disposeEntities(): void {
    this.gates.forEach((g) => g.dispose(this.scene));
    this.barricades.forEach((b) => b.dispose(this.scene));
    this.enemies.forEach((e) => e.dispose(this.scene));
    this.objectives.forEach((o) => o.dispose(this.scene));
    this.boss?.dispose(this.scene);
    this.finish?.dispose(this.scene);
    this.gates = []; this.barricades = []; this.enemies = [];
    this.objectives = []; this.boss = null; this.finish = null;
  }

  // ---------------------------------------------------------------- run control
  private showMenu(): void {
    this.state = 'MENU';
    this.hud.setHint(false);
    this.hud.bossBar(false);
    this.hud.setCoins(this.save.get().coins);
    this.hud.showOverlay({
      title: 'Crowd Shooter Runner',
      body: 'Drag to steer your crowd. Pick good gates, smash through enemies, and overwhelm the boss.',
      btnText: 'TAP TO START',
      onBtn: () => { this.audio.unlock(); this.audio.play('click'); this.startRun(); },
      btn2Text: '🛒 SHOP',
      onBtn2: () => { this.audio.unlock(); this.audio.play('click'); this.hud.hideOverlay(); this.shop.open(); },
    });
  }

  private startRun(): void {
    this.runGen += 1; // invalidates ad continuations from the previous run
    this.audio.play('click');
    this.hud.hideOverlay();
    // rebuild for a clean slate
    this.buildLevel();
    const s = this.save.get();
    const step = this.cfg.meta.upgradeSteps;
    const start = this.cfg.crowd.startingCount + s.upgrades.startingCrowd * step.startingCrowd;
    this.crowd.reset(start);
    this.crowd.damageMul = 1 + s.upgrades.bulletPower * step.bulletPower;
    this.crowd.fireRateMul = 1 + s.upgrades.fireRate * step.fireRate;
    this.peakCount = start;
    this.bullets.clear();
    this.enemyBullets.clear();
    this.input.resetCenter();
    this.bossBarShown = false;
    this.state = 'PLAYING';
    this.hud.setHint(true);
    this.hud.setCount(this.crowd.count);
    this.hud.setProgress(0);
  }

  // ---------------------------------------------------------------- main tick
  private tick(dtReal: number): void {
    this.time += dtReal;
    // ease slow-mo
    this.timeScale += (this.targetTimeScale - this.timeScale) * Math.min(1, dtReal * 6);
    const dt = dtReal * this.timeScale;

    if (this.state === 'PLAYING' || this.state === 'BOSS') {
      this.simulate(dt);
    }
    this.updateEntitiesVisual(dt);
    this.updateCamera(dtReal);
    this.renderer.render(this.scene, this.camera);
  }

  private simulate(dt: number): void {
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

    // Boss chip: the standoff bleeds the crowd every frame, so out-waiting the
    // sweep is never a strategy — you have to out-damage it.
    if (this.state === 'BOSS' && this.boss && this.boss.alive) {
      const b = this.cfg.boss;
      this.crowd.damage(Math.max(b.chipMinUnitsPerSecond, this.crowd.count * b.chipFractionPerSecond) * dt);
    }

    // bullets
    this.bullets.update(dt);
    this.enemyBullets.update(dt);

    // HUD
    this.hud.setCount(this.crowd.count);
    const prog = clamp(this.crowd.centroid.z / this.level.length, 0, 1);
    this.hud.setProgress(prog);
    if (this.bossBarShown && this.boss) this.hud.bossBar(this.boss.alive, this.boss.hpFraction());

    // boss death → resume to finish
    if (this.state === 'BOSS' && this.boss && !this.boss.alive) {
      this.onBossDefeated();
    }
    // game over
    if (this.crowd.count <= 0) this.onLose();
  }

  // ---------------------------------------------------------------- combat
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

    // pick the single nearest target ahead to focus the crowd's fire
    const t = this.findTarget(cx, cz, laneHalf, c.engageRange);
    if (!t || dps <= 0) return;

    if (t.kind === 'gate') {
      // shooting a tickable gate pumps the door you are aimed at, nothing else
      (t.ref as GatePair).hit(t.halfIdx ?? 0, dps * dt);
    } else {
      const ref = t.ref as Barricade | EnemyCrowd | ObjectiveNode | Boss;
      const before = (ref as any).count ?? (ref as any).hp;
      ref.takeDamage(dps * dt);

      // rewards / clears
      if (t.kind === 'objective') {
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

    // visual tracers toward the target
    this.bulletAccum += dt;
    while (this.bulletAccum > 0.03) {
      this.bulletAccum -= 0.03;
      const fromX = cx + (Math.random() - 0.5) * Math.max(0.4, laneHalf);
      const fromZ = cz + 0.4;
      this.bullets.spawn(fromX, 0.5, fromZ, t.x, t.z, c.bulletSpeed);
    }
  }

  private findTarget(cx: number, cz: number, laneHalf: number, range: number): Target | null {
    let best: Target | null = null;
    const consider = (
      kind: TargetKind, ref: Target['ref'], x: number, z: number, half: number,
      alive: boolean, halfIdx?: number,
    ) => {
      if (!alive) return;
      const d = z - cz;
      if (d < -1 || d > range) return;
      if (Math.abs(cx - x) > laneHalf + half) return;
      if (!best || d < best.dist) best = { kind, ref, dist: d, x, z, halfIdx };
    };
    for (const b of this.barricades) consider('barricade', b, b.x, b.z, b.halfWidth, b.alive);
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
    return best;
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
      this.audio.play('multiply', res.after / Math.max(1, res.before));
      this.hud.flash('#9fe6ff', 0.45);
      this.fovPunch = Math.min(10, 4 + res.after / Math.max(1, res.before));
      this.shake = Math.max(this.shake, 0.25);
    } else if (res.op === 'add') {
      this.audio.play('add');
    } else if (res.after === res.before) {
      this.audio.play('click'); // no-op gate (e.g. a fully decayed tickable): not a punish
    } else {
      this.audio.play('bad');
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
            this.hud.flash('#ff5a52', 0.35);
            this.shake = Math.max(this.shake, 0.3);
          }
        } else if (b.alive) {
          b.forceBreak(); // crowd steered around it
        }
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

  // ---------------------------------------------------------------- visuals
  private updateEntitiesVisual(dt: number): void {
    const cam = this.camera;
    for (const g of this.gates) g.update(dt, cam);
    for (const b of this.barricades) b.update(dt, cam);
    for (const e of this.enemies) e.update(dt, this.time, cam);
    for (const o of this.objectives) o.update(dt, cam);
    if (this.finish) this.finish.update(dt, cam);
    if (this.boss) {
      const frac = this.boss.update(dt, this.time, cam, this.crowd.centroid.x, this.crowdHalf(), this.state === 'BOSS');
      if (frac > 0 && this.state === 'BOSS') {
        const lost = this.crowd.kill(Math.ceil(this.crowd.count * frac));
        if (lost > 0) {
          this.popupWorld(`-${lost}`, '#ff5a52', this.crowd.centroid.x, 1.4, this.crowd.centroid.z);
          this.audio.play('bad');
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
    this.hud.bossBar(false);
    this.bossBarShown = false;
    this.audio.play('win');
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
    this.audio.play('coin');

    this.state = 'REWARD';
    this.showReward(surviving, mult, coins);
  }

  private showReward(surviving: number, mult: number, coins: number): void {
    this.hud.showOverlay({
      title: 'LEVEL CLEAR!',
      body: `${surviving} survivors · ×${mult} lane`,
      extraHTML: `<div class="reward-coins">+${coins} ●</div>`,
      btnText: 'NEXT LEVEL',
      onBtn: () => { this.audio.play('click'); void this.advanceLevel(); },
      btn3Text: '🛒 SHOP',
      onBtn3: () => {
        this.audio.play('click');
        this.hud.hideOverlay();
        this.shop.open(() => {
          this.hud.setCoins(this.save.get().coins);
          this.showReward(surviving, mult, coins);
        });
      },
      btn2Text: '×2 COINS (AD)',
      onBtn2: async () => {
        this.audio.play('click');
        const gen = this.runGen;
        const ok = await this.ads.showRewarded('double_coins');
        if (gen !== this.runGen || this.state !== 'REWARD') return; // run moved on during the ad
        if (ok) {
          this.save.addCoins(coins);
          this.hud.setCoins(this.save.get().coins);
          this.audio.play('coin');
          this.hud.showOverlay({
            title: 'LEVEL CLEAR!',
            body: `${surviving} survivors · ×${mult} lane`,
            extraHTML: `<div class="reward-coins">+${coins * 2} ● (doubled)</div>`,
            btnText: 'NEXT LEVEL',
            onBtn: () => { this.audio.play('click'); void this.advanceLevel(); },
          });
        }
      },
    });
  }

  private onLose(): void {
    if (this.state === 'LOSE') return;
    this.resumeState = this.boss && this.bossBarShown ? 'BOSS' : 'PLAYING';
    this.state = 'LOSE';
    this.audio.play('lose');
    this.hud.bossBar(false);
    this.showLoseOverlay();
  }

  private showLoseOverlay(): void {
    this.hud.showOverlay({
      title: 'OUT OF CROWD',
      body: 'Your swarm was wiped out.',
      btnText: 'RETRY',
      onBtn: () => { this.audio.play('click'); this.startRun(); },
      btn2Text: 'REVIVE (AD)',
      onBtn2: async () => {
        this.audio.play('click');
        const gen = this.runGen;
        const ok = await this.ads.showRewarded('revive');
        if (gen !== this.runGen || this.state !== 'LOSE') return; // run moved on during the ad
        if (ok) this.revive();
      },
      btn3Text: '🛒 SHOP',
      onBtn3: () => {
        this.audio.play('click');
        this.hud.hideOverlay();
        this.shop.open(() => {
          this.hud.setCoins(this.save.get().coins);
          this.showLoseOverlay();
        });
      },
    });
  }

  private revive(): void {
    const amount = Math.max(10, Math.floor(this.peakCount * this.cfg.meta.reviveFraction));
    this.crowd.count = amount;
    this.hud.setCount(amount);
    this.hud.hideOverlay();
    if (this.resumeState === 'BOSS' && this.boss) this.hud.bossBar(true, this.boss.hpFraction());
    this.state = this.resumeState;
  }

  // ---------------------------------------------------------------- debug
  debug(): Record<string, unknown> {
    return {
      state: this.state,
      count: this.crowd?.count,
      z: this.crowd ? +this.crowd.centroid.z.toFixed(1) : 0,
      x: this.crowd ? +this.crowd.centroid.x.toFixed(2) : 0,
      bossHp: this.boss ? Math.ceil(this.boss.hp) : null,
      runSpeed: +this.runSpeed.toFixed(2),
      coins: this.save.get().coins,
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
