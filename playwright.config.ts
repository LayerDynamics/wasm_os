import { defineConfig, devices } from "@playwright/test";

export default defineConfig({
  testDir: "e2e",
  timeout: 30_000,
  // Retry on CI only: the kernel/IPC logic is deterministic + unit-tested, but the
  // browser-driven E2E occasionally hits an environment hiccup on the constrained CI
  // runner (e.g. a keystroke/syscall that doesn't land on the first attempt) that is
  // not reproducible locally. A retry self-heals a transient flake; a real bug still
  // fails all attempts. Locally, retries stay off so flakes surface loudly.
  retries: process.env.CI ? 2 : 0,
  use: { baseURL: "http://localhost:8080", ...devices["Desktop Chrome"] },
  // Two lanes (M5-T10): the "fast" suite is the M0–M4 + light M5 checks that run in
  // seconds; the "slow" suite boots a real Linux in the TinyEMU RISC-V emulator (multi-second,
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
