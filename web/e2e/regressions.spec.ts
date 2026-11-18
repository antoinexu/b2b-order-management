import { expect, test, type APIRequestContext, type Page } from '@playwright/test';

async function register(request: APIRequestContext, name: string) {
  const email = `${name.toLowerCase()}.${Date.now()}@regression.example`;
  const response = await request.post('/api/v1/auth/register', { data: { organizationName: name, name, email, password: 'Password123!' } });
  expect(response.status()).toBe(201);
  const session = await response.json();
  return { ...session, email, headers: { Authorization: `Bearer ${session.token}` } };
}

async function openAs(page: Page, session: { token: string }, url: string) {
  await page.addInitScript(token => localStorage.setItem('b2b.token', token), session.token);
  await page.goto(url);
}

async function create(request: APIRequestContext, session: { headers: Record<string, string> }, resource: string, data: Record<string, unknown>) {
  const response = await request.post(`/api/v1/${resource}`, { headers: session.headers, data });
  expect(response.status()).toBe(201);
  return response.json();
}

test('switching accounts in another tab removes stale forms and isolates writes', async ({ page, context, request }) => {
  const alpha = await register(request, 'Alpha');
  await openAs(page, alpha, '/customers');
  await expect(page.getByText('No customers yet', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'New customer' }).click();
  await page.getByLabel('Company name').fill('Unsaved Alpha customer');
  const other = await context.newPage();
  await other.goto('/');
  await other.getByRole('button', { name: 'Sign out' }).click();
  await expect(page.getByRole('heading', { name: 'Sign in', exact: true })).toBeVisible();
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await other.getByRole('link', { name: 'Create an organization' }).click();
  await other.getByLabel('Company name').fill('Bravo');
  await other.getByLabel('Your name').fill('Bravo');
  const email = `bravo.${Date.now()}@regression.example`;
  await other.getByLabel('Work email').fill(email);
  await other.getByLabel('Password').fill('Password123!');
  await other.getByRole('button', { name: 'Create organization' }).click();
  await expect(other.getByRole('heading', { name: 'Welcome back, Bravo' })).toBeVisible();
  await expect(page.getByText(email, { exact: true })).toBeVisible();
  await expect(page.getByText(alpha.email, { exact: true })).toHaveCount(0);
  await page.getByRole('navigation', { name: 'Main' }).getByRole('link', { name: 'Customers', exact: true }).click();
  await expect(page.getByText('No customers yet', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'New customer' }).click();
  await expect(page.getByLabel('Company name')).toHaveValue('');
  await page.getByLabel('Company name').fill('Bravo customer');
  await page.getByRole('button', { name: 'Save', exact: true }).click();
  await expect(page.getByRole('cell', { name: 'Bravo customer', exact: true })).toBeVisible();
  expect((await (await request.get('/api/v1/customers', { headers: alpha.headers })).json()).meta.total).toBe(0);
});

test('customer and product pickers search and paginate beyond 100 records and preserve edit selections', async ({ page, request }) => {
  const session = await register(request, 'Lookup');
  const customer = await create(request, session, 'customers', { companyName: 'Oldest Client 000' });
  const product = await create(request, session, 'products', { sku: 'ZZ-TARGET', name: 'Target product', unitPriceCents: 1250 });
  for (let index = 0; index < 100; index++) {
    await create(request, session, 'customers', { companyName: `New Client ${String(index).padStart(3, '0')}` });
    await create(request, session, 'products', { sku: `P-${String(index).padStart(3, '0')}`, name: `Product ${index}`, unitPriceCents: 100 });
  }
  await openAs(page, session, '/quotes/new');
  const customers = page.getByRole('combobox', { name: 'Customer', exact: true });
  await customers.click();
  await expect(page.getByRole('option')).toHaveCount(50);
  await page.getByRole('button', { name: 'Load more customers' }).click();
  await expect(page.getByRole('option')).toHaveCount(100);
  await page.getByRole('button', { name: 'Load more customers' }).click();
  await expect(page.getByRole('option')).toHaveCount(101);
  await customers.fill('Oldest Client');
  await expect(page.getByRole('option')).toHaveCount(1);
  await page.getByRole('option', { name: 'Oldest Client 000', exact: true }).click();
  await page.getByRole('combobox', { name: 'Line 1 product' }).fill('ZZ-TARGET');
  await page.getByRole('option', { name: /ZZ-TARGET/ }).click();
  await expect(page.getByLabel('Line 1 unit price')).toHaveValue('12.50');
  const saved = page.waitForResponse(response => response.request().method() === 'POST' && response.url().endsWith('/quotes'));
  await page.getByRole('button', { name: 'Create draft' }).click();
  const quote = await (await saved).json();
  expect(quote.customerId).toBe(customer.id);
  expect(quote.items[0].productId).toBe(product.id);
  await page.getByRole('link', { name: 'Edit', exact: true }).click();
  await expect(page.getByRole('combobox', { name: 'Customer', exact: true })).toHaveValue('Oldest Client 000');
  await expect(page.getByRole('combobox', { name: 'Line 1 product' })).toHaveValue(/ZZ-TARGET/);
  await expect(page.getByRole('button', { name: 'Save changes' })).toBeEnabled();
});

