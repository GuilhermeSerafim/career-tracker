import { defineConfig, devices } from '@playwright/test';

// Playwright 1.65 adds a failure DOM snapshot even with trace/screenshots off.
// One-time credentials must never enter that diagnostic copy prompt.
process.env.PLAYWRIGHT_NO_COPY_PROMPT = '1';

export default defineConfig({
  testDir: './tests/e2e',
  // Shared dedicated source database: do not overlap integration consumers.
  fullyParallel: false,
  workers: 1,
  forbidOnly: Boolean(process.env.CI),
  retries: 0,
  reporter: 'list',
  // Credential issuance is exercised here: never persist DOM/network secrets.
  use: { baseURL: 'http://127.0.0.1:4173', trace: 'off', screenshot: 'off', video: 'off' },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'], channel: process.env.PLAYWRIGHT_CHANNEL } }],
  webServer: {
    command: 'node node_modules/vite/bin/vite.js preview',
    env: { VITE_SUPABASE_URL: 'http://127.0.0.1:54321', VITE_SUPABASE_PUBLISHABLE_KEY: 'sb_publishable_synthetic_e2e_only' },
    url: 'http://127.0.0.1:4173',
    reuseExistingServer: false,
    timeout: 30_000,
  },
});
