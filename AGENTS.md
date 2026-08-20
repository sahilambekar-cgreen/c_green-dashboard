# AGENTS.md

## Maintenance Rule

> **Every change made to this repository must be reflected in AGENTS.md in the same commit.** Before finishing any task — adding dependencies, changing commands, restructuring directories, introducing new patterns, modifying build/test/deploy steps, or anything else that affects how the codebase works — update the relevant section of AGENTS.md. If a change has no impact on what's documented here, note that briefly in the commit message. Treat AGENTS.md as part of the change, not an afterthought.

## Rules

1. Plan mode first before pushing anything — plan first even if something happens mid task.
2. Complex tasks → subagents. Keep main context clean.
3. Self-improvement loop: every lesson goes into `tasks/lessons.md` as a rule; next session reads and applies.
4. Verification standard: never mark a task done without running tests or checking logs.
5. Autonomous bug fixing: given a bug, go to logs, find root cause, fix immediately.
6. Document codebase-affecting changes in this file (see Maintenance Rule).

## Project Overview

"Stitch Debt Recovery Pulse" — a full-width TV/war-room dashboard for debt collection agencies. The visible dashboard masthead uses the single heading "Live Collections Floor" (with no separate "Recovery Pulse" title), and the Recent Collections panel header shows only its title without the prototype-feed subtitle. Shows live leaderboard, recent collections, queued celebration toasts, and a rotating monthly lender-points horizontal bar graph pulled from a MySQL database. Dark "Cyber-Techno" neon theme; the token set lives in `src/design-system.css`.

## Stack

- **Frontend:** React 19 + TypeScript, Vite 7, Tailwind CSS 4 (via `@tailwindcss/vite`), Framer Motion, lucide-react icons, canvas-confetti, use-sound.
- **Backend:** Express 5 served via `tsx` (no separate compile step), MySQL access via `mysql2/promise`, live dashboard updates via Server-Sent Events.
- **Data import tooling:** Python 3 (`mysql-connector-python`, `pymysql`, `gspread`, `pandas`, Google Auth libraries). `import_sheets.py` is the only ETL — Google Sheets → MySQL.
- **Deployment:** two Docker images — `Dockerfile` (Node app) and `Dockerfile.etl` (Python ETL sidecar). See [DEPLOY.md](DEPLOY.md).

## Directory Structure

- [src/](src/) — React app (`App.tsx`, `main.tsx`, `index.css`, `design-system.css`, `privacy.ts`, `vite-env.d.ts`). `design-system.css` contains the dashboard-owned copy of every CGReen brand token so builds never depend on the sibling `CGreen Design System` directory; `privacy.ts` contains shared display-data masking rules used by both the API and UI; `agent-name.ts` resolves the agent display name (roster → email-derived → source sheet → `Unassigned`).
- [server.ts](server.ts) — Express API server. Loads the root `.env` file when present before creating the MySQL pool, then exposes `/api/health`, `/api/dashboard`, `/api/dashboard/stream` (SSE live feed), `/api/dashboard.js`. In production it also serves the built `dist/` and injects the dashboard payload into `index.html` server-side.
- [dist/](dist/) — Vite build output (generated, not hand-edited).
- [requirements.txt](requirements.txt) — Python dependencies for `import_sheets.py`.
- [import_sheets.py](import_sheets.py) — Google Sheets → MySQL ETL. One-shot and idempotent: every run is a full upsert keyed on a SHA-256 `uid`. Rewrites its OAuth token file on every run.
- [prod_seeder.py](prod_seeder.py) — production → local MySQL clone utility. Validates and recreates all five dashboard base-table schemas, then streams and verifies production rows for the four reference tables (`emp_details`, `dossier`, `lenders`, `bucket`). `collections_messages` is deliberately created empty with its auto-increment reset so `import_sheets.py` can populate local collection events independently. The target is restricted to loopback/socket connections unless explicitly overridden; existing dashboard tables require `--replace`.
- [Dockerfile](Dockerfile) — multi-stage build of the app image (Node 22 Alpine, tini, non-root uid 1000).
- [Dockerfile.etl](Dockerfile.etl) — ETL sidecar image (Python 3.12 slim).
- [docker/etl-loop.sh](docker/etl-loop.sh) — interval loop wrapper around `import_sheets.py`; honours `IMPORT_INTERVAL_SECONDS` and traps SIGTERM.
- [docker-compose.yml](docker-compose.yml) — reference stack (`app` + `etl`). Deliberately has no MySQL service; the dashboard uses an existing production database.
- [.env.example](.env.example) — the full environment contract. Copy to `.env`.
- [db/001_dashboard_tables.sql](db/001_dashboard_tables.sql) — DDL for the two tables production must add, plus the pre-flight check and least-privilege grants. Schema only, safe to commit.
- `db/002_emp_details_data.sql` — populated 162-row `emp_details` seed, `INSERT IGNORE` so re-runs are safe. **Gitignored: contains real employee names and emails.** Transferred to devops out-of-band.
- [DEPLOY.md](DEPLOY.md) — devops handoff: provisioning, env vars, secret mounts, health checks, troubleshooting, token rotation, known limits.