test('unsafe prices and overflowing totals show validation errors and the editor can recover', async ({ page, request }) => {
  const session = await register(request, 'Money');
  await create(request, session, 'customers', { companyName: 'Money Buyer' });
  await openAs(page, session, '/quotes/new');
  await page.getByRole('combobox', { name: 'Customer', exact: true }).click();
  await page.getByRole('option', { name: 'Money Buyer', exact: true }).click();
  await page.getByRole('combobox', { name: 'Line 1 product' }).click();
  await page.getByRole('option', { name: 'Custom item' }).click();
  await page.getByLabel('Line 1 description').fill('Service');
  await page.getByLabel('Line 1 unit price').fill('9'.repeat(310));
  await expect(page.getByRole('alert')).toContainText('Enter a unit price');
  await expect(page.getByRole('button', { name: 'Create draft' })).toBeDisabled();
  await expect(page.getByText('Unexpected Application Error!')).toHaveCount(0);
  await page.getByLabel('Line 1 unit price').fill('30');
  await page.getByLabel('Line 1 quantity').fill('');
  await expect(page.getByRole('alert')).toContainText('Quantity must');
  await page.getByLabel('Line 1 quantity').fill('1000001');
  await expect(page.getByRole('alert')).toContainText('Quantity must be');
  await page.getByLabel('Line 1 quantity').fill('1000000');
  await expect(page.getByRole('alert')).toContainText('must not exceed');
  await page.getByLabel('Line 1 quantity').fill('1');
  await page.getByLabel('Line 1 unit price').fill('20000000');
  await page.getByLabel('Tax rate (%)').fill('10');
  await expect(page.getByRole('alert')).toContainText('must not exceed');
  await expect(page.getByRole('button', { name: 'Create draft' })).toBeDisabled();
  await page.getByLabel('Line 1 unit price').fill('12.50');
  await page.getByLabel('Tax rate (%)').fill('0');
  await expect(page.getByRole('button', { name: 'Create draft' })).toBeEnabled();
  await page.getByRole('button', { name: 'Create draft' }).click();
  await expect(page.getByRole('heading', { name: /Q-\d+/ })).toBeVisible();
  await expect(page.getByText('$12.50', { exact: true }).first()).toBeVisible();
});

for (const resource of ['customers', 'products'] as const) {
  test(`deleting the final ${resource} row returns to the previous page`, async ({ page, request }) => {
    const session = await register(request, resource);
    for (let index = 0; index < 21; index++) await create(request, session, resource, resource === 'customers'
      ? { companyName: `Client ${String(index).padStart(3, '0')}` }
      : { sku: `P-${String(index).padStart(3, '0')}`, name: `Product ${String(index).padStart(3, '0')}`, unitPriceCents: 100 });
    await openAs(page, session, `/${resource}`);
    await page.getByRole('button', { name: 'Next page' }).click();
    await expect(page.getByText('Page 2 of 2')).toBeVisible();
    await page.getByRole('cell', { name: resource === 'customers' ? 'Client 000' : 'Product 020', exact: true }).click();
    await page.getByRole('button', { name: 'Delete', exact: true }).click();
    await page.getByRole('button', { name: resource === 'customers' ? 'Delete customer' : 'Delete product', exact: true }).click();
    await expect(page.getByText('Page 1 of 1')).toBeVisible();
    await expect(page.getByRole('row')).toHaveCount(21);
    await expect(page.getByRole('button', { name: 'Previous page' })).toBeDisabled();
    await expect(page.getByText(resource === 'customers' ? 'No customers yet' : 'No products yet', { exact: true })).toHaveCount(0);
  });
}

