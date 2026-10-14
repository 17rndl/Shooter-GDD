# Crowd Shooter Runner — prototype

A playable, browser-based prototype of the hyper-casual 3D crowd-runner / auto-shooter
described in [`crowd-shooter-runner-gdd.md`](crowd-shooter-runner-gdd.md).

Built with **TypeScript + Three.js + Vite** — the GDD's recommended "validate the feel
in-browser" path (Claude Code can build, run, and verify this end-to-end; it cannot drive
the Unity editor). The shippable target stays Unity; this proves out the design and tuning.

It is a **web app** with a plain-DOM HUD over a WebGL canvas (no React, no React Native).
The same bundle also ships as an **installable Android app** inside a Capacitor WebView shell
(see [Android app (Capacitor)](#android-app-capacitor)). The long-term native target is still
a **Unity (C#) Android** build; [`docs/UNITY_PORT.md`](docs/UNITY_PORT.md) is the port guide.

## Run it

```bash
npm install
npm run dev      # open the printed http://localhost:PORT
```

- **Drag left / right** (mouse or touch) to steer the crowd. Everything else is automatic.
- Build for static hosting: `npm run build` → `dist/` (relative paths, opens anywhere). It
  carries a web manifest and icons, so a phone browser's "Add to Home screen" gets the real
  name and icon (and a fullscreen portrait launch where the browser honours the manifest).
- Android APK: see [Android app (Capacitor)](#android-app-capacitor).

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
  main.ts                  boot (immersive → GameManager → config → level manifest), failed-boot screen
  core/GameManager.ts      state machine (MENU→PLAYING⇄BOSS→WIN→REWARD / LOSE→revive), pause,
                           ad / lifecycle / back-button hooks, quality + context-loss wiring,
                           system tick order
  core/WorldSpace.ts       WORLD_X_SIGN + screenToWorldX: the one place that knows the X mirror
  platform/Platform.ts     isNative / platform ('android' | 'ios' | 'web'), enterImmersive()
  platform/AppLifecycle.ts one deduped hidden / visible signal + back button (Escape on the web)
  platform/NativeHaptics.ts  @capacitor/haptics service; createHaptics() picks native or web
  systems/InputSystem.ts   drag → normalized steer (first finger only, pointer capture)
  systems/QualityPolicy.ts render tiers + the AUTO step-down / step-up rule (pure, Node-testable)
  systems/QualityManager.ts  applies a tier to the renderer: pixel-ratio cap, shadows
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
  services/HapticsService.ts   IHapticsService, HapticThrottle (shared), navigator.vibrate service
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
  manifest.webmanifest     PWA manifest (fullscreen, portrait, navy theme)
  icons/                   PWA icons (rendered from resources/icon.svg)
scripts/balance-sim.mjs    balance regression test (`npm run balance`)
capacitor.config.ts        app id / name, webDir 'dist', native plugin config
android/                   Capacitor Android project (MainActivity: portrait, immersive, screen on)
resources/                 icon.svg master + render-icons.mjs (headless Edge rasterizer)
.github/workflows/         ci.yml (web checks), android.yml (debug APK + release AAB)
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

## Android app (Capacitor)

The web build runs unchanged inside a **Capacitor 8** WebView shell: `android/` was generated by
`npx cap add android` and then customised. It is one bundle for both: in a browser
`src/platform/Platform.ts` reports `'web'` and every native call is skipped.

What the shell adds:

- **Portrait, immersive fullscreen** — `MainActivity` locks portrait (the manifest's
  `appCategory="game"` keeps that lock on Android 16+ tablets and foldables), hides the status
  and navigation bars (a swipe from the edge shows them briefly over the game), draws edge to edge
  into the display cutout and keeps the screen on while the game is in front. Every window
  background is navy `#0a0e1a`, so there is no white flash, and Android 12+ gets a navy splash
  with the launcher icon. The HUD clears notches and the gesture bar via `env(safe-area-inset-*)`.
- **Back button** — `src/platform/AppLifecycle.ts` routes hardware / gesture back: it closes
  Settings (RESUME on the pause sheet, BACK on the menu) or the Shop, pauses a live run, is
  swallowed on the result screens and while an ad or level change is in flight (a stray back
  never skips a reward), and leaves the app from the menu.
- **Backgrounding** — native app state, page visibility and pagehide / pageshow are folded into
  one hidden / visible signal that fires once per real transition: a live run pauses, audio
  goes silent.
- **Native haptics** — `@capacitor/haptics` (impact light / medium / heavy, notification
  warning / success / error) behind `IHapticsService`, through the same priority throttle as
  the web's `navigator.vibrate` service.
- **Adaptive quality** — Settings → **Graphics: AUTO / HIGH / LOW**. HIGH is pixel ratio up to
  2 with 1024 px shadows, LOW is pixel ratio 1 with no shadows. AUTO starts on the middle tier
  in the app (pixel ratio up to 1.5, 512 px shadows; on high in a browser) and measures live
  play only: a 3 s window slower than 45 fps drops a tier at once; climbing back takes 10 s of
  windows faster than 57 fps, at least 20 s after the last drop, so it never flaps. The rule is
  `src/systems/QualityPolicy.ts` (pure, Node-testable).
- **WebGL context loss** — the run pauses and nothing renders or simulates; on restore the tier
  is re-applied (shadow maps and shaders rebuilt) and the run waits on the pause sheet.
- **Touch hygiene** — only the first finger steers (a second one waits until it lifts); no
  long-press callout, context menu, overscroll bounce, text selection or double-tap zoom.

Identity: app id `com.rndl.crowdshooter` (a placeholder, see below), name "Crowd Shooter
Runner", version 0.2.0 / versionCode 2, minSdk 24, compile and target SDK 36. Permissions are
INTERNET and VIBRATE only; cleartext traffic is off; WebView debugging is on in debug builds only.

### CI builds

GitHub Actions runs on every push: `.github/workflows/ci.yml` checks the web build and
`.github/workflows/android.yml` builds the app on JDK 21 + Android SDK 36 (`npm ci`,
`npm run build`, `npx cap sync android`, then Gradle). The Android run uploads two artifacts: a
**debug APK** to install and a **release AAB** for Google Play. The AAB is signed when these
repository secrets exist (Settings → Secrets and variables → Actions):

| Secret | Value |
| --- | --- |
| `ANDROID_KEYSTORE_BASE64` | the upload keystore (`.jks`), base64-encoded |
| `ANDROID_KEYSTORE_PASSWORD` | the keystore password |
| `ANDROID_KEY_ALIAS` | the key's alias |
| `ANDROID_KEY_PASSWORD` | the key's password |

Without them the AAB is built unsigned: good for proving the build, not for uploading. Make a
keystore once with the JDK's `keytool -genkeypair -v -keystore upload.jks -alias upload
-keyalg RSA -keysize 2048 -validity 10000`, encode it with `base64 -w0 upload.jks` (Git Bash),
and keep it out of the repo (`*.jks`, `*.keystore` and `keystore.properties` are gitignored).
Losing it means losing the ability to update the app.

### Install the APK on a phone

1. GitHub → **Actions** → the latest Android workflow run → **Artifacts**: download the debug
   APK (a zip) and unzip it.
2. Either `adb install -r app-debug.apk` with USB debugging on, or copy the APK to the phone and
   open it (allow "Install unknown apps" for the file manager or browser once).

If an install over an older build fails with a signature mismatch (a CI runner can sign debug
builds with its own debug key), uninstall the old build first. That also clears the save, which
lives in the app's WebView storage.

### Build locally

Needs **JDK 21** and the **Android SDK with platform 36** (Android Studio installs both; point
`ANDROID_HOME`, or `sdk.dir` in `android/local.properties`, at the SDK).

```bash
npm run cap:sync      # web build, copy it into android/, sync the plugins
npm run android:apk   # cap:sync, then ./gradlew assembleDebug (macOS / Linux)
```

The APK lands in `android/app/build/outputs/apk/debug/app-debug.apk`. On Windows `android:apk`
fails from every shell, Git Bash included: npm runs scripts through cmd.exe, which cannot run
`./gradlew`. Run the two halves yourself instead: `npm run cap:sync`, then `cd android` and
`gradlew.bat assembleDebug` (in PowerShell `.\gradlew.bat assembleDebug`, in Git Bash
`./gradlew assembleDebug`). `npx cap open android` opens the project in Android Studio.
Re-sync after every web change: the copied bundle in `android/app/src/main/assets/public` is
gitignored and only `cap sync` refreshes it.

### Before the first Play upload: change the app id

`com.rndl.crowdshooter` is a placeholder, and Play never lets an app's id change after its first
upload. Change it in:

- `capacitor.config.ts` → `appId`
- `android/app/build.gradle` → `applicationId` (the id Play sees) and `namespace`
- the Java package: move `android/app/src/main/java/com/rndl/crowdshooter/MainActivity.java` to
  the new package path and update its `package` line (it must match `namespace`, because the
  manifest names the activity `.MainActivity`)
- `android/app/src/main/res/values/strings.xml` → `package_name` and `custom_url_scheme`

then run `npm run cap:sync`. Only `appId` and `applicationId` are strictly required; the
namespace and the Java package can keep the old name, but if one changes, both must.

### Icons

`resources/icon.svg` is the master (1024 px, the art inside the central 66% so adaptive masks
never clip it). `node resources/render-icons.mjs` rasterizes it with headless Edge into every
Android launcher icon (adaptive foreground layers plus legacy square and round PNGs, mdpi to
xxxhdpi) and the PWA icons in `public/icons/`; set `CHROME=/path/to/chrome-or-edge` to use
another Chromium-based browser. `node resources/render-icons.mjs preview` writes a legibility
contact sheet.

## Not yet built
- Real **AppLovin MAX** wiring behind `IAdService` and **Unity IAP / Play Billing** behind
  `IIapService` (receipt validation included); the stubs and AdGate rules are ready for them.
  In the Capacitor shell they would be native plugins behind the same interfaces.
- An **iOS shell**: `Platform`, `AppLifecycle` and the haptics already handle `'ios'`, but there
  is no `ios/` project.
- The **Unity 6 / URP port** (the long-term native target), following `docs/UNITY_PORT.md`.
- **Art**: real unit, enemy and boss models and VFX in place of the primitive shapes.

## Dev/debug
`window.__game` is exposed in the browser console: `__game.debug()` dumps live state (now
including `paused`, `adOpen`, `adBusy`, `skin`, `music`, `settings`, `removeAds`,
`levelCount`, and from Phase F `platform`, `tier`, `graphics`, `glLost`),
`__game.debugSteer(0..1)` drives the steer target. Harmless; strip for production.

- **Escape is back** on the web, exactly like Android's back button (closes Settings or the
  Shop, pauses a live run, does nothing on the menu and the result screens); it is ignored while
  typing in a text field.
- **Graphics** (Settings → Graphics) is saved as `settings.graphics` (`auto` / `high` / `low`;
  older saves migrate to `auto`). `__game.debug().tier` shows the tier in force. A desktop
  rarely leaves high on AUTO: to watch it step down, throttle the CPU in DevTools (Performance →
  CPU 6× slowdown) during a run.
- **Context loss**: in the console,
  `const x = document.getElementById('gl').getContext('webgl2').getExtension('WEBGL_lose_context')`,
  then `x.loseContext()` (the run pauses, `glLost: true`) and `x.restoreContext()`.

Ad test flags (query string, stub SDK only):
- `?adfail`: rewarded ads finish without granting a reward.
- `?adnofill`: no ad is ever ready, so the rewarded buttons are hidden and interstitials are skipped.
- `?adhang`: a rewarded ad never shows or calls back, which exercises AdGate's load timeout (`ads.rewardedTimeoutSec`).
