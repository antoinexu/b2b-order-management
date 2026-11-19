import { readdirSync, readFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { expect } from '@playwright/test';

export const apiPort = Number(process.env.E2E_API_PORT ?? 43001);

/** The e2e API writes each email it sends as a JSON file here (MAIL_TRANSPORT=file). */
export const OUTBOX_DIR = path.join(os.tmpdir(), `b2b-e2e-outbox-${apiPort}`);

interface StoredEmail { to: string; subject: string; text: string; html: string }

function emailsTo(to: string): StoredEmail[] {
  let files: string[];
  try {
    files = readdirSync(OUTBOX_DIR).sort();
  } catch {
    return [];
  }
  return files
    .map((file) => JSON.parse(readFileSync(path.join(OUTBOX_DIR, file), 'utf8')) as StoredEmail)
    .filter((email) => email.to === to);
}

/** Waits for the `count`-th email to `to` and returns the link it contains. */
export async function linkFromEmail(to: string, count = 1): Promise<string> {
  await expect.poll(() => emailsTo(to).length, { message: `email #${count} to ${to}` }).toBeGreaterThanOrEqual(count);
  const email = emailsTo(to)[count - 1]!;
  const link = email.text.match(/https?:\/\/\S+#token=[\w-]+/)?.[0];
  if (!link) throw new Error(`No link in email to ${to}:\n${email.text}`);
  return link;
}
