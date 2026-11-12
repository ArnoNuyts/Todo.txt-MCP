/**
 * Memory and parse-cost benchmark for the documented worst-case legal file.
 *
 * The fuzz session filled a todo.txt through the write tools until the 1 MB
 * file cap refused more input. The result was 1,034,145 bytes, 526 lines, and
 * ~390 tags per line, and it pushed RSS to 279-320 MB. This harness rebuilds
 * the same shape deterministically, loads it through the real read path, and
 * prints bytes, lines, parse time, and RSS.
 *
 * It is informational, not a pass/fail test. Run with `npm run bench:worst-case`.
 */
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readTodosFromFile } from "../logic/todo-file-helpers.ts";

/** Matches the 526-line legal maximum observed in the fuzz session. */
const LINE_COUNT = 526;
/** Matches the ~390 tags per line observed in the fuzz session. */
const TAGS_PER_LINE = 390;
/** Ten tag keys keep the per-key value list realistic (39 values each). */
const TAG_KEYS = "abcdefghij";

/**
 * A two-character base-36 value gives 390 distinct values per line
 * (`00`..`at`) while keeping each `key:value` token short enough that 526
 * lines stay just under the 1 MB file cap.
 */
function tagValue(index: number): string {
  return index.toString(36).padStart(2, "0");
}

function buildLine(lineIndex: number): string {
  const tags: string[] = [];
  for (let tagIndex = 0; tagIndex < TAGS_PER_LINE; tagIndex++) {
    const key = TAG_KEYS[tagIndex % TAG_KEYS.length];
    tags.push(`${key}:${tagValue(tagIndex)}`);
  }
  const lineNumber = String(lineIndex + 1).padStart(4, "0");
  return `task ${lineNumber} ${tags.join(" ")}`;
}

function buildFileContent(): string {
  const lines: string[] = [];
  for (let lineIndex = 0; lineIndex < LINE_COUNT; lineIndex++) {
    lines.push(buildLine(lineIndex));
  }
  return `${lines.join("\n")}\n`;
}

const directory = await mkdtemp(join(tmpdir(), "todo-worst-case-"));
const filename = join(directory, "todo.txt");

try {
  const content = buildFileContent();
  await writeFile(filename, content, "utf8");

  const startedAt = performance.now();
  const todos = await readTodosFromFile(filename);
  const parseMs = performance.now() - startedAt;

  const { rss } = process.memoryUsage();
  console.log(
    JSON.stringify(
      {
        bytes: Buffer.byteLength(content, "utf8"),
        lines: todos.length,
        parseMs: Number(parseMs.toFixed(1)),
        rssMB: Number((rss / (1024 * 1024)).toFixed(1)),
      },
      null,
      2,
    ),
  );
} finally {
  await rm(directory, { recursive: true, force: true });
}
