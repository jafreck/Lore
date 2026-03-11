import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    coverage: {
      provider: "v8",
      reporter: ["text", "json", "json-summary"],
      thresholds: {
        lines: 87.5,
        functions: 89,
        branches: 71.5,
        statements: 85.5,
      },
    },
  },
});
