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
