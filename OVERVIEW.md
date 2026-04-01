# Tech Service Hub — Overview

Browser-based IT team dashboard. Live ticket data from HaloPSA. Deployed on Render.
Auth is session-cookie based (HttpOnly JWT). Frontend talks only to the Python backend proxy — never directly to Halo or Supabase.

---

## File Structure

```
index.html                  ← HTML shell + tab layout. No inline <script> or <style>.
assets/style.css            ← All CSS (~247 lines). Dark theme, CSS variables.
assets/app.js               ← All frontend logic (~3,350 lines, single file).
service-hub-launcher.py     ← Flask backend proxy (~835 lines).
render.yaml                 ← Render deployment config + env var declarations.
```

### Image assets
`assets/tech-sprite-*.png` — robot avatar body + hat sprites for gamification.
`assets/enemy-*.png` — Battlefield Engine enemy sprites.

---

## Frontend Sections (app.js)

| Section | Lines | Purpose |
|---|---|---|
| STATE | 1 | Module globals — `actTix`, `actRaw`, `histRaw`, `roster`, `loggedInAgent`, etc. |
| AUTH & PROXY | 9 | `supaLogin`, `fetchRetry`, robot config CRUD, `openTicket` |
| OVERRIDE PERSISTENCE | 90 | localStorage + Supabase sync for manual ticket positions |
| UTILS | 155 | Date, time, format helpers (`wkD`, `hT`, `snap`, `esc`, `bizH`) |
| HISTORICAL PROCESSING | 175 | `procHist()` — monthly KPI stats from closed ticket raw data |
| ACTIVE PROCESSING | 214 | `procAct()` — builds `actTix[]` from HaloPSA raw data; `schedTix()` (line 338) and `renderCampaignCharts()` (line 518) live in this block (no sub-headers) |
| KPI AGENT SELECTOR | 563 | Per-agent KPI deep-dive panel |
| TECH SIDEBAR | 656 | `renderSidebar()` — ticket list per tech |
| CALENDAR | 794 | `renderCal()`, `_bindCalDrag()` — weekly drag/resize calendar |
| PLAYER CARDS (GAMIFICATION) | 1083 | `renderPlayerCards()` — gamified tech stat cards |
| RADAR | 1280 | `renderRisk()` — at-risk ticket detection (duplicate header at 1283; `renderRisk()` starts at 1284) |
| BANNER | 1417 | Header stats bar |
| EVENTS | 1420 | Tab switching, keyboard, button wiring, `applyLoginState()` |
| HALOPSA LIVE FETCH | 1582 | `fetchHaloReport()`, `fetchActiveNow()`, auto-refresh |
| SESSION RESTORE | 1643 | Boot sequence — loads data, restores session |
| ROBOT CUSTOMIZER | 1670 | Avatar builder UI + canvas renderer |
| BATTLEFIELD ENGINE | 1933 | Mini-game (~975 lines) |
| COMMS BOARD | 2909 | Team comms cards — CRUD, reactions, emoji picker |

---

## Backend Routes (service-hub-launcher.py)

| Method | Path | Auth | Purpose |
|---|---|---|---|
| POST | `/api/login` | — | Issue HttpOnly JWT cookie via Supabase GoTrue |
| POST | `/api/logout` | — | Clear auth cookies |
| POST | `/api/refresh` | cookie | Refresh JWT |
| GET | `/api/me` | ✓ | Return current agent info |
| GET | `/api/config` | — | Return Supabase URL + anon key to frontend |
| GET | `/api/active` | ✓ | Proxy HaloPSA report (active tickets) |
| GET | `/api/ticket/<path:ticket_id>/open` | ✓ | Return full Halo ticket URL (base URL in env var) |
| GET/PATCH | `/api/agent-schedules` | ✓ | Per-agent shift + lunch slot assignments |
| GET/POST | `/api/ticket-overrides` | ✓ | Manual calendar position overrides |
| DELETE | `/api/ticket-overrides/<path:ticket_id>` | ✓ | Delete a specific ticket override |
| GET/POST/PUT/DELETE | `/api/comms-cards` | ✓ | Team comms board cards (PUT/DELETE use `/<card_id>`) |
| POST | `/api/comms-reactions` | ✓ | Toggle emoji reactions on comms cards |
| GET | `/api/robots` | ✓ | Load all robot avatar configs |
| GET/POST | `/api/robot` | ✓ | Load or save robot config for a specific agent |
| GET | `/api/commanders` | ✓ | List commander-role agents |
| GET | `/health` | — | Health check |

---

## Auth Flow

- Login → `POST /api/login` → backend calls Supabase GoTrue → sets HttpOnly `access_token` + `refresh_token` cookies.
- Frontend sets `authToken = "1"` as a flag only — the actual JWT is never in JS.
- All fetch calls use `credentials: "include"` to send cookies. `fetchRetry` adds this automatically; plain `fetch()` calls need it explicitly.
- `@require_auth` decorator on backend routes decodes the cookie JWT (Supabase format first, legacy format fallback).
- Token refresh: `POST /api/refresh` — returns 401 if expired, triggering logout.

---

## Scheduler Architecture

`schedTix()` runs after every data fetch or user interaction. It:

1. Calls `applyOverrides()` — restores manual positions from localStorage (synced from Supabase).
2. **In-memory time-shift**: overridden tickets on today with `startHour < nowSnapped` are advanced forward in memory (saved overrides unchanged).
3. Runs `autoSchedule` — greedy packing of non-overridden tickets respecting shift + lunch windows.
4. Post-scheduling safety pass — scans sorted tickets per tech per day and pushes any still-overlapping auto tickets forward.

