# Container memory budget

This note records why the reference Compose files allow 512 MB of memory and a
384 MB V8 old-space, and how to reproduce the measurement behind that choice.

## Evidence

The 2026-11-12 fuzz session drove the server through the real write tools until
the documented 1 MB file cap refused more input. The largest **legal** file it
produced was:

| Measure | Value |
| --- | --- |
| File size | 1,034,145 bytes |
| Lines | 526 |
| Tags per line | ~390 |
| Observed RSS | 279-320 MB |
| Request latency | 0.5-0.65 s |

The Compose `mem_limit` at the time was **256m**, so a legal, tool-created file
could push the container over the cgroup limit and risk an OOM kill with no
application-level error. The same session also showed what malformed files can
do:

- A 1,000,000-byte file of 500,000 one-character lines OOM-killed the process
  at `--max-old-space-size=256`; 400,000 lines used 415 MB RSS and 200,000
  lines used 288 MB.
- A single 588,895-byte line with 60,000 distinct values for one tag key used
  186 MB RSS and blocked the event loop for 53.7 s.

Those attack shapes are not made safe by this change. They are bounded by the
read-side caps in the separate hardening PR (`TODOTXT_MCP_MAX_READ_TODOS`,
line-size and tag-count limits). **This PR is capacity headroom, not the
primary fix.**

## Chosen limits

Both `docker-compose.yml` and `docker-compose.deploy.yml` now set:

```yaml
mem_limit: 512m
environment:
  - NODE_OPTIONS=--max-old-space-size=384
```

- **512 MB cgroup limit** leaves roughly 190 MB above the observed 320 MB
  worst case for concurrent requests, buffers, and cgroup accounting.
- **384 MB old-space** leaves ~128 MB of the cgroup for memory that is not V8
  heap: `Buffer`/`ArrayBuffer` external memory, code, stacks, and the runtime
  itself. A heap cap that equals the cgroup limit would let non-heap memory
  push the container into a kernel OOM kill first.

`pids_limit`, `read_only`, `cap_drop`, `no-new-privileges`, and the rest of the
security posture are unchanged.

### The cgroup still kills on RSS

`--max-old-space-size` limits the V8 heap only. It does not cap RSS, and it does
not replace the cgroup limit. If a file drives heap or external memory past
512 MB, the kernel still OOM-kills the container. The heap flag is there so a
pathological workload is more likely to fail as a restartable V8 out-of-memory
error than as an abrupt SIGKILL, but that ordering is not guaranteed.

## Reproduce

```bash
npm ci
npm run bench:worst-case
```

The benchmark is standalone and deterministic. It generates a temporary
`todo.txt` with 526 lines, 390 distinct tag values per line (spread over ten
tag keys), and ~1.03 MB of content, loads it through `readTodosFromFile`,
prints JSON, and removes the temporary directory. It is **informational, not a
pass/fail test**; RSS depends on the host, Node version, and GC timing.

Example output from a development host:

```json
{
  "bytes": 1030960,
  "lines": 526,
  "parseMs": 498.6,
  "rssMB": 126.6
}
```

The parse-only RSS here is lower than the 279-320 MB fuzz peak because the
fuzz measurement went through a live server: it included the `list_todos`
response serialization, the MCP/HTTP request path, and the running process
baseline. The benchmark isolates the read path so changes to parsing cost are
visible; it is not a container-limit assertion.

Treat the `bytes` and `lines` values as the stable shape check and `parseMs` /
`rssMB` as order-of-magnitude evidence. Compare runs on the same host rather
than across machines.

## Operational notes

- One replica only. The file lock and abuse state are process-local; do not
  scale out this service to spread the memory budget.
- The budget assumes the default 1 MB `TODOTXT_MCP_MAX_FILE_BYTES`. Raising that
  cap without re-measuring invalidates the headroom calculation.
- If the container is OOM-killed, check `docker inspect` for `OOMKilled` and
  compare the file size against the limits before raising `mem_limit`. The
  read-side caps are the first defense; memory is the last.
