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

/** Resolves read-only mode from an explicit option, then `MCP_READ_ONLY`. */
export function resolveReadOnlyMode(
  options: { readOnly?: boolean } = {},
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  if (options.readOnly !== undefined) {
    return options.readOnly;
  }
  return TRUE_VALUES.has((env.MCP_READ_ONLY ?? "").trim().toLowerCase());
}

/** True when the raw value is one of the documented spellings. */
export function isRecognizedReadOnlyValue(value: string): boolean {
  return RECOGNIZED_VALUES.has(value.trim().toLowerCase());
}
