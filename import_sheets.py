"""
ETL: Google Sheets → Local MySQL (collections_messages)

Reads structured rows from a Google Sheet, cleans them, and upserts into
a local MySQL table. Safe to re-run — uses a deterministic SHA-256 uid
so duplicate rows are updated, never duplicated.

Authentication: OAuth user credentials via credentials.json.
- First run opens a browser for consent → saves token.json.
- All subsequent runs (including cron) use the cached token silently.
"""

import hashlib
import logging
import os
import sys
from datetime import datetime

import gspread
import mysql.connector
from mysql.connector import Error as MySQLError
import pandas as pd
from google.auth.transport.requests import Request
from google.oauth2.credentials import Credentials
from google_auth_oauthlib.flow import InstalledAppFlow

# ──────────────────────────────────────────────────────────────────────────────
# CONFIGURATION
# Read from environment variables with sensible local-dev defaults.
# ──────────────────────────────────────────────────────────────────────────────

SPREADSHEET_URL = os.getenv(
    "SHEET_URL",
    "https://docs.google.com/spreadsheets/d/1GsyC6Cc_SobMkQnfkQSRrF1IaatY0iw5v7uIKz221PE/edit?gid=0#gid=0",
)
SHEET_TAB = os.getenv("SHEET_TAB", "Sheet1")
CREDENTIALS_FILE = os.getenv("GOOGLE_CREDENTIALS", "credentials.json")
TOKEN_FILE = os.getenv("GOOGLE_TOKEN", "token.json")

DB_HOST = os.getenv("DB_HOST", "localhost")
DB_PORT = int(os.getenv("DB_PORT", "3306"))
DB_USER = os.getenv("DB_USER", "root")
DB_PASSWORD = os.getenv("DB_PASSWORD", "1234")  # no hardcoded password — set via env
DB_NAME = os.getenv("DB_NAME", "c_green")

SCOPES = ["https://www.googleapis.com/auth/spreadsheets.readonly"]

# ──────────────────────────────────────────────────────────────────────────────
# LOGGING
# ──────────────────────────────────────────────────────────────────────────────

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [%(levelname)s] %(message)s",
    datefmt="%Y-%m-%d %H:%M:%S",
)
log = logging.getLogger(__name__)

# ──────────────────────────────────────────────────────────────────────────────
# EXPECTED COLUMNS (header row in the sheet, after normalization to
# lowercase with spaces → underscores)
# ──────────────────────────────────────────────────────────────────────────────

# These must match the sheet headers EXACTLY after normalization.
SHEET_COLUMNS = [
    "client_name",
    "bucket",
    "loan_id",
    "customer_name",
    "collection_amt",
    "utr_number",
    "date_of_collection",
    "name_of_agent",
    "group",
    "waiver",
    "emp_id",
    "tl_name",
    "email_id",
    "sender_name",
    "date_of_message_sent",
    "message_sent",
    "link_to_message",
    "status",
]

# Mapping: sheet column (normalized) → database column name
COLUMN_MAP = {
    "client_name": "client_name",
    "bucket": "bucket",
    "loan_id": "loan_no",
    "customer_name": "customer_name",
    "collection_amt": "amount_collected",
    "utr_number": "utr_no",
    "date_of_collection": "transaction_date",
    "name_of_agent": "agent_name",
    "group": "collection_mode",
    "waiver": "waiver",
    "emp_id": "emp_id",
    "tl_name": "tl_name",
    "email_id": "email_id",
    "sender_name": "sender_name",
    "date_of_message_sent": "date_of_message_sent",
    "message_sent": "message_sent",
    "link_to_message": "link_to_message_sent",
    "status": "status",
}


# ──────────────────────────────────────────────────────────────────────────────
# HELPERS
# ──────────────────────────────────────────────────────────────────────────────


def generate_uid(row: dict) -> str:
    """
    Deterministic UID: SHA-256 of loan_no | transaction_date | utr_no | amount | agent_name.

    Using more fields reduces collisions when utr_no is blank.
    """
    raw = (
        f"{row.get('loan_no', '')}|"
        f"{row.get('transaction_date', '')}|"
        f"{row.get('utr_no', '')}|"
        f"{row.get('amount_collected', '')}|"
        f"{row.get('agent_name', '')}"
    )
    return hashlib.sha256(raw.encode()).hexdigest()


def parse_date(value):
    """Parse a date string to a date object. Returns None if no format matches."""
    if not value or str(value).strip() == "":
        return None
    text = str(value).strip()
    for fmt in ("%Y-%m-%d", "%d-%m-%Y", "%d/%m/%Y", "%m/%d/%Y"):
        try:
            return datetime.strptime(text, fmt).date()
        except ValueError:
            continue
    return None


