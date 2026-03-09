import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    coverage: {
      provider: "v8",
      thresholds: {
        lines: 79,
        functions: 80,
        branches: 64,
        statements: 77,
      },
    },
  },
});
