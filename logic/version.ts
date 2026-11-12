import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Reads the package version at runtime so `serverInfo.version` cannot drift
 * from `package.json` when release-please bumps the version.
 *
 * Works from the source tree (`logic/version.ts`) and from a compiled
 * `dist/logic/version.js` by checking the nearest package.json candidates.
 */
function readPackageVersion(): string {
  const here = dirname(fileURLToPath(import.meta.url));
  const candidates = [
    join(here, "..", "package.json"),
    join(here, "..", "..", "package.json"),
    join(here, "package.json"),
  ];
  for (const candidate of candidates) {
    try {
      const parsed = JSON.parse(readFileSync(candidate, "utf8")) as {
        version?: unknown;
      };
      if (typeof parsed.version === "string" && parsed.version !== "") {
        return parsed.version;
      }
    } catch {
      // Try the next location; a missing package.json must not break startup.
    }
  }
  return "0.0.0";
}

export const SERVER_VERSION = readPackageVersion();
