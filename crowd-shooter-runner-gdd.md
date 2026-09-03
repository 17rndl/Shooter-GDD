# Crowd Shooter Runner — Game Design & Technical Spec

> A hyper-casual 3D "crowd runner + auto-shooter" game. You command a growing crowd that auto-runs forward, auto-fires bullets, and steers left/right through multiplier gates while smashing barricades and out-gunning enemy crowds, ending each level in a boss fight.
>
> This document is written to be fed directly to **Claude Code** as a build brief. It defines the design, the tuning numbers, the data formats, and a recommended architecture so an implementation can start immediately.

---

## 1. One-line pitch

Drag to steer a swarm of shooters down a track, pick the right gates to multiply your numbers, blast through barricades and enemy crowds, and overwhelm the boss at the end.

---

## 2. Reference & genre

- **Reference image:** blue crowd at the bottom auto-firing up a bridge at orange enemies; numbered multiplier gates (`+1`, `-1`), numbered barricades (`79`), and large enemy/objective numbers (`215`, `130`, `37`).
- **Genre:** Hyper-casual 3D crowd runner / auto-shooter (a.k.a. "count masters" / "tower run" / "crowd shooter").
- **Session length:** 30–90 seconds per level. Instantly restartable. Built for ad-driven retention.

---

## 3. Core loop

```
Spawn crowd  ─►  Auto-run forward
      ▲                │
      │          Steer left/right (drag)
      │                │
      │          Auto-fire bullets ──► destroy barricades / enemies
      │                │
      │          Pass through gates (×, +, −, ÷) ──► crowd count changes
      │                │
      │          Reach boss ──► dump DPS until boss HP = 0
      │                │
   Restart        Finish line ──► reward (coins ∝ surviving crowd)  ──► next level
```

The entire emotional arc is: **start small → feel the crowd grow → feel powerful → tense boss → payoff.** Every system should serve that arc.

---

## 4. Controls

- **Single input: horizontal drag.** Touch (mobile) or mouse drag (web). The crowd's *centroid* tracks the finger's X position along the track width.
- **No tap-to-shoot.** Shooting is fully automatic and continuous.
- **No jump, no brake.** Forward speed is constant (designer-tunable per level / per segment).
- **Optional juice:** slight crowd "lean" in the steer direction; camera eases horizontally a fraction of the crowd's movement.

Steering model:
- Track has a fixed playable width (e.g. `-3.0` to `+3.0` world units).
- Map normalized input `[0,1]` → world X within `[minX, maxX]`.
- Move the crowd centroid toward target X with smoothing (lerp / critically-damped spring), clamped to the track and constrained by barricades currently in front.

---

## 5. The crowd (the star of the show)

### 5.1 Representation
- A single logical value: **`crowdCount`** (integer).
- A pool of visual unit instances. **Decouple count from instances** — render at most `maxVisibleUnits` (e.g. 60–120) and let `crowdCount` exceed that. Above the cap, scale firepower by the number, not by spawning more meshes (perf).

### 5.2 Formation
Arrange visible units around the steered centroid using a **sunflower / phyllotaxis spread** so packing always looks natural and dense:

```
for i in 0..n-1:
  r     = formationSpacing * sqrt(i)
  theta = i * 2.399963   # golden angle in radians
  x     = centroid.x + r * cos(theta)
  z     = centroid.z + r * sin(theta)   # small forward/back spread
```

- Radius grows with `sqrt(count)` so a big crowd reads as "big" without exploding in size.
- Clamp the formation so it never overflows the track width; squeeze spacing when near walls.
- Add tiny per-unit jitter + bob animation so the mass feels alive.

### 5.3 Death / loss of units
When the crowd loses units (bad gate, enemy fire, crashing a barricade), reduce `crowdCount` and despawn the outermost visible units with a quick pop/fade. **Game over when `crowdCount` reaches 0.**

---

## 6. Shooting system

### 6.1 Damage model (decoupled from visuals)
Do **not** instantiate one bullet per unit per frame — it won't scale. Instead:

- **`totalDPS = crowdCount * perUnitDamage * fireRate`** (logical).
- Spawn a **capped, pooled** set of *visual* tracer bullets (e.g. up to `maxVisibleBullets ≈ 40`) fanned across the crowd's front, purely cosmetic.
- Apply damage to whatever is "in front" each tick using `totalDPS * dt`, distributed across targets in the firing lane.

