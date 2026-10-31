import { describe, expect, it } from "vitest";
import { LocalFileBackend } from "../logic/backends/local-file-backend.ts";
import { WebDavBackend } from "../logic/backends/webdav-backend.ts";
import { createBackend } from "../server.ts";

describe("createBackend", () => {
  it("creates a LocalFileBackend from local config", () => {
    const backend = createBackend({
      backend: "local",
      local: { filename: "custom.txt" },
    });

    expect(backend).toBeInstanceOf(LocalFileBackend);
  });

  it("creates a WebDavBackend from webdav config", () => {
    const backend = createBackend({
      backend: "webdav",
      webdav: { url: "https://example.com/todo.txt" },
    });

    expect(backend).toBeInstanceOf(WebDavBackend);
  });
});
