import type { GameConfig } from './types';

// Tuning config loading. validateConfig is the pure part (Node-testable); it
// checks structure, not balance: a missing section fails loudly at boot instead
// of surfacing later as a NaN deep inside a system.

const SECTIONS: readonly string[] = [
  'track', 'crowd', 'combat', 'boss', 'gates', 'barricade', 'pickup', 'meta', 'economy', 'skins', 'ads',
];
const HEX = /^#[0-9a-f]{6}$/i;

export function validateConfig(raw: unknown): GameConfig {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('config.json: not an object');
  const r = raw as Record<string, unknown>;
  const missing = SECTIONS.filter((k) => {
    const v = r[k];
    if (k === 'skins') return !Array.isArray(v);
    return !v || typeof v !== 'object' || Array.isArray(v);
  });
  if (missing.length > 0) throw new Error(`config.json: missing section(s): ${missing.join(', ')}`);

  const skins = r.skins as unknown[];
  const first = skins[0] as { id?: unknown } | undefined;
  if (!first || first.id !== 'default') throw new Error("config.json: skins[0].id must be 'default'");
  // Cosmetic data: a malformed skin is worth a warning, not a dead boot.
  const seen = new Set<string>();
  for (let i = 0; i < skins.length; i++) {
    const s = skins[i] as Record<string, unknown> | null;
    const id = s && typeof s.id === 'string' ? s.id : '';
    if (!id || seen.has(id)) console.warn(`config.json: skins[${i}] has a missing or duplicate id`);
    seen.add(id);
    if (!s || typeof s.color !== 'string' || !HEX.test(s.color)) console.warn(`config.json: skins[${i}].color is not '#rrggbb'`);
    if (!s || typeof s.tracer !== 'string' || !HEX.test(s.tracer)) console.warn(`config.json: skins[${i}].tracer is not '#rrggbb'`);
    if (!s || typeof s.price !== 'number' || !Number.isFinite(s.price) || s.price < 0) console.warn(`config.json: skins[${i}].price is not a number >= 0`);
  }
  return raw as GameConfig;
}

/** Fetches `<baseUrl>config.json` and validates it. */
export async function loadConfig(baseUrl: string): Promise<GameConfig> {
  const url = `${baseUrl}config.json`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`config.json: HTTP ${res.status} loading ${url}`);
  let raw: unknown;
  try {
    raw = await res.json();
  } catch {
    throw new Error('config.json: not valid JSON');
  }
  return validateConfig(raw);
}
