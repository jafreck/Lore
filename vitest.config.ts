import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    coverage: {
      provider: "v8",
      reporter: ["text", "json", "json-summary"],
      exclude: [
        "tests/benchmark/util/**",
        "tests/helpers/**",
      ],
      thresholds: {
        lines: 87,
        functions: 88.5,
        branches: 70.5,
        statements: 85,
      },
    },
  },
});
