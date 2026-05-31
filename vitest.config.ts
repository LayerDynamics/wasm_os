import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    include: ["packages/host/test/**/*.test.ts"],
    // e2e/ is Playwright, not Vitest — keep it out.
    exclude: ["e2e/**", "node_modules/**"],
  },
});
