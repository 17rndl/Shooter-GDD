# Crowd Shooter Runner — prototype

A playable, browser-based prototype of the hyper-casual 3D crowd-runner / auto-shooter
described in [`crowd-shooter-runner-gdd.md`](crowd-shooter-runner-gdd.md).

Built with **TypeScript + Three.js + Vite** — the GDD's recommended "validate the feel
in-browser" path (Claude Code can build, run, and verify this end-to-end; it cannot drive
the Unity editor). The shippable target stays Unity; this proves out the design and tuning.

It is a **web app**, not a native app and not React Native (there is no React anywhere): it
runs in a browser, with a plain-DOM HUD over a WebGL canvas. The ship target is a native
**Unity (C#) Android** build; [`docs/UNITY_PORT.md`](docs/UNITY_PORT.md) is the port guide.

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
services behind interfaces with stubs (see the meta & services pass below).

## Architecture (mirrors GDD §13)

```
src/
  main.ts                  boot (config → level manifest → GameManager), failed-boot screen
  core/GameManager.ts      state machine (MENU→PLAYING⇄BOSS→WIN→REWARD / LOSE→revive), pause,
                           ad/visibility hooks, system tick order
  core/WorldSpace.ts       WORLD_X_SIGN + screenToWorldX: the one place that knows the X mirror
  systems/InputSystem.ts   drag → normalized steer
  crowd/                   CrowdController (count + formation + DPS), UnitInstancer (GPU-instanced units)
  combat/BulletPool.ts     capped pooled visual tracers (tinted by the equipped skin)
  combat/ParticlePool.ts   pooled sparks, death pops
  entities/                GatePair, Barricade, EnemyCrowd, ObjectiveNode, Boss, Finish, Pickup
  world/Track.ts           ground, rails, depth cues
  ui/HUD.ts                DOM overlay (count, coins, progress, popups, boss bar, overlays, gear)
  ui/ShopPanel.ts          shop: UPGRADES (coin sink) / SKINS (cosmetic) / STORE (IAP)
  ui/SettingsPanel.ts      settings sheet, doubles as the in-run pause menu
  services/SaveService.ts      localStorage save + sanitize/migrate (sanitizeSave)
  services/AudioService.ts     WebAudio SFX + procedural 3-intensity music loop
  services/HapticsService.ts   IHapticsService → navigator.vibrate, priority throttle
  services/AdService.ts        IAdService (SDK adapter, stubbed) + AdGate (every ad rule)
  services/IapService.ts       IIapService (store adapter, stubbed)
  data/types.ts            config / level / save contracts
  data/ConfigLoader.ts     loadConfig + validateConfig (missing sections fail the boot)
  data/LevelRepository.ts  ILevelRepository, manifest wrap + cache, validateLevel
  util/                    MathUtil (phyllotaxis, damp), Label (canvas-texture number plates)
public/
  config.json              all tuning numbers (GDD §14.1 / §15), skins, ad cadence
  levels/index.json        level manifest: {"levels": [...]} in play order
  levels/level_00{1,2,3}.json   JSON-driven levels, scaling difficulty (GDD §14.2)
scripts/balance-sim.mjs    balance regression test (`npm run balance`)
docs/UNITY_PORT.md         Unity port guide
```

Every tuning value lives in `config.json`; the level is data in `level_001.json` — edit and
reload, no recompile. Add a level by dropping in `level_00N.json` and listing it in
`levels/index.json`; it is validated on load (a broken file fails with its name, segment
index and the bad field).

### Steering / camera note
The chase camera looks down +Z, which mirrors world-X on screen (world +X is screen-left in
right-handed Three.js). `src/core/WorldSpace.ts` owns that flip (`WORLD_X_SIGN = -1`): steering,
gate doors and finish lanes all go through `screenToWorldX`, so **drag-right = crowd-moves-right**
and gate `left`/`right` in JSON map to screen left/right. A left-handed engine (Unity) sets +1.

### Feel pass — the arc made visible

The audit's second verdict: *the numbers change but the world doesn't*. The feel pass gives every
beat of the arc a physical signal, all pooled and allocation-free:

- **Growth you can see** — new units scale in with an overshoot that ripples outward through the
  formation; above the render cap the crowd swells (unit size + spacing ∝ log count) so 1000 reads
  bigger than 100; **tracer density scales with √count**, so a 5-crowd and a 500-crowd look nothing alike.
- **The count rolls up**, not teleports — an eased tween with a pitched tick per step and an arrival
  pop proportional to the delta (the genre's signature dopamine beat).
- **Loss and impact have bodies** — dying units pop off the formation's edge and fall; bullets spark
  on arrival; targets flinch (scale-punch) on every hit; a barricade shot down flashes white with a
  BREAK pop, a rammed one flashes red with the loss — and a dodged one is left standing, so the
  three outcomes read as three different lessons.
- **Danger is felt** — at ≤5 units a red vignette closes in and a heartbeat plays, so the revive
  offer lands with setup instead of surprise. Best-ever crowd is persisted and celebrated.
- **Payoff has ceremony** — coins count up with blips before the ×2 ad button is revealed; finish
  lanes preview the coins they're worth as you approach; the boss's chip damage has an audible cue.

### Content pass — variety without new code

- **Pickups** — `coin_pickup` (a spinning row of coins, banks coins immediately) and `crowd_pickup`
  (a small blue cluster, adds units) are steered into, never shot; they fill the gaps between beats
  with something to aim for. Missed ones just scroll away.
- **Lane-distributed fire** (GDD §6.2) — the crowd now splits its DPS across up to 3 in-lane
  targets, nearest-weighted, so a wide crowd really does "cover more targets in parallel" and
  flanking set pieces feel different from a single blob.
- **Boss attacks from JSON** — the `attacks` array is honored and cycled: `sweep_fire` (a random
  band you read from the telegraph) and `slam` (a band that locks onto *where you are standing*,
  faster and harder — so standing still is the wrong answer). Orange telegraph = slam, red = sweep.
- **Compound set pieces** — barricades guarding the good door, flanking enemy pairs, pickups after
  a costly fight: all authored in the level JSON, no engine changes. The balance sim models
  pickups, split fire and both attacks, and still has to pass.

### Meta & services pass — the shell around the run, and port prep

- **Skins** — five cosmetic unit skins in `config.json` (`skins`: body colour, tracer tint,
  price), bought and equipped in the shop's SKINS tab. The equipped skin tints the crowd, its
  tracers and their impact sparks; hues stay clear of enemy orange, hazard red and coin gold so
  a skin never reads as a threat or a pickup. An unknown saved id falls back to Classic.
- **Settings + pause** — a gear button (top-left) opens Settings on the menu (Sound FX, Music,
  Haptics, and a two-tap RESET PROGRESS that keeps those settings and a bought Remove Ads);
  mid-run it becomes a pause button and the same sheet is the pause menu (RESUME / QUIT TO
  MENU). Pausing freezes the whole world, not just the sim. Backgrounding the app (tab switch,
  lock screen) pauses a live run and silences audio.
- **Music** — a procedural WebAudio loop with three intensities that change on the bar line:
  calm on menus and result screens, driving in the run, opened-up and faster at the boss.
- **Haptics** — `IHapticsService` (`navigator.vibrate` on the web) pulses on gates, rams, boss
  hits, the boss kill, win and lose, with a priority throttle so a spray of small hits can
  never drown a boss kill. Not on coins or per-bullet hits.
- **AdGate** — every ad rule lives in one pure-TS class in front of the SDK adapter: single
  flight, open/close always balanced (the game freezes and audio suspends while an ad is up),
  a load timeout so an ad that never shows can never freeze the game (once it is on screen only
  a long backstop applies, so a full video never loses its reward), late results ignored, and
  interstitial caps (every N clears, a minimum interval, skipped with Remove Ads). Rewarded
  buttons show LOADING... while an ad runs (the screen's other buttons disable with it) and are
  hidden when there is no fill. New rewarded placement (GDD §10): **+N START CROWD** on the menu.
- **IAP stub** — the shop's STORE tab (Remove Ads, two coin packs, RESTORE PURCHASES) runs
  against `IIapService`; the stub approves everything. Granting is the game's job, so a real
  store's receipt check slots in behind the interface.
- **Port prep** — `WORLD_X_SIGN` isolates the camera mirror; `LevelRepository` loads levels
  from a manifest (an object, so Unity's `JsonUtility` can read it), wraps for endless mode,
  caches, and validates every file; `ConfigLoader` fails the boot on a missing config section.
  [`docs/UNITY_PORT.md`](docs/UNITY_PORT.md) maps every file to its Unity home and lists the
  JS-vs-C# numeric traps the balance sim depends on.

## Not yet built
- Real **AppLovin MAX** wiring behind `IAdService` and **Unity IAP / Play Billing** behind
  `IIapService` (receipt validation included); the stubs and AdGate rules are ready for them.
- The **Unity 6 / URP port** for an Android `.aab` itself (the actual ship target), following
  `docs/UNITY_PORT.md`.
- **Art**: real unit, enemy and boss models and VFX in place of the primitive shapes.

## Dev/debug
`window.__game` is exposed in the browser console: `__game.debug()` dumps live state (now
including `paused`, `adOpen`, `adBusy`, `skin`, `music`, `settings`, `removeAds`,
`levelCount`), `__game.debugSteer(0..1)` drives the steer target. Harmless; strip for production.

Ad test flags (query string, stub SDK only):
- `?adfail`: rewarded ads finish without granting a reward.
- `?adnofill`: no ad is ever ready, so the rewarded buttons are hidden and interstitials are skipped.
- `?adhang`: a rewarded ad never shows or calls back, which exercises AdGate's load timeout (`ads.rewardedTimeoutSec`).
