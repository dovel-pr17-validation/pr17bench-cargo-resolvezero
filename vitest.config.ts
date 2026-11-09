import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    include: ["apps/**/*.test.ts", "packages/**/*.test.ts"],
    testTimeout: 10_000,
    hookTimeout: 10_000,
    // Socket tests bind fixed local ports; run files serially to keep them stable.
    fileParallelism: false,
  },
});
