import * as THREE from 'three';
import type { GameConfig, GameState, LevelDefinition, Segment } from '../data/types';
import { clamp } from '../util/MathUtil';
import { Track } from '../world/Track';
import { CrowdController } from '../crowd/CrowdController';
import { BulletPool } from '../combat/BulletPool';
import { ParticlePool } from '../combat/ParticlePool';
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
import { Pickup } from '../entities/Pickup';

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
  private ads: IAdService = new AdServiceStub();
  private input: InputSystem;
  private hud = new HUD();
  private shop!: ShopPanel;

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
  private levelsClearedThisSession = 0;
  private transitioning = false;
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
    this.particles = new ParticlePool(240, this.scene);
    this.crowd.particles = this.particles;
    // tracers die into a spark puff instead of blinking out
    this.bullets.onExpire = (x, y, z) => {
      this.particles.burst(x, y, z, 3, 0xfff1a8, 2.5);
      this.audio.play('spark'); // self-throttled: this fires ~100×/s at high crowd counts
    };
    this.enemyBullets.onExpire = (x, y, z) => this.particles.burst(x, y, z, 2, 0xff7a3d, 2.0);

    this.audio.enabled = this.save.get().settings.sound;
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
      case 'coin_pickup':
      case 'crowd_pickup': {
        const p = new Pickup(seg, this.cfg);
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
    this.hud.bossBar(false);
    this.tickRamp = 0;
    this.heartbeatT = 0;
    this.chipCueT = 0;
    this.lanePreviewCount = -1;
    this.pickupsCollected = 0;
    this.state = 'PLAYING';
    this.hud.setHint(true);
    this.hud.setCount(this.crowd.count, true); // a fresh run must not roll up from the last one
    this.hud.setDanger(false);
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
    // Unconditional: death pops and the count roll-up must finish playing while
    // an overlay is up, not freeze mid-air.
    this.particles.update(dt);
    this.hud.update(dtReal);
    this.updateEntitiesVisual(dt);
    this.updateCamera(dtReal);
    this.renderer.render(this.scene, this.camera);
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
    this.audio.play('cheer');
    this.hud.setDanger(false);
    const isNewBest = this.recordPeak();
    this.rewardDoubled = false;

    this.state = 'REWARD';
    this.showReward(surviving, mult, coins, isNewBest);
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
    this.hud.showRewardCeremony({
      survivors: surviving,
      mult,
      coins,
      best: this.save.get().bestPeak,
      isNewBest,
      onNext: () => { this.audio.play('click'); void this.advanceLevel(); },
      onDouble: () => { void this.doubleCoins(coins); },
      onShop: () => {
        this.audio.play('click');
        this.hud.hideOverlay();
        this.shop.open(() => {
          this.hud.setCoins(this.save.get().coins);
          this.showReward(surviving, mult, coins, isNewBest); // replays the ceremony from the top
        });
      },
    });
    // a re-show (returning from the shop) must not re-arm an already-claimed ×2
    if (this.rewardDoubled) this.hud.setRewardCoins(coins * 2, true);
  }

  private async doubleCoins(coins: number): Promise<void> {
    this.audio.play('click');
    const gen = this.runGen;
    const ok = await this.ads.showRewarded('double_coins');
    if (gen !== this.runGen || this.state !== 'REWARD') return; // run moved on during the ad
    if (!ok) return;
    this.rewardDoubled = true;
    this.save.addCoins(coins);
    this.hud.setCoins(this.save.get().coins);
    this.audio.play('coin');
    this.hud.setRewardCoins(coins * 2, true);
  }

  private onLose(): void {
    if (this.state === 'LOSE') return;
    this.resumeState = this.boss && this.bossBarShown ? 'BOSS' : 'PLAYING';
    this.state = 'LOSE';
    this.audio.play('lose');
    this.hud.bossBar(false);
    this.hud.setDanger(false); // simulate() stops here, so clear the vignette by hand
    this.recordPeak();
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
    this.hud.setCount(amount, true); // a revive is a hard reset, not a roll-up
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
      bossAttack: this.boss ? this.boss.currentAttack : null,
      pickups: this.pickupsCollected,
      runSpeed: +this.runSpeed.toFixed(2),
      coins: this.save.get().coins,
      peak: this.peakCount,
      bestPeak: this.save.get().bestPeak,
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
