import { randomUUID } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { Logger } from 'pino';
import type { Config } from '../config';

export interface OutgoingEmail {
  to: string;
  subject: string;
  text: string;
  html: string;
}

export interface Mailer {
  /** False when no transport is configured; features that need email refuse up front instead of failing later. */
  readonly enabled: boolean;
  send(email: OutgoingEmail): Promise<void>;
}

type MailConfig = Pick<Config, 'MAIL_TRANSPORT' | 'MAIL_FROM' | 'RESEND_API_KEY' | 'MAIL_OUTBOX_DIR'>;

const SEND_TIMEOUT_MS = 10_000;

/** Sends through the Resend HTTP API (https://resend.com/docs/api-reference/emails/send-email). */
function resendMailer(apiKey: string, from: string): Mailer {
  return {
    enabled: true,
    async send(email) {
      const response = await fetch('https://api.resend.com/emails', {
        method: 'POST',
        headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ from, to: [email.to], subject: email.subject, text: email.text, html: email.html }),
        signal: AbortSignal.timeout(SEND_TIMEOUT_MS),
      });
      if (!response.ok) {
        // The body explains the failure (e.g. an unverified sender domain) without containing the message itself.
        throw new Error(`Resend rejected the email (${response.status}): ${(await response.text()).slice(0, 500)}`);
      }
    },
  };
}

export function createMailer(config: MailConfig, logger: Logger): Mailer {
  switch (config.MAIL_TRANSPORT) {
    case 'resend':
      return resendMailer(config.RESEND_API_KEY!, config.MAIL_FROM);
    case 'file': {
      const dir = config.MAIL_OUTBOX_DIR!;
      return {
        enabled: true,
        async send(email) {
          await mkdir(dir, { recursive: true });
          const file = path.join(dir, `${Date.now()}-${randomUUID()}.json`);
          await writeFile(file, JSON.stringify({ from: config.MAIL_FROM, ...email }, null, 2));
        },
      };
    }
    case 'log':
      // Development only: the message, including its link, goes to the log instead of an inbox.
      return {
        enabled: true,
        async send(email) {
          logger.info({ to: email.to, subject: email.subject }, `Email not sent (MAIL_TRANSPORT=log):\n${email.text}`);
        },
      };
    default:
      return {
        enabled: false,
        async send() {
          throw new Error('Email delivery is not configured');
        },
      };
  }
}

/** Collects messages in memory, for tests. */
export function memoryMailer(): Mailer & { outbox: OutgoingEmail[] } {
  const outbox: OutgoingEmail[] = [];
  return { enabled: true, outbox, async send(email) { outbox.push(email); } };
}