for (const action of ['retry', 'sign out'] as const) {
  test(`a failed account lookup offers ${action}`, async ({ page, request }) => {
    const session = await register(request, action === 'retry' ? 'Recovery' : 'Logout');
    let unavailable = true;
    await page.route('**/api/v1/auth/me', route => unavailable
      ? route.fulfill({ status: 503, contentType: 'application/json', body: JSON.stringify({ error: { code: 'UNAVAILABLE', message: 'Temporary outage' } }) })
      : route.continue());
    await openAs(page, session, '/');
    await expect(page.getByRole('alert')).toContainText('Temporary outage', { timeout: 10_000 });
    if (action === 'retry') {
      unavailable = false;
      await page.getByRole('button', { name: 'Try again' }).click();
      await expect(page.getByRole('heading', { name: 'Welcome back, Recovery' })).toBeVisible();
    } else {
      await page.getByRole('button', { name: 'Sign out' }).click();
      await expect(page.getByRole('heading', { name: 'Sign in', exact: true })).toBeVisible();
      expect(await page.evaluate(() => localStorage.getItem('b2b.token'))).toBeNull();
    }
  });
}

test('an EUR quote keeps EUR throughout editing and saving', async ({ page, request }) => {
  const session = await register(request, 'Currency');
  const buyer = await create(request, session, 'customers', { companyName: 'EUR Buyer' });
  const quote = await create(request, session, 'quotes', { customerId: buyer.id, currency: 'EUR',
    items: [{ description: 'EUR service', quantity: 1, unitPriceCents: 1000 }] });
  await openAs(page, session, `/quotes/${quote.id}/edit`);
  await expect(page.getByText('€10.00', { exact: true }).first()).toBeVisible();
  await expect(page.getByText('$10.00', { exact: true })).toHaveCount(0);
  await page.getByLabel('Line 1 quantity').fill('2');
  await expect(page.getByText('€20.00', { exact: true }).first()).toBeVisible();
  const response = page.waitForResponse(response => response.request().method() === 'PATCH' && response.url().endsWith(`/quotes/${quote.id}`));
  await page.getByRole('button', { name: 'Save changes' }).click();
  const saved = await (await response).json();
  expect(saved.currency).toBe('EUR');
  expect(saved.totalCents).toBe(2000);
});

test('a draft whose validity date has passed can still be saved, and is blocked only when sent', async ({ page, request }) => {
  const session = await register(request, 'PastDraft');
  const buyer = await create(request, session, 'customers', { companyName: 'Past Buyer' });
  const quote = await create(request, session, 'quotes', { customerId: buyer.id, validUntil: '2020-01-01',
    items: [{ description: 'Old offer', quantity: 1, unitPriceCents: 1000 }] });
  await openAs(page, session, `/quotes/${quote.id}/edit`);
  await expect(page.getByText(/This date has passed/)).toBeVisible();
  await page.getByLabel('Notes').fill('Only the notes changed');
  const response = page.waitForResponse(response => response.request().method() === 'PATCH' && response.url().endsWith(`/quotes/${quote.id}`));
  await page.getByRole('button', { name: 'Save changes' }).click();
  expect((await response).status()).toBe(200);
  await expect(page.getByText('Only the notes changed')).toBeVisible();

  await page.getByRole('button', { name: 'Mark as sent' }).click();
  await expect(page.getByText(/validUntil is in the past/)).toBeVisible();
});

