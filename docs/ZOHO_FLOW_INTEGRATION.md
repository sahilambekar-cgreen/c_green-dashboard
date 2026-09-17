# Zoho Flow collection ingestion

## Architecture

```text
Zoho Cliq → existing extractor → Zoho Sheet / Collection_Data
                                      ↓ new or updated row
                                  Zoho Flow
                                      ↓ HTTPS POST + bearer secret
Express /api/integrations/zoho/collections → MySQL collections_messages
                                                       ↓
                                         existing dashboard API + React UI
```

The browser never reads Zoho Sheet. MySQL remains the application database and
the existing dashboard queries and RP calculation are unchanged.

## API contract

`POST /api/integrations/zoho/collections`

Send `Authorization: Bearer <ZOHO_FLOW_WEBHOOK_SECRET>` and
`Content-Type: application/json`. The body limit is `64kb` by default. This is
a server-to-server request, so CORS is not required for Zoho Flow.

The endpoint requires `msg_id`, `loan_id`, `collection_amt`,
`name_of_agent`, and `date_of_message_sent` for a live collection. Amount must
be a positive decimal with no more than two fraction digits. Use an ISO-8601
timestamp with an offset, such as `2026-09-17T10:37:30+05:30`; the server
stores the configured business-local (`TZ`, normally `Asia/Kolkata`) wall time.

`msg_id` is hashed with SHA-256 into the existing unique `collections_messages.uid`.
The same message sent again returns `200` and updates that row; it cannot create
a second collection. An edited Sheet row must keep the same `msg_id`.

For a retraction, send only `msg_id` and `version_status: "DELETED"`. The
endpoint marks the existing row deleted rather than removing it; dashboard
queries already exclude that lifecycle status. A `404` means Flow sent a
retraction for a collection not yet received and should be investigated.

## Sheet-to-API-to-MySQL mapping

| Collection_Data header | API JSON key | MySQL column |
|---|---|---|
| `client_name` | `client_name` | `client_name` |
| `bucket` | `bucket` | `bucket` |
| `loan_id` | `loan_id` | `loan_no` |
| `customer_name` | `customer_name` | `customer_name` |
| `collection_amt` | `collection_amt` | `amount_collected` |
| `utr_number` | `utr_number` | `utr_no` |
| `date_of_collection` | `date_of_collection` | `transaction_date` |
| `name_of_agent` | `name_of_agent` | `agent_name` |
| `group` | `group` | `collection_mode` |
| `waiver` | `waiver` | `waiver` |
| `emp_id` | `emp_id` | `emp_id` |
| `tl_name` | `tl_name` | `tl_name` |
| `sender_name_ai` | `sender_name_ai` | `sender_name` |
| `date_of_message_sent` | `date_of_message_sent` | `date_of_message_sent` |
| `message_sent` | `message_sent` | `message_sent` |
| `link_to_message` | `link_to_message` | `link_to_message_sent` |
| `ai_status` | `ai_status` | `status` |
| `version_status` | `version_status` | `version_status` |
| `msg_id` | `msg_id` | `msg_id`, SHA-256 → `uid` |

`email_id` is deliberately not accepted: the Sheet emits the Cliq bot account.
The endpoint derives the collector email from `emp_details` using `emp_id`,
which preserves the existing leaderboard behavior.

## Configure Zoho Flow

1. Create a Flow with **Zoho Sheet** as the trigger app.
2. Select workbook resource `fym3rf908df9958f14c4c8c3593ae476cd81d`, worksheet **Collection_Data** (confirm its displayed name in Zoho), and trigger **New or Updated Row**.
3. Add a Webhook/Custom HTTP Request action.
4. Use method `POST` and URL `https://YOUR-DASHBOARD-DOMAIN/api/integrations/zoho/collections`.
5. Add headers:

   ```text
   Authorization: Bearer YOUR_LONG_RANDOM_SECRET
   Content-Type: application/json
   ```

