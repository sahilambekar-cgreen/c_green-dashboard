# Deployment Guide — Stitch Debt Recovery Pulse

Handoff document for the devops team. Assumes no prior knowledge of this repo.

> **Current ingestion path:** Zoho Sheet → Zoho Flow → authenticated
> `POST /api/integrations/zoho/collections` → `collections_messages`. The
> `etl` material described below is retained only as a rollback artifact; it is
> no longer included in `docker-compose.yml` and must not run alongside Flow.
> Follow [docs/ZOHO_FLOW_INTEGRATION.md](docs/ZOHO_FLOW_INTEGRATION.md) for the
> Flow configuration, secret, test, cutover, and rollback steps.

---

## 1. What this is

A TV/war-room dashboard for the debt collection floor. Two containers:

```
                        ┌──────────────────────────────┐
   Zoho Sheet    ──────▶│  etl  (Dockerfile.etl)       │
   (Collection_Data tab) │  import_sheets.py, every 60s │
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
- **`etl`** — Python sidecar. Pulls the Zoho Sheet `Collection_Data` tab over the
  Zoho Sheet API v2 and upserts it into `collections_messages` on a loop. Every
  run is a full idempotent upsert, so a missed run self-heals on the next one.
  It mounts no files and writes nothing, so it runs `read_only: true`.

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

Finally, add the two Zoho columns (see §2.1.1):

```bash
mysql -h <host> -u <admin-user> -p <schema> < db/003_version_status.sql
mysql -h <host> -u <admin-user> -p <schema> < db/004_msg_id.sql
```

**Both must be applied before enabling the Zoho Flow webhook** (or the rollback
ETL) — every insert carries `version_status` and `msg_id`, so a missing column
fails every request, and every dashboard query filters on `version_status`.
Both are additive and idempotent: they add a nullable column only if it is
missing and never drop, recreate, or rewrite existing data.

> **All five tables must live in the SAME schema.** Every SQL statement in
> `server.ts` uses unqualified table names, so they all resolve against `DB_NAME`.
> A cross-schema layout will not work without code changes.

### 2.1.1 Message lifecycle (`version_status`)

A collection posted in Zoho Cliq can be **edited or retracted** after the fact.
Two mechanisms handle that, and both matter for correctness:

**Row identity.** `uid` is a SHA-256 of the Cliq **message id**, not of the row's
contents. If it hashed the contents, correcting an amount would produce a
different `uid`, so the ETL would insert a second row and orphan the first — the
collection would then be counted **twice** on the leaderboard, permanently.
Keying on the message id makes an edit an `UPDATE` of the same row.

**Visibility.** Retracted messages are kept for audit and flagged
`version_status = 'DELETED'`. All six dashboard queries exclude them via
`(version_status IS NULL OR version_status <> 'DELETED')`. `NULL` means live,
so rows predating the column need no backfill.

[`db/003_version_status.sql`](db/003_version_status.sql) adds the column. It is
additive and idempotent — one nullable column plus an index, no data rewritten,
no downtime, safe to re-run.

> ### Reconciliation — read before enabling in a rotated sheet
>
> A row can also vanish from the sheet with **no** `DELETED` flag (someone
> removes the spreadsheet row). Nothing in the payload reports it, so the ETL
> compares the sheet against the database each run and hides anything the sheet
> no longer lists. It **marks** rather than deletes, so a mistake self-heals: if
> the row reappears, the next run clears the flag automatically.
>
> Rows imported from the old Google sheet are kept as history and are **excluded
> from reconciliation entirely** — they have `msg_id IS NULL`, and the candidate
> query filters on it. This is not optional tidiness: their `uid` is a content
> hash that can never match what Zoho reports, so they are permanent deletion
> candidates, and the ratio guard only masks that until Zoho grows past roughly
> four times the legacy row count.
>
> This is safe **only because `Collection_Data` retains all history.** If the tab
> is ever rotated or archived, an absent row stops meaning "retracted" and this
> would hide every collection outside the current window. Set
> `RECONCILE_MISSING_ROWS=false` before that happens.
>
> Two guards are always on: reconciliation is skipped if the sheet returns less
> than `RECONCILE_MIN_RATIO` (default 80%) of the live database rows — a partial
> fetch must never read as a mass deletion — and `RECONCILE_DRY_RUN=true` logs
> what it would hide without changing anything. Run dry for the first few cycles.

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

Copy `.env.example` to `.env` and fill it in. The file is grouped into
**required**, **optional**, and **legacy ETL** (rollback only) sections. The
compose file pins `PORT=3001` and `NODE_ENV=production` inside the app
container, so the reverse proxy always targets container port `3001`.

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
| `ZOHO_FLOW_WEBHOOK_SECRET` | yes | — | Webhook answers `503`; no collections ingested. Secret store only — never commit |
| `ZOHO_FLOW_MAX_BODY_BYTES` | no | `64kb` | Oversized Flow payloads rejected |
| `GOOGLE_PHOTOS_CREDENTIALS` | no | `credentials1.json` | Path *inside* the container |
| `GOOGLE_PHOTOS_TOKEN` | no | `token1.json` | Path *inside* the container |

**Legacy ETL only** (`Dockerfile.etl`, rollback path — not read by the app):

| Variable | Required | Default | What breaks if wrong |
|---|---|---|---|
| `IMPORT_INTERVAL_SECONDS` | no | `60` | How stale the dashboard gets |
| `ZOHO_CLIENT_ID` | yes | — | ETL exits 1 naming the missing variable |
| `ZOHO_CLIENT_SECRET` | yes | — | ETL exits 1 naming the missing variable |
| `ZOHO_REFRESH_TOKEN` | yes | — | ETL exits 1 naming the missing variable |
| `ZOHO_RESOURCE_ID` | yes | *(baked default)* | ETL imports the wrong sheet, or 404s |
| `ZOHO_ACCOUNTS_URL` | no | `https://accounts.zoho.in` | **Must match the account's data centre** — see below |
| `ZOHO_SHEET_API_URL` | no | `https://sheet.zoho.in/api/v2` | **Must match the account's data centre** — see below |
| `SHEET_TAB` | no | `Collection_Data` | ETL exits with a worksheet error. `Raw_Messages` is unparsed chat text and will not work |
| `ZOHO_PAGE_SIZE` | no | `1000` | Pagination size for `worksheet.records.fetch` |
| `ZOHO_TIMEOUT_SECONDS` | no | `60` | HTTP timeout for both Zoho calls |
| `ZOHO_FETCH_CRITERIA` | no | *(empty)* | Optional server-side row filter; unset reads every row |
| `ZOHO_MESSAGE_ID_COLUMN` | no | `msg_id` | Row identity. Wrong value ⇒ edits insert duplicate rows |
| `ZOHO_VERSION_STATUS_COLUMN` | no | `version_status` | Deletion signal. Wrong value ⇒ retracted rows keep scoring |
| `RECONCILE_MISSING_ROWS` | no | `true` | **Set `false` if the sheet is ever rotated/archived** — see §2.2 |
| `RECONCILE_MIN_RATIO` | no | `0.8` | Refuses to reconcile below this share; guards against a partial fetch |
| `RECONCILE_DRY_RUN` | no | `false` | Log what would be hidden without changing anything |