Optional softening so huge crowds don't trivialize everything:
- `effectiveDPS = crowdCount^0.85 * perUnitDamage * fireRate` (sub-linear). Tune the exponent for feel.

### 6.2 Targeting
- Bullets travel +Z (forward). Damage is applied to the **nearest damageable object overlapping the crowd's X-span**: barricade > enemy unit > enemy group node > boss.
- Wider crowd = wider damage lane (covers more targets in parallel). This makes growth feel meaningful beyond raw DPS.

### 6.3 Upgrades that touch shooting
- `perUnitDamage` (bullet power)
- `fireRate` (rate of fire)
- `bulletSpread` / lane width
- `startingCrowd`

---

## 7. Gates (multiplier doors)

The signature mechanic. Gates come in **pairs** spanning the track (left option / right option). The player steers through one; the other is destroyed/ignored.

### 7.1 Operations
| Type | Symbol | Effect on crowdCount | Color cue |
|------|--------|----------------------|-----------|
| Add | `+N` | `count += N` | green |
| Multiply | `×N` | `count *= N` | blue |
| Subtract | `−N` | `count -= N` | red |
| Divide | `÷N` | `count = floor(count / N)` | red |

- Good gates green/blue, bad gates red. Always present a meaningful choice (e.g. `×2` vs `+15`, or `×3` vs `−5`).
- Gate has its own small "HP" sometimes — you can **shoot a gate's value up/down** before passing (a common variant: a `+1`/`−1` counter that ticks as bullets hit it, like in the reference image). Support both:
  - **Static gate:** value fixed; just pick it.
  - **Tickable gate:** value changes while bullets hit it (e.g. starts `+1`, climbs as you shoot; or starts high `−` and you shoot it down toward `+`). Optional per-gate flag.

### 7.2 Passing logic
- When the crowd centroid crosses the gate plane, apply the gate it overlaps most.
- If the crowd is wide enough to clip both, apply the one the centroid is on (and visually shatter the other), OR (variant) apply both — choose per design; default = centroid wins.

---

## 8. Obstacles & enemies

### 8.1 Barricades (numbered blocks — the "79" tires in the ref)
- Block the lane; have **HP shown as a number** that ticks down as bullets hit.
- If destroyed before the crowd reaches it → crowd passes safely.
- If the crowd hits it while HP > 0 → **lose units** proportional to remaining HP (or a flat penalty), and the barricade breaks. Encourages steering around or pre-shooting.

### 8.2 Enemy crowds (orange shooters)
- Mirror of the player: a count + auto-fire that **damages the player crowd**.
- Resolve as a DPS race in the overlap lane: both sides lose units over time; bigger/faster side wins. Player steering can avoid part of an enemy group.

### 8.3 Numbered objective nodes (`215`, `130`, `37`)
- Large HP pools (gun emplacements / enemy clusters). Park your firepower on them until they hit 0 to clear the path or earn bonus crowd.

### 8.4 Boss (level finale)
- Single large entity with a big HP bar.
- `timeToKill = bossHP / effectiveDPS`. Tune so a *well-grown* crowd wins comfortably and a *poorly-grown* crowd loses — this is where gate choices pay off.
- Boss may have attacks that shave the crowd (telegraphed AoE / sweeping fire) to add tension.
- On boss death: confetti, slow-mo, finish line, reward screen.

---

## 9. Reward & progression

- **End-of-level reward:** `coins = survivingCrowd * coinPerUnit * levelMultiplier`.
- Optional **finish-line multiplier zone** (run through `×2 / ×3 / ×5` lanes for bonus coins) — classic rewarded-ad upsell spot.
- **Upgrades (coin sinks)** with rising costs:
  - Bullet Power (`perUnitDamage`)
  - Fire Rate (`fireRate`)
  - Starting Crowd (`startingCrowd`)
  - Income (`coinPerUnit`)
- **Skins** for units (cosmetic only).
- **Level structure:** handcrafted/config-driven levels 1–N, then procedural/looping with scaling difficulty. Difficulty curve via segment counts, gate balance, barricade HP, enemy counts, boss HP.

---

## 10. Monetization (ad-style hyper-casual)

- **Interstitial** between levels (frequency-capped, e.g. every 2–3 levels).
- **Rewarded video:**
  - `×2` (or `×3`) coins at reward screen.
  - **Revive** with partial crowd on game over.
  - Free upgrade / bonus crowd at level start.