6. Map the trigger fields into this JSON body. Configure Flow's date formatter to
   produce an offset-bearing ISO timestamp for `date_of_message_sent`.

   ```json
   {
     "client_name": "{{client_name}}",
     "bucket": "{{bucket}}",
     "loan_id": "{{loan_id}}",
     "customer_name": "{{customer_name}}",
     "collection_amt": "{{collection_amt}}",
     "utr_number": "{{utr_number}}",
     "date_of_collection": "{{date_of_collection}}",
     "name_of_agent": "{{name_of_agent}}",
     "group": "{{group}}",
     "waiver": "{{waiver}}",
     "emp_id": "{{emp_id}}",
     "tl_name": "{{tl_name}}",
     "sender_name_ai": "{{sender_name_ai}}",
     "date_of_message_sent": "{{date_of_message_sent_iso}}",
     "message_sent": "{{message_sent}}",
     "link_to_message": "{{link_to_message}}",
     "ai_status": "{{ai_status}}",
     "version_status": "{{version_status}}",
     "msg_id": "{{msg_id}}"
   }
   ```

7. Treat `201`, `200`, and (for a previously processed deletion) `200` as
   success. Retry network errors and `503` with exponential backoff. Do not
   retry `400`, `401`, or `404` without correcting the configuration/data.
8. If the source automation can retract a message, it must update its Sheet row
   to `version_status = DELETED`, triggering the Flow. Physically deleting a
   Sheet row cannot be detected by a New/Updated trigger.

## Local test

Put a long random `ZOHO_FLOW_WEBHOOK_SECRET` in the local `.env`, restart the
API, then use placeholder/test values only:

```bash
curl -i -X POST http://127.0.0.1:3001/api/integrations/zoho/collections \
  -H "Authorization: Bearer YOUR_SECRET" \
  -H "Content-Type: application/json" \
  -d '{"client_name":"Test Client","loan_id":"TEST-6194","collection_amt":1003,"name_of_agent":"Test Agent","emp_id":"TEST001","date_of_message_sent":"2026-09-17T10:37:30+05:30","msg_id":"test-zoho-flow-001"}'
```

Expected results: first request `201 {"status":"created"...}`; repeat it
unchanged and expect `200 {"status":"updated"...}`. Test rejected input with
no bearer token (`401`), missing `msg_id` (`400`), an invalid amount (`400`),
and an invalid timestamp (`400`). Confirm `/api/dashboard` still responds after
the test. Do not use a real loan number in test payloads.

## Production cutover and rollback

0. **Apply the two additive migrations to the existing production schema** if
   they are not already present. The webhook's upsert writes both
   `version_status` and `msg_id`; without them every request fails with `503`.
   Both scripts check `information_schema` first, change nothing if the column
   exists, and never drop or recreate a table:

   ```bash
   mysql -h <host> -u <admin-user> -p <schema> < db/003_version_status.sql
   mysql -h <host> -u <admin-user> -p <schema> < db/004_msg_id.sql
   ```

1. Generate a high-entropy secret in the deployment secret manager and set
   `ZOHO_FLOW_WEBHOOK_SECRET` for the app. Do not commit it.
2. Build/deploy the app image: `docker compose up -d --build`.
3. Verify `/api/health`, then execute the authenticated curl test with a safe
   test record and verify the dashboard API.
4. Enable the Flow with the production HTTPS URL
   (`https://collections.dashboard.cgreen.in/api/integrations/zoho/collections`)
   and secret.
5. Confirm new Flow rows appear in app logs and the dashboard. Compose no longer
   starts the direct Zoho Sheet ETL, preventing two ingestion paths.
6. Remove unneeded `ZOHO_CLIENT_ID`, `ZOHO_CLIENT_SECRET`, and
   `ZOHO_REFRESH_TOKEN` from the deployed app secret set only after a stable
   observation period. Keep them separately for rollback.

No new table, proxy port change, or Dockerfile change is required — only
migrations 003/004 above, if the schema predates them. The reverse proxy keeps
routing to the app on port `3001`. The existing least-privilege database user
already has the required `INSERT` and `UPDATE` rights on `collections_messages`.

To roll back, disable the Flow and explicitly restore the `etl` service from a
known-good prior compose revision. Never run the ETL and Flow together in the
normal production path.
