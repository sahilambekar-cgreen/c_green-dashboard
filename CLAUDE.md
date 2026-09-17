# CLAUDE.md

## Maintenance Rule

> **Every change made to this repository must be reflected in CLAUDE.md in the same commit.** Before finishing any task — adding dependencies, changing commands, restructuring directories, introducing new patterns, modifying build/test/deploy steps, or anything else that affects how the codebase works — update the relevant section of CLAUDE.md. If a change has no impact on what's documented here, note that briefly in the commit message. Treat CLAUDE.md as part of the change, not an afterthought.

## Rules

1. Plan mode first before pushing anything — plan first even if something happens mid task.
2. Complex tasks → subagents. Keep main context clean.
3. Self-improvement loop: every lesson goes into `tasks/lessons.md` as a rule; next session reads and applies.
4. Verification standard: never mark a task done without running tests or checking logs.
5. Autonomous bug fixing: given a bug, go to logs, find root cause, fix immediately.
6. Document codebase-affecting changes in this file (see Maintenance Rule).

## Project Overview

"Stitch Debt Recovery Pulse" — a TV/war-room dashboard for debt collection agencies. Shows live leaderboard, recent collections, and queued celebration toasts pulled from a MySQL database. Dark "Cyber-Techno" neon theme; the token set lives in `src/design-system.css`.

## Stack

- **Frontend:** React 19 + TypeScript, Vite 7, Tailwind CSS 4 (via `@tailwindcss/vite`), Framer Motion, lucide-react icons, canvas-confetti, use-sound.
- **Backend:** Express 5 served via `tsx` (no separate compile step), MySQL access via `mysql2/promise`, live dashboard updates via Server-Sent Events.
- **Data import tooling:** Python 3 (`mysql-connector-python`, `pandas`, `requests`). `import_sheets.py` is the only ETL — Zoho Sheet → MySQL, over the Zoho Sheet API v2.
- **Ingestion:** Zoho Cliq → Zoho Sheet → Zoho Flow → `POST /api/integrations/zoho/collections` (Bearer `ZOHO_FLOW_WEBHOOK_SECRET`) → `collections_messages`. See [docs/ZOHO_FLOW_INTEGRATION.md](docs/ZOHO_FLOW_INTEGRATION.md). `import_sheets.py` is now the rollback path only.
- **Deployment:** two Docker images — `Dockerfile` (Node app, the only service compose starts) and `Dockerfile.etl` (Python ETL, rollback only). See [DEPLOY.md](DEPLOY.md).

## Directory Structure

- [src/](src/) — React app (`App.tsx`, `main.tsx`, `index.css`, `design-system.css`, `privacy.ts`, `vite-env.d.ts`). `design-system.css` contains the dashboard-owned copy of every CGReen brand token so builds never depend on the sibling `CGreen Design System` directory; `privacy.ts` contains shared display-data masking rules used by both the API and UI; `agent-name.ts` resolves the agent display name (roster → email-derived → source sheet → `Unassigned`).
- [server.ts](server.ts) — Express API server. Exposes `/api/health`, `POST /api/integrations/zoho/collections` (Zoho Flow webhook), `/api/dashboard`, `/api/dashboard/stream` (SSE live feed), `/api/dashboard.js`. In production it also serves the built `dist/` and injects the dashboard payload into `index.html` server-side.
- [dist/](dist/) — Vite build output (generated, not hand-edited).
- [import_sheets.py](import_sheets.py) — Zoho Sheet → MySQL ETL. One-shot and idempotent: every run is a full upsert keyed on a SHA-256 `uid`, which is a hash of the Cliq **message id** — an identity key, not a content hash, so an edited message updates its row instead of inserting a duplicate. Writes nothing to disk — Zoho auth is three env vars, so the ETL container needs no credential mounts and runs read-only.
- [scripts/zoho_probe.py](scripts/zoho_probe.py) — read-only diagnostic. Prints the sheet's real headers, how each cell would parse, and which `COLUMN_MAP` entries are missing. Run it whenever the source sheet changes shape.
- [Dockerfile](Dockerfile) — multi-stage build of the app image (Node 22 Alpine, tini, non-root uid 1000).
- [Dockerfile.etl](Dockerfile.etl) — ETL sidecar image (Python 3.12 slim).
- [docker/etl-loop.sh](docker/etl-loop.sh) — interval loop wrapper around `import_sheets.py`; honours `IMPORT_INTERVAL_SECONDS` and traps SIGTERM.
- [docker-compose.yml](docker-compose.yml) — reference stack (`app` only; the `etl` service was removed so it never runs alongside Zoho Flow). Pins `PORT=3001` and `NODE_ENV=production` inside the container; everything else comes from `.env`. Deliberately has no MySQL service; the dashboard uses an existing production database.
- [.env.example](.env.example) — the full environment contract. Copy to `.env`.
- [db/001_dashboard_tables.sql](db/001_dashboard_tables.sql) — DDL for the two tables production must add, plus the pre-flight check and least-privilege grants. Schema only, safe to commit.
- `db/002_emp_details_data.sql` — populated 162-row `emp_details` seed, `INSERT IGNORE` so re-runs are safe. **Gitignored: contains real employee names and emails.** Transferred to devops out-of-band.
- [db/003_version_status.sql](db/003_version_status.sql) — adds `collections_messages.version_status` for the Zoho message lifecycle. Additive and idempotent; safe to commit and re-run.
- [db/004_msg_id.sql](db/004_msg_id.sql) — adds `collections_messages.msg_id`: traceability back to the Cliq message, and the ownership marker that keeps Google-era rows out of reconciliation. Additive and idempotent.
- [DEPLOY.md](DEPLOY.md) — devops handoff: provisioning, env vars, secret mounts, health checks, troubleshooting, token rotation, known limits.

