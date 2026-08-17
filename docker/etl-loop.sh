#!/bin/sh
# Runs the Sheets → MySQL ETL on a fixed interval.
# Replaces the old `while true; do python import_sheets.py; sleep 60; done` shell
# loop. import_sheets.py itself is unchanged: it is a one-shot script, and every
# run is a full idempotent upsert keyed on collections_messages.uid.
set -u

INTERVAL="${IMPORT_INTERVAL_SECONDS:-60}"
echo "[etl] starting loop, interval=${INTERVAL}s"

# Without a trap, `docker stop` would wait the full timeout while sleep runs.
terminate() {
  echo "[etl] signal received, stopping"
  exit 0
}
trap terminate TERM INT

while true; do
  python import_sheets.py || echo "[etl] run failed (exit $?) — retrying in ${INTERVAL}s"
  # Backgrounded sleep + wait so the trap above can fire mid-sleep.
  sleep "$INTERVAL" &
  wait $!
done
