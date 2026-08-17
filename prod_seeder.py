"""Install the complete dashboard dataset into a local MySQL database.

This is an offline destination-only installer. It never connects to production.
All five dashboard table schemas are created; the bundled compressed snapshot
populates ``bucket``, ``dossier``, ``emp_details``, and ``lenders`` while
``collections_messages`` is deliberately left empty for ``import_sheets.py``.

Destination environment variables (all optional):
    LOCAL_DB_HOST (default: 127.0.0.1)
    LOCAL_DB_PORT (default: 3306)
    LOCAL_DB_USER (default: root)
    LOCAL_DB_PASSWORD (default: 1234)
    LOCAL_DB_NAME (default: c_green)
    LOCAL_DB_SOCKET_PATH (default on macOS: /private/tmp/mysql.sock)
    DB_SEED_FILE (default: db/local_reference_seed.jsonl.gz)

Run:
    python3 prod_seeder.py

Use ``--replace`` to deliberately rebuild existing dashboard tables.
"""

from __future__ import annotations

import argparse
import gzip
import hashlib
import json
import logging
import os
import sys
from dataclasses import dataclass
from pathlib import Path
from typing import Any

import mysql.connector
from mysql.connector import Error as MySQLError


logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [%(levelname)s] %(message)s",
    datefmt="%Y-%m-%d %H:%M:%S",
)
log = logging.getLogger(__name__)

BASE_DIR = Path(__file__).resolve().parent
DEFAULT_SEED_FILE = BASE_DIR / "db" / "local_reference_seed.jsonl.gz"
DEFAULT_BATCH_SIZE = 1_000
SEED_FORMAT = "cgreen-reference-seed-v1"
EXPECTED_SEED_SIZE = 15_569_162
EXPECTED_SEED_SHA256 = (
    "9577b30c1f5eec2a8740e7ca99b3c20ddf17130362e8c87f0938bc8bcda01896"
)
MAX_JSON_LINE_BYTES = 1_048_576
LOCAL_HOSTS = {"127.0.0.1", "::1", "localhost"}

DASHBOARD_TABLES = (
    "bucket",
    "collections_messages",
    "dossier",
    "emp_details",
    "lenders",
)
DATA_TABLES = ("bucket", "dossier", "emp_details", "lenders")

SEED_COLUMNS: dict[str, tuple[str, ...]] = {
    "bucket": ("id", "name", "weights"),
    "dossier": (
        "id",
        "dossier_code",
        "lender_id",
        "dpd_bucket_id",
        "due_date",
        "loan_account_number",
        "dpd_bucket",
        "dpd_days",
    ),
    "emp_details": (
        "id",
        "caller_empcode",
        "caller_name",
        "caller_emailid",
        "tl_empcode",
        "tl_name",
        "tl_emailid",
        "am_empcode",
        "am_name",
        "am_emailid",
        "dossier_code",
        "created_date",
        "active",
        "created_at",
    ),
    "lenders": ("id", "lender_code", "name", "brand_name"),
}

EXPECTED_ROW_COUNTS = {
    "bucket": 9,
    "dossier": 1_813_465,
    "emp_details": 162,
    "lenders": 26,
}

