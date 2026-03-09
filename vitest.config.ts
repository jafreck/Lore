import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    coverage: {
      provider: "v8",
      reporter: ["text", "json", "json-summary"],
      thresholds: {
        lines: 79,
        functions: 80,
        branches: 64,
        statements: 77,
      },
    },
  },
});
