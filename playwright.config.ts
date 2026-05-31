import { defineConfig, devices } from "@playwright/test";

export default defineConfig({
  testDir: "e2e",
  timeout: 30_000,
  use: { baseURL: "http://localhost:8080", ...devices["Desktop Chrome"] },
  webServer: {
    command: "npm run build && npm run bundle && node tools/serve.mjs",
    url: "http://localhost:8080/",
    timeout: 120_000,
    reuseExistingServer: false,
  },
});