> **Zoho data centre.** The two `ZOHO_*_URL` values must both point at the DC the
> account was provisioned in — `.in` for India, `.com` for the US, `.eu`, `.com.au`.
> A DC mismatch does **not** return an auth error: the Sheet API returns **404**,
> which reads like a wrong `ZOHO_RESOURCE_ID`. Change both URLs together.

`.env` contains a database password. Keep it out of version control (it is in
`.gitignore` and `.dockerignore`) and restrict it to `chmod 600`.

---

## 4. Secret files to mount

These two files are **not** in the image — `.dockerignore` excludes them
specifically so no credential ends up in a layer. They must be mounted at runtime.

| File | Container path | Used by | Mode |
|---|---|---|---|
| `credentials1.json` | `/app/credentials1.json` | app | **read-only** |
| `token1.json` | `/app/token1.json` | app | **READ-WRITE** |

**The `etl` container mounts nothing.** Its Zoho credentials are three environment
variables and it never writes to disk, so it runs with `read_only: true`. Do not
add a token file back — that would reintroduce the writable-mount problem below.

> ### The read-write requirement is not optional (app only)
>
> `token1.json` is **rewritten in place** whenever the Google access token is
> within 60s of expiry. Mount it read-only and the app crashes *at refresh time* —
> up to an hour after start, so it survives a smoke test. Mount it on ephemeral
> storage and every restart forces a fresh refresh.
>
> The container runs as **uid 1000**. On a Linux host the mounted file must be
> writable by that uid:
>
> ```bash
> sudo chown 1000:1000 token1.json
> sudo chmod 600 token1.json
> ```
>
> The writer truncates in place rather than doing an atomic rename, so a
> single-file bind mount works correctly.

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

