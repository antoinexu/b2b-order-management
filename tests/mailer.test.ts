import { mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import pino from 'pino';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { parseConfig } from '../src/config';
import { invitationEmail, passwordResetEmail } from '../src/lib/emails';
import { createMailer } from '../src/lib/mailer';

const SECRET = 'test-only-unique-signing-key-1234567890';
const logger = pino({ level: 'silent' });
const message = { to: 'ada@example.com', subject: 'Hello', text: 'Plain', html: '<p>Html</p>' };

describe('mail configuration', () => {
  it('logs email in development and disables it in production unless a provider is configured', () => {
    expect(parseConfig({}).MAIL_TRANSPORT).toBe('log');
    expect(parseConfig({ NODE_ENV: 'production', JWT_SECRET: SECRET }).MAIL_TRANSPORT).toBe('none');
    expect(parseConfig({ RESEND_API_KEY: 're_test' }).MAIL_TRANSPORT).toBe('resend');
  });

  it('requires the settings each transport needs', () => {
    expect(() => parseConfig({ MAIL_TRANSPORT: 'resend' })).toThrow('RESEND_API_KEY is required');
    expect(() => parseConfig({ MAIL_TRANSPORT: 'file' })).toThrow('MAIL_OUTBOX_DIR is required');
    // Production links must point at the deployed web app, not the localhost default.
    expect(() => parseConfig({ NODE_ENV: 'production', JWT_SECRET: SECRET, RESEND_API_KEY: 're_test' })).toThrow('APP_URL must be set');
    const config = parseConfig({ NODE_ENV: 'production', JWT_SECRET: SECRET, RESEND_API_KEY: 're_test', APP_URL: 'https://orders.example.com/' });
    expect(config.APP_URL).toBe('https://orders.example.com');
  });

  it('treats settings left blank as unset', () => {
    const config = parseConfig({ NODE_ENV: 'production', JWT_SECRET: SECRET, APP_URL: '', RESEND_API_KEY: '', MAIL_FROM: '', MAIL_TRANSPORT: '' });
    expect(config).toMatchObject({ MAIL_TRANSPORT: 'none', APP_URL: 'http://localhost:5173', MAIL_FROM: 'B2B Orders <onboarding@resend.dev>' });
  });
});

describe('transports', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('sends through the Resend API and surfaces its errors', async () => {
    const fetchMock = vi.fn(async () => new Response('{"id":"1"}', { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);
    const mailer = createMailer({ MAIL_TRANSPORT: 'resend', RESEND_API_KEY: 're_test', MAIL_FROM: 'Team <team@example.com>', MAIL_OUTBOX_DIR: undefined }, logger);
    await mailer.send(message);
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('https://api.resend.com/emails');
    expect(new Headers(init.headers).get('Authorization')).toBe('Bearer re_test');
    expect(JSON.parse(init.body as string)).toEqual({ from: 'Team <team@example.com>', to: ['ada@example.com'], subject: 'Hello', text: 'Plain', html: '<p>Html</p>' });

    fetchMock.mockResolvedValueOnce(new Response('{"message":"The example.com domain is not verified"}', { status: 403 }));
    await expect(mailer.send(message)).rejects.toThrow('Resend rejected the email (403): {"message":"The example.com domain is not verified"}');
  });

  it('writes one JSON file per message for end-to-end tests', async () => {
    const dir = path.join(mkdtempSync(path.join(os.tmpdir(), 'b2b-outbox-')), 'nested');
    try {
      const mailer = createMailer({ MAIL_TRANSPORT: 'file', MAIL_OUTBOX_DIR: dir, MAIL_FROM: 'team@example.com', RESEND_API_KEY: undefined }, logger);
      await mailer.send(message);
      const files = readdirSync(dir);
      expect(files).toHaveLength(1);
      expect(JSON.parse(readFileSync(path.join(dir, files[0]!), 'utf8'))).toEqual({ from: 'team@example.com', ...message });
    } finally {
      rmSync(path.dirname(dir), { recursive: true, force: true });
    }
  });

  it('is disabled without a transport', async () => {
    const mailer = createMailer({ MAIL_TRANSPORT: 'none', MAIL_FROM: 'x@example.com', RESEND_API_KEY: undefined, MAIL_OUTBOX_DIR: undefined }, logger);
    expect(mailer.enabled).toBe(false);
    await expect(mailer.send(message)).rejects.toThrow('Email delivery is not configured');
  });
});

describe('email templates', () => {
  it('escapes names in HTML but keeps them readable in plain text', () => {
    const email = invitationEmail({
      to: 'x@example.com', name: '<b>Eve</b>', inviterName: 'Tom & Jerry', organizationName: 'A "Quoted" Co',
      role: 'sales', url: 'https://app.example/accept-invitation#token=abc', expiresInDays: 7,
    });
    expect(email.text).toContain('Hi <b>Eve</b>,');
    expect(email.html).toContain('Hi &lt;b&gt;Eve&lt;/b&gt;,');
    expect(email.html).toContain('Tom &amp; Jerry invited you to join A &quot;Quoted&quot; Co');
    expect(email.html).toContain('href="https://app.example/accept-invitation#token=abc"');
    expect(email.html).not.toContain('<b>');
  });

  it('says how long a reset link lasts', () => {
    const email = passwordResetEmail({ to: 'x@example.com', name: 'Ada', url: 'https://app.example/reset-password#token=abc', expiresInMinutes: 60 });
    expect(email.text).toContain('This link expires in 60 minutes and works once.');
  });
});