## Commands

- `npm run dev` — runs API server (`tsx server.ts`) and Vite dev server (port 4173) concurrently.
- `npm run build` — Vite production build → `dist/`.
- `npm start` — `NODE_ENV=production tsx server.ts`, serves built `dist/` + API from one process.
- `python3 import_sheets.py` — one ETL run. Fully unattended on every run, including the first: the Zoho refresh token comes from the environment and is never cached to disk.
- `python3 scripts/zoho_probe.py` — print the Zoho sheet's real headers and cell encodings without touching MySQL. Run this before editing `COLUMN_MAP`.
- `docker compose up -d --build` — build and run the app. Requires `.env`, copied from `.env.example` (grouped into required / optional / legacy-ETL sections).
- `docker compose logs -f app` — watch the app, including `[zoho-flow]` webhook log lines.
- Live dashboard stream polling defaults to every 2 seconds inside the API server; override with `DASHBOARD_STREAM_POLL_MS`. This cost is **per connected client**.
- No test suite currently exists in this repo. Verification is done by running the stack and checking `/api/health`, `/api/photo-health`, `/api/dashboard`, and the ETL logs.
- `tsx` is a **runtime** dependency, not a devDependency — the production server executes TypeScript directly, so the pruned container image needs it.
- The dashboard is source-level self-contained: its complete CGReen color, typography, spacing, radius, shadow, glow, blur, motion, surface, border, text, accent, and status token set lives in `src/design-system.css`; `src/index.css` must import that local file rather than reaching outside the project.

## Database

**Single schema.** Every SQL statement in `server.ts` uses unqualified table names, so all five tables must resolve inside `DB_NAME`. A cross-schema layout requires code changes.

The five tables, and who owns them:

| Table | Access | Created by |
|---|---|---|
| `collections_messages` | read + write | this project (`db/001_dashboard_tables.sql`) |
| `emp_details` | read | this project (`db/001_dashboard_tables.sql`), populated from the HR roster |
| `dossier`, `lenders`, `bucket` | read | pre-existing in the production database |

Locally that schema is `c_green`. In production it is whatever `DB_NAME` points at — the two tables above get added to the existing production database, which already has the other three.

The static stored `bucket.weights` scale is `Bucket X=1`, `Bucket 1=1.25`, `Buket 2=1.6`, `NPA=2.1`, `Write Off=3.5`; `Multiple Bucket` and KL/test buckets are left null. The API applies `RP_MULTIPLIER_SCALE=0.1` to produce the effective RP multipliers without changing production reference data.

Connection defaults (overridable via `DB_SOCKET_PATH`, `DB_HOST`, `DB_PORT`, `DB_USER`, `DB_PASSWORD`, `DB_NAME`): user `root`, password `1234`, db `c_green`. `DB_SOCKET_PATH` defaults to the local socket **only on macOS** — everywhere else it is unset so containers use `DB_HOST`/`DB_PORT`. A non-empty socket path makes mysql2 ignore host and port entirely. These defaults are mirrored in `server.ts` and `import_sheets.py` — keep them in sync if changed.

