# Tech Warrior Online — Claude Instructions

This file is read automatically by Claude Code at the start of every session.
It defines architecture, conventions, and standards for this project.

---

## Project Overview

Browser-based top-down mech shooter built with Phaser 3.60.0. Players pick a chassis,
build a loadout in the Hangar, and deploy into combat. Three modes: Combat Simulation
(roguelike), Campaign (persistent progression), PVP (Socket.IO multiplayer).

---

## File Structure & Load Order

```
index.html              ← Main game shell + all core logic (currently a monolith — being split)
js/loot-system.js       ← Items, rarity, affixes, inventory, gear stats, equipment drops
js/enemy-types.js       ← Special enemy types, elite modifiers
js/arena-objectives.js  ← Arena layouts, objective logic, _arenaState object
js/campaign-system.js   ← Missions, XP, levels, skill tree, shop, cloud saves
js/multiplayer.js       ← PVP matchmaking, Socket.IO, remote players
OVERVIEW.md             ← Living map of the project — read this before reading code
CHANGELOG.md            ← Session-by-session change history with version numbers
```

**Script load order:** `loot-system.js → enemy-types.js → arena-objectives.js → campaign-system.js → multiplayer.js → inline <script>`

All files share globals via `window`. No module system.

---

## Always Do This at Session Start

1. Read `OVERVIEW.md` before touching any code
2. Read `CHANGELOG.md` to understand what changed recently
3. After making any changes, update both `OVERVIEW.md` (current state) and `CHANGELOG.md` (what changed, with new version number)

Version numbers use `v1.0, v1.1, v1.2...` format. Every session that changes code gets a version bump.
The current version must be displayed somewhere visible in the game UI.

---

## Target File Structure (Refactor Goal)

`index.html` is being broken into multiple files. When adding new code or refactoring,
move toward this structure:

```
index.html              ← Pure HTML shell only — no inline <style> or <script>
css/
  base.css              ← Variables, reset, shared components
  hud.css               ← In-game HUD, paper doll, weapon bars
  garage.css            ← Hangar/garage UI, dropdowns, stats panel
  menus.css             ← Main menu, death screen, pause, leaderboard
js/
  constants.js          ← CHASSIS, WEAPONS, SHIELD_SYSTEMS, AUGMENTS, LEG_SYSTEMS, COVER_DEFS, LOOT_TYPES
  state.js              ← All mutable globals (player, torso, _round, _perkState, etc.)
  utils.js              ← Pure helpers — darkenColor(), getTotalHP(), showDamageText(), etc.
  audio.js              ← _tone(), _noise(), all snd* functions, Web Audio engine
  mechs.js              ← buildPlayerMech(), buildEnemyTorso(), refreshMechColor(), chassis FX
  combat.js             ← fire(), all fireXxx() functions, processPlayerDamage(), damageEnemy(), explosions
  mods.js               ← activateMod() and all activateXxx() functions
  enemies.js            ← spawnEnemy(), spawnCommander(), spawnMedic(), spawnBoss(), enemy AI
  rounds.js             ← startRound(), onEnemyKilled(), extraction system, perk menu flow
  perks.js              ← _perks{} object, showPerkMenu(), pickPerk()
  cover.js              ← generateCover(), damageCover(), placeBuilding()
  hud.js                ← updateHUD(), updateBars(), updatePaperDoll(), drawMinimap(), cooldown overlays
  garage.js             ← toggleDD(), buildDD(), selectSlot(), refreshGarage(), updateGarageStats()
  menus.js              ← Main menu, death screen, hangar nav, leaderboard, stats overlay
  loot-system.js        ← (already split)
  enemy-types.js        ← (already split)
  arena-objectives.js   ← (already split)
  campaign-system.js    ← (already split)
  multiplayer.js        ← (already split)
  events.js             ← All keyboard/mouse event listeners
  init.js               ← window.onload, startMenuGrid(), Phaser game config
```

Use `window.TW = {}` as the project namespace defined in `constants.js`.
Each feature file exposes only its public API: `window.TW.featureName = { fn1, fn2 }`.

---

## Code Style Standards

### Section Comments

```javascript
// ═══════════ SECTION NAME ═══════════       ← major JS sections

// ── Sub-section name ─────────────────────── ← sub-sections within a section
```

```css
/* ============================================================
   SECTION NAME
   ============================================================ */

/* --- Sub-section Name --- */
```

```html
<!-- ═══ Section Name ═══ -->
```

### Naming Conventions

