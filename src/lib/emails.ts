import type { OutgoingEmail } from './mailer';

const escapeHtml = (value: string) =>
  value.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);

function layout(paragraphs: string[], action: { label: string; url: string }, footer: string) {
  const body = paragraphs.map((p) => `<p style="margin:0 0 16px">${escapeHtml(p)}</p>`).join('');
  return `<!doctype html><html><body style="margin:0;padding:24px;background:#f4f4f5;font-family:system-ui,sans-serif;color:#18181b">
<div style="max-width:480px;margin:0 auto;background:#fff;border-radius:8px;padding:32px;line-height:1.5">
${body}
<p style="margin:24px 0"><a href="${escapeHtml(action.url)}" style="background:#18181b;color:#fff;padding:10px 18px;border-radius:6px;text-decoration:none;display:inline-block">${escapeHtml(action.label)}</a></p>
<p style="margin:0;font-size:13px;color:#71717a">${escapeHtml(footer)}</p>
</div></body></html>`;
}

export function invitationEmail(input: {
  to: string; name: string; inviterName: string; organizationName: string; role: string; url: string; expiresInDays: number;
}): OutgoingEmail {
  const intro = `Hi ${input.name},`;
  const invite = `${input.inviterName} invited you to join ${input.organizationName} on B2B Order Management as ${input.role}.`;
  const footer = `This invitation expires in ${input.expiresInDays} days. If you weren't expecting it, you can ignore this email.`;
  return {
    to: input.to,
    subject: `Join ${input.organizationName} on B2B Order Management`,
    text: `${intro}\n\n${invite}\n\nChoose a password to accept:\n${input.url}\n\n${footer}\n`,
    html: layout([intro, invite], { label: 'Accept invitation', url: input.url }, footer),
  };
}

export function passwordResetEmail(input: { to: string; name: string; url: string; expiresInMinutes: number }): OutgoingEmail {
  const intro = `Hi ${input.name},`;
  const request = 'Someone asked to reset the password for your B2B Order Management account.';
  const footer = `This link expires in ${input.expiresInMinutes} minutes and works once. If you didn't ask for it, ignore this email; your password stays the same.`;
  return {
    to: input.to,
    subject: 'Reset your B2B Order Management password',
    text: `${intro}\n\n${request}\n\nChoose a new password:\n${input.url}\n\n${footer}\n`,
    html: layout([intro, request], { label: 'Reset password', url: input.url }, footer),
  };
}

/**
 * Stands in for the customer's link in a stored email body. Each delivery attempt mints a new link token
 * (only its hash is stored), so the link is filled in at send time.
 */
export const QUOTE_LINK_PLACEHOLDER = 'https://quote-link.invalid/placeholder';

export function quoteEmail(input: {
  recipientName: string | null; organizationName: string; senderName: string; quoteNumber: string;
  total: string; validUntil: string | null; message: string | null;
}): Pick<OutgoingEmail, 'subject' | 'text' | 'html'> {
  const greeting = input.recipientName ? `Hi ${input.recipientName},` : 'Hello,';
  const intro = `${input.senderName} at ${input.organizationName} sent you quote ${input.quoteNumber} for ${input.total}. The PDF is attached.`;
  const validity = input.validUntil ? `It is valid through ${input.validUntil}.` : 'It has no expiry date.';
  const action = 'You can review it and accept or decline online:';
  const footer = `Reply to this email to reach ${input.senderName} directly.`;
  const paragraphs = [greeting, intro, ...(input.message ? [input.message] : []), `${validity} ${action}`];
  return {
    subject: `Quote ${input.quoteNumber} from ${input.organizationName}`,
    text: `${paragraphs.join('\n\n')}\n${QUOTE_LINK_PLACEHOLDER}\n\n${footer}\n`,
    html: layout(paragraphs, { label: 'Review quote', url: QUOTE_LINK_PLACEHOLDER }, footer),
  };
}

export function quoteResponseEmail(input: {
  to: string; quoteNumber: string; customerName: string; decision: 'accepted' | 'rejected'; respondent: string;
  note: string | null; url: string;
}): OutgoingEmail {
  const headline = `${input.respondent} ${input.decision} quote ${input.quoteNumber} for ${input.customerName}.`;
  const paragraphs = [headline, ...(input.note ? [`Their note: "${input.note}"`] : [])];
  const next = input.decision === 'accepted' ? 'You can now convert it into an order.' : 'You can follow up with them or prepare a new quote.';
  return {
    to: input.to,
    subject: `Quote ${input.quoteNumber} ${input.decision} by ${input.customerName}`,
    text: `${paragraphs.join('\n\n')}\n\n${next}\n${input.url}\n`,
    html: layout(paragraphs, { label: 'Open quote', url: input.url }, next),
  };
}