- **Banner** on menus (optional).
- **IAP:** Remove Ads, coin packs, starter pack, skin bundles.
- Keep all ad calls behind a thin `AdService` interface with a no-op stub for development so the game runs without an SDK.

---

## 11. Art & audio direction

- **Visual:** clean low-poly 3D, bright flat colors, soft shadows, slight outline/toon shading. Player = blue, enemies = orange/red, good gates = green/blue, hazards = red. Readable at a glance from a top-down-ish chase camera.
- **Camera:** elevated chase cam behind/above the crowd, slight FOV punch on big multiplies, subtle shake on barricade breaks and boss hits.
- **Juice:** number pop-ups on gates/hits, crowd-grow whoosh, hit sparks, screen flash on `×N`, slow-mo on boss kill.
- **Audio:** light loopable track, satisfying "blip" multiply SFX that pitches up with bigger numbers, impact thuds, crowd cheer at finish.
- **UI:** live `crowdCount` big and center-bottom, coins top-right, level/progress bar top, minimal buttons.

---

## 12. Tech stack — Unity for Android (primary)

**Target platform: Android mobile (portrait).** The engine for this brief is **Unity**.

### Why Unity for this game
- It is the dominant engine for hyper-casual crowd runners: best ad mediation (AppLovin MAX / Unity LevelPlay / AdMob), mature **GPU instancing** for large crowds, one-click **Android App Bundle (.aab)** export.
- Claude Code can't drive the Unity editor, but it **can** write the full C# codebase, manager scripts, shaders, and editor scripts that wire prefabs/scenes — you run the editor + build loop. This is the normal Unity-with-an-assistant workflow.

### Versions & render pipeline
- **Unity 6 LTS (6000.x)** or latest 2022 LTS. **URP** (Universal Render Pipeline) — lightweight, mobile-tuned, supports GPU instancing.
- **C#**, **IL2CPP** scripting backend, **ARM64** target (required by Google Play).

### Android build settings
- Orientation: **Portrait** locked.
- Output: **Android App Bundle (.aab)** for the Play Store.
- **minSdkVersion 24** (Android 7.0) for broad reach; **targetSdkVersion** must meet current Play policy: new apps and app updates must target Android 15 (API level 35) or higher to be submitted to Google Play, and note the rolling deadline — as of August 31, 2026, all new apps and app updates submitted to Google Play must target Android 16 (API level 36) or higher. Set the target SDK to the highest installed Android SDK platform and keep it current; new apps and app updates must target an API level within one year of the latest major Android release, or Google Play will prevent submission.
- Texture compression: **ASTC**. Strip engine code, enable managed stripping (Medium/High).
- Keep the build lean (hyper-casual users bounce on big downloads) — aim well under typical install-size thresholds; prune unused packages.

### Mobile performance rules (non-negotiable for a crowd game)
- Render the crowd with **GPU instancing**: a shared instanced material on a simple **non-skinned** low-poly unit, with a tiny vertex-shader bob for "alive" motion. Avoid `SkinnedMeshRenderer` per unit — it won't scale.
- For MVP, pooled `GameObject` units with a hard visible cap (≈100–150) + GPU instancing is fine. For thousands later, move to `Graphics.DrawMeshInstanced` / `DrawMeshInstancedIndirect`, or **DOTS/Entities Graphics** if you go big.
- Decouple `crowdCount` (logic) and `effectiveDPS` (logic) from rendered instances and visible bullets (capped + pooled). This is the single most important perf decision — bake it in from commit one.

> **Optional fast prototype:** if you want to validate the *feel* before committing art, a throwaway TypeScript + Three.js build is the quickest thing for Claude Code to run in-browser. Treat it as disposable; ship in Unity.

---

## 13. Architecture (engine-agnostic, ECS-lite)

Systems (run each tick in this order):

1. **InputSystem** — read drag → target centroid X.
2. **MovementSystem** — advance track (constant +Z), smooth crowd toward target X, clamp to walls.
3. **FormationSystem** — lay out visible units (phyllotaxis) around centroid.
4. **SpawnSystem** — stream level segments ahead, recycle behind (object pooling).
5. **CombatSystem** — compute `effectiveDPS`, apply to in-lane targets, spawn capped visual bullets.
6. **GateSystem** — detect gate-plane crossings, apply op to `crowdCount`, shatter loser.
7. **CollisionSystem** — barricade contact, enemy overlap, boss contact.
8. **CrowdSystem** — reconcile `crowdCount` ↔ visible instances (spawn/pop), check game-over.
9. **HUDSystem** — render count, coins, progress, popups.
10. **GameStateMachine** — `MENU → PLAYING → WIN → REWARD → NEXT` / `LOSE → REVIVE? → RETRY`.