| Type | Convention | Example |
|---|---|---|
| CSS classes | `kebab-case` | `.weapon-row`, `.perk-card` |
| CSS variables | `--kebab-case` | `--surface`, `--border-bright` |
| HTML IDs | `camelCase` | `id="roundHud"`, `id="bossFill"` |
| JS variables | `camelCase` | `let reloadL`, `let _roundKills` |
| JS constants | `SCREAMING_SNAKE` | `const CHASSIS`, `const RARITY_DEFS` |
| JS functions | `camelCase` with verb prefix | `renderGarage()`, `spawnEnemy()`, `activateJump()` |
| Private/internal vars | underscore prefix | `_perkState`, `_roundActive`, `_isPaused` |
| Render functions | `render` prefix | `renderGarage()`, `renderStats()` |
| Event handlers | `on` prefix | `onTabClick()`, `onKeyDown()` |

### Formatting

- **2 spaces** for indentation — HTML, CSS, and JS
- Single quotes `'` in JS, double quotes `"` in HTML attributes
- Opening braces on the same line
- No magic numbers — extract to named constants
- No anonymous functions in event listeners if logic is > 2 lines
- CSS properties alphabetical within each rule
- Trailing commas in multi-line objects/arrays

---

## Architecture Rules — Read Before Writing Any Code

### Critical Slot Key Distinction

| Context | Keys Used |
|---------|-----------|
| `loadout` object | `L` `R` `mod` `aug` `leg` **`shld`** (not `shield`) |
| Garage dropdown IDs | `L` `R` `M` (mod) `A` (aug) `G` (leg) `S` (shield) `C` (color) |
| `_equipped` object | `L` `R` `chest` `arms` `legs` **`shield`** `mod` `augment` |

Never mix these up. `loadout.shld` and `_equipped.shield` are different things in different contexts.

### Phaser Groups — Never Destroy Them

`bullets`, `enemyBullets`, `enemies`, `coverObjects` are created once in `create()` and
survive every deploy/death/respawn. Only ever call `.clear(true, true)` on their children.
Never call `.destroy()` on the groups themselves.

### Cover Object Origins

Cover uses `origin(0,0)` — `c.x` and `c.y` are the **top-left corner**, not the center.
Always use `c.coverCX` / `c.coverCY` for center-based distance checks and LOS raycasting.

### Player Visual Split

- `player` — invisible physics rectangle. Rotates with WASD movement direction.
- `torso` — visual container. Rotates toward mouse cursor each frame in `syncVisuals()`.

Enemy equivalent: `e.visuals` (faces movement) and `e.torso` (aims at player).
Always sync BOTH: `e.visuals.setPosition(e.x, e.y)` AND `e.torso.setPosition(e.x, e.y)`.

### External Function Guards

All calls to functions defined in external JS files must use typeof guards:
```javascript
if (typeof spawnSpecialEnemy === 'function') spawnSpecialEnemy(scene, typeKey);
if (typeof shouldEndRound === 'function' && shouldEndRound()) { ... }
```
This prevents crashes if a file fails to load.

### `_arenaState` — Mutate, Never Reassign

`_arenaState` is exported from `arena-objectives.js`. Always mutate its properties:
```javascript
_arenaState.currentArena = 'pit';     // ✓ correct
_arenaState = { currentArena: 'pit' }; // ✗ breaks the reference
```

### Campaign Enemy Scaling

Never use raw `_round` for campaign enemy HP or speed. Always use:
```javascript
const _effectiveRound = (window._activeCampaignConfig?.enemyLevel) || _round;
```

### Round Flow — Extraction Required

Rounds do NOT end when enemies die. Flow is:
```
all enemies dead → _spawnExtractionPoint() → player presses E in zone
  → _triggerExtraction() → heal → showPerkMenu(next) → startRound(next)
```
`_roundActive` and `_extractionActive` must be kept in sync. Check both before starting new logic.

### `_roundClearing` Blocks `update()`

`update()` returns early when `_roundClearing === true` (during perk menu and equip prompt).
Never start game logic during this window.

### Boss HP Bar is DOM-Based

Not a Phaser object — it's DOM divs. Always call:
- `_addBossHPBar(scene, e, color, name)` on spawn
- `_updateBossHPBar(e)` each frame
- `_hideBossHPBar()` inside `e._onDestroy` — every boss must have `_onDestroy`

### Swarm Boss Exception

`e._isSwarmUnit === true` means damage goes to `e._swarmState.hp`, not `e.health`.
Check `window._activeSwarm` before standard damage logic. The swarm pool handles its own kill.

### Two-Handed Weapons