test('saving the organization time zone adopts the canonical spelling', async ({ page, request }) => {
  const session = await register(request, 'ZoneCase');
  await openAs(page, session, '/users');
  const zone = page.getByLabel('Time zone');
  await zone.fill('america/new_york');
  await page.getByRole('button', { name: 'Save', exact: true }).click();
  await expect(page.getByText('Saved. Quote validity now follows America/New_York time.')).toBeVisible();
  await expect(zone).toHaveValue('America/New_York');
  await expect(page.getByRole('button', { name: 'Save', exact: true })).toBeDisabled();
});

test("sales can edit a draft priced beyond their limit as long as those lines stay unchanged", async ({ page, request }) => {
  const admin = await register(request, 'Limit');
  const buyer = await create(request, admin, 'customers', { companyName: 'Limit Buyer' });
  const product = await create(request, admin, 'products', { sku: 'DEAL', name: 'Deal item', unitPriceCents: 10_000 });
  const salesEmail = `sales.${Date.now()}@regression.example`;
  await create(request, admin, 'users', { email: salesEmail, name: 'Sam Sales', password: 'Password123!', role: 'sales' });
  const sales = await (await request.post('/api/v1/auth/login', { data: { email: salesEmail, password: 'Password123!' } })).json();
  const quote = await create(request, admin, 'quotes', { customerId: buyer.id,
    items: [{ productId: product.id, quantity: 1, discountBps: 5000 }] });

  await openAs(page, sales, `/quotes/${quote.id}/edit`);
  await expect(page.getByText(/You can give up to 20% off catalog prices/)).toBeVisible();
  await page.getByLabel('Notes').fill('Sales follow-up');
  const response = page.waitForResponse(response => response.request().method() === 'PATCH' && response.url().endsWith(`/quotes/${quote.id}`));
  await page.getByRole('button', { name: 'Save changes' }).click();
  expect((await response).status()).toBe(200);
  await expect(page.getByText('Sales follow-up')).toBeVisible();

  // Changing the discounted line is a new price decision, which the API rejects with a clear message.
  await page.goto(`/quotes/${quote.id}/edit`);
  await page.getByLabel('Line 1 discount percent').fill('49');
  await page.getByRole('button', { name: 'Save changes' }).click();
  await expect(page.getByRole('alert')).toContainText('Line 1: effective discount of 49% off the catalog price exceeds the 20% limit');
});

for (const resource of ['quotes', 'orders'] as const) {
  test(`sales can submit ${resource} after the catalog price drops while editing`, async ({ page, request }) => {
    const admin = await register(request, `Catalog${resource}`);
    await create(request, admin, 'customers', { companyName: 'Catalog Buyer' });
    const product = await create(request, admin, 'products', { sku: 'CHANGING', name: 'Changing price', unitPriceCents: 10_000 });
    const email = `sales.${resource}.${Date.now()}@regression.example`;
    await create(request, admin, 'users', { email, name: 'Catalog Sales', password: 'Password123!', role: 'sales' });
    const login = await request.post('/api/v1/auth/login', { data: { email, password: 'Password123!' } });
    expect(login.status()).toBe(200);
    await openAs(page, await login.json(), `/${resource}/new`);
    await page.getByRole('combobox', { name: 'Customer', exact: true }).click();
    await page.getByRole('option', { name: 'Catalog Buyer', exact: true }).click();
    await page.getByRole('combobox', { name: 'Line 1 product' }).click();
    await page.getByRole('option', { name: /CHANGING/ }).click();
    await expect(page.getByLabel('Line 1 unit price')).toHaveValue('100.00');
    await page.getByLabel('Line 1 unit price').fill('70');

    // Catalog previews must not prevent the server from checking the current price.
    const submit = page.getByRole('button', { name: resource === 'quotes' ? 'Create draft' : 'Create order', exact: true });
    await expect(submit).toBeEnabled();
    const rejected = page.waitForResponse(response => response.request().method() === 'POST' && response.url().endsWith(`/${resource}`));
    await submit.click();
    expect((await rejected).status()).toBe(403);
    await expect(page.getByRole('alert')).toContainText('Line 1: effective discount of 30%');

    // The same $70 price is now only 12.5% off, without reselecting the product or losing the draft.
    const changed = await request.patch(`/api/v1/products/${product.id}`, { headers: admin.headers, data: { unitPriceCents: 8000 } });
    expect(changed.status()).toBe(200);
    await expect(page.getByLabel('Line 1 unit price')).toHaveValue('70');
    await expect(page.getByRole('status').filter({ hasText: '30% off the catalog price' })).toContainText('checked when you save');
    const accepted = page.waitForResponse(response => response.request().method() === 'POST' && response.url().endsWith(`/${resource}`));
    await submit.click();
    const response = await accepted;
    expect(response.status()).toBe(201);
    const saved = await response.json();
    expect(saved.items[0].unitPriceCents).toBe(7000);
    expect(saved.totalCents).toBe(7000);
    await expect(page).toHaveURL(new RegExp(`/${resource}/${saved.id}$`));
  });
}

