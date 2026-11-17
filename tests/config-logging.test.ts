import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmdirSync, unlinkSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import express from 'express';
import { pinoHttp } from 'pino-http';
import request from 'supertest';
import { describe, expect, it } from 'vitest';
import { parseConfig } from '../src/config';
import { createLogger } from '../src/lib/logger';

describe('production signing secrets', () => {
  it.each([
    undefined,
    'dev-only-secret-change-me-please-0123456789',
    'change-me-to-a-long-random-string-at-least-32-chars',
    'replace-with-a-long-random-string-of-at-least-32-characters',
    '',
    'too-short',
    ' '.repeat(64),
  ])('rejects missing, sample and invalid secrets (%s)', (secret) => {
    expect(() => parseConfig({ NODE_ENV: 'production', JWT_SECRET: secret })).toThrow();
  });

  it('accepts an explicitly configured production secret', () => {
    expect(parseConfig({ NODE_ENV: 'production', JWT_SECRET: 'test-only-unique-signing-key-1234567890' }).NODE_ENV).toBe('production');
  });
});

describe('environment files', () => {
  it('loads .env and gives existing process variables priority', () => {
    const directory = mkdtempSync(path.join(os.tmpdir(), 'b2b-env-'));
    const filename = path.join(directory, '.env');
    writeFileSync(filename, 'PORT=4321\nDATABASE_URL=postgres://review:review@localhost:6543/review\nJWT_SECRET=test-only-file-secret-12345678901234567890\n');
    const env = { ...process.env };
    for (const key of ['NODE_ENV', 'PORT', 'DATABASE_URL', 'JWT_SECRET', 'NODE_OPTIONS']) delete env[key];
    const code = `const { config } = require(${JSON.stringify(path.resolve('src/config.ts'))}); process.stdout.write(JSON.stringify({ port: config.PORT, database: config.DATABASE_URL, secret: config.JWT_SECRET }));`;
    const run = (overrides = {}) => JSON.parse(execFileSync(process.execPath, [require.resolve('tsx/cli'), '-e', code], {
      cwd: directory, env: { ...env, ...overrides }, encoding: 'utf8',
    }));
    try {
      expect(run()).toEqual({ port: 4321, database: 'postgres://review:review@localhost:6543/review', secret: 'test-only-file-secret-12345678901234567890' });
      expect(run({ PORT: '9876', JWT_SECRET: 'test-only-shell-secret-1234567890123456789' })).toMatchObject({ port: 9876, secret: 'test-only-shell-secret-1234567890123456789' });
      unlinkSync(filename);
      expect(run().port).toBe(3000);
    } finally {
      // Only these task-created files are removed; the temporary directory must be empty.
      try { unlinkSync(filename); } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
      rmdirSync(directory);
    }
  });
});

describe('production request logging', () => {
  it('keeps useful request metadata while removing bearer tokens and cookies', async () => {
    let output = '';
    const logger = createLogger({ NODE_ENV: 'production', LOG_LEVEL: 'info' }, { write: (chunk) => { output += chunk; } });
    const app = express();
    app.use(pinoHttp({ logger }));
    app.get('/probe', (_req, res) => {
      res.setHeader('Set-Cookie', 'session=response-cookie-secret');
      res.json({ status: 'ok' });
    });
    await request(app).get('/probe').set('Authorization', 'Bearer request-token-secret').set('Cookie', 'session=request-cookie-secret').expect(200);
    const log = JSON.parse(output.trim());
    expect(log.req.url).toBe('/probe');
    expect(log.res.statusCode).toBe(200);
    expect(log.req.headers.authorization).toBeUndefined();
    expect(log.req.headers.cookie).toBeUndefined();
    expect(log.res.headers['set-cookie']).toBeUndefined();
    for (const secret of ['request-token-secret', 'request-cookie-secret', 'response-cookie-secret']) expect(output).not.toContain(secret);
  });
});