TABLE_DDL = {
    "bucket": """
        CREATE TABLE `bucket` (
          `id` bigint unsigned NOT NULL AUTO_INCREMENT,
          `name` varchar(255) COLLATE utf8mb4_unicode_ci NOT NULL,
          `weights` decimal(18,6) DEFAULT NULL,
          PRIMARY KEY (`id`),
          KEY `idx_bucket_name` (`name`)
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
    """,
    "collections_messages": """
        CREATE TABLE `collections_messages` (
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
          KEY `idx_date_of_message_sent` (`date_of_message_sent`)
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
    """,
    "dossier": """
        CREATE TABLE `dossier` (
          `id` bigint unsigned NOT NULL,
          `dossier_code` varchar(255) COLLATE utf8mb4_unicode_ci DEFAULT NULL,
          `lender_id` bigint unsigned NOT NULL,
          `dpd_bucket_id` bigint unsigned NOT NULL,
          `due_date` date DEFAULT NULL,
          `loan_account_number` varchar(50) COLLATE utf8mb4_0900_ai_ci DEFAULT NULL,
          `dpd_bucket` text COLLATE utf8mb4_unicode_ci,
          `dpd_days` text COLLATE utf8mb4_unicode_ci,
          PRIMARY KEY (`id`),
          KEY `idx_dossier_loan_lookup` (`loan_account_number`,`due_date`,`id`),
          KEY `idx_dossier_lender_id` (`lender_id`),
          KEY `idx_dossier_dpd_bucket_id` (`dpd_bucket_id`)
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci
    """,
    "emp_details": """
        CREATE TABLE `emp_details` (
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
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
    """,
    "lenders": """
        CREATE TABLE `lenders` (
          `id` bigint unsigned NOT NULL,
          `lender_code` varchar(255) COLLATE utf8mb4_unicode_ci NOT NULL,
          `name` varchar(255) COLLATE utf8mb4_unicode_ci NOT NULL,
          `brand_name` varchar(255) COLLATE utf8mb4_unicode_ci DEFAULT NULL,
          PRIMARY KEY (`id`),
          UNIQUE KEY `idx_lender_code` (`lender_code`)
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
    """,
}


@dataclass(frozen=True)
class DatabaseConfig:
    host: str
    port: int
    user: str
    password: str
    database: str
    unix_socket: str | None = None

    def connection_args(self, include_database: bool = True) -> dict[str, Any]:
        args: dict[str, Any] = {
            "user": self.user,
            "password": self.password,
            "connection_timeout": 15,
            "autocommit": False,
        }
        if self.unix_socket:
            args["unix_socket"] = self.unix_socket
        else:
            args["host"] = self.host
            args["port"] = self.port
        if include_database:
            args["database"] = self.database
        return args


def parse_port(name: str, default: int) -> int:
    raw = os.getenv(name, str(default))
    try:
        port = int(raw)
    except ValueError as exc:
        raise ValueError(f"{name} must be a number, got {raw!r}") from exc
    if not 1 <= port <= 65_535:
        raise ValueError(f"{name} must be between 1 and 65535")
    return port


def load_config() -> DatabaseConfig:
    configured_socket = os.getenv("LOCAL_DB_SOCKET_PATH")
    local_socket = (
        configured_socket.strip() or None
        if configured_socket is not None
        else "/private/tmp/mysql.sock"
        if sys.platform == "darwin"
        else None
    )
    return DatabaseConfig(
        host=os.getenv("LOCAL_DB_HOST", "127.0.0.1").strip() or "127.0.0.1",
        port=parse_port("LOCAL_DB_PORT", 3306),
        user=os.getenv("LOCAL_DB_USER", "root").strip() or "root",
        password=os.getenv("LOCAL_DB_PASSWORD", "1234"),
        database=os.getenv("LOCAL_DB_NAME", "c_green").strip() or "c_green",
        unix_socket=local_socket,
    )


def quote_identifier(identifier: str) -> str:
    return f"`{identifier.replace('`', '``')}`"


def is_local_target(config: DatabaseConfig) -> bool:
    return bool(config.unix_socket) or config.host.lower() in LOCAL_HOSTS


def list_dashboard_objects(connection: Any, schema: str) -> list[tuple[str, str]]:
    cursor = connection.cursor()
    try:
        placeholders = ", ".join(["%s"] * len(DASHBOARD_TABLES))
        cursor.execute(
            f"""
            SELECT TABLE_NAME, TABLE_TYPE
            FROM information_schema.TABLES
            WHERE TABLE_SCHEMA = %s AND TABLE_NAME IN ({placeholders})
            ORDER BY CASE WHEN TABLE_TYPE = 'VIEW' THEN 0 ELSE 1 END, TABLE_NAME
            """,
            (schema, *DASHBOARD_TABLES),
        )
        return [(row[0], row[1]) for row in cursor.fetchall()]
    finally:
        cursor.close()


