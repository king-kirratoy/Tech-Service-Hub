# Tech Service Hub — Claude Instructions

This file is read automatically by Claude Code at the start of every session.
It defines conventions, architecture rules, and standards for this project.

---

## Project Overview

Browser-based IT team dashboard for an MSP. Live ticket data from HaloPSA.
A Python/Flask backend (`service-hub-launcher.py`) proxies all API calls — the frontend never touches Halo or Supabase directly.
Deployed on Render. Auth is HttpOnly cookie JWT (Supabase GoTrue).

---

## Always Do This at Session Start

1. Read `OVERVIEW.md` — it is the living map of the codebase. Read it before touching any code.
2. After making changes, update `OVERVIEW.md` to reflect the current state.

---

## File Structure

```
index.html                  ← HTML shell + tab layout. No inline <script> or <style>.
assets/style.css            ← All CSS. Dark theme, CSS variables.
assets/app.js               ← All frontend logic (~3,350 lines, single file).
service-hub-launcher.py     ← Flask backend proxy.
render.yaml                 ← Render deploy config + env var declarations.
OVERVIEW.md                 ← Living reference — architecture, functions, state, routes.
CLAUDE.md                   ← This file — session instructions and coding rules.
```

---

## Code Style Standards

### Section Comments

```javascript
// ═══════════ SECTION NAME ═══════════         ← major JS sections
// ── Sub-section name ──────────────────────── ← sub-sections
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
| CSS classes | `kebab-case` | `.ticket-card`, `.cal-ctx-menu` |
| CSS variables | `--kebab-case` | `--surface`, `--border-bright` |
| HTML IDs | `camelCase` | `id="syncStatus"`, `id="riskBadge"` |
| JS variables | `camelCase` | `let actTix`, `let selTech` |
| JS constants | `SCREAMING_SNAKE` | `const BL_CAT`, `const SHIFTS` |
| JS functions | `camelCase` with verb prefix | `renderCal()`, `schedTix()`, `procAct()` |
| Private/internal vars | underscore prefix | `_lastTicketState`, `_calCtxMenu` |
| Render functions | `render` prefix | `renderCal()`, `renderSidebar()` |
| Async data loaders | `load` prefix | `loadTicketOverrides()`, `loadAgentSchedules()` |

### Formatting

- **2 spaces** for indentation — HTML, CSS, and JS
- Single quotes `'` in JS, double quotes `"` in HTML attributes
- Opening braces on the same line
- No magic numbers — extract to named constants
- CSS properties alphabetical within each rule
- Trailing commas in multi-line objects/arrays

---

## Architecture Rules — Read Before Writing Any Code

### All fetch calls need `credentials: "include"`

The session JWT lives in an HttpOnly cookie — it is never in JS.
`fetchRetry()` adds `credentials:"include"` automatically.
Plain `fetch()` calls must include it explicitly, or they'll get 401.

### `window.open()` must be called synchronously

Opening a new tab inside a `.then()` callback loses the user gesture context and gets blocked.
Always open the blank window first, then navigate it after the async result:

```javascript
const win = window.open('', '_blank');   // synchronous — preserves gesture
fetch(url, {credentials: 'include'})
  .then(r => r.ok ? r.json() : null)
  .then(d => { if (d?.url) win.location.href = d.url; else win.close(); });
```

### Ticket override schema

Manual calendar positions are stored in localStorage (`servicehub_overrides`) and synced to Supabase.
The schema for each entry:

```javascript
{
  startHour: 9.5,        // decimal hour, 0.25 steps
  dayIdx: 2,             // 0=Mon … 4=Fri
  est: 1.0,              // hours; 0.25 min only if manualResize:true, else 0.5 min
  manualResize: true,    // present only when user used the resize handle
  ts: 1711000000000      // Date.now() at save time
}
```

`applyOverrides()` skips `est < 0.5` unless `manualResize: true` — this prevents legacy
`est=0.25` defaults (saved before the minimum changed) from being reinstated.

### Scheduler constraints

`schedTix()` must never place tickets:
- During lunch (`ls` to `le`)
- Past shift end (`se`)
- Overlapping another ticket for the same tech on the same day

Use `advancePast(cursor, sched, dur)` to jump a time cursor past lunch/shift boundaries.
Use `snap(h)` (`Math.ceil(h*4)/4`) for all hour values — positions are always 0.25h increments.

Auto-clear: if a ticket's SLA or Next Response Date changes between syncs, its override is deleted
so the scheduler repositions it. This is checked in `procAct()` using `_lastTicketState`.

### Never put sensitive data in frontend source

HaloPSA base URL, bearer token, Supabase service key, and JWT secrets live only in Render env vars.
The frontend receives only `supabase_url` and `supabase_anon_key` via `/api/config`.
Ticket deep-link URLs are resolved server-side via `/api/ticket/<id>/open`.

### `getSched(techId)` may return defaults

If a tech has no entry in `AGENT_SHIFT` / `AGENT_LUNCH`, `getSched()` returns the default
schedule (shift index 1, lunch index 1). Don't assume it's always personalized.

### Context menu lifecycle

`_calCtxMenu` holds the active DOM element. Before creating a new one:
1. Remove the existing menu
2. Strip `ctx-open` class from its ticket element
3. Set `_calCtxMenu = null`

The `ctx-open` class on a ticket element triggers `.tt.ctx-open .tt-popup { display:none!important }`
to hide the hover card while the context menu is open.

---

## Common Pitfalls

1. `fetch()` without `credentials:"include"` → 401 on every backend call
2. `window.open()` inside `.then()` → popup blocker silently kills it
3. Using raw `h` values without `snap()` → fractional positions cause layout misalignment
4. `applyOverrides()` uses `manualResize` flag — don't add `est` to an override unless it was set intentionally
5. `getSched()` returns a fallback — never assume `techSched[id]` exists; always use `getSched()`
6. Forgetting to remove `_calCtxMenu` and the `ctx-open` class before opening a new context menu
7. `actTix[]` is rebuilt every sync — don't store direct references to ticket objects across async boundaries
