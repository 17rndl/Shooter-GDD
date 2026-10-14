# Unity port guide

For the engineer porting this prototype to **Unity 6 LTS + URP, Android, IL2CPP ARM64** (GDD §12).

The prototype is a browser build: TypeScript + Three.js + Vite, no React or React Native. It exists to lock in feel, rules and numbers. Port the rules and the data. Rebuild the rendering, UI and platform services on Unity's own APIs.

Status words used below:

- **Verbatim**: a pure rule with no engine types. Translate it line by line to C# and keep the names, so the two codebases can be diffed by eye.
- **Glue**: engine or DOM code. Rewrite it with Unity idioms and keep only the behaviour.
- **Mixed**: lift the pure methods out as Verbatim and rewrite the rest.

## 1. Module map

Target layout is GDD §13: `Assets/_Game/Scripts/{Core,Systems,Crowd,Entities,Data,Services,UI,Util}`.

| Prototype file | Unity home | Port | What carries over |
|---|---|---|---|
| `src/main.ts` | `Core/Boot` (Boot scene) | Glue | Boot order: load config, then levels, then build GameManager. |
| `src/core/GameManager.ts` | `Core/GameManager` + `GameStateMachine`; `Systems/*` | Mixed | `simulate()` is the §13 system order: Input → Movement → Formation (`crowd.update`) → Combat → Gate → Collision → boss chip → HUD. Split it into systems in **that order**. The pure parts are Verbatim: `findTargets` (split fire, see §5), `scaleSegment` (wrap scaling), `crowdHalf`, the revive amount `max(10, floor(peak·reviveFraction))`, the payout `round(survivors·(coinPerUnit+income)·max(1,mult))`, the finish-lane preview and the danger rule. States: `MENU → PLAYING ⇄ BOSS → WIN → REWARD`, and `LOSE → revive → resumeState`. |
| `src/core/WorldSpace.ts` | `Core/WorldSpace` | Verbatim, **sign = +1** | See §2. |
| `src/systems/InputSystem.ts` | `Systems/InputSystem` | Glue | Absolute mapping: touch X as a 0..1 fraction of screen width, clamped. Ignore touches that start on UI (`EventSystem.IsPointerOverGameObject`). |
| `src/crowd/CrowdController.ts` | `Crowd/CrowdController` | Mixed | Verbatim: `effectiveDPS`, `laneHalf`, `damage` (fractional loss accumulator), `kill`, `visibleCount`, `visualSwell`. Glue: the phyllotaxis layout loop, the birth ripple and the death pops. |
| `src/crowd/UnitInstancer.ts` | `Crowd/UnitInstancer` | Glue | One instanced draw for the whole crowd (§5). |
| `src/combat/BulletPool.ts`, `ParticlePool.ts` | `Systems/CombatSystem` visuals over `Util/ObjectPool` | Glue | Visual only, capped, never carries damage. `setColor` tints the tracer material to the equipped skin. |
| `src/entities/GatePair.ts` | `Entities/GatePair` | Mixed | Verbatim: `applyFor` (add / mul with `round` / sub / div with `floor`, clamped ≥ 0, nearest door wins), `hit` (tick accumulator; add/mul climb to `addCap`/`mulCap`, sub/div decay to `decayFloor`), `overlappingHalf`. Door meshes become a prefab. |
| `src/entities/Boss.ts` | `Entities/Boss` | Mixed | Verbatim: the attack registry (`sweep_fire`, `slam`; unknown names dropped, empty falls back to sweep), cooldown/telegraph lerps by `hurt`, the slam lock-on and clamp, the overlap-fraction loss, and the `rollBand` anti-repeat. |
| `src/entities/Barricade.ts` | `Entities/Barricade` | Mixed | Verbatim: `ramPenalty = ceil(hp·ramFactor)`, `overlapsLane`. |
| `src/entities/EnemyCrowd.ts` | `Entities/EnemyCrowd` | Mixed | Verbatim: `enemyDPS`, `overlapsLane` (half = `max(0.4, spacing·√count·0.5)`). |
| `src/entities/ObjectiveNode.ts`, `Finish.ts`, `Pickup.ts` | `Entities/` | Mixed | Verbatim: the reward on clear, `Finish.pickFor`, and lane centres from WorldSpace. Pickup resolution lives in `GameManager.collisionSystem`. |
| `src/world/Track.ts` | Track prefab under `Entities/` | Glue | Static strip, rails and chevrons. |
| `src/data/types.ts` | `Data/GameConfig.cs`, `LevelDefinition.cs`, `SaveData.cs` | Verbatim shapes | `[Serializable]` classes (see §3). |
| `src/data/ConfigLoader.ts` | `Data/ConfigLoader` | Mixed | `validateConfig` is Verbatim. Replace `fetch` with `Resources.Load<TextAsset>("config")`. |
| `src/data/LevelRepository.ts` | `Data/LevelRepository` | Mixed | `validateLevel`, `wrapIndex`, `wrapsFor` and `parseManifest` are Verbatim, including the error strings. `FetchLevelRepository` becomes `ResourcesLevelRepository`. Cache by wrapped index and never mutate a cached definition. |
| `src/services/AdService.ts` | `Services/IAdService`, `AdGate`, `MaxAdService`, `AdServiceStub` | `AdGate` Verbatim | See §4. |
| `src/services/IapService.ts` | `Services/IIapService`, `UnityIapService` | Glue behind the interface | See §4. |
| `src/services/HapticsService.ts` | `Services/IHapticsService`, `AndroidHapticsService` | Throttle Verbatim | See §4. |
| `src/services/SaveService.ts` | `Services/SaveService` | Mixed | `sanitizeSave` is Verbatim. Storage is Glue (§4). |
| `src/services/AudioService.ts` | `Services/AudioService` | Rewrite | See §4. |
| `src/ui/HUD.ts`, `ShopPanel.ts`, `SettingsPanel.ts`, `index.html` | `UI/` (uGUI or UI Toolkit) | Glue | Verbatim rules: upgrade cost `ceil(upgradeCostBase·upgradeCostGrowth^level)` with max level 10, the skin card states (EQUIPPED / EQUIP / price), the store in-flight lock, and the two-tap reset (the second tap counts only between 450 ms and 3 s after the first, and a held key's auto-repeat never counts). |
| `src/util/MathUtil.ts` | `Util/MathUtil` | Verbatim | `clamp`, `lerp`, `damp` (frame-rate independent), `phyllotaxis`, `spansOverlap`. |
| `src/util/Label.ts` | TextMeshPro world-space text | Glue | Redraw only when the value changes. |
| `scripts/balance-sim.mjs` | `Tests/EditMode/BalanceSimTests` | Port | See §6. |
| `public/config.json`, `public/levels/*.json` | `Assets/_Game/Resources/config.json`, `Resources/levels/` | Same files | `Resources.Load` takes the path without the extension. Strip `.json` from manifest entries. |

**Wrap scaling (endless mode)** is a Verbatim rule:

- Wraps: `wraps = wrapsFor(n, count)`, and the factor is `f = 1 + wrapDifficultyStep·wraps`.
- Scaled by `f` and rounded: `hp`, `count`, and the `sub`/`div` gate values.
- Not scaled: `add`/`mul` gate values and pickup `value`.
- Speed: `forwardSpeed + wrapSpeedStep·wraps`.
- Always scale a copy, never the cached definition.

**Numeric parity.** JS numbers are doubles, and these are the spots where a naive C# port drifts:

| JS | C# trap | Use |
|---|---|---|
| `Math.round(x)` rounds .5 toward +∞ | `Math.Round` and `Mathf.RoundToInt` round .5 to even | `Math.Floor(x + 0.5)` |
| `Math.floor((n-1)/count)` | Integer `/` truncates toward 0 | Floor division, or divide as doubles |
| `Math.pow` (double) | `Mathf.Pow` is float | `Math.Pow` |
| Stable insertion sort in `findTargets` | `List.Sort` / `Array.Sort` are unstable | Port the insertion sort. Tie order (barricade, enemy, objective, gate, boss) decides damage shares. |

The Verbatim rule functions (DPS, gate ops and ticks, damage and its fractional-loss accumulator, overlap fractions, split weights, payouts) take and return `double`, because the balance sim calls them (§6) and float drift over thousands of 1/60 s steps can move a `floor`/`round` boundary or a `toFixed(1)` TTK. Gameplay code may cast to `float` at the edges: Transform positions, shader values and UI.

## 2. Coordinate frame

Three.js is **right-handed**. The chase camera sits at `(0, 6.2, -8.5)` and looks down **+Z**, so world **+X renders on screen-left**. `WORLD_X_SIGN = -1` in `src/core/WorldSpace.ts`.

Unity is **left-handed**. A camera looking +Z has +X on screen-**right**, so set `WORLD_X_SIGN = +1`. Do not flip the camera or give it a negative scale to "match".

```
screenToWorldX(t01, minX, maxX) = (minX + maxX)/2 + WORLD_X_SIGN·(t01 - 0.5)·(maxX - minX)
t01: 0 = screen-left edge, 1 = screen-right edge
```

Every screen-authored placement goes through this one function:

- **Steering:** `screenToWorldX(clamp01(t))`.
- **Gate doors:** `left` at `screenToWorldX(0.25)` and `right` at `screenToWorldX(0.75)`.
- **Finish lanes:** lane *i* of *n* at `screenToWorldX((i + 0.5)/n)`. Lane 0 is screen-left.

**Authored level `x` values are in the Three.js world frame.** For example, `x: 1.4` is screen-left. To keep the same screen layout, the Unity importer must negate every segment `x` (`xUnity = -x`). The track bounds become `[-maxX, -minX]`, which is unchanged while the track is the symmetric ±3.

Gate `left`/`right` in JSON are **screen** labels. Do not swap them in data, because WorldSpace already places them.

What needs no sign handling:

- **Z** is forward (+Z) in both engines.
- **The boss band** is rolled and clamped in world X. The slam band locks onto the crowd's world X.
- **The phyllotaxis offsets** are symmetric.
- **Camera follow** (`x·0.3`, look-at `x·0.18`) is world-relative.

Every rule depends only on |Δx| and on the symmetric clamps, so a negated level with sign +1 plays identically to the original.

## 3. JSON with JsonUtility

- **Flat `Segment` class.** `Segment` is one flat `[Serializable]` class with every optional field: `z, type, left, right, tickable, tickPerHit, x, hp, width, count, fireRate, reward, attacks, multiplierLanes, value`. `GateSide` is `{ op, value }`. Use `float` for anything a designer might make fractional (`z, x, hp, width, fireRate`, gate `value`, lanes). Use `int` for `count`, `reward`, pickup `value` and `tickPerHit`.
- **Absent vs 0.** JsonUtility cannot tell an absent key from 0 and has no nullable primitives (`int?` is not serialized). The validator's required-positive checks double as presence checks: `length`, `forwardSpeed`, `hp`, `count`, `value`, gate `value` and `multiplierLanes` all fail with the same message whether the key is absent or zero. `id` and `z` are the exceptions: absent becomes 0 and passes silently, while the TS validator rejects it. Accept that, or parse levels with Newtonsoft (`com.unity.nuget.newtonsoft-json`) and nullable fields.
- **Defaults.** Do not rely on C# field initializers. `JsonUtility.FromJson` does not run the constructor, so a missing key arrives as `default(T)` (0, `false`, `null`), and array elements such as `Segment[]` are built by the serializer the same way. Apply the non-zero defaults explicitly after parsing, in the importer before `validateLevel`: `tickPerHit` 1, `width` 2.0 and `fireRate` 4 when the parsed value is `<= 0`. 0 is never a meaningful authored value for these: a tickable gate that never ticks, a barricade with no width, an enemy that never fires. This differs from the TS `??` only for an explicit `0`, which no shipped level uses. Pin it with an EditMode test that parses a segment without these keys. `FromJsonOverwrite` onto a `new T()` keeps initializers for a top-level object only, never for array elements.
- **Gate sides need a has-flag.** Nested `[Serializable]` fields are never null after `FromJson`, so an absent `left` arrives as `GateSide { op = "" or null, value = 0 }`. Treat `string.IsNullOrEmpty(op)` as "side absent" before validating. Absent `attacks` arrives as an empty array, which resolves to `['sweep_fire']` exactly as `undefined` does in TS, so it needs no flag.
- **No top-level arrays.** That is why `levels/index.json` is the object `{"levels": [...]}`.
- **No `Dictionary`.** Config sections are plain nested classes, and `skins` is a `SkinDef[]`.
- **Fields, not properties.** JsonUtility reads public fields (or `[SerializeField]`) only, and the names must match the JSON keys. Keep them camelCase, not PascalCase.
- **Hex colors.** Parse with `ColorUtility.TryParseHtmlString("#4ea3ff", out var c)`. Skin colors are sRGB. Assign them to material color properties as-is, and URP Linear handles the conversion.

## 4. Services

All services sit behind interfaces from day one, so the game runs with stubs and no SDK (GDD §10, §13).

### Ads

`IAdService` is implemented by a `MaxAdService` adapter over AppLovin MAX.

- `isRewardedReady` / `isInterstitialReady` call the SDK's ready checks.
- `showRewarded` completes `true` only when the reward callback fired before the hide callback. It completes `false` on display failure.
- `showRewarded` and `showInterstitial` take an `onShown` callback. Call it from `OnAdDisplayedEvent`. AdGate's `rewardedTimeoutSec` (30 s) only bounds the time until the ad is on screen, for a load or show that never happens. Once `onShown` fires, only a 180 s backstop remains, so a full 30 s video plus its end card never loses its reward. An adapter that never calls `onShown` brings back the 30 s cap on the whole ad.
- Reload the ad after every hide.
- Complete the `Task` on the main thread. Awaits resume through Unity's synchronization context.

**Port `AdGate` as-is:**

- Single-flight: `busy` is set while an ad is open or loading.
- `onAdOpen` / `onAdClose` always fire, including on timeout and on reject.
- A timed-out rewarded ad that resolves late grants nothing. This is why the timeout must not cover the video itself (see `onShown` above).
- Interstitials are capped by `every N clears`, `minIntervalSec` and `removeAds`.

**Hooks:**

- `onAdOpen`: pause gameplay time and call `AudioService.Suspend()`.
- `onAdClose`: undo that.
- `now()`: `Time.realtimeSinceStartupAsDouble`. It must be unscaled, because `timeScale` is 0 while an ad is up.
- Android also delivers `OnApplicationPause(true)` when the ad activity takes over. That is harmless because suspend/resume are idempotent.

### In-app purchases

`IIapService` is implemented over Unity IAP (`com.unity.purchasing`).

- **Products:** `remove_ads` is NonConsumable. `coins_small` (1500) and `coins_large` (10000) are Consumable.
- **Prices:** take them from the store's localized price string, not the stub's hard-coded `$2.99`.
- **Granting** stays in the caller (`ShopPanel`), as in the prototype. For consumables, confirm or acknowledge the purchase only **after** the grant is saved, so a crash between payment and save cannot eat coins.
- **Restore:** Google Play re-delivers owned non-consumables at initialization. The RESTORE PURCHASES button is mainly an iOS requirement. On Android it re-grants `remove_ads` if the store reports it owned.
- **Receipts:** validate on a server before trusting them in production.

### Haptics

`IHapticsService` is implemented by `AndroidHapticsService` over `AndroidJavaObject`.

- **Vibrator:** on API 31+ use `VibratorManager.getDefaultVibrator()`. Otherwise use `getSystemService("vibrator")`.
- **Effects:** on API 26+ use `VibrationEffect.createOneShot` / `createWaveform(timings, -1)`. minSdk is 24, so API 24–25 fall back to the deprecated `vibrate(long[], -1)`.
- **Pattern gotcha:** `navigator.vibrate` patterns start with an **on** time, but Android `timings` start with an **off** delay. Prepend `0`, so heavy `[28,40,28]` becomes `[0,28,40,28]`.
- **Permission:** declare `android.permission.VIBRATE` in the manifest. Unity adds it only when `Handheld.Vibrate` is referenced.
- **Allocations:** cache the Java objects and the `long[]` patterns, because JNI calls allocate.
- **Behaviour:** `supported = hasVibrator()`. Port the 70 ms throttle and the priority order (fail > success > heavy > warn > medium > light) verbatim. Drop the `userActivation` gate, which is web-only.

### Save

`SaveService` writes JSON to `Path.Combine(Application.persistentDataPath, "csr_save_v1.json")`. PlayerPrefs is acceptable for an MVP.

- **Atomic writes:** write to a temp file, then `File.Replace` or move it over the real one. A kill mid-write must not corrupt the save.
- **Sanitize:** run the ported `sanitizeSave` on every load.
- **Migration gotcha:** JsonUtility turns a missing boolean into `false`, so a save written before `music` existed would load with music off. Either add a `saveVersion` field and migrate explicitly (`< 2` sets `music = true`), or read the save with Newtonsoft.
- **Reset progress** clears level, coins, best peak, upgrades and skins. It keeps `settings` and `removeAds`: preferences and a paid entitlement are not progress.
- **Resolve skins in the game:** match `equippedSkin` against `cfg.skins` and fall back to `cfg.skins[0]`. SaveService does not know the catalog.

### Audio

`AudioService` uses real loop assets on an `AudioMixer` with **Music** and **SFX** groups. Each toggle drives the group's exposed volume to -80 dB. The procedural WebAudio synth in the prototype (SFX and music) is prototype-only.

- **Music intensity (0 menu/reward/lose, 1 run, 2 boss):** use stems started together with `AudioSource.PlayScheduled` at one `dspTime`. Change a layer by fading its volume, scheduled on the next bar line computed from `dspTime` and the BPM.
- **SFX:** pool AudioSources. `magnitude` maps to pitch (bigger multiplies pitch up, GDD §11). Keep the prototype's throttle on high-rate cues such as `spark`, which is requested about 100×/s at large crowds.
- **Suspend / resume:** `AudioListener.pause`, also wired to `OnApplicationPause` / `OnApplicationFocus`.
- **`unlock()`** is a browser autoplay workaround. It is a no-op on Android.

## 5. Performance rules carried over

- **Crowd rendering:** one non-skinned low-poly unit in one instanced draw. Use `Graphics.RenderMeshInstanced` (at most 1023 per call with `DrawMeshInstanced`) over a preallocated `Matrix4x4[maxVisibleUnits]` that is filled in place. Enable GPU instancing on the material and do the "alive" bob in the vertex shader. Only one skin shows at a time, so a skin change is a single material color set.
- **Logical count is decoupled from visible instances:**
  - Power is `count`.
  - Rendering shows `min(count, maxVisibleUnits)` (100).
  - Above the cap, `visualSwell = clamp(log10(count/cap), 0, 1)` makes the crowd bigger instead of wider.
  - DPS, the firing lane (`laneHalf`) and damage read `count`, never instances.
  - The one deliberate exception is the crowd's physical footprint, `crowdHalf = max(0.3, formationSpacing·√visibleCount·0.55)`. It reads `visibleCount = min(count, maxVisibleUnits)`, so the body stops widening at the cap. It drives the barricade ram test, the boss sweep and slam overlap, and pickup reach. The balance sim does the same, so computing it from `count` breaks the golden.
- **Tracers carry no damage.** Damage is applied logically each frame. Tracers are pooled and capped (`maxVisibleBullets` 120 for the player, 28 for enemies), and a new spawn recycles an old one. Tracer density scales with √count, so it reads as crowd size. Particles are a capped pool (240) that overwrites its oldest slot. One `ParticleSystem.Emit` with `maxParticles` set does the same.
- **No per-frame allocation:**
  - The target candidates are a pooled array with an in-place stable insertion sort.
  - The lane-preview buffer is reused.
  - No LINQ, no capturing lambdas and no string building in `Update`.
  - HUD text calls TMP `SetText` only when the value changes. Number plates redraw on change, at most about 12 times a second.
  - Target 0 B GC Alloc per frame in the Profiler during a run.
- **No physics.** Every contact is a 1-D X-span overlap test (`spansOverlap`) at a Z crossing. Do not add Rigidbodies or colliders.

## 6. The balance sim is the regression oracle

`npm run balance` (`scripts/balance-sim.mjs`) does the following:

- It replays every level in `levels/index.json` order at a fixed 1/60 s step under two deterministic policies:
  - **BEST:** takes every good gate, dodges, clears objectives.
  - **WORST:** takes every bad gate, fights everything, rams, and stays passive at the boss.
- It asserts the §15 rule: BEST kills the boss, keeps at least 40% of its standoff crowd, and the boss lasts at least 5 s. WORST dies before the finish.
- It prints a table and the BEST trace, and exits 1 on failure.

Port it as an EditMode test that produces the **same text** and compares it to a golden file captured with `npm run --silent balance` (commit it as `Tests/balance-golden.txt`). For a byte-identical match:

- **Data and frame:** read the raw authored JSON, with no x negation, and keep the sim's own `WORLD_X_SIGN = -1`. Give the C# `ScreenToWorldX` an optional sign parameter for this. The sim's tie-breaks are not mirror-symmetric (`dHi >= dLo ? maxX : minX`, `bandCenter < 0 ? maxX : minX`, `BAND_SEQUENCE`), so it must run in the authored frame.
- **Shared rule code:** call the game's ported rule functions (DPS, gate op and ticks, overlap fraction, split weights) instead of re-implementing them. Then a rule drift in the game breaks the golden. This only works because those functions take and return `double` (§1). Never route the sim through a `float` overload.
- **Arithmetic:** use double math throughout, including the per-frame hp and fractional-loss accumulators, and the rounding rules from §1.
- **Fixed inputs:** keep the same `BAND_SEQUENCE`, `LOOKAHEAD` and `DODGE_MARGIN`.
- **Formatting:** `toFixed(1)` becomes `ToString("F1", CultureInfo.InvariantCulture)`. A device locale with decimal commas will otherwise break it. `padEnd` becomes `PadRight`. Write UTF-8, because the output contains `§ — → ✗`.

When a rule or number changes on purpose, re-run the sim in both codebases and update the golden in the same commit.

## 7. X-mirror checklist

- [ ] `WorldSpace.WORLD_X_SIGN = +1` in Unity, and the camera is unflipped and looks +Z.
- [ ] The importer negates every segment `x`, and the track bounds become `[-maxX, -minX]`.
- [ ] Gate `left`/`right` are not swapped in data. Doors are placed by `ScreenToWorldX(0.25 / 0.75)`.
- [ ] Finish lanes come from `ScreenToWorldX((i + 0.5)/n)`. The first lane (×2) is screen-left.
- [ ] Input feeds `ScreenToWorldX(clamp01(t))`. Dragging right moves the crowd right.
- [ ] The balance-sim test runs on raw JSON with sign -1 and matches the golden.
- [ ] Level 1 smoke test on device:
  - The first gate shows ×3 on screen-left and +12 on screen-right.
  - The opening coin trail (`x: -2.2`) runs on screen-**right**.
  - The first enemy crowd (`x: 1.4`) is screen-**left**.
