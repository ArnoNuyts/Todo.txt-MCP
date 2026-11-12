import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { SERVER_VERSION } from "../logic/version.ts";

describe("server version", () => {
  it("matches package.json so release-please bumps are reflected", () => {
    const pkg = JSON.parse(
      readFileSync(join(process.cwd(), "package.json"), "utf8"),
    ) as { version: string };

    expect(SERVER_VERSION).toBe(pkg.version);
  });
});
