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
        lines: 75,
        functions: 78,
        branches: 60,
        statements: 73,
      },
    },
  },
});
