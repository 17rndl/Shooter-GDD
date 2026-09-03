// ---------------------------------------------------------------------------
// Shared data contracts: tuning config, level definitions, save data.
// Everything a designer can touch lives as plain JSON matching these types.
// ---------------------------------------------------------------------------

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
  | 'crowd_pickup';

export interface Segment {
  z: number;
  type: SegmentType;
  // gate_pair
  left?: GateSide;
  right?: GateSide;
  tickable?: boolean;
  tickPerHit?: number;
  // barricade / enemy / objective / boss
  x?: number;
  hp?: number;
  width?: number;
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

export interface SaveData {
  currentLevel: number;
  coins: number;
  /** Largest crowd ever reached across all runs — drives the NEW BEST badge. */
  bestPeak: number;
  upgrades: UpgradeLevels;
  settings: { sound: boolean; haptics: boolean };
  ownedSkins: string[];
}

export type GameState =
  | 'MENU'
  | 'PLAYING'
  | 'BOSS'
  | 'WIN'
  | 'REWARD'
  | 'LOSE';