## Commands

- `npm run dev` — runs API server (`tsx server.ts`) and Vite dev server (port 4173) concurrently. The API loads database settings from the root `.env`; leave `NODE_ENV` unset there for local development because the Docker image sets production mode itself.
- `npm run build` — Vite production build → `dist/`.
- `npm start` — `NODE_ENV=production tsx server.ts`, serves built `dist/` + API from one process.
- `python3 -m pip install -r requirements.txt` — installs Python dependencies for `import_sheets.py`.
- `python3 import_sheets.py` — one ETL run. The first run on a new machine opens a browser for Google consent and writes `token.json`; every run after that is unattended.
- `PROD_DB_HOST=<host> PROD_DB_USER=<read-user> PROD_DB_PASSWORD=<password> PROD_DB_NAME=<schema> python3 prod_seeder.py` — clone all five production dashboard schemas and the contents of the four reference tables into local MySQL; `collections_messages` starts empty. Local defaults are `root` / `1234` / `c_green`; override with `LOCAL_DB_HOST`, `LOCAL_DB_PORT`, `LOCAL_DB_USER`, `LOCAL_DB_PASSWORD`, `LOCAL_DB_NAME`, or `LOCAL_DB_SOCKET_PATH`. The dashboard tables must be absent on the first run; use `--replace` to deliberately rebuild them.
- `docker compose up -d --build` — build and run the full stack (app + ETL sidecar). Requires `.env`, copied from `.env.example`.
- `docker compose logs -f etl` — watch ETL cycles.
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

The static `bucket.weights` multiplier scale is `Bucket X=1`, `Bucket 1=1.25`, `Buket 2=1.6`, `NPA=2.1`, `Write Off=3.5`; `Multiple Bucket` and KL/test buckets are left null.

`prod_seeder.py` copies production reference data, including sensitive employee and loan-account fields, directly into the named local schema; it does not copy any `collections_messages` rows, write a dump file, or add copied data to the repository. Use a read-only production account, keep the local database private, and never commit or share a data export made from it. The seeder copies base tables only, not views, triggers, routines, or events.

Connection defaults (overridable via `DB_SOCKET_PATH`, `DB_HOST`, `DB_PORT`, `DB_USER`, `DB_PASSWORD`, `DB_NAME`): user `root`, password `1234`, db `c_green`. `DB_SOCKET_PATH` defaults to `/private/tmp/mysql.sock` **only on macOS** — on every other platform it is unset so containers use `DB_HOST`/`DB_PORT`. A non-empty socket path makes mysql2 ignore host and port entirely. These defaults are mirrored in `server.ts` and `import_sheets.py` — keep them in sync if changed.

