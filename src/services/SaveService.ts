import type { GraphicsMode, SaveData } from '../data/types';

const KEY = 'csr_save_v1';
const DEFAULT_SKIN = 'default';

const DEFAULT_SAVE: SaveData = {
  currentLevel: 1,
  coins: 0,
  bestPeak: 0,
  upgrades: { bulletPower: 0, fireRate: 0, startingCrowd: 0, income: 0 },
  settings: { sound: true, music: true, haptics: true, graphics: 'auto' },
  ownedSkins: [DEFAULT_SKIN],
  equippedSkin: DEFAULT_SKIN,
  removeAds: false,
};

function wholeAtLeast(v: unknown, min: number, fallback: number): number {
  return typeof v === 'number' && Number.isFinite(v) ? Math.max(min, Math.floor(v)) : fallback;
}

function flag(v: unknown, fallback: boolean): boolean {
  return v === undefined || v === null ? fallback : !!v;
}

// a mode a later build adds (or a typo) reads as auto, the safe adaptive default
function graphicsMode(v: unknown): GraphicsMode {
  return v === 'high' || v === 'low' ? v : 'auto';
}

function record(v: unknown): Record<string, unknown> {
  return v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
}

/**
 * Any parsed blob → a well-formed SaveData. Old saves predate music, skins,
 * removeAds and the graphics mode, so missing fields take defaults; a
 * hand-edited or corrupt save can never hand the game a NaN balance, a level
 * below 1, an unowned skin or an unknown graphics mode.
 * Skin ids are not checked against the catalog here (the game resolves them).
 */
export function sanitizeSave(raw: unknown): SaveData {
  const r = record(raw);
  const up = record(r.upgrades);
  const st = record(r.settings);
  const d = DEFAULT_SAVE;

  const owned = [DEFAULT_SKIN];
  if (Array.isArray(r.ownedSkins)) {
    for (const id of r.ownedSkins) {
      if (typeof id === 'string' && id.length > 0 && !owned.includes(id)) owned.push(id);
    }
  }
  const equipped = typeof r.equippedSkin === 'string' && owned.includes(r.equippedSkin)
    ? r.equippedSkin
    : DEFAULT_SKIN;

  return {
    currentLevel: wholeAtLeast(r.currentLevel, 1, d.currentLevel),
    coins: wholeAtLeast(r.coins, 0, d.coins),
    bestPeak: wholeAtLeast(r.bestPeak, 0, d.bestPeak),
    upgrades: {
      bulletPower: wholeAtLeast(up.bulletPower, 0, d.upgrades.bulletPower),
      fireRate: wholeAtLeast(up.fireRate, 0, d.upgrades.fireRate),
      startingCrowd: wholeAtLeast(up.startingCrowd, 0, d.upgrades.startingCrowd),
      income: wholeAtLeast(up.income, 0, d.upgrades.income),
    },
    settings: {
      sound: flag(st.sound, d.settings.sound),
      music: flag(st.music, d.settings.music),
      haptics: flag(st.haptics, d.settings.haptics),
      graphics: graphicsMode(st.graphics),
    },
    ownedSkins: owned,
    equippedSkin: equipped,
    removeAds: flag(r.removeAds, d.removeAds),
  };
}

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
      return sanitizeSave(JSON.parse(raw));
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

  /** Deducts, grants and equips in one save. False when owned or unaffordable. */
  buySkin(id: string, price: number): boolean {
    const d = this.data;
    if (d.ownedSkins.includes(id)) return false;
    if (!Number.isFinite(price) || price < 0 || d.coins < price) return false;
    d.coins -= price;
    d.ownedSkins.push(id);
    d.equippedSkin = id;
    this.save();
    return true;
  }

  equipSkin(id: string): boolean {
    if (!this.data.ownedSkins.includes(id)) return false;
    this.data.equippedSkin = id;
    this.save();
    return true;
  }

  setSetting(key: 'sound' | 'music' | 'haptics', on: boolean): void {
    this.data.settings[key] = on;
    this.save();
  }

  setGraphics(mode: GraphicsMode): void {
    this.data.settings.graphics = graphicsMode(mode);
    this.save();
  }

  setRemoveAds(on: boolean): void {
    this.data.removeAds = on;
    this.save();
  }

  reset(): void {
    this.data = structuredClone(DEFAULT_SAVE);
    this.save();
  }
}
