import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    exclude: [
      "**/node_modules/**",
      "**/dist/**",
      ".benchmark/**",
    ],
    coverage: {
      provider: "v8",
      reporter: ["text", "json", "json-summary"],
      exclude: [
        "tests/benchmark/util/**",
        "tests/helpers/**",
        "src/indexer/stages/parse-worker.ts",
      ],
      thresholds: {
        lines: 86,
        functions: 88,
        branches: 69,
        statements: 83.5,
      },
    },
  },
});
