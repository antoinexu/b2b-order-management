import path from 'node:path';
import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  plugins: [react(), tailwindcss()],
  resolve: { alias: { '@': path.resolve(import.meta.dirname, './src') } },
  server: {
    port: 5173,
    // In development the API runs on :3000; proxying keeps requests same-origin (no CORS setup needed).
    proxy: { '/api': process.env.API_PROXY_TARGET ?? 'http://localhost:3000' },
  },
  test: { include: ['src/**/*.test.{ts,tsx}'], environment: 'node' },
});
