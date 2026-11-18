import { expect, test, type Page } from '@playwright/test';

async function loginAs(page: Page, role: 'admin' | 'manager' | 'sales' | 'viewer') {
  await page.goto('/login');
  await page.getByRole('button', { name: role[0]!.toUpperCase() + role.slice(1), exact: true }).click();
  await expect(page.getByRole('heading', { name: /Welcome back/ })).toBeVisible();
}

/** Sidebar links only (the dashboard also has cards linking to the same pages). */
const nav = (page: Page, name: string) => page.getByRole("navigation", { name: "Main" }).getByRole("link", { name, exact: true });

async function choose(page: Page, combobox: string, option: string | RegExp) {
  await page.getByRole('combobox', { name: combobox }).click();
  await page.getByRole('option', { name: option }).click();
}

test('sales quotes a customer, converts it, and a manager fulfils the order', async ({ page }) => {
  // --- Sales builds a quote with a catalog line and a custom service line ---
  await loginAs(page, 'sales');
  await nav(page, 'Quotes').click();
  await page.getByRole('link', { name: 'New quote' }).click();

  await choose(page, 'Customer', 'Pinecrest Facilities');
  await page.getByLabel('Tax rate (%)').fill('10');
  await choose(page, 'Line 1 product', /BOLT-M8-50/);
  await page.getByLabel('Line 1 quantity').fill('10'); // 10 x $24.50 = $245.00

  await page.getByRole('button', { name: 'Add line' }).click();
  await choose(page, 'Line 2 product', 'Custom item');
  await page.getByLabel('Line 2 description').fill('Installation service');
  await page.getByLabel('Line 2 unit price').fill('100');
  // Sales can't discount custom lines, but can price them.
  await page.getByLabel('Line 2 discount percent').fill('25');
  await expect(page.getByRole('alert')).toHaveText("Custom lines can't be discounted.");
  await expect(page.getByRole('button', { name: 'Create draft' })).toBeDisabled();
  await page.getByLabel('Line 2 discount percent').fill('0');
  await page.getByLabel('Line 2 unit price').fill('75'); // $75.00
  // Catalog discounts show an advisory preview; current prices are enforced by the API on save.
  await page.getByLabel('Line 1 discount percent').fill('25');
  await expect(page.getByRole('status').filter({ hasText: '25% off the catalog price' }))
    .toContainText('Current pricing will be checked when you save.');
  await expect(page.getByRole('button', { name: 'Create draft' })).toBeEnabled();
  await page.getByLabel('Line 1 discount percent').fill('0');

  // Live preview uses the same integer math as the server: 320.00 + 10% tax.
  await expect(page.getByText('$352.00')).toBeVisible();
  await page.getByRole('button', { name: 'Create draft' }).click();

  // --- Quote lifecycle ---
  await expect(page.getByRole('heading', { name: /Q-\d{6}/ })).toBeVisible();
  await expect(page.getByText('Draft', { exact: true })).toBeVisible();
  const quoteNumber = (await page.getByRole('heading', { name: /Q-\d{6}/ }).textContent())!.match(/Q-\d{6}/)![0];

  await page.getByRole('button', { name: 'Mark as sent' }).click();
  await expect(page.getByText('Sent', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Accepted' }).click();
  await expect(page.getByText('Accepted', { exact: true })).toBeVisible();
  // Every transition is audited with who made it.
  for (const step of ['Created', 'Marked as sent', 'Marked as accepted']) {
    await expect(page.getByText(step, { exact: true })).toBeVisible();
  }
  await expect(page.getByText(/by Demo Sales/)).toHaveCount(3);

  await page.getByRole('button', { name: 'Convert to order' }).click();
  await page.getByLabel('Customer PO number (optional)').fill('PO-E2E-1');
  await page.getByRole('button', { name: 'Create order' }).click();

  await expect(page.getByRole('heading', { name: /SO-\d{6}/ })).toBeVisible();
  await expect(page.getByText('PO-E2E-1')).toBeVisible();
  await expect(page.getByText('$352.00')).toBeVisible();
  const orderUrl = page.url();
  // Sales can place orders but not move them through fulfilment.
  await expect(page.getByRole('heading', { name: 'Update status' })).toHaveCount(0);

  // The quote remembers it was converted (convert button gone once it's an order).
  await page.getByRole('link', { name: 'From quote' }).click();
  await expect(page.getByRole('heading', { name: new RegExp(quoteNumber) })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Convert to order' })).toBeVisible(); // still accepted; a second convert would be rejected by the API

  // --- Manager fulfils the order ---
  await page.getByRole('button', { name: 'Sign out' }).click();
  await loginAs(page, 'manager');
  await page.goto(orderUrl);
  await page.getByRole('button', { name: 'Confirm order' }).click();
  await expect(page.getByText('Confirmed', { exact: true }).first()).toBeVisible();
  await page.getByLabel('Status change note').fill('UPS 1Z999AA10123456784');
  await page.getByRole('button', { name: 'Mark shipped' }).click();

  const history = page.getByRole('list').filter({ hasText: 'Pending' });
  await expect(history).toContainText('Shipped');
  await expect(history).toContainText('UPS 1Z999AA10123456784');
  // Only valid next steps are offered: shipped orders can be delivered, not cancelled.
  await expect(page.getByRole('button', { name: 'Mark delivered' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Cancel order' })).toHaveCount(0);
});

test('viewers get a read-only interface', async ({ page }) => {
  await loginAs(page, 'viewer');
  await expect(nav(page, 'Team')).toHaveCount(0);

  await nav(page, 'Quotes').click();
  await expect(page.getByRole('row', { name: /Q-000001/ })).toBeVisible();
  await expect(page.getByRole('link', { name: 'New quote' })).toHaveCount(0);

  await page.goto('/quotes/new');
  await expect(page.getByRole('heading', { name: "You don't have access to this page" })).toBeVisible();
});

test('a new organization starts empty and isolated from the demo tenant', async ({ page }) => {
  await page.goto('/register');
  await page.getByLabel('Company name').fill('Fresh Start Inc');
  await page.getByLabel('Your name').fill('Riley Founder');
  await page.getByLabel('Work email').fill(`riley.${Date.now()}@fresh.example`);
  await page.getByLabel('Password').fill('Password123!');
  await page.getByRole('button', { name: 'Create organization' }).click();

  await expect(page.getByRole('heading', { name: 'Welcome back, Riley' })).toBeVisible();
  await nav(page, 'Customers').click();
  await expect(page.getByText('No customers yet')).toBeVisible();

  await page.getByRole('button', { name: 'New customer' }).click();
  await page.getByLabel('Company name').fill('First Client LLC');
  await page.getByRole('button', { name: 'Save' }).click();
  await expect(page.getByRole('cell', { name: 'First Client LLC' })).toBeVisible();
  await expect(page.getByRole('cell', { name: 'Summit Manufacturing Co.' })).toHaveCount(0);
});

test('expired sessions return to the login page', async ({ page }) => {
  await loginAs(page, 'admin');
  await page.evaluate(() => localStorage.setItem('b2b.token', 'tampered.token.value'));
  await page.goto('/customers');
  await expect(page.getByRole('heading', { name: 'Sign in' })).toBeVisible();
});

test('changing the password keeps this session and retires the old password', async ({ page }) => {
  const email = `pat.${Date.now()}@password.example`;
  await page.goto('/register');
  await page.getByLabel('Company name').fill('Password Co');
  await page.getByLabel('Your name').fill('Pat Owner');
  await page.getByLabel('Work email').fill(email);
  await page.getByLabel('Password').fill('Password123!');
  await page.getByRole('button', { name: 'Create organization' }).click();
  await expect(page.getByRole('heading', { name: 'Welcome back, Pat' })).toBeVisible();

  await page.getByRole('button', { name: 'Change password' }).click();
  await page.getByLabel('Current password').fill('wrong-password');
  await page.getByLabel('New password', { exact: true }).fill('NewPassword456!');
  await page.getByLabel('Confirm new password').fill('NewPassword456!');
  await page.getByRole('dialog').getByRole('button', { name: 'Change password' }).click();
  await expect(page.getByRole('alert')).toHaveText('Current password is incorrect');

  await page.getByLabel('Current password').fill('Password123!');
  await page.getByRole('dialog').getByRole('button', { name: 'Change password' }).click();
  await expect(page.getByText('Password changed. Other sessions were signed out.')).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Welcome back, Pat' })).toBeVisible();

  await page.getByRole('button', { name: 'Sign out' }).click();
  await page.getByLabel('Email').fill(email);
  await page.getByLabel('Password').fill('Password123!');
  await page.getByRole('button', { name: 'Sign in', exact: true }).click();
  await expect(page.getByRole('alert')).toContainText('Invalid email or password');
  await page.getByLabel('Password').fill('NewPassword456!');
  await page.getByRole('button', { name: 'Sign in', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Welcome back, Pat' })).toBeVisible();
});
