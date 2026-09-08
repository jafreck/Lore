import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["tests/**/*.test.ts"],
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