Points and celebration qualification flow:
- New `collections_messages` rows are evaluated from `email_id`, `loan_no`, and `amount_collected`; the dashboard displays normalized points instead of raw collection amount.
- Treat every LAN/loan account number as sensitive display data. The API must replace the hidden portion with the fixed `••••` redaction marker and expose only the final four characters (for example, `•••• 1175`) before returning dashboard payloads; the fixed marker also avoids disclosing the LAN's original length. The frontend must apply the shared, idempotent `maskLoanAccountNumber` helper again at the render boundary as defense in depth, and keep the separator, redaction marker, and visible suffix together as a non-wrapping display token. LANs of four or fewer characters remain unchanged.
- `email_id` maps to `emp_details.caller_emailid` to resolve `caller_name` and `caller_empcode`.
- Agent display names resolve through `resolveAgentName` in `src/agent-name.ts`: `emp_details.caller_name` → derived from the email local part (`fname.lname@` → `Fname Lname`, trailing digits stripped) → `collections_messages.agent_name` → `Unassigned`. The email deliberately outranks the sheet column, which is hand-typed and carries misspellings and conflicting names for a single address. Do not reintroduce the sheet name as a higher-priority source; add the agent to `emp_details` instead.
- `loan_no` maps to `dossier.loan_account_number` to resolve `dossier_code`, `lender_id`, and `dpd_bucket_id`. If a loan maps to multiple dossier rows/codes, the API picks the row with the latest non-null `due_date`, using newest dossier row id as a tie-breaker.
- `lender_id` maps through `lenders.id` for lender context, and `dpd_bucket_id` maps through `bucket.id` for the canonical bucket name and multiplier context.
- Points are calculated as `amount_collected * multiplier`. For normal buckets, the multiplier comes from `bucket.weights`; blank, null, or non-numeric weights count as `0` points. For `dpd_bucket_id = 7` (`Multiple Bucket`), the multiplier comes from `dossier.dpd_days`: `1-30=1`, `31-60=1.25`, `61-90=1.6`, `91-180=2.1`, `181-360=2.75`, `361+=3.5`. A row qualifies when points are greater than `500`, set in `server.ts` as `CELEBRATION_MIN_POINTS`.
- The API does not use the removed `profiles` table.
- The API returns qualifying rows in `celebrationQueue`; the frontend queues newly seen qualifying collection rows for the automatic celebration overlay and still uses `qualifiedCelebrations` to count auto triggers. Each recent collection card also has a manual Celebrate button that replays the overlay for that row, even if it did not qualify automatically. Celebration audio plays two bundled real recordings layered together — `src/assets/applause.wav` (CC0) and `src/assets/cheer.ogg` (Public Domain), both from Wikimedia Commons — for a loud "cheers + applause" burst (capped ~6s with a fade-out). If the recordings fail to load/play, it falls back to the in-browser synth (Web Audio crowd-roar + applause + whistles), and finally to a generated WAV data URL.
- The API returns `lenderMonthlyPoints`, a current-month aggregation of the same normalized points grouped by resolved lender. The frontend uses it for the information canvas that appears for one minute every five minutes, replacing the blank canvas with a horizontal lender bar graph that dynamically fits all returned lenders in the available panel height. Keep the summary rail compact so the chart gets most of the width, and scale row type/bar thickness from the lender count. Bar color is pace-based: the normal monthly target is `day-of-month * 1000` points using the dashboard latest batch date, green for lenders at/above pace and red for lenders below pace, with darker shades normalized against the current returned lenders' distance from the threshold. `src/App.tsx` currently has a temporary `LENDER_MONTHLY_POINT_TARGET_OVERRIDE = 100_000` for testing; set it to `null` to restore the normal day-of-month rule.
- Dashboard queries should keep dossier lookups scoped to each panel's row set: current month for monthly points/top performer, today for today's leaderboard, and recent rows for the live feed.
- Dashboard period filters use half-open ranges on `collections_messages.date_of_message_sent` for daily/monthly KPIs, the daily leaderboard, and the monthly top performer. Anchor those ranges to the latest loaded `date_of_message_sent` date so the dashboard keeps showing the newest completed batch when there are no rows for the server's current date; fall back to `CURDATE()` only when the table is empty. Keep `created_at` for ingestion ordering/live recency, not business-period collection counts.

## Deployment

Full detail in [DEPLOY.md](DEPLOY.md). The parts that constrain code changes:

- **Two images, one stack.** `app` (Express + built `dist/`, port 3001) and `etl` (`import_sheets.py` on a loop). No MySQL container — production supplies the database.
- **Four Google credential files are mounted, never baked into an image.** `.dockerignore` excludes `credentials*.json` and `token*.json` specifically. Do not add them to a `COPY`.
- **`token.json` and `token1.json` must be mounted read-write.** `import_sheets.py` rewrites its token on every run and `server.ts` rewrites `token1.json` on refresh. Any change that assumes a read-only filesystem will break both.
- **Containers run as uid 1000**, so mounted token files must be writable by that uid.
- **`TZ` matters.** Daily/monthly KPI boundaries are computed in local time; a UTC container shifts the business day.
- **`NODE_ENV=production` is required** for the server to serve `dist/` at all.
- Neither OAuth token can be minted inside a container — both flows need an interactive browser.

## Tasks / Lessons

- [tasks/lessons.md](tasks/lessons.md) — running log of lessons learned, written as rules. Read at the start of a session and apply; append new lessons as they're learned.
