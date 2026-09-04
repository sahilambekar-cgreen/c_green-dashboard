-- ─────────────────────────────────────────────────────────────────────────────
-- Stitch Debt Recovery Pulse — add collections_messages.version_status
--
-- WHY
-- The Zoho Cliq source tracks a message's lifecycle: a collection can be edited
-- or retracted after it was first posted. The dashboard must stop counting a
-- retracted collection, but the row is kept for audit rather than deleted.
--
-- `status` cannot carry this. It already holds the source sheet's own Status
-- value (e.g. 'ACTIVE'), and overwriting it would destroy that value and
-- conflate two different facts about the row.
--
-- SAFETY
-- Additive and idempotent. One nullable column, no backfill, no data rewritten,
-- no downtime. Existing rows read NULL, which every query treats as live.
--
--     mysql -h <host> -u <admin> -p <schema> < db/003_version_status.sql
--
-- Run AFTER db/001_dashboard_tables.sql. Safe to re-run.
-- ─────────────────────────────────────────────────────────────────────────────

SET @column_exists = (
  SELECT COUNT(*)
  FROM information_schema.COLUMNS
  WHERE TABLE_SCHEMA = DATABASE()
    AND TABLE_NAME = 'collections_messages'
    AND COLUMN_NAME = 'version_status'
);

SET @ddl = IF(
  @column_exists = 0,
  'ALTER TABLE `collections_messages`
     ADD COLUMN `version_status` varchar(50)
       COLLATE utf8mb4_unicode_ci DEFAULT NULL
       COMMENT ''Zoho message lifecycle: ACTIVE / EDITED / DELETED. NULL = live (pre-migration rows).'',
     ADD KEY `idx_version_status` (`version_status`)',
  'SELECT ''version_status already present — nothing to do'' AS note'
);

PREPARE apply_ddl FROM @ddl;
EXECUTE apply_ddl;
DEALLOCATE PREPARE apply_ddl;


-- ── Verification ────────────────────────────────────────────────────────────
-- Expect one row: version_status / varchar(50) / YES / NULL
SELECT COLUMN_NAME, COLUMN_TYPE, IS_NULLABLE, COLUMN_DEFAULT
FROM information_schema.COLUMNS
WHERE TABLE_SCHEMA = DATABASE()
  AND TABLE_NAME = 'collections_messages'
  AND COLUMN_NAME = 'version_status';

-- Every dashboard query excludes retracted rows with:
--     (cm.version_status IS NULL OR cm.version_status <> 'DELETED')
-- so this returns the number of rows currently hidden from the dashboard.
SELECT COUNT(*) AS hidden_rows
FROM collections_messages
WHERE version_status = 'DELETED';
