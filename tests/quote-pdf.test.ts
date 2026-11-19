import path from 'node:path';
import { getDocument } from 'pdfjs-dist/legacy/build/pdf.mjs';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { MAX_MONEY_CENTS } from '../src/lib/pricing';
import { formatAmount, pdfSafe, renderQuotePdf, wrapText, type QuotePdfData } from '../src/lib/quote-pdf';
import { createUser, registerOrg, setupTestApp, type Session } from './helpers';

// pdfjs reads these with fs in Node and wants forward slashes with a trailing slash, on every platform.
const standardFontDataUrl = `${path.resolve('node_modules/pdfjs-dist/standard_fonts').split(path.sep).join('/')}/`;

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

interface Placed { page: number; x: number; y: number; str: string }

/** Every text run with its page and position (PDF coordinates: y grows upwards). No-break spaces read as spaces. */
async function pdfRuns(pdf: Buffer): Promise<Placed[]> {
  const task = getDocument({ data: new Uint8Array(pdf), standardFontDataUrl, useSystemFonts: false, isEvalSupported: false });
  const document = await task.promise;
  const runs: Placed[] = [];
  for (let page = 1; page <= document.numPages; page++) {
    for (const item of (await (await document.getPage(page)).getTextContent()).items) {
      if (!('str' in item) || item.str.trim() === '') continue;
      runs.push({ page, x: item.transform[4] as number, y: item.transform[5] as number, str: item.str.replace(/\u00a0/g, ' ') });
    }
  }
  await task.destroy();
  return runs;
}

const normalize = (s: string) => s.replace(/\u00a0/g, ' ');

/**
 * Asserts the table invariant: each row's number, quantity, unit price, discount and amount are whole runs on
 * the same page and line as the first line of its description. Descriptions must start with a unique first line.
 */
