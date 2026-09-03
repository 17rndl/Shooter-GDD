import type { SaveData } from '../data/types';

const KEY = 'csr_save_v1';

const DEFAULT_SAVE: SaveData = {
  currentLevel: 1,
  coins: 0,
  bestPeak: 0,
  upgrades: { bulletPower: 0, fireRate: 0, startingCrowd: 0, income: 0 },
  settings: { sound: true, haptics: true },
  ownedSkins: ['default'],
};

/** Persistence behind a tiny interface; localStorage for the web prototype. */
export class SaveService {
  private data: SaveData;

  constructor() {
    this.data = this.load();
  }

  private load(): SaveData {
    try {
      const raw = localStorage.getItem(KEY);
      if (!raw) return structuredClone(DEFAULT_SAVE);
      const parsed = JSON.parse(raw) as Partial<SaveData>;
      return {
        ...structuredClone(DEFAULT_SAVE),
        ...parsed,
        upgrades: { ...DEFAULT_SAVE.upgrades, ...(parsed.upgrades ?? {}) },
        settings: { ...DEFAULT_SAVE.settings, ...(parsed.settings ?? {}) },
      };
    } catch {
      return structuredClone(DEFAULT_SAVE);
    }
  }

  get(): SaveData {
    return this.data;
  }

  save(): void {
    try {
      localStorage.setItem(KEY, JSON.stringify(this.data));
    } catch {
      /* storage may be unavailable (private mode) — ignore */
    }
  }

  addCoins(n: number): void {
    this.data.coins += n;
    this.save();
  }

  reset(): void {
    this.data = structuredClone(DEFAULT_SAVE);
    this.save();
  }
}