def prepare_target(connection: Any, schema: str, replace: bool) -> None:
    cursor = connection.cursor()
    try:
        quoted_schema = quote_identifier(schema)
        cursor.execute(
            f"CREATE DATABASE IF NOT EXISTS {quoted_schema} "
            "CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_ai_ci"
        )
        cursor.execute(f"USE {quoted_schema}")
        objects = list_dashboard_objects(connection, schema)
        if objects and not replace:
            raise RuntimeError(
                f"Target schema {schema!r} already contains {len(objects)} dashboard object(s). "
                "Nothing was changed; rerun with --replace to rebuild them."
            )
        if replace:
            cursor.execute("SET FOREIGN_KEY_CHECKS = 0")
            for name, object_type in objects:
                keyword = "VIEW" if object_type == "VIEW" else "TABLE"
                cursor.execute(f"DROP {keyword} IF EXISTS {quote_identifier(name)}")
            cursor.execute("SET FOREIGN_KEY_CHECKS = 1")
        connection.commit()
    except Exception:
        connection.rollback()
        raise
    finally:
        cursor.close()


def create_tables(connection: Any) -> None:
    cursor = connection.cursor()
    try:
        for table in DASHBOARD_TABLES:
            cursor.execute(TABLE_DDL[table])
            log.info("[Schema] Created %s", table)
        connection.commit()
    except Exception:
        connection.rollback()
        raise
    finally:
        cursor.close()


def read_json_line(seed_file: Any, context: str) -> Any:
    line = seed_file.readline()
    if not line:
        raise RuntimeError(f"Seed snapshot ended while reading {context}")
    if len(line.encode("utf-8")) > MAX_JSON_LINE_BYTES:
        raise RuntimeError(f"Seed snapshot line is too large while reading {context}")
    try:
        return json.loads(line)
    except json.JSONDecodeError as exc:
        raise RuntimeError(f"Invalid JSON while reading {context}: {exc}") from exc


def validate_snapshot(seed_path: Path) -> None:
    if not seed_path.is_file():
        raise RuntimeError(
            f"Offline seed snapshot not found: {seed_path}. "
            "Copy local_reference_seed.jsonl.gz into the db directory."
        )
    if seed_path.stat().st_size != EXPECTED_SEED_SIZE:
        raise RuntimeError("Offline seed snapshot size does not match this installer")

    digest = hashlib.sha256()
    with seed_path.open("rb") as compressed_file:
        while chunk := compressed_file.read(1024 * 1024):
            digest.update(chunk)
    if digest.hexdigest() != EXPECTED_SEED_SHA256:
        raise RuntimeError(
            "Offline seed snapshot checksum does not match this installer"
        )

    with gzip.open(seed_path, "rt", encoding="utf-8", newline="") as seed_file:
        manifest = read_json_line(seed_file, "manifest")
        if not isinstance(manifest, dict):
            raise RuntimeError("Seed manifest must be a JSON object")
        expected_manifest = {
            "format": SEED_FORMAT,
            "row_counts": EXPECTED_ROW_COUNTS,
        }
        if manifest != expected_manifest:
            raise RuntimeError("Seed manifest does not match this installer")

        for table in DATA_TABLES:
            section = read_json_line(seed_file, f"{table} section header")
            expected_header = {
                "table": table,
                "columns": list(SEED_COLUMNS[table]),
                "row_count": EXPECTED_ROW_COUNTS[table],
            }
            if section != expected_header:
                raise RuntimeError(
                    f"Unexpected or incompatible seed section for {table}"
                )
            for row_number in range(1, EXPECTED_ROW_COUNTS[table] + 1):
                row = read_json_line(seed_file, f"{table} row {row_number}")
                if not isinstance(row, list) or len(row) != len(SEED_COLUMNS[table]):
                    raise RuntimeError(
                        f"Invalid column count in {table} row {row_number}"
                    )
        if seed_file.readline():
            raise RuntimeError("Seed snapshot contains unexpected trailing data")
    log.info("Offline snapshot integrity and structure verified")


