# Crowd Shooter Runner — prototype

A playable, browser-based prototype of the hyper-casual 3D crowd-runner / auto-shooter
described in [`crowd-shooter-runner-gdd.md`](crowd-shooter-runner-gdd.md).

Built with **TypeScript + Three.js + Vite** — the GDD's recommended "validate the feel
in-browser" path (Claude Code can build, run, and verify this end-to-end; it cannot drive
the Unity editor). The shippable target stays Unity; this proves out the design and tuning.

## Run it

```bash
npm install
npm run dev      # open the printed http://localhost:PORT
```

- **Drag left / right** (mouse or touch) to steer the crowd. Everything else is automatic.
- Build for static hosting: `npm run build` → `dist/` (relative paths, opens anywhere).

## What's implemented (GDD §16 phases 1–7, all verified)

1. **Skeleton** — chase camera, track, drag steering, constant forward motion.
2. **Crowd** — logical `crowdCount` **decoupled** from rendered instances. One `InstancedMesh`,
   phyllotaxis (sunflower) formation, capped at `maxVisibleUnits` (100). 1000s logical, ~100 drawn.
3. **Shooting** — logical sub-linear DPS (`count^0.85 · dmg · fireRate`), capped pooled visual
   tracers (cosmetic), wider crowd = wider damage lane. Shootable numbered barricades.
4. **Gates** — `+ × − ÷` paired doors, color-coded, static **and** tickable, centroid-wins pass
   logic, count math, shatter the loser, number pop-ups + screen flash + SFX.
5. **Enemies + objective nodes** — orange enemy crowds resolved as a DPS race in the overlap
   lane (steer to dodge); objective emplacements grant bonus crowd when cleared.
6. **Boss + finish + reward** — HP-bar boss with a **steerable sweep-fire** attack you dodge,
   slow-mo on kill, ×N multiplier finish lanes, win/lose states, coin reward, revive + ×2-coins
   rewarded-ad hooks.
7. **Meta / progression** — 3 JSON levels with scaling difficulty + endless wrap, an **upgrades
   shop** (Bullet Power / Fire Rate / Starting Crowd / Income) spending coins at rising costs,
   persistent save (coins, upgrades, current level), interstitial hook every N clears. Shop is
   reachable from the menu, the reward screen, and the lose screen.

### Balance pass (GDD §15) — verified by a checked-in simulator

A 15-agent audit found the first cut *worked as software but not as a game*: enemies beat equal
crowds (player units had 1 HP vs enemy 3), the boss never decided a level (its only attack was
trivially dodgeable, so HP was just a timer), barricades died before contact, and tickable gates
inflated for free on a wall-clock timer. The balance overhaul:

- **Every balance number lives in `config.json`** — `combat.playerUnitHp/enemyUnitHp/...`, a
  `boss` block (standoff, cooldown→cooldownMin and telegraph→telegraphMin *escalating with lost
  HP*, hit fraction, band width, chip damage), `gates` (damage per tick, caps, floor),
  `barricade.ramFactor`, `meta` (revive fraction, endless-wrap scaling, upgrade steps).
- **Player units have HP** — the DPS race now favors the bigger side, per GDD §8.2.
- **Boss standoff has pressure** — chip loss per second so time matters, random telegraph bands
  you must *read*, cycle speed that ramps as the boss weakens, and a **proportional-overlap
  sweep** (only the units under the band die) so big crowds can't fully dodge but steering
  always matters.
- **Tickable gates are bullet-driven** — the half you shoot is the half that ticks; the gate
  competes for your fire like any target (the reference image's mechanic, with real agency).
- **Endless wrap scales** — past the authored levels, threats grow `1 + 0.35·wraps` and the
  track speeds up, so upgrades never make the loop strictly easier.
- **`npm run balance`** runs `scripts/balance-sim.mjs`: it plays every level with a
  best-path policy (good gates, dodge, shoot the good half) and a worst-path policy (bad gates,
  fight everything, passive at the boss) using the game's exact formulas, and fails the build
  if a best path can't beat the boss with margin or a worst path survives. Treat it as the
  balance regression test — retune numbers until it passes.

Plus juice (camera shake, FOV punch on big multiplies, pop-ups, zero-asset WebAudio SFX) and
services behind interfaces with no-op stubs: `SaveService` (localStorage), `AudioService`,
`IAdService` (`AdServiceStub` → swap in AppLovin MAX / AdMob later).

## Architecture (mirrors GDD §13)

```
src/
  core/GameManager.ts      state machine (MENU→PLAYING→BOSS→WIN→REWARD / LOSE→revive) + system tick order
  systems/InputSystem.ts   drag → normalized steer
  crowd/                   CrowdController (count + formation + DPS), UnitInstancer (GPU-instanced units)
  combat/BulletPool.ts     capped pooled visual tracers
  entities/                GatePair, Barricade, EnemyCrowd, ObjectiveNode, Boss, Finish
  world/Track.ts           ground, rails, depth cues
  ui/HUD.ts                DOM overlay (count, coins, progress, popups, boss bar, overlays)
  ui/ShopPanel.ts          upgrades shop (coin sink → run-start stat buffs)
  services/                Save / Audio / Ad (interface-first, stubbed)
  data/types.ts            config / level / save contracts
  util/                    MathUtil (phyllotaxis, damp), Label (canvas-texture number plates)
public/
  config.json              all tuning numbers (GDD §14.1 / §15)
  levels/level_00{1,2,3}.json   JSON-driven levels, scaling difficulty (GDD §14.2)
```

Every tuning value lives in `config.json`; the level is data in `level_001.json` — edit and
reload, no recompile. Add levels by dropping more `level_00N.json` files and pointing the loader at them.

### Steering / camera note
The chase camera looks down +Z, which mirrors world-X on screen. Input is inverted so
**drag-right = crowd-moves-right**, and gate `left`/`right` in JSON map to screen left/right.

## Not yet built (GDD phases 8–10, post-MVP)
Extra juice polish + unit **skins** (cosmetic), real **ad SDK** wiring (AppLovin MAX behind the
existing `IAdService`), **IAP**, **haptics**, and the **Unity/URP port** for Android `.aab` (the
actual ship target). The data formats and service interfaces here are designed to carry straight over.

## Dev/debug
`window.__game` is exposed in the browser console: `__game.debug()` dumps live state,
`__game.debugSteer(0..1)` drives the steer target. Harmless; strip for production.
