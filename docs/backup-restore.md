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
without encryption. Backups made by `bin/backup-todo.sh` contain only
`data/todo.txt` and its `.sha256` sidecar; they never include tokens, `.env`, or
`secrets/`. Back up deployment secrets separately (encrypted) only if you need
to rebuild the host from scratch.

## Snapshot while running

Local writes are temp-file + rename, so a reader that opens `data/todo.txt` sees
one complete version even if a write lands during the copy. For a guaranteed
consistent snapshot (or before an upgrade), stop the service first.

The repository ships the procedure as an executable script:

```bash
# From the repository root; writes backups/todo-<UTC timestamp>.txt plus .sha256.
./bin/backup-todo.sh

# Override the destination or retention count when needed.
BACKUP_DIR=/srv/backups KEEP=14 ./bin/backup-todo.sh
```

`bin/backup-todo.sh` uses `set -euo pipefail`, creates the directory with mode
`0700` via `umask 077`, refuses a missing file, a snapshot over 1 MiB, or
invalid UTF-8, writes the copy as mode `0600`, records a SHA-256 checksum, and
keeps the newest `KEEP` snapshots (default 14), pruning each one together with
its `.sha256`. `BACKUP_DIR` defaults to `backups/` relative to the current
directory.

Run it from the repository root, or from cron/systemd after `cd`-ing there, with
an absolute script path and a `BACKUP_DIR` outside the repository if the
repository is on a small disk.

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
