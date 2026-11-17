import { defineConfig, devices } from '@playwright/test';

const apiPort = Number(process.env.E2E_API_PORT ?? 43001);
const webPort = Number(process.env.E2E_WEB_PORT ?? 45173);
if (![apiPort, webPort].every((port) => Number.isInteger(port) && port > 0 && port < 65536)) throw new Error('Invalid E2E port');
const apiOrigin = `http://localhost:${apiPort}`;
const webOrigin = `http://localhost:${webPort}`;

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
    baseURL: webOrigin,
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
  },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
  webServer: [
    {
      command: 'node --import tsx ../src/dev-memory.ts',
      url: `${apiOrigin}/health`,
      reuseExistingServer: !process.env.CI,
      env: { PORT: String(apiPort), NODE_ENV: 'test', AUTH_RATE_LIMIT_MAX: '100' },
      timeout: 60_000,
    },
    {
      command: `npm run dev -- --port ${webPort} --strictPort`,
      url: webOrigin,
      reuseExistingServer: !process.env.CI,
      env: { API_PROXY_TARGET: apiOrigin, VITE_API_URL: '', VITE_SHOW_DEMO_ACCOUNTS: 'true' },
      timeout: 60_000,
    },
  ],
});
