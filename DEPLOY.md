# Deployment Guide — Stitch Debt Recovery Pulse

Handoff document for the devops team. Assumes no prior knowledge of this repo.

---

## 1. What this is

A TV/war-room dashboard for the debt collection floor. Two containers:

```
                        ┌──────────────────────────────┐
   Google Sheet  ──────▶│  etl  (Dockerfile.etl)       │
   (collections log)    │  import_sheets.py, every 60s │
                        └──────────────┬───────────────┘
                                       │ INSERT/UPDATE
                                       │ collections_messages
                                       ▼
                        ┌──────────────────────────────┐
                        │   EXISTING PRODUCTION MySQL  │
                        │   (not managed by this repo) │
                        └──────────────┬───────────────┘
                                       │ SELECT
                                       ▼
   Wall TVs   ◀────────  ┌──────────────────────────────┐
   (browser)   HTTP+SSE  │  app  (Dockerfile)           │
                         │  Express API + built React   │
                         │  port 3001                   │
                         └──────────────────────────────┘
                                       │
                                       ▼
                         Google Admin Directory API
                         (employee profile photos)
```

- **`app`** — single Node process. Serves the React bundle from `dist/` *and* the
  `/api/*` routes, so there is no separate web server to run. Pushes live updates
  to each TV over Server-Sent Events.
- **`etl`** — Python sidecar. Pulls a Google Sheet and upserts it into
  `collections_messages` on a loop. Every run is a full idempotent upsert, so a
  missed run self-heals on the next one.

There is **no database container**. The dashboard connects to your existing
production MySQL.

---

## 2. What you must provision

### 2.1 Two new tables

The dashboard reads **five** tables. Three already exist in production:

| Table | Status | Access |
|---|---|---|
| `dossier` | already exists | read-only |
| `lenders` | already exists | read-only |
| `bucket` | already exists | read-only |
| `collections_messages` | **you must create** | read + write |
| `emp_details` | **you must create** | read-only |

Run [`db/001_dashboard_tables.sql`](db/001_dashboard_tables.sql) against the target schema:

```bash
mysql -h <host> -u <admin-user> -p <schema> < db/001_dashboard_tables.sql
```

It is `CREATE TABLE IF NOT EXISTS` throughout — safe to re-run.

Then load the employee roster (see §2.4):

```bash
mysql -h <host> -u <admin-user> -p <schema> < db/002_emp_details_data.sql
```

> **All five tables must live in the SAME schema.** Every SQL statement in
> `server.ts` uses unqualified table names, so they all resolve against `DB_NAME`.
> A cross-schema layout will not work without code changes.

### 2.2 Pre-flight check

Before deploying, confirm all five tables resolve. This must return **5 rows**:

```sql
SELECT table_name FROM information_schema.tables
 WHERE table_schema = DATABASE()
   AND table_name IN ('collections_messages','emp_details','dossier','lenders','bucket');
```

### 2.3 Application database user

The app writes to exactly one table. Least-privilege grants are at the bottom of
`db/001_dashboard_tables.sql`:

```sql
GRANT SELECT, INSERT, UPDATE ON `<schema>`.`collections_messages` TO 'cgreen_dashboard'@'%';
GRANT SELECT ON `<schema>`.`emp_details` TO 'cgreen_dashboard'@'%';
GRANT SELECT ON `<schema>`.`dossier`     TO 'cgreen_dashboard'@'%';
GRANT SELECT ON `<schema>`.`lenders`     TO 'cgreen_dashboard'@'%';
GRANT SELECT ON `<schema>`.`bucket`      TO 'cgreen_dashboard'@'%';
```

### 2.4 Populating `emp_details`

`emp_details` is not filled by the ETL. It maps `collections_messages.email_id` →
agent name and employee code, joined on `LOWER(TRIM(caller_emailid))`. **If it is
empty the dashboard still renders, but the leaderboard shows raw email addresses
instead of agent names.**

A populated 162-row seed is supplied as **`db/002_emp_details_data.sql`**.

> ### This file is not in the repository
>
> It contains real employee names and email addresses, so it is gitignored and
> transferred out-of-band. If you cloned this repo and the file is missing, ask
> the application owner for it — do not ask for it over chat or in a ticket.
>
> Treat it like a credential: secure transfer, delete your local copy after
> loading, and do not commit it to any infrastructure repo.

It uses `INSERT IGNORE` with explicit `id` values, so re-running is safe — rows
already present are skipped rather than duplicated. Verify after loading:

```sql
SELECT COUNT(*) FROM emp_details;   -- expect 162
```

**Coverage gap is handled in code — no action needed.** `collections_messages`
references 167 distinct agent emails; only 113 match a row in this seed. For the
other 54 the API derives a display name from the email address, so **no agent
ever renders as a raw email**. Resolution order (`src/agent-name.ts`):

1. `emp_details.caller_name` — the roster, when a row exists
2. **derived from the email local part** — `sneha.rathod1@` → "Sneha Rathod"
3. `collections_messages.agent_name` — the hand-typed source-sheet name
4. `"Unassigned"`

