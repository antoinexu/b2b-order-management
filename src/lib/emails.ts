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