Cross-cutting:
- **ObjectPool** for units, bullets, popups, gates, barricades.
- **AudioService**, **AdService**, **SaveService** — all interface-first with stubs. On Unity: ads behind `IAdService` (AppLovin MAX impl + no-op stub), save via JSON to `Application.persistentDataPath` (or `PlayerPrefs` for the MVP), IAP via Unity IAP.

**Unity mapping of the systems:** implement systems as lightweight manager `MonoBehaviour`s coordinated by a `GameManager` (the state machine), or as plain C# classes ticked from one `GameManager.Update()` for testability. Suggested project layout:
```
Assets/
  _Game/
    Scripts/
      Core/        GameManager, GameStateMachine, ServiceLocator
      Systems/     Input, Movement, Formation, Combat, Gate, Collision, Crowd, Spawn
      Crowd/       CrowdController, UnitInstancer (GPU instancing)
      Entities/    Barricade, EnemyCrowd, ObjectiveNode, Boss, GatePair, Finish
      Data/        Config, LevelDefinition, SaveData (JSON-serializable)
      Services/    IAdService, AdMobService/MaxService, AudioService, SaveService, IAP
      UI/          HUD, MenuPanel, ShopPanel, RewardPanel
      Util/        ObjectPool, MathUtil (phyllotaxis), Tweens
    Prefabs/   Unit, Bullet, GatePair, Barricade, Enemy, Boss, Popup
    Shaders/   ToonUnit (instanced + vertex bob)
    Resources/ config.json, levels/level_001.json ...
  Scenes/  Boot, Menu, Game
```
Use `[CreateAssetMenu]` `ScriptableObject`s for upgrade/skin definitions; keep level + tuning data as JSON (parsed with `JsonUtility` or Newtonsoft) so designers can tweak without recompiling.

---

## 14. Data formats

### 14.1 Tuning config (`config.json`)
```json
{
  "track": { "minX": -3.0, "maxX": 3.0, "forwardSpeed": 7.0 },
  "crowd": {
    "startingCount": 5,
    "maxVisibleUnits": 100,
    "formationSpacing": 0.42,
    "steerSmoothing": 12.0
  },
  "combat": {
    "perUnitDamage": 1.0,
    "fireRate": 6.0,
    "dpsExponent": 0.85,
    "maxVisibleBullets": 40,
    "laneWidthPerUnit": 0.05,
    "laneWidthMax": 4.0
  },
  "economy": { "coinPerUnit": 2, "upgradeCostBase": 50, "upgradeCostGrowth": 1.35 }
}
```

### 14.2 Level definition (`level_001.json`)
A level is an ordered list of **segments** placed at increasing Z. The runner streams these in.
```json
{
  "id": 1,
  "length": 220,
  "forwardSpeed": 7.0,
  "segments": [
    { "z": 25,  "type": "gate_pair",
      "left":  { "op": "mul", "value": 2 },
      "right": { "op": "add", "value": 15 },
      "tickable": false },

    { "z": 55,  "type": "barricade", "x": 0.0, "hp": 80, "width": 2.0 },

    { "z": 80,  "type": "enemy_crowd", "x": 1.5, "count": 30, "fireRate": 4.0 },

    { "z": 110, "type": "objective_node", "x": -1.0, "hp": 215, "reward": 20 },

    { "z": 140, "type": "gate_pair",
      "left":  { "op": "sub", "value": 5 },
      "right": { "op": "mul", "value": 3 },
      "tickable": true, "tickPerHit": 1 },

    { "z": 190, "type": "boss", "hp": 1200, "attacks": ["sweep_fire"] },

    { "z": 215, "type": "finish", "multiplierLanes": [2, 3, 5] }
  ]
}
```

Supported `segment.type` values: `gate_pair`, `barricade`, `enemy_crowd`, `objective_node`, `boss`, `finish`, `coin_pickup` (optional), `crowd_pickup` (optional).
Supported gate `op` values: `add`, `mul`, `sub`, `div`.