Recovery Points (RP) and celebration qualification flow:
- New `collections_messages` rows are evaluated from `email_id`, `loan_no`, and `amount_collected`; score displays use the `RP` unit everywhere.
- **`Collection_Data.email_id` is the Cliq bot** (`collectionchatbot@cgreen.in`) on every row, not the agent. The ETL discards it and resolves the agent's real address from `emp_id` → `emp_details.caller_empcode` → `caller_emailid`, writing that into `email_id` so the dashboard's existing email join works unchanged. When the code is unknown it writes **NULL, never the bot** — a bot address would group every agent into one leaderboard row. Consequence: **`emp_id` is now the sole agent identity**, so a mis-extracted employee code silently credits the wrong person.
- **`date_of_message_sent` arrives in two different encodings in the same sheet.** The AI extractor writes some rows as epoch milliseconds (`1788420181031.0`) and others as 12-hour day-first text (`'3/9/2026 5:40:54 PM'`). `parse_datetime` must handle both; a form it cannot read returns `NULL`, and a NULL date is invisible to every KPI filter and the recent feed while the row still loads — the run reports success. The counted `WARNING` in `transform()` is the only signal, so do not remove it.
- **Epoch timestamps are converted through an explicit timezone, never the process's own.** `BUSINESS_TZ` resolves `TZ` (default `Asia/Kolkata`) via `zoneinfo`, because `datetime.fromtimestamp()` without a tzinfo uses platform local time: a Linux container honours `TZ=Asia/Kolkata` while Windows cannot parse an IANA name and silently falls back to UTC, landing the same message 5.5 hours apart. `tzdata` is in `requirements.txt` so the zone resolves off-Linux too. The sheet's own `ai_processed_time` column is the ground truth to check a conversion against.
- **Numeric-looking identifiers must be coerced to clean strings** (`IDENTIFIER_COLUMNS` in `import_sheets.py`). Zoho sends `loan_id` as a float, and `'4007266194.0'` matches zero `dossier` rows where `'4007266194'` matches two. The join supplies the bucket weight, so the failure is silent and total: the row loads, scores 0 RP, and never reaches the leaderboard.
- A collection can be **edited or retracted** in Zoho Cliq after it is posted. Two rules follow, and both are load-bearing:
  - `uid` is `SHA-256(msg_id)` — an **identity** key. Never rederive it from row contents: an edited amount would hash differently, insert a second row, orphan the first, and double-count that agent permanently.
  - Retracted rows are kept and flagged `version_status = 'DELETED'`. **Every** query reading `collections_messages` must apply `liveCollectionsFilter` in `server.ts` (six sites today); a query that omits it keeps scoring retracted collections on that panel. `NULL` means live.