def insert_batch(connection: Any, table: str, rows: list[list[Any]]) -> None:
    columns = SEED_COLUMNS[table]
    quoted_columns = ", ".join(quote_identifier(column) for column in columns)
    placeholders = ", ".join(["%s"] * len(columns))
    sql = (
        f"INSERT INTO {quote_identifier(table)} ({quoted_columns}) "
        f"VALUES ({placeholders})"
    )
    cursor = connection.cursor()
    try:
        cursor.executemany(sql, rows)
    finally:
        cursor.close()


def load_snapshot(connection: Any, seed_path: Path, batch_size: int) -> int:
    copied_rows = 0
    with gzip.open(seed_path, "rt", encoding="utf-8", newline="") as seed_file:
        manifest = read_json_line(seed_file, "manifest")
        if manifest.get("format") != SEED_FORMAT:
            raise RuntimeError(
                f"Unsupported seed format {manifest.get('format')!r}; expected {SEED_FORMAT!r}"
            )
        if manifest.get("row_counts") != EXPECTED_ROW_COUNTS:
            raise RuntimeError("Seed manifest row counts do not match this installer")

        for table in DATA_TABLES:
            section = read_json_line(seed_file, f"{table} section header")
            expected_header = {
                "table": table,
                "columns": list(SEED_COLUMNS[table]),
                "row_count": EXPECTED_ROW_COUNTS[table],
            }
            if section != expected_header:
                raise RuntimeError(
                    f"Unexpected or incompatible seed section for {table}"
                )

            batch: list[list[Any]] = []
            for row_number in range(1, EXPECTED_ROW_COUNTS[table] + 1):
                row = read_json_line(seed_file, f"{table} row {row_number}")
                if not isinstance(row, list) or len(row) != len(SEED_COLUMNS[table]):
                    raise RuntimeError(
                        f"Invalid column count in {table} row {row_number}"
                    )
                batch.append(row)
                if len(batch) >= batch_size:
                    insert_batch(connection, table, batch)
                    connection.commit()
                    copied_rows += len(batch)
                    batch.clear()
                    if row_number % 100_000 == 0:
                        log.info(
                            "[Data] %s: inserted %s/%s rows",
                            table,
                            row_number,
                            EXPECTED_ROW_COUNTS[table],
                        )
            if batch:
                insert_batch(connection, table, batch)
                connection.commit()
                copied_rows += len(batch)
            log.info("[Data] %s: inserted %s rows", table, EXPECTED_ROW_COUNTS[table])

        if seed_file.readline():
            raise RuntimeError("Seed snapshot contains unexpected trailing data")
    return copied_rows


def count_rows(connection: Any, table: str) -> int:
    cursor = connection.cursor()
    try:
        cursor.execute(f"SELECT COUNT(*) FROM {quote_identifier(table)}")
        return int(cursor.fetchone()[0])
    finally:
        cursor.close()