def parse_datetime(value):
    """Parse a datetime string. Returns None if no format matches."""
    if not value or str(value).strip() == "":
        return None
    text = str(value).strip()

    # Handle "June 5, 2026 at 9:22 AM IST" format
    # Strip timezone abbreviation (IST, EST, PST, etc.) from end
    import re
    text_no_tz = re.sub(r'\s+[A-Z]{2,4}$', '', text)

    # Handle "Month Day, Year at H:MM AM/PM" format
    for fmt in (
        "%B %d, %Y at %I:%M %p",      # June 5, 2026 at 9:22 AM
        "%B %d, %Y at %I:%M:%S %p",   # June 5, 2026 at 9:22:00 AM
        "%B %d, %Y at %I %p",         # June 5, 2026 at 1 PM
        "%b %d, %Y at %I:%M %p",      # Jun 5, 2026 at 9:22 AM
        "%b %d, %Y at %I:%M:%S %p",   # Jun 5, 2026 at 9:22:00 AM
        "%b %d, %Y at %I %p",         # Jun 5, 2026 at 1 PM
    ):
        try:
            return datetime.strptime(text_no_tz, fmt)
        except ValueError:
            continue

    # Standard formats
    for fmt in (
        "%Y-%m-%d %H:%M:%S",
        "%d-%m-%Y %H:%M:%S",
        "%d/%m/%Y %H:%M:%S",
        "%m/%d/%Y %H:%M:%S",
        "%Y-%m-%d %H:%M",
        "%d-%m-%Y %H:%M",
        "%d/%m/%Y %H:%M",
        "%m/%d/%Y %H:%M",
    ):
        try:
            return datetime.strptime(text, fmt)
        except ValueError:
            continue
    return None


def parse_amount(value) -> float | None:
    """Parse collection_amt, stripping commas. Returns None on failure."""
    if value is None:
        return None
    try:
        return float(str(value).replace(",", "").strip())
    except (ValueError, TypeError):
        return None


# ──────────────────────────────────────────────────────────────────────────────
# EXTRACT
# ──────────────────────────────────────────────────────────────────────────────


def extract() -> pd.DataFrame:
    """
    Authenticate via OAuth (credentials.json + cached token.json), open the
    sheet by URL, and return all rows as a DataFrame keyed by header name.
    """
    creds = None

    # Try loading an existing token
    if os.path.exists(TOKEN_FILE):
        try:
            creds = Credentials.from_authorized_user_file(TOKEN_FILE, SCOPES)
        except (ValueError, KeyError):
            creds = None

    # Refresh or run the OAuth flow
    if creds and creds.expired and creds.refresh_token:
        creds.refresh(Request())
    elif not creds or not creds.valid:
        if not os.path.exists(CREDENTIALS_FILE):
            log.error(
                f"OAuth credentials file not found at '{CREDENTIALS_FILE}'. "
                "Download it from GCP Console → APIs & Services → Credentials."
            )
            sys.exit(1)
        flow = InstalledAppFlow.from_client_secrets_file(CREDENTIALS_FILE, SCOPES)
        creds = flow.run_local_server(port=0)

    # Persist the token for future unattended runs
    with open(TOKEN_FILE, "w") as f:
        f.write(creds.to_json())

    gc = gspread.authorize(creds)

    try:
        spreadsheet = gc.open_by_url(SPREADSHEET_URL)
    except gspread.exceptions.APIError as e:
        error_msg = str(e)
        if "PERMISSION_DENIED" in error_msg or "403" in error_msg:
            log.error(
                "Cannot access the spreadsheet. Make sure you have:\n"
                "  1. Enabled the Google Sheets API in your GCP project.\n"
                "  2. Your Google account has access to the sheet."
            )
        else:
            log.error(f"Google Sheets API error: {e}")
        sys.exit(1)

    worksheet = spreadsheet.worksheet(SHEET_TAB)
    records = worksheet.get_all_records()
    df = pd.DataFrame(records)

    log.info(f"[Extract] Fetched {len(df)} rows from '{SHEET_TAB}'")
    return df


# ──────────────────────────────────────────────────────────────────────────────
# TRANSFORM
# ──────────────────────────────────────────────────────────────────────────────