function expectRowsIntact(runs: Placed[], data: QuotePdfData) {
  data.items.forEach((item, index) => {
    const firstLine = item.description.split('\n')[0]!;
    const starts = runs.filter((r) => r.str === firstLine);
    expect(starts, `first line of row ${index + 1}`).toHaveLength(1);
    const { page, y } = starts[0]!;
    const sameLine = runs.filter((r) => r.page === page && Math.abs(r.y - y) < 0.5).map((r) => r.str);
    const figures = [
      String(index + 1),
      item.quantity.toLocaleString('en-US'),
      normalize(formatAmount(item.unitPriceCents, data.quote.currency)),
      item.discountBps > 0 ? `${item.discountBps / 100}%` : '—',
      normalize(formatAmount(item.lineTotalCents, data.quote.currency)),
    ];
    for (const figure of figures) expect(sameLine, `row ${index + 1} on page ${page}`).toContain(figure);
  });
  const total = normalize(formatAmount(data.quote.totalCents, data.quote.currency));
  const label = runs.find((r) => r.str === `Total (${data.quote.currency})`)!;
  expect(runs.filter((r) => r.page === label.page && Math.abs(r.y - label.y) < 0.5).map((r) => r.str)).toContain(total);
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

describe('table layout', () => {
  const MAX = MAX_MONEY_CENTS;
  const bigQuote = (rows: number, lead: number): QuotePdfData => {
    const data = sample({ currency: 'CHF', taxRateBps: 0, subtotalCents: MAX, taxCents: 0, totalCents: MAX });
    data.items = Array.from({ length: rows }, (_, i) => ({
      // 1–4 line descriptions, shifted by `lead`, so rows of every height land at the bottom of some page.
      description: [`Row ${i + 1}: hydraulic pump assembly`, ...Array.from({ length: (i + lead) % 4 }, (_, k) => `spec line ${k + 1}`)].join('\n'),
      quantity: 1_000_000 - i, unitPriceCents: MAX - i, discountBps: i % 2 ? 9_999 : 0, lineTotalCents: MAX - i,
    }));
    return data;
  };

  it('keeps every row together and every amount on one line, even at the largest allowed values', async () => {
    expect(normalize(formatAmount(MAX, 'CHF'))).toBe('CHF 21,474,836.47');
    for (let lead = 0; lead < 4; lead++) {
      const data = bigQuote(60, lead);
      const runs = await pdfRuns(await renderQuotePdf(data));
      expect(Math.max(...runs.map((r) => r.page))).toBeGreaterThan(2);
      expectRowsIntact(runs, data);
      // No amount was split into pieces such as "CHF 21,474,836." and "47": amounts are whole, and short
      // numbers appear only in the row number column at the left edge.
      for (const run of runs.filter((r) => r.str.startsWith('CHF'))) expect(run.str).toMatch(/^CHF [\d,]+\.\d{2}$/);
      expect(runs.filter((r) => /^[\d.,]{1,3}$/.test(r.str) && r.x > 60)).toEqual([]);
    }
  });

  it('continues a description longer than a page under repeated column headings', async () => {
    const tall = Array.from({ length: 120 }, (_, i) => `L${i + 1}`).join('\n');
    expect(tall.length).toBeLessThanOrEqual(500); // within the API's description limit
    const data = sample();
    data.items = [
      ...Array.from({ length: 5 }, (_, i) => ({ description: `Before ${i + 1}`, quantity: 1, unitPriceCents: 100, discountBps: 0, lineTotalCents: 100 })),
      { description: tall, quantity: 7, unitPriceCents: 4_200, discountBps: 0, lineTotalCents: 29_400 },
      { description: 'After 1', quantity: 2, unitPriceCents: 100, discountBps: 0, lineTotalCents: 200 },
    ];
    const runs = await pdfRuns(await renderQuotePdf(data));
    expectRowsIntact(runs, data);

    // Every line appears once, in reading order (page by page, top to bottom).
    const lines = runs.filter((r) => /^L\d+$/.test(r.str));
    expect(lines.map((r) => r.str)).toEqual(Array.from({ length: 120 }, (_, i) => `L${i + 1}`));
    for (let i = 1; i < lines.length; i++) {
      const [a, b] = [lines[i - 1]!, lines[i]!];
      expect(b.page > a.page || (b.page === a.page && b.y < a.y), `${a.str} before ${b.str}`).toBe(true);
    }
    // Each page the description continues on starts with the column headings, above its first line.
    const pages = [...new Set(lines.map((r) => r.page))];
    expect(pages.length).toBeGreaterThan(1);
    for (const page of pages) {
      const heading = runs.find((r) => r.page === page && r.str === 'Description');
      const top = lines.find((r) => r.page === page)!;
      expect(heading, `headings on page ${page}`).toBeDefined();
      expect(heading!.y).toBeGreaterThan(top.y);
    }
    // The row's figures are printed once, with its first line; continuation pages repeat only its number.
    expect(runs.filter((r) => r.str === '$294.00')).toHaveLength(1);
    for (const page of pages) {
      const top = lines.find((r) => r.page === page)!;
      expect(runs.filter((r) => r.page === page && Math.abs(r.y - top.y) < 0.5).map((r) => r.str)).toContain('6');
    }
    // Lines stay inside the page body, clear of the footer.
    for (const line of lines) expect(line.y).toBeGreaterThan(90);
  });

  it('wraps text at spaces, breaks only over-long words, and keeps blank lines', () => {
    const measure = (s: string) => s.length;
    expect(wrapText('aa bb cc', 5, measure)).toEqual(['aa bb', 'cc']);
    expect(wrapText('abcdefghij x', 4, measure)).toEqual(['abcd', 'efgh', 'ij x']);
    expect(wrapText('one\n\ntwo', 10, measure)).toEqual(['one', '', 'two']);
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

  it('lays out the longest descriptions and largest amounts the API accepts', async () => {
    const customerId = (await admin.as('post', '/customers').send({ companyName: 'Big Buyer' }).expect(201)).body.id;
    const tall = Array.from({ length: 120 }, (_, i) => `L${i + 1}`).join('\n');
    const created = await admin.as('post', '/quotes').send({ customerId, currency: 'CHF', items: [
      { description: 'Turbine', quantity: 1, unitPriceCents: MAX_MONEY_CENTS - 1_000 },
      { description: tall, quantity: 1, unitPriceCents: 1_000 },
    ] }).expect(201);
    expect(created.body.items[1].description).toBe(tall);
    const res = await asBuffer(admin.as('get', `/quotes/${created.body.id}/pdf`)).expect(200);
    const runs = await pdfRuns(res.body as Buffer);
    expectRowsIntact(runs, { ...sample(), quote: { ...created.body, createdAt: new Date(created.body.createdAt) }, items: created.body.items });
    expect(runs.filter((r) => /^L\d+$/.test(r.str))).toHaveLength(120);
  });

  it('keeps other organizations and anonymous callers out', async () => {
    const other = await registerOrg(ctx.app, 'Snoop Org');
    await other.as('get', `/quotes/${quoteId}/pdf`).expect(404);
    await request(ctx.app).get(`/api/v1/quotes/${quoteId}/pdf`).expect(401);
  });
});
