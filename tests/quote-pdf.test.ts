import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { getDocument } from 'pdfjs-dist/legacy/build/pdf.mjs';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { formatAmount, pdfSafe, renderQuotePdf, type QuotePdfData } from '../src/lib/quote-pdf';
import { createUser, registerOrg, setupTestApp, type Session } from './helpers';

// pdfjs wants a URL ending in a slash, on every platform.
const standardFontDataUrl = pathToFileURL(path.resolve('node_modules/pdfjs-dist/standard_fonts')).href + '/';

/** Text of each page, with runs joined by spaces. */
async function pdfPages(pdf: Buffer): Promise<string[]> {
  const task = getDocument({ data: new Uint8Array(pdf), standardFontDataUrl, useSystemFonts: false, isEvalSupported: false });
  const document = await task.promise;
  const pages: string[] = [];
  for (let n = 1; n <= document.numPages; n++) {
    const content = await (await document.getPage(n)).getTextContent();
    pages.push(content.items.map((item) => ('str' in item ? item.str : '')).join(' ').replace(/\s+/g, ' '));
  }
  await task.destroy();
  return pages;
}

const sample = (overrides: Partial<QuotePdfData['quote']> = {}, items = 2): QuotePdfData => ({
  organization: { name: 'Acme Industrial Supply', timezone: 'America/Chicago' },
  quote: {
    number: 'Q-000042', status: 'sent', createdAt: new Date('2026-11-20T03:00:00Z'), validUntil: '2026-12-31', currency: 'USD',
    notes: 'Delivery within 5 business days.', taxRateBps: 825, subtotalCents: 29_050, taxCents: 2_397, totalCents: 31_447, ...overrides,
  },
  customer: {
    companyName: 'Pinecrest Facilities', contactName: 'Dana Lee', email: 'dana@pinecrest.example', phone: '+1 555 0100',
    billingAddress: '12 Elm St\nSpringfield, IL', paymentTermsDays: 45,
  },
  items: Array.from({ length: items }, (_, i) => ({
    description: i === 0 ? 'Hex Bolt M8 x 50mm (box of 100)' : `Item ${i + 1}`,
    quantity: 10, unitPriceCents: 2450, discountBps: i === 0 ? 1000 : 0, lineTotalCents: i === 0 ? 22_050 : 24_500,
  })),
  preparedBy: { name: 'Sam Sales', email: 'sam@acme.example' },
});

describe('renderQuotePdf', () => {
  it('shows the organization, customer, lines, totals and terms', async () => {
    const pdf = await renderQuotePdf(sample());
    expect(pdf.subarray(0, 5).toString()).toBe('%PDF-');
    const [page] = await pdfPages(pdf);
    for (const text of [
      'Acme Industrial Supply', 'QUOTE', 'BILL TO', 'Pinecrest Facilities', 'Dana Lee', '12 Elm St', 'Springfield, IL',
      'dana@pinecrest.example', 'Q-000042', 'Net 45 days', 'Sam Sales', 'Dec 31, 2026',
      'Hex Bolt M8 x 50mm (box of 100)', '$24.50', '10%', '$220.50', 'Subtotal', '$290.50', 'Tax (8.25%)', '$23.97',
      'Total (USD)', '$314.47', 'Delivery within 5 business days.', 'valid through the end of Dec 31, 2026 (America/Chicago time)',
      'Contact Sam Sales at sam@acme.example', 'Q-000042 · Page 1 of 1',
    ]) expect(page).toContain(text);
    // Created at 03:00 UTC on Nov 20, which is still Nov 19 in Chicago.
    expect(page).toContain('Nov 19, 2026');
    expect(page).not.toContain('DRAFT');
  });

  it('marks drafts, expired and rejected quotes, but not sent or accepted ones', async () => {
    for (const [status, mark] of [['draft', 'DRAFT'], ['expired', 'EXPIRED'], ['rejected', 'REJECTED']] as const) {
      expect((await pdfPages(await renderQuotePdf(sample({ status }))))[0]).toContain(mark);
    }
    expect((await pdfPages(await renderQuotePdf(sample({ status: 'accepted' }))))[0]).not.toMatch(/DRAFT|EXPIRED|REJECTED/);
  });

  it('continues long quotes onto more pages, repeating the column headings', async () => {
    const pages = await pdfPages(await renderQuotePdf(sample({}, 120)));
    expect(pages.length).toBeGreaterThan(2);
    pages.forEach((page, i) => {
      expect(page).toContain(`Page ${i + 1} of ${pages.length}`);
      if (i < pages.length - 1 || page.includes('Item 120')) expect(page).toContain('Description');
    });
    expect(pages.join(' ')).toContain('Item 120');
    expect(pages.at(-1)).toContain('Total (USD)');
  });

  it('handles quotes without expiry, notes or contact details', async () => {
    const data = sample({ validUntil: null, notes: null });
    data.customer = { ...data.customer, contactName: null, email: null, phone: null, billingAddress: null };
    const [page] = await pdfPages(await renderQuotePdf(data));
    expect(page).toContain('No expiry date');
    expect(page).toContain('This quote has no expiry date.');
    expect(page).not.toContain('Notes');
  });

  it("formats each currency, and replaces what the PDF's fonts can't show", async () => {
    expect(formatAmount(123_456, 'EUR')).toBe('€1,234.56');
    expect(formatAmount(123_456, 'GBP')).toBe('£1,234.56');
    // Code formatting puts a no-break space between the code and the amount.
    expect(formatAmount(123_456, 'INR')).toBe('INR 1,234.56');
    expect(pdfSafe('Café Müller — 北京分公司')).toBe('Café Müller — ?????');
    const [page] = await pdfPages(await renderQuotePdf({ ...sample({ currency: 'EUR' }), organization: { name: 'Café Müller', timezone: 'UTC' } }));
    expect(page).toContain('Café Müller');
    expect(page).toContain('€314.47');
  });
});

