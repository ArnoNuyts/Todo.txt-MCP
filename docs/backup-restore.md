# Backup and restore: todo.txt

The todo file is the only stateful data. Any valid token can read, rewrite, or
delete it, and the local backend does not `fsync`, so a backup is both the
rollback path for mistakes and the recovery path after a crash or incident.

This page assumes the Compose deployment in
[`docker-compose.deploy.yml`](../docker-compose.deploy.yml):

- host directory: `./data`
- file inside the container: `/data/todo.txt`
- container user: UID/GID `1000`

## What to back up

| Item | Needed for | Notes |
| --- | --- | --- |
| `data/todo.txt` | Restoring todos | Back up before every upgrade, token rotation, or bulk edit. |
| `secrets/mcp_auth_token.txt` | Rebuilding the deployment | Keep separately, encrypted; never in the same directory as todos. |
| `.env` | Rebuilding the deployment | Contains hostnames/settings, and possibly the metrics token. |
| `deploy/` and Compose file | Rebuilding the deployment | Configuration-as-code. |

Do **not** put the token or `.env` in a backup that is copied to a shared drive
without encryption.

## Snapshot while running

Local writes are temp-file + rename, so a reader that opens `data/todo.txt` sees
one complete version even if a write lands during the copy. For a guaranteed
consistent snapshot (or before an upgrade), stop the service first.

```bash
#!/usr/bin/env bash
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

# Keep the newest $KEEP snapshots.
find "$BACKUP_DIR" -maxdepth 1 -type f -name 'todo-*.txt' \
  -printf '%T@ %p\n' | sort -rn | tail -n +"$((KEEP + 1))" |
  cut -d' ' -f2- | xargs -r rm -f --
```

Run it manually, or from cron/systemd with an absolute path and a `BACKUP_DIR`
outside the repository if the repository is on a small disk.

## Restore

Restore with the app **stopped** so no write races the replace.

```bash
# 1. Stop only the app; the proxy can stay up (it will return 502).
docker compose -f docker-compose.deploy.yml stop todo-txt-mcp

# 2. Keep the current file as a rollback copy.
cp -p data/todo.txt "data/todo.txt.before-restore.$(date -u +%Y%m%dT%H%M%SZ)"

# 3. Validate the chosen snapshot before it becomes live.
BACKUP=backups/todo-20260101T000000Z.txt
iconv -f UTF-8 -t UTF-8 "$BACKUP" >/dev/null
test "$(stat -c '%s' "$BACKUP")" -le 1048576

# 4. Replace atomically in the data directory.
install -m 600 "$BACKUP" data/.todo.restore.tmp
# The container runs as UID/GID 1000; run this as root or the file owner, or
# skip it if the data directory is already owned by 1000.
chown 1000:1000 data/.todo.restore.tmp
mv data/.todo.restore.tmp data/todo.txt

# 5. Start and verify.
docker compose -f docker-compose.deploy.yml start todo-txt-mcp
curl -fsS http://127.0.0.1:3000/healthz
```

Then call `list_todos` from a real client (or the MCP Inspector) and check that
the expected items are present. If the restore is wrong, stop the app and move
the `.before-restore` copy back into place.

## Retention and off-host copies

- Keep 7–14 local snapshots; `todo.txt` is small, so disk cost is trivial.
- Keep at least one encrypted off-host copy (object storage, restic, Borg, or an
  encrypted archive) if the todo file matters beyond the host.
- Test a restore once per quarter. A backup you have never restored is a guess.
- Prune by age or count, never by “the file looks old” alone.

## Integrity checklist

- [ ] Snapshot is non-empty and at most 1 MiB.
- [ ] `iconv -f UTF-8 -t UTF-8` succeeds (the app refuses invalid UTF-8).
- [ ] Checksum matches the recorded `.sha256` for older snapshots.
- [ ] The app starts and `list_todos` returns the expected rows.
- [ ] The previous file is retained until the restore is verified.
- [ ] No token, `.env`, or `secrets/` content is present in the backup.
