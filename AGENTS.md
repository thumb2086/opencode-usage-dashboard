# oc-stats (opencode-statboard)

Dashboard for opencode token usage and cost statistics. Published as `opencode-statboard` on npm.

## Quick Start

```bash
npm install -g opencode-statboard
opencode-dashboard
# Open http://127.0.0.1:4868
```

## Architecture

- `server.js` — Node.js HTTP server (zero frameworks, pure `http` module)
- `public/index.html` — Single-file frontend (vanilla JS/CSS/HTML, no build step)
- `backups/` — Gzipped DB backups (auto-rotated, `OPENCODE_BACKUP_RETENTION`)

## Key Patterns

### Data Source

All data comes from `opencode.db` (read-only via `better-sqlite3` with WAL mode). The DB is opened once and health-checked before each query (`SELECT 1`); if the connection is stale, it re-opens automatically.

`detectSchema()` runs on every open and picks the table set:

- **OpenCode V2** — sessions in `session_v2`, messages in `session_message`, tool parts embedded in `session_message.data.content[]` (part objects use `name`, e.g. `{"type":"tool","name":"shell",...}`). Model IDs are nested (`data.model.id` / `data.model.providerID`). Message rows have a `type` column (`user`/`assistant` plus non-chat `idle`/`synthetic`/`compaction`/...), filtered to `user`/`assistant` to keep V1 counting semantics.
- **OpenCode V1 (fallback)** — `session`, `message`, `part` tables; `data.modelID`/`data.providerID` top-level; tool parts in `part` (`{"type":"tool","tool":"bash",...}`).

**V1+V2 merge — never switch.** The V2 migration is lossy, so the schema expressions combine both eras (verified 2026-09 against the live DB):

