/** Todo.txt token parsers shared by the model and tool helpers. */
export const PROJECT_REGEX = /\s+\+(?<name>[\w.\_\-]+)/g;
export const CONTEXT_REGEX = /\s+\@(?<name>[\w.\_\-]+)/g;
// Do not treat URL schemes such as https:// as tags.
export const TAG_REGEX = /\s+(?<key>[A-Za-z]+):(?!\/\/)(?<value>[^\s]+)/g;

/** Escapes a string for literal use inside a regular expression. */
export function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Matches one `@context` token at a word boundary. The leading `@` is
 * optional. `global` is for repeated removals; callers that only test should
 * pass `false`.
 */
export function contextTokenPattern(name: string, global: boolean): RegExp {
  const normalized = name.replace(/^@+/, "").trim();
  if (normalized.length === 0) {
    return /(?!)/;
  }
  const marker = `@${escapeRegExp(normalized)}`;
  return new RegExp(`(^|\\s)${marker}(?=$|\\s)`, global ? "gi" : "i");
}