The email deliberately beats the sheet: that column is typed by hand and carries
misspellings, casing drift, and at least one address with three different names
against it. Loading a fuller roster into `emp_details` later automatically takes
priority again, since step 1 wins.

One consequence to expect: addresses with no separator (`altaf@`, `manshi@`)
yield a single name, because there is no surname in the address to recover.

Two quirks in the seed data itself, both benign — flagged so a reviewer does not
mistake them for a corrupt dump: 4 rows have a blank `caller_emailid` (they
simply never match a collection), and 2 emails appear twice. The dashboard groups
by `LOWER(TRIM(caller_emailid))` and takes `MAX()`, so duplicates resolve
deterministically.

---

## 3. Environment variables

Copy `.env.example` to `.env` and fill it in. Both containers read the same file.

| Variable | Required | Default | What breaks if wrong |
|---|---|---|---|
| `DB_HOST` | yes | `localhost` | No DB connection; `/api/health` returns 500 |
| `DB_PORT` | yes | `3306` | Connection refused |
| `DB_USER` | yes | `root` | Access denied |
| `DB_PASSWORD` | yes | `1234` | Access denied. **Never ship the default.** |
| `DB_NAME` | yes | `c_green` | `Table '...' doesn't exist` on every query |
| `DB_SOCKET_PATH` | yes | *(empty)* | **Must be empty in containers.** Any value makes the driver use a unix socket and silently ignore `DB_HOST`/`DB_PORT` |
| `PORT` | no | `3001` | Healthcheck and port mapping must match |
| `APP_PORT` | no | `3001` | Host port published by compose |
| `NODE_ENV` | yes | — | Must be `production`, or the server won't serve `dist/` and you get 404s |
| `TZ` | yes | `Asia/Kolkata` | Daily/monthly KPIs roll over at the wrong hour |
| `DASHBOARD_STREAM_POLL_MS` | no | `2000` | See §8 — this cost is **per connected TV** |
| `IMPORT_INTERVAL_SECONDS` | no | `60` | How stale the dashboard gets |
| `SHEET_URL` | yes | *(baked default)* | ETL imports the wrong sheet |
| `SHEET_TAB` | no | `Sheet1` | ETL exits with a worksheet error |
| `GOOGLE_CREDENTIALS` | no | `credentials.json` | Path *inside* the container |
| `GOOGLE_TOKEN` | no | `token.json` | Path *inside* the container |
| `GOOGLE_PHOTOS_CREDENTIALS` | no | `credentials1.json` | Path *inside* the container |
| `GOOGLE_PHOTOS_TOKEN` | no | `token1.json` | Path *inside* the container |

`.env` contains a database password. Keep it out of version control (it is in
`.gitignore` and `.dockerignore`) and restrict it to `chmod 600`.

---

## 4. Secret files to mount

These four files are **not** in the image — `.dockerignore` excludes them
specifically so no credential ends up in a layer. They must be mounted at runtime.

| File | Container path | Used by | Mode |
|---|---|---|---|
| `credentials.json` | `/app/credentials.json` | etl | **read-only** |
| `token.json` | `/app/token.json` | etl | **READ-WRITE** |
| `credentials1.json` | `/app/credentials1.json` | app | **read-only** |
| `token1.json` | `/app/token1.json` | app | **READ-WRITE** |

> ### The read-write requirement is not optional
>
> Both token files are **rewritten in place** whenever the OAuth access token is
> refreshed — `import_sheets.py` does this on *every* run, `server.ts` whenever the
> access token is within 60s of expiry. Mount them read-only and the ETL crashes;
> mount them on ephemeral storage and every restart forces a fresh refresh.
>
> Both containers run as **uid 1000**. On a Linux host the mounted files must be
> writable by that uid:
>
> ```bash
> sudo chown 1000:1000 token.json token1.json
> sudo chmod 600 token.json token1.json
> ```
>
> Both writers truncate in place rather than doing an atomic rename, so
> single-file bind mounts work correctly.

Optional: `employee-photos` volume at `/app/public/employee-photos`. Drop image
files there named after the agent's email with non-alphanumerics replaced by
underscores (`jane.doe@corp.com` → `jane_doe_corp_com.jpg`). Local files take
priority over the Google Directory API.

---

## 5. Build and run

### With the provided compose file

```bash
cp .env.example .env    # then edit it
docker compose up -d --build
```

### Without compose

```bash
docker build -t cgreen-dashboard-app:latest -f Dockerfile .
docker build -t cgreen-dashboard-etl:latest -f Dockerfile.etl .
```

```bash
docker run -d --name cgreen-dashboard-app --env-file .env -p 3001:3001 \
  -v "$PWD/credentials1.json:/app/credentials1.json:ro" \
  -v "$PWD/token1.json:/app/token1.json" \
  cgreen-dashboard-app:latest
```

```bash
docker run -d --name cgreen-dashboard-etl --env-file .env \
  -v "$PWD/credentials.json:/app/credentials.json:ro" \
  -v "$PWD/token.json:/app/token.json" \
  cgreen-dashboard-etl:latest
```

