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
        "src/scip/installer.ts",
        "src/scip/compdb.ts",
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