### 14.3 Save data
```json
{ "currentLevel": 1, "coins": 0,
  "upgrades": { "bulletPower": 0, "fireRate": 0, "startingCrowd": 0, "income": 0 },
  "settings": { "sound": true, "haptics": true }, "ownedSkins": ["default"] }
```

---

## 15. Tuning starting values

| Param | Start value | Notes |
|-------|-------------|-------|
| `startingCount` | 5 | grows fast early to hook the player |
| `forwardSpeed` | 7 u/s | bump per level for tension |
| `perUnitDamage` | 1.0 | |
| `fireRate` | 6 /s | logical, not per-mesh |
| `dpsExponent` | 0.85 | sub-linear so size matters but isn't infinite |
| `formationSpacing` | 0.42 | tune so 100 units ≈ 3–4 u wide |
| `maxVisibleUnits` | 100 | perf cap; count can exceed |
| Boss HP (L1) | ~1200 | ≈ a few seconds for a healthy crowd |
| `coinPerUnit` | 2 | feeds upgrade economy |

Balance rule of thumb: a player taking *every good gate* should beat the boss with margin; a player taking *every bad gate* should lose. The fun lives in that gap.

---

## 16. Build phases (suggested order for Claude Code)

1. **Skeleton:** Unity URP project, `Game` scene, fixed-angle chase camera, ground/track plane, one cube as the crowd centroid, drag steering (Input System or `Input.GetTouch`), constant forward motion.
2. **Crowd:** `crowdCount` + GPU-instanced low-poly units + phyllotaxis formation (`MathUtil`) + grow/pop via `ObjectPool`.
3. **Shooting:** logical DPS + capped visual bullets + a single shootable barricade with a number that ticks down.
4. **Gates:** gate-pair prefab, 4 ops, pass detection, count math, shatter loser, popups.
5. **Enemies + objective nodes:** DPS-race resolution, lane targeting.
6. **Boss + finish + reward screen:** win/lose states, coins, multiplier lanes.
7. **Meta:** level loader (JSON), upgrades shop, save/load, progression.
8. **Juice + audio:** popups, shake, slow-mo, SFX, skins.
9. **Services:** `AdService` (stub → real), interstitial/rewarded hooks, IAP stubs.
10. **Polish & balance pass** against the rule in §15.

**MVP = phases 1–6** (a fully playable single level). Ship-feel = through phase 8.

---

## 17. Acceptance criteria for the MVP

- Crowd auto-runs and steers smoothly with one finger/drag; never leaves the track.
- `crowdCount` is always visible and updates instantly on gates/losses.
- Continuous auto-fire visibly damages barricades/enemies/boss; bigger crowd = clearly stronger.
- At least one `gate_pair` with a real trade-off; correct math applied on pass.
- At least one barricade, one enemy crowd, one objective node, one boss in a level loaded from JSON.
- Win → reward (coins) → next; Lose at 0 crowd → retry (+ revive hook).
- Runs at 60 fps on mid-tier mobile/web with `crowdCount` up to several hundred (thanks to instancing + DPS decoupling).

---

## 18. Stretch ideas (post-MVP)

- Tickable gates you actively shoot up/down (per ref `+1`/`−1`).
- Branching tracks / fork choices.
- Unit "types" (tank front line, ranged back line).
- Daily challenges, leaderboards.
- Procedural endless mode with scaling.
- Haptics on big multiplies and boss kill.

---

### Hand-off note to Claude Code
Build in **Unity 6 LTS + URP, C#/IL2CPP, ARM64, portrait, .aab output**. Stand up phases 1–6 for a single JSON-driven level, with `IAdService` / `AudioService` / `SaveService` as injected interfaces (no-op stubs first, AppLovin MAX wired later). Treat every number in §14–§15 as a tunable loaded from `config.json`, and keep levels as JSON so they're editable without recompiling.

From the very first commit, **decouple `crowdCount` and `effectiveDPS` (logic) from rendered instances and visible bullets (capped + pooled), and render the crowd via GPU instancing on a non-skinned unit** — that single decision is what keeps the game at 60 fps on mid/low-tier Android as the crowd grows into the hundreds or thousands. Do not use a `SkinnedMeshRenderer` per unit.

If you want to sanity-check the *feel* before committing art, a disposable TypeScript + Three.js prototype is the fastest thing to run in-browser — but the shippable build is Unity.