This starts the `app` service only. The ETL is intentionally absent — Zoho Flow
is the ingestion path.

### Without compose

```bash
docker build -t cgreen-dashboard-app:latest -f Dockerfile .
# Rollback only — never run alongside Zoho Flow:
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
  --read-only --tmpfs /tmp \
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
| ETL: `Zoho rejected the refresh token: invalid_client` | Wrong client id/secret, or they came from a different DC than `ZOHO_ACCOUNTS_URL` | Re-mint from the correct console (§8) |
| ETL: `Zoho returned 404 for resource ...` | Usually a **data centre mismatch**, not a bad id | Check `ZOHO_ACCOUNTS_URL` *and* `ZOHO_SHEET_API_URL` (§3) |
| ETL: `Zoho returned 401` | Client lacks the `ZohoSheet.dataAPI.READ` scope | Re-mint with the scope (§8) |
| ETL: `missing expected columns` then exits 1 | Sheet headers renamed | Run `python3 scripts/zoho_probe.py`, fix `COLUMN_MAP` |
| ETL: `N rows have an unparseable date_of_message_sent` | Zoho changed its date encoding | Rows load but stay invisible on the dashboard — run the probe and check `parse_datetime` |
| Photos missing, `/api/photo-health` shows `hasRefreshToken: false` | `token1.json` missing or not persisted | Re-mint `token1.json` (§8) and mount it read-write |

---

## 8. Token rotation

### `ZOHO_REFRESH_TOKEN` — Zoho Sheet (ETL)

Minted once from a **Self Client**, which needs no redirect URI and no local
server, then stored as an environment variable. It does not expire, so there is
nothing to rotate on a schedule and nothing to copy onto the host.

1. Go to **https://api-console.zoho.in** → *Add Client* → **Self Client**.
2. Scope `ZohoSheet.dataAPI.READ`, duration 10 minutes. Generate the code.
3. Exchange it for a refresh token (within those 10 minutes):

```bash
curl -X POST "https://accounts.zoho.in/oauth/v2/token" \
  -d "code=<the generated code>" \
  -d "client_id=<client id>" \
  -d "client_secret=<client secret>" \
  -d "grant_type=authorization_code"
```

4. Put `refresh_token` from the response into `.env` as `ZOHO_REFRESH_TOKEN`,
   alongside `ZOHO_CLIENT_ID` and `ZOHO_CLIENT_SECRET`.
5. Verify before deploying: `python3 scripts/zoho_probe.py` prints the sheet's
   headers and sample rows without touching the database.

Use the `.in` hosts above only if the account is in the India DC — see §3.

### `token1.json` — Google Admin Directory (employee photos)

**This one cannot be minted inside the container** — the flow requires an
interactive browser. Mint on a workstation, then copy the file to the host and
restart the container.

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
