import { expect, test, type APIRequestContext, type Page } from '@playwright/test';
import { linkFromEmail } from './outbox';

async function register(request: APIRequestContext, name: string) {
  const email = `${name.toLowerCase()}.${Date.now()}@accounts.example`;
  const response = await request.post('/api/v1/auth/register', { data: { organizationName: `${name} Inc`, name: `${name} Admin`, email, password: 'Password123!' } });
  expect(response.status()).toBe(201);
  const session = await response.json();
  return { ...session, email, headers: { Authorization: `Bearer ${session.token}` } };
}

async function openAs(page: Page, session: { token: string }, url: string) {
  await page.addInitScript(token => localStorage.setItem('b2b.token', token), session.token);
  await page.goto(url);
}

async function choosePassword(page: Page, password: string) {
  await page.getByLabel('New password').fill(password);
  await page.getByLabel('Confirm password').fill(password);
}

test('an admin invites a teammate, who accepts by email and signs in', async ({ page, browser, request }) => {
  const admin = await register(request, 'Invites');
  const inviteeEmail = `riley.${Date.now()}@accounts.example`;

  await openAs(page, admin, '/users');
  await page.getByRole('button', { name: 'Invite member' }).click();
  const dialog = page.getByRole('dialog', { name: 'Invite team member' });
  await dialog.getByLabel('Name').fill('Riley Teammate');
  await dialog.getByLabel('Email').fill(inviteeEmail);
  await expect(dialog.getByText(/email them a link to choose their own password/)).toBeVisible();
  await dialog.getByRole('button', { name: 'Send invitation' }).click();
  await expect(page.getByText(`Invitation sent to ${inviteeEmail}`)).toBeVisible();
  const row = page.getByRole('row', { name: new RegExp(inviteeEmail) });
  await expect(row.getByText('Invited', { exact: true })).toBeVisible();

  // Resending replaces the first link.
  const firstLink = await linkFromEmail(inviteeEmail, 1);
  await row.getByRole('button', { name: `Resend invitation to ${inviteeEmail}` }).click();
  await expect(page.getByText(/New invitation sent/)).toBeVisible();
  const link = await linkFromEmail(inviteeEmail, 2);
  expect(link).toContain('/accept-invitation#token=');

  // The invitee opens the email in their own browser.
  const invitee = await (await browser.newContext()).newPage();
  await invitee.goto(firstLink);
  await expect(invitee.getByRole('alert')).toContainText('This link is invalid, has expired or was already used.');

  await invitee.goto(link);
  await expect(invitee.getByRole('heading', { name: 'Join Invites Inc' })).toBeVisible();
  await expect(invitee.getByText(`You're invited as sales with ${inviteeEmail}.`)).toBeVisible();
  await expect(invitee.getByLabel('Your name')).toHaveValue('Riley Teammate');
  await invitee.getByLabel('New password').fill('Riley-pass-123');
  await invitee.getByLabel('Confirm password').fill('Riley-pass-12');
  await expect(invitee.getByText("Passwords don't match.")).toBeVisible();
  await expect(invitee.getByRole('button', { name: 'Join Invites Inc' })).toBeDisabled();
  await invitee.getByLabel('Confirm password').fill('Riley-pass-123');
  await invitee.getByRole('button', { name: 'Join Invites Inc' }).click();
  await expect(invitee.getByRole('heading', { name: 'Welcome back, Riley' })).toBeVisible();
  await expect(invitee.getByText('Welcome to Invites Inc!')).toBeVisible();

  // The link is spent, and the admin now sees an active member.
  await invitee.goto(link);
  await expect(invitee.getByRole('alert')).toContainText('was already used');
  await page.reload();
  await expect(page.getByRole('row', { name: new RegExp(inviteeEmail) }).getByText('Invited', { exact: true })).toHaveCount(0);
  const login = await request.post('/api/v1/auth/login', { data: { email: inviteeEmail, password: 'Riley-pass-123' } });
  expect(login.status()).toBe(200);
});

