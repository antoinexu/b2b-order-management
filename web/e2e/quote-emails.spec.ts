import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { expect, test, type APIRequestContext, type Page } from '@playwright/test';
import { linkFromEmail, OUTBOX_DIR } from './outbox';

async function setup(request: APIRequestContext, name: string) {
  const stamp = Date.now();
  const adminEmail = `${name.toLowerCase()}.${stamp}@quotes.example`;
  const admin = await (await request.post('/api/v1/auth/register', {
    data: { organizationName: `${name} Supply`, name: 'Ada Admin', email: adminEmail, password: 'Password123!' },
  })).json();
  const headers = { Authorization: `Bearer ${admin.token}` };
  const salesEmail = `sam.${stamp}@quotes.example`;
  expect((await request.post('/api/v1/users', { headers, data: { email: salesEmail, name: 'Sam Sales', role: 'sales', password: 'Password123!' } })).status()).toBe(201);
  const sales = await (await request.post('/api/v1/auth/login', { data: { email: salesEmail, password: 'Password123!' } })).json();
  const customerEmail = `dana.${stamp}@buyer.example`;
  const customer = await (await request.post('/api/v1/customers', {
    headers, data: { companyName: 'Buyer Co', contactName: 'Dana Buyer', email: customerEmail },
  })).json();
  const product = await (await request.post('/api/v1/products', { headers, data: { sku: `PUMP-${stamp}`, name: 'Pump', unitPriceCents: 12_500 } })).json();
  const salesHeaders = { Authorization: `Bearer ${sales.token}` };
  const quote = await (await request.post('/api/v1/quotes', {
    headers: salesHeaders, data: { customerId: customer.id, items: [{ productId: product.id, quantity: 2 }] },
  })).json();
  return { sales, salesEmail, salesHeaders, customerEmail, quote };
}

async function openAs(page: Page, token: string, url: string) {
  await page.addInitScript(t => localStorage.setItem('b2b.token', t), token);
  await page.goto(url);
}

function emailsTo(to: string) {
  return readdirSync(OUTBOX_DIR).sort().map((f) => JSON.parse(readFileSync(path.join(OUTBOX_DIR, f), 'utf8')))
    .filter((e: { to: string }) => e.to === to);
}

test('sales emails a quote, the customer accepts it online, and sales sees the outcome', async ({ page, browser, request }) => {
  const { sales, salesEmail, customerEmail, quote } = await setup(request, 'Loop');
  await openAs(page, sales.token, `/quotes/${quote.id}`);
  await page.getByRole('button', { name: 'Email to customer' }).click();
  const dialog = page.getByRole('dialog', { name: `Email ${quote.number}` });
  await expect(dialog.getByLabel('To')).toHaveValue(customerEmail);
  await expect(dialog.getByLabel('Recipient name (optional)')).toHaveValue('Dana Buyer');
  await expect(dialog.getByText(`${quote.number}.pdf`)).toBeVisible();
  await dialog.getByLabel('Message (optional)').fill('As discussed on the phone.');
  await dialog.getByRole('button', { name: 'Send email' }).click();
  await expect(page.getByText(`Quote emailed to ${customerEmail}`)).toBeVisible();
  await expect(dialog).toHaveCount(0);
  await expect(page.getByText('Sent', { exact: true }).first()).toBeVisible();
  const record = page.getByRole('listitem', { name: `Email to ${customerEmail}` });
  await expect(record).toContainText('Sent');
  await expect(record).toContainText('by Sam Sales');

  // The email carries the PDF and replies go to the salesperson.
  const link = await linkFromEmail(customerEmail);
  const [email] = emailsTo(customerEmail);
  expect(email.replyTo).toBe(salesEmail);
  expect(email.text).toContain('As discussed on the phone.');
  expect(email.attachments[0].filename).toBe(`${quote.number}.pdf`);
  expect(Buffer.from(email.attachments[0].content, 'base64').subarray(0, 5).toString()).toBe('%PDF-');

  // The customer, in their own browser and without an account.
  const customer = await (await browser.newContext()).newPage();
  await customer.goto(link);
  await expect(customer.getByRole('heading', { name: `Quote ${quote.number}` })).toBeVisible();
  await expect(customer.getByText('Loop Supply')).toBeVisible();
  await expect(customer.getByText('$250.00').first()).toBeVisible();
  const download = customer.waitForEvent('download');
  await customer.getByRole('button', { name: 'Download PDF' }).click();
  expect((await download).suggestedFilename()).toBe(`${quote.number}.pdf`);
  await customer.getByLabel('Your name').fill('Dana Buyer');
  await customer.getByRole('button', { name: `Accept quote ${quote.number}` }).click();
  await expect(customer.getByRole('heading', { name: 'Accepted' })).toBeVisible();
  await expect(customer.getByText(`Dana Buyer <${customerEmail}>`)).toBeVisible();
  await customer.reload();
  await expect(customer.getByRole('heading', { name: 'Accepted' })).toBeVisible();
  await expect(customer.getByRole('button', { name: /Accept quote/ })).toHaveCount(0);

  // Sales sees who accepted, gets notified, and can convert.
  await page.reload();
  await expect(page.getByText('Accepted', { exact: true }).first()).toBeVisible();
  await expect(page.getByText('Accepted by the customer online')).toBeVisible();
  await expect(page.getByText(`by Dana Buyer <${customerEmail}>`)).toBeVisible();
  await expect(page.getByRole('button', { name: 'Convert to order' })).toBeVisible();
  await expect.poll(() => emailsTo(salesEmail).map((e: { subject: string }) => e.subject))
    .toContain(`Quote ${quote.number} accepted by Buyer Co`);
});

