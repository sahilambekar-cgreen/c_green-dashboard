"""
Read-only diagnostic: print what the Zoho sheet actually contains.

The Collection_Data tab renamed the headers the ETL used to expect, and Zoho
encodes date cells as numbers rather than strings. Both are invisible failures —
a wrong header map imports zero rows, and an unparsed date loads a row that the
dashboard then filters out of every KPI. Run this before trusting COLUMN_MAP.

    python3 scripts/zoho_probe.py

Reuses import_sheets.get_access_token / fetch_records so there is exactly one
copy of the Zoho auth and pagination logic. Writes nothing, touches no database.
"""

import json
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

import import_sheets as etl  # noqa: E402

SAMPLE_ROWS = 2


def describe_value(column: str, value) -> str:
    """
    Say how the ETL would actually read this cell.

    Interpretation depends on the destination column, not just the cell: only
    date columns get the epoch/serial treatment, and only identifier columns get
    the float-tail fix. Describing every number as a date made `collection_amt:
    1003` read as "1902-09-29", which is noise.
    """
    text = str(value).strip()
    if not text:
        return "empty"

    db_column = etl.COLUMN_MAP.get(column)
    numeric = bool(etl.NUMERIC_RE.match(text))

    if db_column == "date_of_message_sent":
        parsed = etl.parse_datetime(value)
        return f"{'numeric' if numeric else 'text'} -> datetime {parsed}"
    if db_column == "transaction_date":
        return f"{'numeric' if numeric else 'text'} -> date {etl.parse_date(value)}"
    if db_column == "amount_collected":
        return f"{'numeric' if numeric else 'text'} -> amount {etl.parse_amount(value)}"
    if db_column in etl.IDENTIFIER_COLUMNS:
        cleaned = etl.parse_identifier(value)
        flag = "  <- float tail stripped" if numeric and text != cleaned else ""
        return f"{'numeric' if numeric else 'text'} -> {cleaned!r}{flag}"

    return f"numeric ({text})" if numeric else f"text ({len(text)} chars)"


def main():
    print(f"Resource : {etl.ZOHO_RESOURCE_ID}")
    print(f"Tab      : {etl.SHEET_TAB}")
    print(f"Accounts : {etl.ZOHO_ACCOUNTS_URL}")
    print(f"Sheet API: {etl.ZOHO_SHEET_API_URL}")
    print()

    records = etl.fetch_records(etl.get_access_token())
    if not records:
        print("No records returned. Check SHEET_TAB and ZOHO_FETCH_CRITERIA.")
        return

    print(f"Fetched {len(records)} rows.\n")

    raw_headers = list(records[0].keys())
    print("── HEADERS ──────────────────────────────────────────────")
    print(f"{'raw':<34}  normalized")
    for header in raw_headers:
        print(f"{header:<34}  {etl.normalize_header(header)}")

    print("\n── COLUMN_MAP CHECK ─────────────────────────────────────")
    normalized = {etl.normalize_header(h) for h in raw_headers}
    missing = [c for c in etl.SHEET_COLUMNS if c not in normalized]
    unused = sorted(normalized - set(etl.SHEET_COLUMNS))

    if missing:
        print(f"MISSING (COLUMN_MAP expects these, sheet lacks them):\n  {missing}")
    else:
        print("All expected columns present — COLUMN_MAP needs no changes.")
    if unused:
        print(f"\nUnmapped sheet columns (candidates for the missing ones):\n  {unused}")

    print("\n── MESSAGE LIFECYCLE ────────────────────────────────────")
    by_normalized = {etl.normalize_header(h): h for h in raw_headers}

    id_header = by_normalized.get(etl.MESSAGE_ID_COLUMN)
    if not id_header:
        print(f"'{etl.MESSAGE_ID_COLUMN}' NOT FOUND — edits and deletions cannot be applied.")
    else:
        ids = [str(r.get(id_header, "")).strip() for r in records]
        present = [i for i in ids if i]
        unique = len(set(present))
        print(f"{etl.MESSAGE_ID_COLUMN}: {len(present)}/{len(ids)} populated, {unique} distinct")
        if unique != len(present):
            # Duplicates mean two rows would collide on one uid and overwrite
            # each other — the identity key would be wrong.
            print(f"  WARNING: {len(present) - unique} duplicate ids — uid would not be unique per row")
        if present:
            print(f"  example: {present[0]}")

    status_header = by_normalized.get(etl.VERSION_STATUS_COLUMN)
    if not status_header:
        print(f"'{etl.VERSION_STATUS_COLUMN}' NOT FOUND — deletions cannot be detected.")
    else:
        counts = {}
        for record in records:
            value = str(record.get(status_header, "")).strip() or "(empty)"
            counts[value] = counts.get(value, 0) + 1
        print(f"{etl.VERSION_STATUS_COLUMN} distinct values:")
        for value, count in sorted(counts.items(), key=lambda kv: -kv[1]):
            hidden = " -> HIDDEN from dashboard" if etl.is_deleted(value) else ""
            print(f"  {value:<24} {count:>6}{hidden}")

    print("\n── SAMPLE ROWS ──────────────────────────────────────────")
    for index, record in enumerate(records[:SAMPLE_ROWS], start=1):
        print(f"\nRow {index}:")
        print(json.dumps(record, indent=2, default=str, ensure_ascii=False))

    print("\n── CELL TYPES (row 1) ───────────────────────────────────")
    for header, value in records[0].items():
        column = etl.normalize_header(header)
        print(f"{column:<34}  {describe_value(column, value)}")


if __name__ == "__main__":
    main()
