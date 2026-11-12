# Todo file safety

The read path validates `todo.txt` before it builds todo objects or returns a
tool result. A malformed or oversized file is rejected with a bounded
`LIMIT_EXCEEDED` or `BACKEND_ERROR`; the server does not echo the offending
line content.

## Read limits

| Variable | Default | Purpose |
| --- | --- | --- |
| `TODOTXT_MCP_MAX_FILE_BYTES` | `1048576` (1 MiB) | Total file size in bytes. |
| `TODOTXT_MCP_MAX_READ_TODOS` | `50000` | Physical lines accepted on read. |
| `TODOTXT_MCP_MAX_LINE_CHARS` | `8192` | Maximum UTF-16 code units in one line (astral characters count twice). |
| `TODOTXT_MCP_MAX_TODOS` | `10000` | Todo count enforced by write tools. |

The read cap is larger than the write cap on purpose: a file that grew past
the write limit stays readable, so an operator can trim or delete items through
MCP instead of editing it on the host. The line cap is a hard ceiling; write
tools keep their smaller 2,000/2,100-character limits.

## Line endings and rejected characters

- LF (`\n`) separates lines.
- CRLF (`\r\n`) is accepted, and the trailing `\r` is preserved for untouched
  lines so a save keeps the file byte-for-byte. A single trailing `\r` at end
  of file is accepted for the same reason.
- A bare `\r` anywhere else in a line is rejected.
- Tab (`\t`) is allowed.
- NUL, C0 controls other than tab, DEL, C1 controls, U+2028 (line separator),
  and U+2029 (paragraph separator) are rejected with the line number and code
  point only. This prevents embedded separators from turning one stored line
  into several displayed or agent-readable rows.
- Invalid UTF-8 is rejected as well; the file is never rewritten with
  replacement characters.

## Recovery

`list_todos`, the readiness probe, and the other tools fail closed until the
file is valid. To recover:

1. Back up the current file (see `docs/backup-restore.md`).
2. Open it in an editor that can show control characters and invalid UTF-8.
3. Remove the reported line, split an over-long line, or re-save the file as
   UTF-8 with LF or CRLF endings.
4. Call `list_todos` or check `/readyz` again.

If the file is too large to edit comfortably, remove or split lines in place.
Nothing is changed automatically, so a partial external edit is never mistaken
for a successful MCP write.

## Raising the limits

Set the variable in the server environment (or `.env`) and restart:

```bash
TODOTXT_MCP_MAX_READ_TODOS=100000
TODOTXT_MCP_MAX_LINE_CHARS=16384
```

Values must be positive integers. Raising them increases per-request memory
and latency; the 1 MiB file cap and the container memory limit still apply.
Prefer trimming the file over raising the limits permanently.