test('a manager-priced quote in another currency stays editable for sales without new lines', async ({ page, request }) => {
  const admin = await register(request, 'Foreign');
  const buyer = await create(request, admin, 'customers', { companyName: 'Foreign Buyer' });
  const salesEmail = `sales.${Date.now()}@foreign.example`;
  await create(request, admin, 'users', { email: salesEmail, name: 'Fran Sales', password: 'Password123!', role: 'sales' });
  const sales = await (await request.post('/api/v1/auth/login', { data: { email: salesEmail, password: 'Password123!' } })).json();
  const quote = await create(request, admin, 'quotes', { customerId: buyer.id, currency: 'EUR',
    items: [{ description: 'Setup', quantity: 1, unitPriceCents: 5000 }] });

  await openAs(page, sales, `/quotes/${quote.id}/edit`);
  await expect(page.getByText(/priced in EUR, but the catalog is in USD/)).toBeVisible();
  await page.getByLabel('Notes').fill('Kept in EUR');
  const response = page.waitForResponse(response => response.request().method() === 'PATCH' && response.url().endsWith(`/quotes/${quote.id}`));
  await page.getByRole('button', { name: 'Save changes' }).click();
  expect((await response).status()).toBe(200);

  await page.goto(`/quotes/${quote.id}/edit`);
  await page.getByLabel('Line 1 unit price').fill('40');
  await page.getByRole('button', { name: 'Save changes' }).click();
  await expect(page.getByRole('alert')).toContainText('Only a manager or admin can price in EUR; the catalog is priced in USD.');
});

test('a new quote keeps its currency when the organization switches base currency mid-edit', async ({ page, request }) => {
  const admin = await register(request, 'Switch');
  const buyer = await create(request, admin, 'customers', { companyName: 'Switch Buyer' });
  await page.clock.install();
  await openAs(page, admin, '/quotes/new');
  await page.getByRole('combobox', { name: 'Customer' }).click();
  await page.getByRole('option', { name: buyer.companyName }).click();
  await page.getByRole('combobox', { name: 'Line 1 product' }).click();
  await page.getByRole('option', { name: 'Custom item' }).click();
  await page.getByLabel('Line 1 description').fill('Consulting');
  await page.getByLabel('Line 1 unit price').fill('100');
  await expect(page.getByText('$100.00').first()).toBeVisible();

  const switched = await request.patch('/api/v1/organization', { headers: admin.headers, data: { currency: 'EUR' } });
  expect(switched.status()).toBe(200);
  // Let the cached account go stale, then signal the tab became visible again (TanStack Query listens on window).
  await page.clock.fastForward(61_000);
  await page.evaluate(() => window.dispatchEvent(new Event('visibilitychange')));
  await expect(page.getByText(/base currency changed to EUR while you were editing/)).toBeVisible();
  await expect(page.getByText('$100.00').first()).toBeVisible();
  await expect(page.getByText('€100.00')).toHaveCount(0);

  const response = page.waitForResponse(response => response.request().method() === 'POST' && response.url().endsWith('/api/v1/quotes'));
  await page.getByRole('button', { name: 'Create draft' }).click();
  expect((await response).status()).toBe(201);
  expect((await (await response).json()).currency).toBe('USD');
});