### Key scheduler functions

- `getSched(techId)` → `{ss, se, ls, le, si, li}` (shift start/end, lunch start/end, indices)
- `advancePast(a, s, dur)` — advances cursor `{d, h}` past lunch and shift boundaries
- `placeTicket(tk, occ, s)` — loop-based placement (up to 20 iterations) ensuring no overlap with lunch, shift end, or occupied slots
- `clampHour(h, est, s)` — snaps a drop position to valid slot, skipping lunch window
- `cascadeOverrides(techId, dayIdx)` — after a manual drag, re-sorts all overridden tickets for that tech+day and pushes conflicts forward; saves to localStorage and Supabase
- `layoutTixDay(tks)` — greedy column assignment for side-by-side rendering detection (used in `renderCal`)

### Override schema (localStorage key: `servicehub_overrides`)

```javascript
{
  [ticketId]: {
    startHour: 9.5,        // decimal hour (0–24, 0.25 steps)
    dayIdx: 2,             // 0=Mon … 4=Fri
    est: 1.0,              // hours (0.25 min if manualResize:true, else 0.5 min)
    manualResize: true,    // present only when user dragged the resize handle
    ts: 1711000000000      // Date.now() at save time
  }
}
```

`applyOverrides()` skips saved `est` values below 0.5 **unless** `manualResize: true`, preventing legacy `est=0.25` defaults (saved before the minimum changed) from being reinstated.

Auto-clear: if a ticket's SLA or Next Response Date changes between syncs, its override is deleted so the scheduler repositions it fresh.

---

## Key Constants (app.js ~line 142)

```javascript
SH=7, EH=18          // Calendar display: 7 AM – 6 PM
HH=128               // Pixels per hour on calendar
BIZ_S=8.5, BIZ_E=16.5, BIZ_D=8  // Business hours for bizH() / bizD()
FRT_SLA=4            // First response SLA target (hours)

SHIFTS=[
  {l:"7:30 AM — 4:30 PM", s:7.5, e:16.5},
  {l:"8:30 AM — 5:30 PM", s:8.5, e:17.5}
]
LUNCHES=[
  {l:"11:15 — 12:15",  s:11.25, e:12.25},
  {l:"12:30 — 1:30",   s:12.5,  e:13.5},
  {l:"1:45 — 2:45",    s:13.75, e:14.75}
]
```

Per-agent shift/lunch assigned via `AGENT_SHIFT[agentName]` / `AGENT_LUNCH[agentName]` (index into above arrays). Loaded from `/api/agent-schedules`.

---

## Key State Globals (app.js)

```javascript
// ── STATE block (lines 1–8) ──
actTix[]           // Processed active tickets — rebuilt by procAct() each sync
actRaw[]           // Raw HaloPSA response data before processing
closedTix[]        // This week's closed tickets
histRaw[]          // Raw historical ticket records
catStats{}         // Category statistics object
roster[]           // Tech agents list
charts{}           // Chart.js instance map
selTech            // Currently selected tech (null = all)
loggedInAgent      // {agent_name, role} or null
isCommander        // true if role === "commander"
_lastTicketState   // {id: {sla, nrdMs}} — detects SLA/NRD changes for override auto-clear
_calCtxMenu        // Active right-click context menu DOM element (or null)

// ── Declared at line 152 (between OVERRIDE PERSISTENCE and UTILS) ──
techSched          // {techId: {ss,se,ls,le,si,li}} — built from AGENT_SHIFT/LUNCH
```

---

## Env Vars (Render)

| Variable | Purpose |
|---|---|
| `HALOPSA_REPORT_URL` | HaloPSA report endpoint for active tickets |
| `HALO_BEARER_TOKEN` | Bearer token for HaloPSA API |
| `HALO_TICKET_BASE_URL` | Base URL prepended to ticket ID for deep links (e.g. `https://halo.lutz.us/ticket?id=`) |
| `SUPABASE_URL` | Supabase project URL |
| `SUPABASE_KEY` | Supabase service_role key (backend only) |
| `SUPABASE_ANON_KEY` | Supabase anon key (served to frontend via `/api/config`) |
| `SUPABASE_JWT_SECRET` | Used to verify Supabase-issued JWTs |
| `JWT_SECRET` | Legacy JWT signing secret (auto-generated by Render) |
| `ALLOWED_ORIGIN` | CORS allowed origin |

---

## Supabase Tables

| Table | Purpose |
|---|---|
| `agent_logins` | Agent roster + roles + passwords (GoTrue auth) |
| `agent_schedules` | Per-agent shift + lunch slot indices |
| `ticket_overrides` | Manual calendar position overrides (synced from localStorage) |
| `comms_cards` | Comms board cards |
| `comms_reactions` | Emoji reactions on comms cards |
| `agent_robots` | Robot avatar configs per agent |

---

## Common Pitfalls

1. `fetch()` without `credentials:"include"` → 401 on all backend calls
2. Calling `window.open()` inside an async `.then()` → popup blocker kills it; open synchronously first, navigate after
3. Reassigning `AGENT_LUNCH` / `AGENT_SHIFT` instead of mutating — both are plain objects, mutation is fine
4. Using raw `h` for position without `snap()` — calendar positions must be 0.25h increments
5. `getSched()` returns a default schedule if the tech has no entry; don't assume it's always set
6. `_calCtxMenu` holds the active context menu element; always remove it and strip `ctx-open` class before creating a new one
