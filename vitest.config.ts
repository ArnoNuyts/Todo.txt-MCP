import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    include: ["test/**/*.test.ts"],
    env: {
      TZ: "UTC",
    },
    clearMocks: true,
    restoreMocks: true,
    coverage: {
      provider: "v8",
      include: ["logic/**/*.ts", "server.ts"],
      exclude: ["types/**"],
      thresholds: {
        lines: 80,
        branches: 75,
        functions: 80,
        statements: 80,
      },
    },
  },
});
