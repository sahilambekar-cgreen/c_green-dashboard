-- ─────────────────────────────────────────────────────────────────────────────
-- Stitch Debt Recovery Pulse — add collections_messages.msg_id
--
-- WHY
-- Two reasons, one of them load-bearing.
--
-- 1. Traceability. `uid` is SHA-256(msg_id), which is one-way: given a row you
--    cannot get back to the Zoho Cliq message it came from. Storing the id makes
--    a row auditable against the source.
--
-- 2. Ownership — this is the important one. Rows imported from the old Google
--    sheet have a CONTENT-derived uid, so their uid can never appear in the set
--    Zoho reports. That makes every one of them a permanent candidate for the
--    ETL's reconciliation pass, which hides rows the sheet no longer lists.
--
--    Today the ratio guard blocks that (a handful of sheet rows against 4,487 in
--    the database is far below the threshold). But the guard compares the sheet
--    against the WHOLE table, so it stops protecting them once Zoho has enough
--    rows of its own:
--
--        skip while  N < 0.8 * (4487 + N)   =>   N < ~17,948
--
--    Past that point a single run would flag all 4,487 historical rows DELETED
--    and empty the dashboard's history. Scoping reconciliation to rows that have
--    a msg_id removes the failure mode entirely rather than tuning around it.
--
-- Google-era rows keep msg_id NULL, exactly as intended: the ETL only ever
-- considers rows it imported itself.
--
-- SAFETY
-- Additive and idempotent. One nullable column plus an index, no backfill, no
-- data rewritten, no downtime.
--
--     mysql -h <host> -u <admin> -p <schema> < db/004_msg_id.sql
--
-- Run AFTER db/003_version_status.sql. Safe to re-run.
-- ─────────────────────────────────────────────────────────────────────────────

SET @column_exists = (
  SELECT COUNT(*)
  FROM information_schema.COLUMNS
  WHERE TABLE_SCHEMA = DATABASE()
    AND TABLE_NAME = 'collections_messages'
    AND COLUMN_NAME = 'msg_id'
);

SET @ddl = IF(
  @column_exists = 0,
  'ALTER TABLE `collections_messages`
     ADD COLUMN `msg_id` varchar(100)
       COLLATE utf8mb4_unicode_ci DEFAULT NULL
       COMMENT ''Zoho Cliq message id. NULL means imported from the old Google sheet - the ETL only reconciles rows where this is set.'',
     ADD KEY `idx_msg_id` (`msg_id`)',
  'SELECT ''msg_id already present — nothing to do'' AS note'
);

PREPARE apply_ddl FROM @ddl;
EXECUTE apply_ddl;
DEALLOCATE PREPARE apply_ddl;


-- ── Verification ────────────────────────────────────────────────────────────
-- Expect one row: msg_id / varchar(100) / YES / NULL
SELECT COLUMN_NAME, COLUMN_TYPE, IS_NULLABLE, COLUMN_DEFAULT
FROM information_schema.COLUMNS
WHERE TABLE_SCHEMA = DATABASE()
  AND TABLE_NAME = 'collections_messages'
  AND COLUMN_NAME = 'msg_id';

-- Row ownership. `google_legacy` should equal the row count from before the Zoho
-- cutover and must never change again; only `zoho_owned` is reconciled.
SELECT
  SUM(msg_id IS NULL)     AS google_legacy,
  SUM(msg_id IS NOT NULL) AS zoho_owned,
  COUNT(*)                AS total
FROM collections_messages;
