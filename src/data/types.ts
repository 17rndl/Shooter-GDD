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
