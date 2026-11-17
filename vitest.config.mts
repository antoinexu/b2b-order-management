import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['tests/**/*.test.ts'],
    environment: 'node',
    env: { NODE_ENV: 'test' },
    testTimeout: 30_000,
    hookTimeout: 60_000,
    coverage: { provider: 'v8', include: ['src/**'], exclude: ['src/server.ts', 'src/db/seed.ts'] },
  },
});
