# Library / Metadata Plan (LoL TR Scrims)

## Goals
- Detect a new Tournament Realm (TR) scrim starting via LCU.
- Start recording + streaming, and **tag everything** with a stable `sessionId`.
- Capture and persist metadata (champion played, enemy champs, etc.) linked to the recording/stream.
- In-app: show the replay instantly when the game ends (local-first).
- In-browser: list/search sessions for a small user base (≤10), using Google Sheets as the shared registry.

## Non-goals (for now)
- Full OBS integration.
- Complex multi-user permissions, scalable backend, payments.
- Perfect accuracy for “enemy team name” early in champ select (treat as best-effort).

---

## Architecture Overview (MVP)

### Source of truth
- **Local**: a small local index per session (JSON sidecar file). This guarantees instant playback in the app and offline resilience.
- **Shared**: a Google Sheet that mirrors sessions for browser viewing (and optionally server links).

### Key concept: `sessionId`
- Generate `sessionId = uuid()` as soon as we detect a new TR session (at `ChampSelect` or `InProgress`).
- Use the same `sessionId` everywhere:
  - recording filename
  - stream/ingest metadata
  - local JSON sidecar
  - Google Sheets row key
  - later matchId (if/when available)

### Progressive metadata enrichment
- We won’t know everything immediately.
- Start with what’s available at detection time, then enrich after EndOfGame (match history).

---

## Data Model

### Local sidecar file (per recording)
Store next to the video file (or in a predictable folder) as:
- `recordings/<sessionId>.json`

**Schema (MVP)**
```json
{
  "schemaVersion": 1,
  "sessionId": "uuid",
  "userId": "string",
  "trDetected": true,
  "startedAt": "2026-01-05T12:34:56.000Z",
  "endedAt": "2026-01-05T13:20:01.000Z",
  "gameflow": {
    "firstPhase": "ChampSelect",
    "lastPhase": "EndOfGame"
  },
  "lol": {
    "matchId": null,
    "championPlayed": null,
    "role": null,
    "enemyChampions": []
  },
  "recording": {
    "localFilePath": "C:/.../recordings/<sessionId>.mp4",
    "durationMs": null,
    "sizeBytes": null
  },
  "stream": {
    "serverIngestUrl": null,
    "serverRecordingId": null,
    "vodUrl": null
  },
  "status": "recording",
  "errors": []
}
```

### Google Sheets row (shared registry)
One row per `sessionId`.

**Columns (MVP)**
- `sessionId` (primary key)
- `userId`
- `startedAt`
- `endedAt`
- `trDetected`
- `phaseStart` (ChampSelect/InProgress)
- `championPlayed`
- `role`
- `enemyChampions` (comma-separated)
- `matchId`
- `localVideoFilename` (optional, mainly for debugging)
- `vodUrl` (optional)
- `status` (recording/uploaded/done/failed)
- `error` (optional)

---

## LCU Detection & Metadata Capture

### 1) Detect TR client (already started in `lol_lcu_watch.js`)
- Find `LeagueClientUx.exe` processes
- Prefer process whose cmdline or exe path contains `loltmnt`
- Read lockfile with retry loop
- Poll `/lol-gameflow/v1/gameflow-phase`

### 2) Session lifecycle events
We want deterministic transitions:
- `None → ChampSelect` (or `None → Lobby/Matchmaking → ChampSelect`) => **create session**
- `ChampSelect → InProgress` => **ensure recording+stream started**
- `InProgress → EndOfGame/None` => **stop recording**, finalize and enrich

### 3) Metadata sources (best-effort)
- Champ select:
  - try to read local player + selected champion/team comps
- End of game:
  - query match history endpoints to reliably get matchId + participants

Notes:
- Some TR environments may differ; keep this best-effort and log failures into the sidecar.

---

## Local “Library” (Indexer)

### Responsibilities
- Create/update/finalize session JSON sidecar
- Provide queries to the UI:
  - list sessions sorted by date
  - filter by champion
  - filter by enemy champion

### Storage approach (MVP)
- JSON sidecars only (no SQLite yet).
- Optional `recordings/index.json` cache that can be rebuilt by scanning sidecars.

### Minimal library API (conceptual)
- `createSession({ startedAt, trDetected, userId }) -> sessionId`
- `updateSession(sessionId, patch)`
- `attachRecording(sessionId, filePath)`
- `finalizeSession(sessionId, { endedAt, status })`
- `listSessions({ from?, to?, champion?, enemyChampion? })`

---

## Google Sheets Sync

### Recommendation
Prefer: **App → your server → Google Sheets**
- The app posts session updates to your server
- The server owns the Google credentials and writes to Sheets
- Avoid shipping Google service-account secrets in the desktop app

If you must write directly from the app:
- Use a service account and share the sheet to it
- Accept the risk that desktop distribution exposes credentials

### Sync behavior
- Upsert row by `sessionId`
- Write minimal fields immediately, then update row on enrich/finalize
- Queue/retry on failure (don’t block recording)

---

## Integration Points (later, not now)

### Recording / streaming start
- When `sessionId` is created, start recorder/stream and name output using `sessionId`.

### “Instant replay in app”
- When recording finishes:
  - write sidecar (`status=done`)
  - emit an internal event for UI to refresh list
  - auto-select newest file in the existing player

### Browser UI
- Read sessions from Google Sheets (or from your server that proxies Sheets)
- Render the library view (date/champion/opponent)

---

## Implementation Steps (practical order)

### Step 0 — Decide identifiers
- Decide `userId` format (e.g., local config: summonerName/puuid/team name)
- Confirm `sessionId` format (uuid v4)

### Step 1 — Local library sidecars (no app wiring yet)
- Create `scripts/library/` helpers (node module style) to:
  - create/update/finalize sidecars
  - scan `recordings/` and build a list

### Step 2 — Drive library from LCU watcher
- Extend watcher to emit lifecycle events:
  - on session start => create sidecar
  - on phase changes => update sidecar
  - on end => finalize sidecar

### Step 3 — Enrichment after EndOfGame
- Query match history after game ends and fill:
  - `matchId`
  - `enemyChampions`
  - `championPlayed` (if missing)

### Step 4 — Sheets sync (via server preferred)
- Implement server endpoint:
  - `POST /sessions/upsert`
  - `POST /sessions/finalize`
- Server writes/upserts to Sheet

### Step 5 — App integration (when ready)
- Hook recorder completion => update sidecar => refresh UI library list
- Add “Library view” in the app that reads sidecars/index

---

## Acceptance Criteria (MVP)
- Start a TR scrim:
  - a `sessionId` is created
  - recording/stream start is triggered
  - a sidecar JSON appears immediately
- End a scrim:
  - recording stops
  - sidecar is finalized
  - app shows replay instantly
- Google Sheet has 1 row per sessionId and updates correctly.

---

## Risks / Unknowns
- Some metadata (enemy team name) may not be obtainable reliably from LCU early.
- Match history endpoints may lag after EndOfGame; implement retry with backoff.
- TR detection by `loltmnt` needs validation across environments.
