/**
 * Read-only mode policy. Kept in one module so the startup resolver and the
 * posture warning cannot drift on accepted spellings.
 */

const TRUE_VALUES = new Set(["1", "true", "yes"]);
const RECOGNIZED_VALUES = new Set([
  "",
  "0",
  "false",
  "no",
  "1",
  "true",
  "yes",
]);

/**
 * Resolves read-only mode from an explicit option, then `MCP_READ_ONLY`.
 *
 * An explicit `readOnly` option always wins. Otherwise the environment value
 * must be one of the documented spellings: a typo fails startup instead of
 * silently leaving the write tools enabled.
 */
export function resolveReadOnlyMode(
  options: { readOnly?: boolean } = {},
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  if (options.readOnly !== undefined) {
    return options.readOnly;
  }
  const raw = env.MCP_READ_ONLY;
  if (raw === undefined) {
    return false;
  }
  const normalized = raw.trim().toLowerCase();
  if (!RECOGNIZED_VALUES.has(normalized)) {
    throw new Error(
      `Invalid MCP_READ_ONLY "${raw.trim()}": expected 1/true/yes ` +
        "for read-only or 0/false/no for writes.",
    );
  }
  return TRUE_VALUES.has(normalized);
}

/** True when the raw value is one of the documented spellings. */
export function isRecognizedReadOnlyValue(value: string): boolean {
  return RECOGNIZED_VALUES.has(value.trim().toLowerCase());
}