describe('GET /quotes/:id/pdf', () => {
  let ctx: Awaited<ReturnType<typeof setupTestApp>>;
  let admin: Session, viewer: Session, quoteId: string;

  beforeAll(async () => {
    ctx = await setupTestApp();
    admin = await registerOrg(ctx.app, 'PDF Org');
    viewer = await createUser(ctx.app, admin, 'viewer');
    const customerId = (await admin.as('post', '/customers').send({ companyName: 'PDF Buyer', email: 'buyer@pdf.example', paymentTermsDays: 15 }).expect(201)).body.id;
    const productId = (await admin.as('post', '/products').send({ sku: 'GEAR', name: 'Gear', unitPriceCents: 1000 }).expect(201)).body.id;
    quoteId = (await admin.as('post', '/quotes').send({ customerId, taxRateBps: 500, items: [{ productId, quantity: 3 }] }).expect(201)).body.id;
  });
  afterAll(() => ctx.close());

  // supertest doesn't buffer binary bodies by default.
  const asBuffer = (test: request.Test) => test.buffer(true).parse((res, done) => {
    const chunks: Buffer[] = [];
    res.on('data', (chunk: Buffer) => chunks.push(chunk));
    res.on('end', () => done(null, Buffer.concat(chunks)));
  });

  it('downloads the current quote as a PDF for anyone who can read quotes', async () => {
    const res = await asBuffer(viewer.as('get', `/quotes/${quoteId}/pdf`)).expect(200);
    expect(res.headers['content-type']).toBe('application/pdf');
    expect(res.headers['content-disposition']).toBe('attachment; filename=Q-000001.pdf');
    expect(res.headers['cache-control']).toBe('private, no-store');
    const [page] = await pdfPages(res.body as Buffer);
    for (const text of ['PDF Org', 'PDF Buyer', 'buyer@pdf.example', 'Net 15 days', 'Org Admin', 'Gear', '$30.00', 'Tax (5%)', '$1.50', '$31.50', 'DRAFT']) {
      expect(page).toContain(text);
    }

    await admin.as('post', `/quotes/${quoteId}/send`).expect(200);
    const sent = await asBuffer(viewer.as('get', `/quotes/${quoteId}/pdf`)).expect(200);
    expect((await pdfPages(sent.body as Buffer))[0]).not.toContain('DRAFT');
  });

  it('keeps other organizations and anonymous callers out', async () => {
    const other = await registerOrg(ctx.app, 'Snoop Org');
    await other.as('get', `/quotes/${quoteId}/pdf`).expect(404);
    await request(ctx.app).get(`/api/v1/quotes/${quoteId}/pdf`).expect(401);
  });
});
