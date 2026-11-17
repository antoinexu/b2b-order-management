import { defineConfig, devices } from '@playwright/test';

/**
 * End-to-end tests run the real frontend against the real API, backed by an in-memory
 * Postgres (PGlite) with demo data, so they need no database or Docker.
 */
export default defineConfig({
  testDir: './e2e',
  fullyParallel: false,
  workers: 1, // tests share one in-memory database
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI ? [['list'], ['html', { open: 'never' }]] : 'list',
  use: {
    baseURL: 'http://localhost:5173',
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
  },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
  webServer: [
    {
      command: 'npm run dev:memory --prefix ..',
      url: 'http://localhost:3000/health',
      reuseExistingServer: !process.env.CI,
      timeout: 60_000,
    },
    {
      command: 'npm run dev',
      url: 'http://localhost:5173',
      reuseExistingServer: !process.env.CI,
      timeout: 60_000,
    },
  ],
});