The images are orchestrator-agnostic — only the wiring above is compose-specific.
For Kubernetes: a Deployment + Service for `app`, and either a second Deployment
or a CronJob for `etl` (if you use a CronJob, set the schedule instead of
`IMPORT_INTERVAL_SECONDS` and override the command to `python import_sheets.py`).

---

## 6. Health and verification

| Endpoint | Meaning |
|---|---|
| `GET /api/health` | `{"ok":true}` — runs `SELECT 1` against MySQL. Used by the Docker `HEALTHCHECK`. |
| `GET /api/photo-health` | Whether the Google photo credentials and refresh token are present and loadable. |
| `GET /api/dashboard` | The full payload. Non-empty `recentCollections` means the ETL is working. |

```bash
curl -s localhost:3001/api/health
curl -s localhost:3001/api/photo-health
docker compose logs -f etl
```

A healthy ETL cycle logs:

```
[Extract] Fetched 4367 rows from 'Sheet1'
[Transform] Prepared 4355 rows (sorted by date, earliest first)
[Load] Inserted 0, updated 4355 rows
ETL complete ✓
```

`Inserted 0` on a steady-state run is expected and correct — the upsert is keyed
on a content hash, so unchanged rows are simply re-written.

---

## 7. Troubleshooting

| Symptom | Cause | Fix |
|---|---|---|
| `/api/health` 500, `ECONNREFUSED /private/tmp/mysql.sock` | `DB_SOCKET_PATH` is set to a non-empty value | Set `DB_SOCKET_PATH=` (empty) in `.env` |
| `Table 'x.collections_messages' doesn't exist` | Tables not created, or `DB_NAME` points at the wrong schema | Run `db/001_dashboard_tables.sql`; re-run the §2.2 pre-flight query |
| Dashboard loads but is empty | ETL has not run, or no rows for the current period | Check `docker compose logs etl`; confirm `SELECT COUNT(*) FROM collections_messages` |
| Names look derived from emails ("Sneha Rathod" not "Sneha R Rathod") | Expected: that agent has no `emp_details` row, so the name comes from the email | Not a deploy fault (§2.4). Add the agent to `emp_details` and the roster name takes over |
| Everyone shows a derived name | `emp_details` empty — seed not loaded | Load `db/002_emp_details_data.sql` (§2.4) |
| Blank page, 404 on assets | `NODE_ENV` is not `production` | Set `NODE_ENV=production` |
| KPIs roll over at the wrong time of day | `TZ` unset → container defaults to UTC | Set `TZ=Asia/Kolkata` |
| ETL: `PERMISSION_DENIED` / 403 | Sheet not shared with the token's Google account, or Sheets API disabled | Share the sheet; enable the Sheets API in the GCP project |
| ETL: `invalid_grant` / token refresh fails | Refresh token expired or revoked | Re-mint `token.json` (§8) |
| ETL crashes with a read-only filesystem error | `token.json` mounted `:ro` or owned by the wrong uid | See §4 |
| Photos missing, `/api/photo-health` shows `hasRefreshToken: false` | `token1.json` missing or not persisted | Re-mint `token1.json` (§8) and mount it read-write |

---

## 8. Token rotation

**Neither token can be minted inside the container.** Both flows require an
interactive browser. Mint on a workstation, then copy the resulting file to the
host and restart the container.

### `token.json` — Google Sheets (ETL)

On a machine with a browser and this repo checked out:

```bash
pip install -r requirements.txt
python3 import_sheets.py
```

The first run opens a browser for consent and writes `token.json`. Requires an
account with read access to the sheet.

### `token1.json` — Google Admin Directory (employee photos)

```bash
npm install
npm run google:photos:auth
```

Prints a URL, you paste back the callback code, and it writes `token1.json`.
**Requires a Google Workspace admin account** — the scope is
`admin.directory.user.readonly`.

Then:

```bash
sudo chown 1000:1000 token.json token1.json
docker compose restart
```

If you would rather stop doing this periodically, both integrations can be moved
to GCP **service accounts** (the photo one needs domain-wide delegation authorized
by a Workspace super-admin). That removes refresh tokens entirely and lets the
container filesystem be read-only. It is a code change, not a config change.

---

## 9. Scaling and known limits

Raise these with the application owner before going wide:

1. **SSE polling is per-client.** Each connected TV opens its own
   `/api/dashboard/stream` connection, and each one re-queries MySQL every
   `DASHBOARD_STREAM_POLL_MS` (default 2s). Ten screens = ~5 dashboard queries per
   second against production. If you are adding screens, raise the interval or ask
   for a shared server-side poller.
2. **CORS is wide open.** `server.ts` sends `Access-Control-Allow-Origin: *` on
   every route. Put the container behind your reverse proxy; do not expose 3001
   publicly.
3. **No authentication.** Any client that can reach the port sees collections
   data. Restrict at the network/proxy layer.
4. **Loan account numbers are masked** at both the API and UI boundaries (all but
   the last four characters). Do not add logging that dumps raw rows.
5. **The `app` container is stateless** and can be scaled horizontally. **The
   `etl` container is not** — run exactly one replica, or concurrent runs will
   fight over the same upsert.
