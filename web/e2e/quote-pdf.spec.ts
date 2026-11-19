import { readFileSync } from 'node:fs';
import { expect, test } from '@playwright/test';

test('anyone who can read a quote can download it as a PDF', async ({ page, request }) => {
  const email = `pdf.${Date.now()}@pdf.example`;
  const registered = await request.post('/api/v1/auth/register', { data: { organizationName: 'PDF Co', name: 'Pat', email, password: 'Password123!' } });
  const admin = await registered.json();
  const headers = { Authorization: `Bearer ${admin.token}` };
  const customer = await (await request.post('/api/v1/customers', { headers, data: { companyName: 'PDF Buyer' } })).json();
  const quote = await (await request.post('/api/v1/quotes', { headers, data: {
    customerId: customer.id, items: [{ description: 'Consulting', quantity: 2, unitPriceCents: 15_000 }],
  } })).json();
  await request.post('/api/v1/users', { headers, data: { email: `v.${email}`, name: 'Vic Viewer', role: 'viewer', password: 'Password123!' } });
  const viewer = await (await request.post('/api/v1/auth/login', { data: { email: `v.${email}`, password: 'Password123!' } })).json();

  await page.addInitScript(token => localStorage.setItem('b2b.token', token), viewer.token);
  await page.goto(`/quotes/${quote.id}`);
  await expect(page.getByRole('heading', { name: new RegExp(quote.number) })).toBeVisible();
  const download = page.waitForEvent('download');
  await page.getByRole('button', { name: 'PDF' }).click();
  const file = await download;
  expect(file.suggestedFilename()).toBe(`${quote.number}.pdf`);
  expect(readFileSync(await file.path()).subarray(0, 5).toString()).toBe('%PDF-');
});
