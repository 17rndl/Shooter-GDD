// ---------------------------------------------------------------------------
// Shared data contracts: tuning config, level definitions, save data.
// Everything a designer can touch lives as plain JSON matching these types.
// ---------------------------------------------------------------------------

import type { MotionDef } from '../core/Motion';

export type { MotionDef };

export interface GameConfig {
  track: { minX: number; maxX: number; forwardSpeed: number; width: number };
  crowd: {
    startingCount: number;
    maxVisibleUnits: number;
    formationSpacing: number;
    steerSmoothing: number;
    unitRadius: number;
  };
  combat: {
    perUnitDamage: number;
    fireRate: number;
    dpsExponent: number;
    maxVisibleBullets: number;
    bulletSpeed: number;
    laneWidthPerUnit: number;
    laneWidthMax: number;
    engageRange: number;
    // damage → units conversion: `damage` of this size removes one unit
    playerUnitHp: number;
    enemyUnitHp: number;
    enemyPerUnitDamageFactor: number;
    enemyDamageFactor: number;
    // fire splitting: how many targets the crowd can service at once, and how
    // hard the per-target share falls off with distance (0 = even split)
    maxSplitTargets: number;
    splitFalloff: number;
  };
  boss: {
    standoff: number;
    cooldown: number;
    cooldownMin: number;
    telegraphTime: number;
    telegraphTimeMin: number;
    hitFraction: number;
    bandHalf: number;
    firstTelegraphDelay: number;
    chipFractionPerSecond: number;
    chipMinUnitsPerSecond: number;
    // slam: a shorter telegraph that locks onto the crowd and hits harder
    slamTelegraphScale: number;
    slamHitScale: number;
    // crossfire: two danger planes either side of one safe gap the crowd must find
    crossfireGapHalf: number;
    crossfireTelegraphScale: number;
    crossfireHitScale: number;
  };
  gates: { damagePerTick: number; mulCap: number; addCap: number; decayFloor: number };
  barricade: { ramFactor: number };
  pickup: { halfWidth: number };
  meta: {
    reviveFraction: number;
    wrapDifficultyStep: number;
    wrapSpeedStep: number;
    upgradeSteps: { bulletPower: number; fireRate: number; startingCrowd: number };
  };
  economy: { coinPerUnit: number; upgradeCostBase: number; upgradeCostGrowth: number };
  /** Cosmetic unit skins. The first entry is id 'default' at price 0. */
  skins: SkinDef[];
  ads: {
    interstitialEveryLevels: number;
    interstitialMinIntervalSec: number;
    /** How long any ad may take to reach the screen; once shown, only AdGate's long backstop applies. */
    rewardedTimeoutSec: number;
    /** How long the stub SDK pretends an ad takes to show. */
    stubLatencyMs: number;
    /** Units the bonus_crowd rewarded ad adds at run start. */
    bonusCrowd: number;
  };
  /** Daily challenge payout, first clear of the day only. */
  daily: {
    bonusCoins: number;
    /** Coins per day of the clear streak, counted up to streakCap days. */
    streakBonus: number;
    streakCap: number;
  };
}

export interface SkinDef {
  id: string;
  name: string;
  /** '#rrggbb' unit body. */
  color: string;
  /** '#rrggbb' bullet tint. */
  tracer: string;
  /** Coins; 0 = free. */
  price: number;
}

export type GateOp = 'add' | 'mul' | 'sub' | 'div';

export interface GateSide {
  op: GateOp;
  value: number;
}

export type SegmentType =
  | 'gate_pair'
  | 'barricade'
  | 'enemy_crowd'
  | 'objective_node'
  | 'boss'
  | 'finish'
  | 'coin_pickup'
  | 'crowd_pickup'
  | 'blade';

export interface Segment {
  z: number;
  type: SegmentType;
  // gate_pair
  left?: GateSide;
  right?: GateSide;
  tickable?: boolean;
  tickPerHit?: number;
  // barricade / enemy / objective / boss / blade
  x?: number;
  hp?: number;
  /** barricade: wall width; blade: saw length along X */
  width?: number;
  /** blade: share of the overlapped crowd it cuts, (0, 1] */
  kill?: number;
  /** Side-to-side sway. barricade, enemy_crowd, coin_pickup, crowd_pickup and blade only. */
  motion?: MotionDef;
  count?: number;
  fireRate?: number;
  reward?: number;
  attacks?: string[];
  // finish
  multiplierLanes?: number[];
  // pickups
  value?: number;
}

export interface LevelDefinition {
  id: number;
  length: number;
  forwardSpeed: number;
  segments: Segment[];
}

export interface UpgradeLevels {
  bulletPower: number;
  fireRate: number;
  startingCrowd: number;
  income: number;
}

/** 'auto' adapts the render tier to the measured frame rate; 'high' / 'low' pin it. */
export type GraphicsMode = 'auto' | 'high' | 'low';

export interface SaveData {
  currentLevel: number;
  coins: number;
  /** Largest crowd ever reached across all runs — drives the NEW BEST badge. */
  bestPeak: number;
  upgrades: UpgradeLevels;
  settings: { sound: boolean; music: boolean; haptics: boolean; graphics: GraphicsMode };
  ownedSkins: string[];
  /** A skin id from ownedSkins. Resolved against cfg.skins by the game, not here. */
  equippedSkin: string;
  /** Remove Ads purchase: suppresses interstitials (rewarded ads stay opt-in). */
  removeAds: boolean;
  daily: DailySave;
}

/** Daily challenge progress. Keys are local calendar dates, 'YYYY-MM-DD'. */
export interface DailySave {
  /** The day `best` and `cleared` refer to; '' before the first daily run. */
  key: string;
  /** Peak crowd reached on that day's challenge. */
  best: number;
  /** That day pays no first-clear bonus: it is lastClearKey or earlier. */
  cleared: boolean;
  /** Consecutive days cleared, ending on lastClearKey. */
  streak: number;
  lastClearKey: string;
}

export type GameState =
  | 'MENU'
  | 'PLAYING'
  | 'BOSS'
  | 'WIN'
  | 'REWARD'
  | 'LOSE';