test('a customer can decline with a reason', async ({ page, browser, request }) => {
  const { sales, salesHeaders, customerEmail, quote } = await setup(request, 'Decline');
  const sent = await request.post(`/api/v1/quotes/${quote.id}/deliveries`, { headers: { ...salesHeaders, 'Idempotency-Key': `decline-${Date.now()}` }, data: {} });
  expect(sent.status()).toBe(201);

  const customer = await (await browser.newContext()).newPage();
  await customer.goto(await linkFromEmail(customerEmail));
  await customer.getByRole('button', { name: 'Decline…' }).click();
  await customer.getByLabel('Your name').fill('Dana Buyer');
  await customer.getByLabel('Reason (optional)').fill('Found a closer supplier');
  await customer.getByRole('button', { name: 'Decline quote' }).click();
  await expect(customer.getByRole('heading', { name: 'Declined' })).toBeVisible();
  await expect(customer.getByText('"Found a closer supplier"')).toBeVisible();

  await openAs(page, sales.token, `/quotes/${quote.id}`);
  await expect(page.getByText('Declined by the customer online')).toBeVisible();
  await expect(page.getByText('Found a closer supplier')).toBeVisible();
});

test('a failed email is shown as failed, retried as the same email, and double clicks reuse one key', async ({ page, request }) => {
  const { sales, salesHeaders, customerEmail, quote } = await setup(request, 'Failing');
  const delivery = (status: 'failed' | 'sent', attempts: number) => ({
    id: '00000000-0000-4000-8000-000000000001', quoteId: quote.id, status, recipientEmail: customerEmail, recipientName: 'Dana Buyer',
    message: null, subject: `Quote ${quote.number} from Failing Supply`, sentById: sales.user.id, sentByName: 'Sam Sales', attempts,
    lastAttemptAt: new Date().toISOString(), lastError: status === 'failed' ? 'Resend rejected the email (422): invalid domain' : null,
    sentAt: status === 'sent' ? new Date().toISOString() : null, retryable: status === 'failed', createdAt: new Date().toISOString(),
  });
  // Simulate a mail provider outage for the first send; the retry succeeds.
  const keys: string[] = [];
  await page.route(`**/api/v1/quotes/${quote.id}/deliveries`, async (route) => {
    if (route.request().method() !== 'POST') return route.fallback();
    keys.push(route.request().headers()['idempotency-key']!);
    await new Promise((r) => setTimeout(r, 300));
    await route.fulfill({ status: 201, json: delivery('failed', 1) });
  });
  let retried = 0;
  await page.route('**/api/v1/quotes/*/deliveries/*/retry', async (route) => {
    retried++;
    await route.fulfill({ status: 200, json: delivery('sent', 2) });
  });

  await openAs(page, sales.token, `/quotes/${quote.id}`);
  await page.getByRole('button', { name: 'Email to customer' }).click();
  const dialog = page.getByRole('dialog', { name: `Email ${quote.number}` });
  await expect(dialog.getByLabel('To')).toHaveValue(customerEmail);
  await dialog.getByRole('button', { name: 'Send email' }).dblclick();
  await expect(dialog.getByRole('alert')).toHaveText('The email could not be sent: Resend rejected the email (422): invalid domain');
  // The quote is still a draft: nothing was marked as sent.
  expect((await (await request.get(`/api/v1/quotes/${quote.id}`, { headers: salesHeaders })).json()).status).toBe('draft');
  expect(new Set(keys).size).toBe(1);

  await dialog.getByRole('button', { name: 'Try again' }).click();
  await expect(page.getByText(`Quote emailed to ${customerEmail}`)).toBeVisible();
  expect(retried).toBe(1);
  expect(keys.length).toBeLessThanOrEqual(2);
});