`siege` and `chain` lock both arm slots to the same key. When equipped: `loadout.L === loadout.R`.
Weight is counted once. Medium/Heavy only — Light cannot use 2H weapons.
This is NOT dual-wield. Dual-wield is Light chassis only when same weapon in both arms.

---

## Key Constants Reference

```javascript
// Chassis HP (base values before perks/gear)
CHASSIS.light  = { spd:250, scale:0.7, coreHP:212, armHP:120, legHP:152 }
CHASSIS.medium = { spd:210, scale:1.0, coreHP:272, armHP:180, legHP:212 }
CHASSIS.heavy  = { spd:185, scale:1.4, coreHP:332, armHP:240, legHP:272 }

// World
World size: 4000×4000   Player spawn: (2000, 2000)   INVENTORY_MAX: 30
Boss cycle: every 5 rounds, 8 bosses rotate
Enemy HP scale: 0.50 × (1 + (level−1) × 0.08)  (+8%/level, no cap)

// Audio
_masterVol = 0.32    _MAX_NODES = 48

// Supabase tables
'tw_scores'           ← leaderboard
'tw_campaign_saves'   ← campaign cloud saves
```

---

## Key State Globals

```javascript
let isDeployed          // false during drop-in tween and while in hangar
let _isPaused           // true while pause overlay is showing
let _roundClearing      // true during perk menu/equip prompt — blocks update()
let _gameMode           // 'simulation' | 'campaign' | 'pvp'
let _round, _roundKills, _roundTotal, _roundActive
let _extractionActive, _extractionPoint
let _lArmDestroyed, _rArmDestroyed, _legsDestroyed
let reloadL, reloadR    // scene.time.now — next allowed fire timestamp
let lastDamageTime      // last player damage received
let lastModTime         // last mod activation

// Player component HP
player.comp = { core:{hp,max}, lArm:{hp,max}, rArm:{hp,max}, legs:{hp,max} }
player.shield, player.maxShield, player._shieldAbsorb

// Perk state (flat object — all fields should be initialized before reading)
_perkState.dmgMult, .reloadMult, .speedMult, .critChance, .fortress (DR)
_perkState.legSystemActive  // false when legs destroyed

// Gear state (rebuilt by recalcGearStats() from _equipped)
_gearState.dmgFlat, .dmgPct, .reloadPct, .coreHP, .shieldHP, .dr, .speedPct...
```

---

## Damage Calculation Order

Always apply in this order — never skip, never apply twice:
```
1. Base weapon damage
2. Gear flat bonus (_gearState.dmgFlat)
3. Perk multipliers (_perkState.dmgMult)
4. Gear percent bonus (_gearState.dmgPct)
5. Situational bonuses (crit, brace, hollow point, etc.)

For incoming damage:
1. Barrier/active shield (full block)
2. Passive shield absorption (player._shieldAbsorb)
3. Chassis passive DR (CHASSIS.heavy.passiveDR = 0.15)
4. Perk DR (_perkState.fortress)
5. Gear DR (_gearState.dr)
6. Dodge chance
7. Apply to player.comp[target].hp
```

---

## HUD Element IDs

```
slot-L/R/M/S       txt-L/R/M/S       wr-fill-L/R/M/S    wr-st-L/R/M/S
slot-leg-wrap      txt-G
round-hud          round-num          round-remaining     round-kills
boss-hud           boss-bar-fill      boss-bar-name
doll-head          doll-core          doll-lArm           doll-rArm
doll-lShoulder     doll-rShoulder     doll-lLeg           doll-rLeg
minimap-canvas     enemy-doll-hud     edoll-label
stats-overlay      pause-overlay      death-screen        perk-menu
```

---

## Common Pitfalls (Don't Repeat These)

1. Using `c.x / c.y` for cover center — use `c.coverCX / c.coverCY`
2. Destroying `bullets`, `enemyBullets`, `enemies`, or `coverObjects` groups — only clear children
3. Starting game logic when `_roundClearing === true`
4. Using `loadout.shield` — it's `loadout.shld`
5. Using `_round` for campaign enemy scaling — use `_activeCampaignConfig?.enemyLevel || _round`
6. Forgetting `_hideBossHPBar()` in `e._onDestroy`
7. Reassigning `_arenaState` — always mutate properties in place
8. Forgetting to sync both `e.visuals` and `e.torso` positions
9. Calling external JS functions without `typeof` guard
10. Applying the same damage multiplier in two places (double-dipping)
11. Assuming round ends when enemies die — extraction step is required first
12. Checking `!player` without also checking `!player.active` (destroyed ≠ null)
