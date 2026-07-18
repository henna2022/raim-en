#!/usr/bin/env bash
# Seoul RAIM (EN) — SQLite online backup.
#
# Uses node:sqlite's DatabaseSync in read-only mode and `VACUUM INTO` to take
# a consistent snapshot of the live database (safe to run while the app is
# up and writing, including with WAL enabled). No sqlite3 CLI required.
#
# Usage:
#   scripts/backup.sh [DATA_DIR]
#   DATA_DIR=/app/data scripts/backup.sh
#
# Output: backups/raim-YYYYMMDD-HHMMSS.db (directory created automatically).
# Retention: only the 14 most recent backups are kept; older ones are deleted.

set -euo pipefail

DATA_DIR="${1:-${DATA_DIR:-./data}}"
SRC="${DATA_DIR%/}/raim.db"
BACKUP_DIR="backups"
TIMESTAMP="$(date +%Y%m%d-%H%M%S)"
DEST="${BACKUP_DIR}/raim-${TIMESTAMP}.db"
KEEP=14

mkdir -p "$BACKUP_DIR"

if [ ! -f "$SRC" ]; then
  echo "[backup] FAILED: source database not found at $SRC"
  exit 1
fi

if node -e "const { DatabaseSync } = require('node:sqlite'); const db = new DatabaseSync('${SRC}', { readOnly: true }); db.exec(\"VACUUM INTO '${DEST}'\");"; then
  if [ -f "$DEST" ]; then
    echo "[backup] SUCCESS: $DEST"
  else
    echo "[backup] FAILED: node command succeeded but $DEST was not created"
    exit 1
  fi
else
  echo "[backup] FAILED: node backup command exited non-zero"
  exit 1
fi

# Retention: keep only the most recent $KEEP backups, delete the rest.
# (Portable form: avoids `mapfile`, which stock macOS bash 3.2 lacks.)
ls -1t "${BACKUP_DIR}"/raim-*.db 2>/dev/null | tail -n "+$((KEEP + 1))" | while IFS= read -r old; do
  [ -n "$old" ] || continue
  rm -f "$old"
  echo "[backup] removed old backup (retention ${KEEP}): $old"
done

exit 0
