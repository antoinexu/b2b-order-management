import { randomUUID } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { Logger } from 'pino';
import type { Config } from '../config';

export interface Attachment {
  filename: string;
  content: Buffer;
}

export interface OutgoingEmail {
  to: string;
  subject: string;
  text: string;
  html: string;
  /** Where replies go, e.g. the salesperson who sent a quote. */
  replyTo?: string;
  attachments?: Attachment[];
}

export interface SentEmail {
  /** The provider's message id, when it reports one. */
  id?: string;
}

export interface Mailer {
  /** False when no transport is configured; features that need email refuse up front instead of failing later. */
  readonly enabled: boolean;
  /** Resolves once the provider has accepted the message; rejects if it did not. */
  send(email: OutgoingEmail): Promise<SentEmail>;
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
        body: JSON.stringify({
          from,
          to: [email.to],
          subject: email.subject,
          text: email.text,
          html: email.html,
          ...(email.replyTo ? { reply_to: email.replyTo } : {}),
          ...(email.attachments?.length
            ? { attachments: email.attachments.map((a) => ({ filename: a.filename, content: a.content.toString('base64') })) }
            : {}),
        }),
        signal: AbortSignal.timeout(SEND_TIMEOUT_MS),
      });
      if (!response.ok) {
        // The body explains the failure (e.g. an unverified sender domain) without containing the message itself.
        throw new Error(`Resend rejected the email (${response.status}): ${(await response.text()).slice(0, 500)}`);
      }
      const body = (await response.json().catch(() => ({}))) as { id?: unknown };
      return typeof body.id === 'string' ? { id: body.id } : {};
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
          const id = randomUUID();
          const file = path.join(dir, `${Date.now()}-${id}.json`);
          const attachments = email.attachments?.map((a) => ({ filename: a.filename, content: a.content.toString('base64') }));
          await writeFile(file, JSON.stringify({ from: config.MAIL_FROM, ...email, attachments }, null, 2));
          return { id };
        },
      };
    }
    case 'log':
      // Development only: the message, including its link, goes to the log instead of an inbox.
      return {
        enabled: true,
        async send(email) {
          const attachments = email.attachments?.map((a) => `${a.filename} (${a.content.length} bytes)`);
          logger.info({ to: email.to, replyTo: email.replyTo, subject: email.subject, attachments }, `Email not sent (MAIL_TRANSPORT=log):\n${email.text}`);
          return {};
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

/** Collects messages in memory, for tests. `failWith` makes the next sends fail, like a provider outage. */
export function memoryMailer(): Mailer & { outbox: OutgoingEmail[]; failWith: Error | null } {
  const mailer = {
    enabled: true,
    outbox: [] as OutgoingEmail[],
    failWith: null as Error | null,
    async send(email: OutgoingEmail): Promise<SentEmail> {
      if (mailer.failWith) throw mailer.failWith;
      mailer.outbox.push(email);
      return { id: `memory-${mailer.outbox.length}` };
    },
  };
  return mailer;
}
