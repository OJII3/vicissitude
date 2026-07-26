import { defineConfig } from "vitest/config";
export default defineConfig({
  test: {
    environment: "node",
    include: ["src/**/*.test.ts", "spec/**/*.spec.ts"],
    fileParallelism: false,
    restoreMocks: true,
    testTimeout: 10000,
  },
});