test('an invitation link opened in a browser signed in to another account switches to the invited account', async ({ page, request }) => {
  const admin = await register(request, 'Switcher');
  const email = `sam.${Date.now()}@accounts.example`;
  const created = await request.post('/api/v1/users', { headers: admin.headers, data: { email, name: 'Sam Viewer', role: 'viewer' } });
  expect(created.status()).toBe(201);

  await openAs(page, admin, await linkFromEmail(email));
  await expect(page.getByText(/signed in to another account in this browser/)).toBeVisible();
  await choosePassword(page, 'Sam-pass-1234');
  await page.getByRole('button', { name: 'Join Switcher Inc' }).click();
  await expect(page.getByRole('heading', { name: 'Welcome back, Sam' })).toBeVisible();
});

test('cancelling an invitation removes it and lets the admin invite the same email again', async ({ page, request }) => {
  const admin = await register(request, 'Canceller');
  const email = `typo.${Date.now()}@accounts.example`;
  expect((await request.post('/api/v1/users', { headers: admin.headers, data: { email, name: 'Tpyo Name', role: 'viewer' } })).status()).toBe(201);
  const link = await linkFromEmail(email);

  await openAs(page, admin, '/users');
  await page.getByRole('button', { name: `Cancel invitation for ${email}` }).click();
  await page.getByRole('alertdialog').getByRole('button', { name: 'Cancel invitation' }).click();
  await expect(page.getByText(`Invitation for ${email} cancelled`)).toBeVisible();
  await expect(page.getByRole('row', { name: new RegExp(email) })).toHaveCount(0);

  await page.goto(link);
  await expect(page.getByRole('alert')).toContainText('This link is invalid');
  expect((await request.post('/api/v1/users', { headers: admin.headers, data: { email, name: 'Typo Name', role: 'viewer' } })).status()).toBe(201);
});

test('a user who forgot their password resets it by email', async ({ page, request }) => {
  const account = await register(request, 'Forgetful');

  await page.goto('/login');
  await page.getByLabel('Email').fill(account.email);
  await page.getByRole('link', { name: 'Forgot password?' }).click();
  await expect(page.getByRole('heading', { name: 'Reset your password' })).toBeVisible();
  await expect(page.getByLabel('Email')).toHaveValue(account.email);
  await page.getByRole('button', { name: 'Send reset link' }).click();
  await expect(page.getByRole('status')).toContainText(`If an account exists for ${account.email}, a reset link is on its way.`);

  await page.goto(await linkFromEmail(account.email));
  await expect(page.getByRole('heading', { name: 'Choose a new password' })).toBeVisible();
  await choosePassword(page, 'Recovered-pass-1');
  await page.getByRole('button', { name: 'Set password and sign in' }).click();
  await expect(page.getByRole('heading', { name: 'Welcome back, Forgetful' })).toBeVisible();
  await expect(page.getByText('Password updated. You were signed out everywhere else.')).toBeVisible();

  // The old password and the old session no longer work.
  expect((await request.post('/api/v1/auth/login', { data: { email: account.email, password: 'Password123!' } })).status()).toBe(401);
  expect((await request.get('/api/v1/auth/me', { headers: account.headers })).status()).toBe(401);
});

test('incomplete or unknown links explain what to do next', async ({ page }) => {
  await page.goto('/reset-password');
  await expect(page.getByRole('alert')).toContainText('Open the link from your email again');
  await expect(page.getByRole('link', { name: 'Request a new link' })).toBeVisible();

  await page.goto(`/reset-password#token=${'x'.repeat(43)}`);
  await choosePassword(page, 'Whatever-pass-1');
  await page.getByRole('button', { name: 'Set password and sign in' }).click();
  await expect(page.getByRole('alert')).toContainText('This link is invalid, has expired or was already used.');

  await page.goto(`/accept-invitation#token=${'x'.repeat(43)}`);
  await expect(page.getByRole('alert')).toContainText('Ask your admin to resend it');
});