- `session` → per-field `MAX(v2, v1)` over shared rows + V1-only rows. **455/734 migrated sessions lost their lifetime totals (−196M input tokens)**: V2 recomputed totals from surviving messages, dropping pruned compaction history (fully-pruned sessions went to 0; V1's frozen totals are authoritative). MAX, never SUM — shared rows are the same lifetime counter. No shared session continued after the freeze, so MAX is exact. Result: all-time input is ~467M (V1 439.96M + 29 post-upgrade sessions), not 270M.
- `message` → `session_message(user/assistant)` ∪ V1 rows whose ids are not in `session_message` (30 rows, 4.3M input, never migrated; their sessions all exist in `session_v2`).
- tools → embedded content (already covers migrated V1 parts — dedup by id is impossible because migration rewrote `prt_` ids to `call_`) ∪ `part` rows whose `message_id` is absent from `session_message` (the double-count-safe remainder, currently 1 part).

On a V1-only database every expression collapses to the plain V1 tables.

### Hybrid Attribution (`attributeUsage`)

Token/cost attribution uses a hybrid model:
1. **Message-level** — Each assistant message's `tokens` and `cost` from `message.data` JSON are attributed to its `time_created` local day
2. **Session residual** — `session.tokens_* - sum(message.tokens_*)` is spread across the session's full local-day span, weighted by per-day message volume
3. **Speed (message-level only)** — Per-model `speed` (output tok/s) = Σ completed-assistant-message `tokens.output` ÷ Σ(`time.completed - time.created`). Session residuals carry no duration and are excluded; models without usable durations report `null` (shown as —). Tracked in the same message scan, no extra query.
4. **Period speed/active/wall (report)** — `buildReportFromDb` runs one extra `GROUP BY session_id` over the merged message view (scoped to `[periodStart, attrSnapshot)`), mapped onto the same session-meta buckets: providers/agents gain period `speed`; agents gain `wallMs` (Σ full session spans — same scope as their token columns) and `activeMs` (Σ in-period message durations); `report.sessions` lists the top 20 sessions by wall time with both durations. Wall includes idle; active counts only model-running time.

This ensures multi-day sessions (e.g. a session created Monday, updated Thursday) don't dump all tokens onto Thursday.

### API Endpoints

| Endpoint | Description | Cache TTL |
|----------|-------------|-----------|
| `GET /api/stats?days=7` | Overview + trend data | 60s (trend) |
| `GET /api/report?days=1\|7\|30\|-1` | Usage report (Daily/Weekly/Monthly/All) | 10min |
| `GET /api/backup` | Manual backup trigger | — |
| `GET /api/backups` | List backups | — |
| `GET /api/vacuum` | DB vacuum (skips if freelist <64MB) | — |
| `GET /api/db-info` | DB file sizes + pragma | — |

### Environment Variables

- `OC_PORT` — Listening port (default 4868, auto-fallbacks +5)
- `OPENCODE_DATA` — Custom path to `opencode.db`
- `OPENCODE_BACKUP_RETENTION` — Max backup dirs (default 3)

## Verification

After any change, run:
```bash
node check-stats-verify.js
node check-trend-verify.js 7
node check-report-verify.js
```

Checks time-travel via API `generatedAt`, so live chat (sessions mutating mid-check) can still cause drift. For exact verification while chatting, run both server and checks against a frozen snapshot:

```bash
# 1. snapshot the live DB (SQLite backup API = consistent even on a live WAL DB;
#    a raw file copy can tear)
node -e "const D=require('better-sqlite3'),p=require('path'),f=require('fs');const s=p.join(process.env.USERPROFILE,'.local/share/opencode/opencode.db');const d=p.join(f.mkdtempSync(p.join(f.realpathSync(require('os').tmpdir()),'oc-snap-')),'opencode.db');new D(s,{readonly:true}).backup(d).then(()=>console.log(d))"

# 2. server reads the snapshot:   OPENCODE_DATA=<snapdir> node server.js
# 3. checks read the snapshot:    OC_STATS_SNAP_DB=<snapdir>\opencode.db node check-stats-verify.js
```

`check-lib.js` honors `OC_STATS_SNAP_DB`; `server.js` honors `OPENCODE_DATA` (both expect a directory containing `opencode.db`).

## Publishing

Publishing is automated via GitHub Actions + npm **trusted publishing (OIDC)** — no npm token involved. Workflow: `.github/workflows/publish.yml`, triggered by pushing a `v*` tag.

One-time setup on npmjs.com → `opencode-statboard` → Settings → **Trusted Publisher** → GitHub Actions:

| Field | Value |
|-------|-------|
| Organization or user | `thumb2086` |
| Repository | `opencode-usage-dashboard` |
| Workflow filename | `publish.yml` (exact, with extension) |
| Environment name | leave empty |
| Allowed actions | enable **both** `npm stage publish` **and** `npm publish` (configs made after Sep 2026 default to stage-only, which rejects `npm publish`) |

Release flow:

```bash
npm version patch --no-git-tag-version
git commit -am "vX.Y.Z"
git tag vX.Y.Z
git push --follow-tags    # tag push runs publish.yml → npm publish (OIDC)
npm install -g opencode-statboard   # after the Actions run is green
```

- The workflow fails fast if the tag doesn't match `package.json` version.
- `repository.url` must exactly match the GitHub repo (npm requirement for OIDC publishes) — `npm pkg fix` keeps it normalized.
- Provenance attestations are generated automatically for public repos; no `--provenance` flag.
- Requires npm CLI ≥ 11.5.1 / Node ≥ 22.14 (CI uses Node 24).
- The old `NPM_TOKEN` flow is retired (token revoked 2026-09); revoke leftover tokens on npmjs.com.

## Known Constraints

- `better-sqlite3` is a native addon; must match Node.js ABI
- `attributeUsage` does a full DB scan (~35k messages); cached 300s via `getAttrAll()`
- Trend buckets are sliced from the same `getAttrAll()` attribution the report uses — never a separate windowed call (windowed calls inflate in-window days via residual growth; fixed 2026-09-29 after measuring +0.25–1.7M input/day). Remaining panel differences are cache ages only (trend ≤60s, report ≤10min, both timestamps shown)
- V2 tool counts use `json_each` over `session_message` content (~1.2s full scan) and run on every 15s refresh; legacy V1 DBs scan `part` instead (~0.8s)
- OpenCode V2 writes `cost = 0` for free/subscription providers, so $ totals only reflect paid (per-token billed) usage — same field, not a schema issue
- `gzip` compression on all `/api/` responses (>512B, level 1 for speed)
- Backup is deferred 30s after startup — heavy disk I/O (500MB copy+compress) during startup causes Windows to terminate the process
- Backup file ops are async (`fs.promises.copyFile`/`rm`): with the DB now ~2.7GB, synchronous copy+`rmSync` cleanup starved the event loop during the daily auto-backup and the process was terminated mid-cleanup (no log output, exit 1)
