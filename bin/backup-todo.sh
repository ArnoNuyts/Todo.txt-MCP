#!/usr/bin/env bash
# Snapshot data/todo.txt with checksum and simple count-based retention.
#
# Run from the repository root (or from the directory that contains data/):
#   ./bin/backup-todo.sh
#   BACKUP_DIR=/srv/backups KEEP=14 ./bin/backup-todo.sh
#
# This script only copies todo.txt. It never reads or writes tokens, .env, or
# secrets/.
set -euo pipefail

BACKUP_DIR="${BACKUP_DIR:-backups}"
KEEP="${KEEP:-14}"
STAMP="$(date -u +%Y%m%dT%H%M%SZ)"
SRC="data/todo.txt"
DEST="$BACKUP_DIR/todo-$STAMP.txt"

umask 077
mkdir -p "$BACKUP_DIR"

if [[ ! -f "$SRC" ]]; then
  echo "missing $SRC" >&2
  exit 1
fi

# Refuse a snapshot that exceeds the app's default file cap.
size="$(stat -c '%s' "$SRC")"
if (( size > 1048576 )); then
  echo "refusing: $SRC is $size bytes (limit 1048576)" >&2
  exit 1
fi

# Refuse invalid UTF-8 before it becomes the only copy.
iconv -f UTF-8 -t UTF-8 "$SRC" >/dev/null

cp -p -- "$SRC" "$DEST"
chmod 600 "$DEST"
sha256sum "$DEST" > "$DEST.sha256"
echo "backup: $DEST"

# Keep the newest $KEEP snapshots; remove each pruned snapshot with its checksum.
# Names embed a UTC timestamp, so they sort chronologically regardless of the
# preserved source mtime.
find "$BACKUP_DIR" -maxdepth 1 -type f -name 'todo-*.txt' -printf '%f\n' |
  sort -r | tail -n +"$((KEEP + 1))" | while IFS= read -r name; do
    rm -f -- "$BACKUP_DIR/$name" "$BACKUP_DIR/$name.sha256"
  done