def verify_seed(connection: Any) -> None:
    mismatches = []
    for table, expected_count in EXPECTED_ROW_COUNTS.items():
        actual_count = count_rows(connection, table)
        if actual_count != expected_count:
            mismatches.append(
                f"{table}: expected={expected_count}, actual={actual_count}"
            )
    collections_count = count_rows(connection, "collections_messages")
    if collections_count != 0:
        mismatches.append(
            f"collections_messages: expected empty, actual={collections_count}"
        )

    cursor = connection.cursor()
    try:
        cursor.execute(
            """
            SELECT COUNT(*)
            FROM dossier d
            LEFT JOIN lenders l ON l.id = d.lender_id
            WHERE l.id IS NULL
            """
        )
        missing_lenders = int(cursor.fetchone()[0])
        if missing_lenders:
            mismatches.append(f"dossier rows with missing lenders: {missing_lenders}")

        cursor.execute(
            """
            SELECT COUNT(*)
            FROM dossier d
            LEFT JOIN bucket b ON b.id = d.dpd_bucket_id
            WHERE b.id IS NULL
            """
        )
        missing_buckets = int(cursor.fetchone()[0])
        if missing_buckets:
            mismatches.append(f"dossier rows with missing buckets: {missing_buckets}")
    finally:
        cursor.close()

    if mismatches:
        raise RuntimeError("Seed verification failed: " + "; ".join(mismatches))

    cursor = connection.cursor()
    try:
        for table in DASHBOARD_TABLES:
            cursor.execute(f"CHECK TABLE {quote_identifier(table)}")
            result = cursor.fetchone()
            if not result or str(result[3]).lower() != "ok":
                raise RuntimeError(f"CHECK TABLE failed for {table}: {result}")
    finally:
        cursor.close()


def install_database(
    config: DatabaseConfig,
    seed_path: Path,
    replace: bool,
    batch_size: int,
) -> int:
    connection = mysql.connector.connect(
        **config.connection_args(include_database=False)
    )
    try:
        cursor = connection.cursor()
        try:
            cursor.execute("SET SESSION time_zone = '+00:00'")
            cursor.execute("SELECT VERSION()")
            version = str(cursor.fetchone()[0])
            try:
                major_version = int(version.split(".", 1)[0])
            except ValueError as exc:
                raise RuntimeError(
                    f"Could not parse destination MySQL version: {version}"
                ) from exc
            if major_version < 8:
                raise RuntimeError(
                    f"MySQL 8 or newer is required; destination reports {version}"
                )
        finally:
            cursor.close()
        prepare_target(connection, config.database, replace)
        create_tables(connection)
        copied_rows = load_snapshot(connection, seed_path, batch_size)
        verify_seed(connection)
        return copied_rows
    except Exception:
        connection.rollback()
        raise
    finally:
        connection.close()


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description=(
            "Install the offline dashboard database: four populated reference tables "
            "and an empty collections_messages table."
        )
    )
    parser.add_argument(
        "--replace",
        action="store_true",
        help="drop and rebuild dashboard tables already present in the local schema",
    )
    parser.add_argument(
        "--batch-size",
        type=int,
        default=DEFAULT_BATCH_SIZE,
        help=f"rows inserted per transaction (default: {DEFAULT_BATCH_SIZE})",
    )
    parser.add_argument(
        "--seed-file",
        type=Path,
        default=Path(os.getenv("DB_SEED_FILE", DEFAULT_SEED_FILE)),
        help=f"compressed offline snapshot (default: {DEFAULT_SEED_FILE})",
    )
    args = parser.parse_args()
    if args.batch_size < 1:
        parser.error("--batch-size must be at least 1")
    return args


def main() -> int:
    args = parse_args()
    try:
        config = load_config()
        if not is_local_target(config):
            raise ValueError(
                f"Refusing non-local destination {config.host}:{config.port}. "
                "This installer can only write to local MySQL."
            )
        seed_path = args.seed_file.resolve()
        validate_snapshot(seed_path)
        location = config.unix_socket or f"{config.host}:{config.port}"
        log.info(
            "Installing offline seed -> %s/%s (no production connection)",
            location,
            config.database,
        )
        copied_rows = install_database(
            config,
            seed_path,
            replace=args.replace,
            batch_size=args.batch_size,
        )
        log.info(
            "Seed complete: %s reference rows loaded; collections_messages is empty",
            copied_rows,
        )
        return 0
    except (OSError, ValueError, RuntimeError, MySQLError) as exc:
        log.error("Seed failed: %s", exc)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
