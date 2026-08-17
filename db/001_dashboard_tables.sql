-- ─────────────────────────────────────────────────────────────────────────────
-- Stitch Debt Recovery Pulse — production schema additions
--
-- The dashboard needs FIVE tables, all in the SAME schema. Three of them
-- already exist in the production database and are read-only to this app:
--
--     dossier   lenders   bucket
--
-- This script adds the two that do not exist yet:
--
--     collections_messages   emp_details
--
-- Run against the existing production schema. Both statements are
-- CREATE TABLE IF NOT EXISTS, so this is safe to re-run.
--
--     mysql -h <host> -u <admin> -p <schema> < db/001_dashboard_tables.sql
-- ─────────────────────────────────────────────────────────────────────────────


-- ── 1. collections_messages ─────────────────────────────────────────────────
-- Written by import_sheets.py (the ETL sidecar), read by the dashboard API.
-- The UNIQUE KEY on `uid` is load-bearing: the ETL derives uid as a SHA-256 of
-- loan_no|transaction_date|utr_no|amount_collected|agent_name and uses it to
-- decide INSERT vs UPDATE. Without this index the table accumulates duplicates.

CREATE TABLE IF NOT EXISTS `collections_messages` (
  `id` bigint NOT NULL AUTO_INCREMENT,
  `client_name` varchar(255) COLLATE utf8mb4_unicode_ci DEFAULT NULL,
  `bucket` varchar(50) COLLATE utf8mb4_unicode_ci DEFAULT NULL,
  `loan_no` varchar(50) COLLATE utf8mb4_unicode_ci DEFAULT NULL,
  `customer_name` varchar(255) COLLATE utf8mb4_unicode_ci DEFAULT NULL,
  `amount_collected` decimal(15,2) DEFAULT NULL,
  `utr_no` varchar(100) COLLATE utf8mb4_unicode_ci DEFAULT NULL,
  `transaction_date` date DEFAULT NULL,
  `agent_name` varchar(255) COLLATE utf8mb4_unicode_ci DEFAULT NULL,
  `collection_mode` varchar(100) COLLATE utf8mb4_unicode_ci DEFAULT NULL,
  `waiver` varchar(100) COLLATE utf8mb4_unicode_ci DEFAULT NULL,
  `emp_id` varchar(50) COLLATE utf8mb4_unicode_ci DEFAULT NULL,
  `tl_name` varchar(255) COLLATE utf8mb4_unicode_ci DEFAULT NULL,
  `email_id` varchar(255) COLLATE utf8mb4_unicode_ci DEFAULT NULL,
  `sender_name` varchar(255) COLLATE utf8mb4_unicode_ci DEFAULT NULL,
  `date_of_message_sent` datetime DEFAULT NULL,
  `message_sent` text COLLATE utf8mb4_unicode_ci,
  `link_to_message_sent` text COLLATE utf8mb4_unicode_ci,
  `status` varchar(50) COLLATE utf8mb4_unicode_ci DEFAULT NULL,
  `uid` char(64) COLLATE utf8mb4_unicode_ci NOT NULL,
  `created_at` timestamp NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  UNIQUE KEY `idx_uid` (`uid`),
  -- Not in the source schema, but the dashboard filters and sorts on this
  -- column on every request and every SSE tick. Cheap insurance.
  KEY `idx_date_of_message_sent` (`date_of_message_sent`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;


-- ── 2. emp_details ──────────────────────────────────────────────────────────
-- Read-only to the dashboard. Resolves collections_messages.email_id →
-- caller_name / caller_empcode, joined on LOWER(TRIM(caller_emailid)).
-- Populate it from your existing HR/agent roster.

CREATE TABLE IF NOT EXISTS `emp_details` (
  `id` bigint NOT NULL AUTO_INCREMENT,
  `caller_empcode` varchar(50) COLLATE utf8mb4_unicode_ci DEFAULT NULL,
  `caller_name` varchar(255) COLLATE utf8mb4_unicode_ci DEFAULT NULL,
  `caller_emailid` varchar(255) COLLATE utf8mb4_unicode_ci DEFAULT NULL,
  `tl_empcode` varchar(50) COLLATE utf8mb4_unicode_ci DEFAULT NULL,
  `tl_name` varchar(255) COLLATE utf8mb4_unicode_ci DEFAULT NULL,
  `tl_emailid` varchar(255) COLLATE utf8mb4_unicode_ci DEFAULT NULL,
  `am_empcode` varchar(50) COLLATE utf8mb4_unicode_ci DEFAULT NULL,
  `am_name` varchar(255) COLLATE utf8mb4_unicode_ci DEFAULT NULL,
  `am_emailid` varchar(255) COLLATE utf8mb4_unicode_ci DEFAULT NULL,
  `dossier_code` varchar(255) COLLATE utf8mb4_unicode_ci DEFAULT NULL,
  `created_date` date DEFAULT NULL,
  `active` tinyint DEFAULT NULL,
  `created_at` timestamp NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  KEY `idx_caller_emailid` (`caller_emailid`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;


-- ── 3. Pre-flight check ─────────────────────────────────────────────────────
-- Run this against the target schema. It must return exactly 5 rows. If it
-- returns fewer, the dashboard will start and then fail every query — every
-- SQL statement in server.ts uses unqualified table names, so all five must
-- resolve inside DB_NAME.

-- SELECT table_name FROM information_schema.tables
--  WHERE table_schema = DATABASE()
--    AND table_name IN ('collections_messages','emp_details','dossier','lenders','bucket');


-- ── 4. Least-privilege application user ─────────────────────────────────────
-- Replace <schema>, <password>, and the host pattern to match your network.
-- The app only ever writes to collections_messages; everything else is SELECT.

-- CREATE USER IF NOT EXISTS 'cgreen_dashboard'@'%' IDENTIFIED BY '<password>';
--
-- GRANT SELECT, INSERT, UPDATE ON `<schema>`.`collections_messages` TO 'cgreen_dashboard'@'%';
-- GRANT SELECT                  ON `<schema>`.`emp_details`          TO 'cgreen_dashboard'@'%';
-- GRANT SELECT                  ON `<schema>`.`dossier`              TO 'cgreen_dashboard'@'%';
-- GRANT SELECT                  ON `<schema>`.`lenders`              TO 'cgreen_dashboard'@'%';
-- GRANT SELECT                  ON `<schema>`.`bucket`               TO 'cgreen_dashboard'@'%';
--
-- FLUSH PRIVILEGES;
