import { defineConfig, devices } from "@playwright/test";

const port = Number(process.env.PORT ?? 3000);
const baseURL = `http://localhost:${port}`;

export default defineConfig({
  testDir: "./e2e",
  fullyParallel: false,
  workers: 1,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI ? [["github"], ["html", { open: "never" }]] : "list",
  use: { baseURL, trace: "on-first-retry" },
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }],
  webServer: {
    command: process.env.CI ? "pnpm build && pnpm start" : "pnpm dev",
    url: baseURL,
    // The demo role switcher is default-deny in production builds (CI runs pnpm build && pnpm start),
    // so the e2e server must opt in explicitly. The login budget is raised because every spec signs in
    // from the same address; both values are for this test server only.
    env: { DEMO_AUTH_ENABLED: "true", LOGIN_RATE_LIMIT_PER_MIN: "10000" },
    reuseExistingServer: !process.env.CI,
    timeout: 120_000,
  },
});