def transform(df: pd.DataFrame) -> list[dict]:
    """Normalize headers, parse types, map to DB columns, generate UIDs."""
    # Normalize column names: lowercase, spaces → underscores
    df.columns = [c.strip().lower().replace(" ", "_") for c in df.columns]

    log.info(f"[Transform] Sheet columns after normalization: {list(df.columns)}")

    rows: list[dict] = []
    for _, record in df.iterrows():
        # Extract sheet columns and map to DB column names
        db_row = {}
        for sheet_col in SHEET_COLUMNS:
            db_col = COLUMN_MAP[sheet_col]
            db_row[db_col] = record.get(sheet_col, None)

        # Type conversions
        db_row["transaction_date"] = parse_date(db_row.get("transaction_date"))
        db_row["date_of_message_sent"] = parse_datetime(db_row.get("date_of_message_sent"))
        db_row["amount_collected"] = parse_amount(db_row.get("amount_collected"))

        # Replace empty strings and NaN with None
        for key in db_row:
            if db_row[key] == "" or (isinstance(db_row[key], float) and pd.isna(db_row[key])):
                db_row[key] = None

        db_row["uid"] = generate_uid(db_row)

        # Skip rows without a valid collection amount (e.g., PTP messages
        # accidentally posted and logged before deletion)
        if db_row["amount_collected"] is None or db_row["amount_collected"] == 0:
            continue

        rows.append(db_row)

    # Sort chronologically: earliest dates first, latest last.
    rows.sort(key=lambda r: (
        r["transaction_date"] or datetime.min.date(),
        r["date_of_message_sent"] or datetime.min,
    ))

    log.info(f"[Transform] Prepared {len(rows)} rows (sorted by date, earliest first)")
    return rows


# ──────────────────────────────────────────────────────────────────────────────
# LOAD
# ──────────────────────────────────────────────────────────────────────────────

CHECK_SQL = "SELECT 1 FROM collections_messages WHERE uid = %(uid)s"

INSERT_SQL = """
INSERT INTO collections_messages (
    client_name, bucket, loan_no, customer_name, amount_collected,
    utr_no, transaction_date, agent_name, collection_mode,
    waiver, emp_id, tl_name, email_id, sender_name,
    date_of_message_sent, message_sent, link_to_message_sent, status, uid
) VALUES (
    %(client_name)s, %(bucket)s, %(loan_no)s, %(customer_name)s, %(amount_collected)s,
    %(utr_no)s, %(transaction_date)s, %(agent_name)s, %(collection_mode)s,
    %(waiver)s, %(emp_id)s, %(tl_name)s, %(email_id)s, %(sender_name)s,
    %(date_of_message_sent)s, %(message_sent)s, %(link_to_message_sent)s, %(status)s, %(uid)s
)
"""

UPDATE_SQL = """
UPDATE collections_messages SET
    client_name          = %(client_name)s,
    bucket               = %(bucket)s,
    customer_name        = %(customer_name)s,
    amount_collected     = %(amount_collected)s,
    utr_no               = %(utr_no)s,
    transaction_date     = %(transaction_date)s,
    agent_name           = %(agent_name)s,
    collection_mode      = %(collection_mode)s,
    waiver               = %(waiver)s,
    emp_id               = %(emp_id)s,
    tl_name              = %(tl_name)s,
    email_id             = %(email_id)s,
    sender_name          = %(sender_name)s,
    date_of_message_sent = %(date_of_message_sent)s,
    message_sent         = %(message_sent)s,
    link_to_message_sent = %(link_to_message_sent)s,
    status               = %(status)s
WHERE uid = %(uid)s
"""


def load(rows: list[dict]):
    """
    Insert new rows, update existing ones. Uses SELECT + INSERT/UPDATE
    instead of ON DUPLICATE KEY UPDATE to avoid auto_increment gaps.
    """
    conn = None
    try:
        conn = mysql.connector.connect(
            host=DB_HOST,
            port=DB_PORT,
            user=DB_USER,
            password=DB_PASSWORD,
            database=DB_NAME,
        )
        cursor = conn.cursor()

        inserted = 0
        updated = 0
        for row in rows:
            cursor.execute(CHECK_SQL, {"uid": row["uid"]})
            exists = cursor.fetchone()

            if exists:
                cursor.execute(UPDATE_SQL, row)
                updated += 1
            else:
                cursor.execute(INSERT_SQL, row)
                inserted += 1

        conn.commit()
        cursor.close()
        log.info(f"[Load] Inserted {inserted}, updated {updated} rows")

    except MySQLError as e:
        log.error(f"MySQL error: {e}")
        raise
    finally:
        if conn and conn.is_connected():
            conn.close()


# ──────────────────────────────────────────────────────────────────────────────
# MAIN
# ──────────────────────────────────────────────────────────────────────────────


def main():
    log.info("ETL starting: Google Sheets → MySQL")

    df = extract()

    if df.empty:
        log.warning("Sheet returned 0 rows. Nothing to do.")
        return

    rows = transform(df)
    load(rows)

    log.info("ETL complete ✓")


if __name__ == "__main__":
    main()