- **`msg_id` marks row ownership.** Rows imported from the old Google sheet keep it `NULL` and are deliberately kept as history. Their `uid` is a content hash, so it can never appear in what Zoho reports — which would make every one of them a permanent reconciliation candidate. `SELECT_LIVE_UIDS_SQL` therefore filters on `msg_id IS NOT NULL`. Do not remove that predicate: the ratio guard alone stops protecting them once Zoho exceeds roughly four times the legacy row count, and a single run would then flag the entire history `DELETED`.
- The ETL also reconciles: rows the sheet no longer lists are flagged `DELETED`. This is correct **only while `Collection_Data` retains all history** — if the tab is ever rotated or archived, set `RECONCILE_MISSING_ROWS=false` first, or every row outside the current window is hidden. Guarded by `RECONCILE_MIN_RATIO` (default 80%) so a partial fetch cannot read as a mass deletion.
- Treat every LAN/loan account number as sensitive display data. The API must mask every character except the final four before returning dashboard payloads, and the frontend must apply the shared `maskLoanAccountNumber` helper again at the render boundary as defense in depth. LANs of four or fewer characters remain unchanged.
- `email_id` maps to `emp_details.caller_emailid` to resolve `caller_name` and `caller_empcode`.
- Agent display names resolve through `resolveAgentName` in `src/agent-name.ts`: `emp_details.caller_name` → derived from the email local part (`fname.lname@` → `Fname Lname`, trailing digits stripped) → `collections_messages.agent_name` → `Unassigned`. The email deliberately outranks the sheet column, which is hand-typed and carries misspellings and conflicting names for a single address. Do not reintroduce the sheet name as a higher-priority source; add the agent to `emp_details` instead.
- `loan_no` maps to `dossier.loan_account_number` to resolve `dossier_code`, `lender_id`, and `dpd_bucket_id`. If a loan maps to multiple dossier rows/codes, the API picks the row with the latest non-null `due_date`, using newest dossier row id as a tie-breaker.
- `lender_id` maps through `lenders.id` for lender context, and `dpd_bucket_id` maps through `bucket.id` for the canonical bucket name and multiplier context.
- RP is calculated as `amount_collected * effective multiplier`. The API scales stored `bucket.weights` by `0.1`, producing effective normal-bucket multipliers of `x0.1`, `x0.125`, `x0.16`, `x0.21`, and `x0.35`; blank, null, or non-numeric weights count as `0 RP`. For `dpd_bucket_id = 7` (`Multiple Bucket`), the effective multiplier comes from `dossier.dpd_days`: `1-30=0.1`, `31-60=0.125`, `61-90=0.16`, `91-180=0.21`, `181-360=0.275`, `361+=0.35`. A row qualifies when RP is greater than `500`, set in `server.ts` as `CELEBRATION_MIN_RP`.
- The API does not use the removed `profiles` table.
- The API returns qualifying rows in `celebrationQueue`; the frontend queues newly seen qualifying collection rows for the automatic celebration overlay and still uses `qualifiedCelebrations` to count auto triggers. Each recent collection card also has a manual Celebrate button that replays the overlay for that row, even if it did not qualify automatically. Celebration audio plays two bundled real recordings layered together — `src/assets/applause.wav` (CC0) and `src/assets/cheer.ogg` (Public Domain), both from Wikimedia Commons — for a loud "cheers + applause" burst (capped ~6s with a fade-out). If the recordings fail to load/play, it falls back to the in-browser synth (Web Audio crowd-roar + applause + whistles), and finally to a generated WAV data URL.
- Dashboard queries should keep dossier lookups scoped to each panel's row set: current month for monthly RP/top performer, today for today's leaderboard, and recent rows for the live feed.

## Deployment

Full detail in [DEPLOY.md](DEPLOY.md). The parts that constrain code changes:

- **Two images, one running service.** `app` (Express + built `dist/`, port 3001, behind the proxy at `https://collections.dashboard.cgreen.in`) is the only compose service. `etl` (`import_sheets.py` on a loop) is rollback-only and must never run alongside Zoho Flow. No MySQL container — production supplies the database.
- **Migrations 003 and 004 are required** on the production schema before enabling the webhook: its upsert writes `version_status` and `msg_id`.
- **`.dockerignore` also excludes `db/`, `docs/`, and `*.csv`** so the PII roster seed and data exports never enter the build context or cache.
- **Two Google credential files are mounted on the `app` image only, never baked in.** `credentials1.json` / `token1.json`, used solely for employee photos. `.dockerignore` excludes `credentials*.json` and `token*.json` specifically. Do not add them to a `COPY`.
- **`token1.json` must be mounted read-write.** `server.ts` rewrites it on refresh, so a `:ro` mount fails at refresh time — not at startup — and survives a smoke test.
- **The `etl` image mounts nothing and runs `read_only: true`.** Zoho auth is `ZOHO_CLIENT_ID` / `ZOHO_CLIENT_SECRET` / `ZOHO_REFRESH_TOKEN` in the environment. Do not reintroduce a token cache file.
- **The Zoho data centre must match the account.** `ZOHO_ACCOUNTS_URL` and `ZOHO_SHEET_API_URL` both default to `.in`. Pointing an India account at `.com` returns 404, which misreads as a bad `ZOHO_RESOURCE_ID`. Change both together.
- **Containers run as uid 1000**, so mounted token files must be writable by that uid.
- **`TZ` matters.** Daily/monthly KPI boundaries are computed in local time; a UTC container shifts the business day.
- **`NODE_ENV=production` is required** for the server to serve `dist/` at all.
- The Google photo token (`token1.json`) cannot be minted inside a container — that flow needs an interactive browser. The Zoho refresh token has no such constraint: it is minted once from a Self Client at `api-console.zoho.in` and then lives in the environment.
- Employee photos still come from the **Google Admin Directory** API. If the org leaves Google Workspace this breaks independently of the ETL: `/api/photo-health` reports `ok: false` and avatars fall back to initials. No code change is needed to fix it — files dropped into `public/employee-photos/` take priority over the API.

## Tasks / Lessons

- [tasks/lessons.md](tasks/lessons.md) — running log of lessons learned, written as rules. Read at the start of a session and apply; append new lessons as they're learned.
