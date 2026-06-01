import { defineConfig, devices } from "@playwright/test";

export default defineConfig({
  testDir: "e2e",
  timeout: 30_000,
  use: { baseURL: "http://localhost:8080", ...devices["Desktop Chrome"] },
  // Two lanes (M5-T10): the "fast" suite is the M0–M4 + light M5 checks that run in
  // seconds; the "slow" suite boots a real Linux in the v86 emulator (multi-second,
  // multi-MB) — run separately so a slow boot can never flake the fast suite.
  projects: [
    { name: "fast", testIgnore: /emulator-.*\.spec\.ts/ },
    { name: "slow", testMatch: /emulator-.*\.spec\.ts/, timeout: 120_000 },
  ],
  webServer: {
    command:
      "npm run build && npm run build:guests && npm run bundle && npm run bundle:harness && node tools/serve.mjs",
    url: "http://localhost:8080/",
    timeout: 120_000,
    reuseExistingServer: false,
  },
});
