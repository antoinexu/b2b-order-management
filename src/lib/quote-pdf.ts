import PDFDocument from 'pdfkit';

export interface QuotePdfData {
  organization: { name: string; timezone: string };
  quote: {
    number: string;
    status: string;
    createdAt: Date;
    validUntil: string | null;
    currency: string;
    notes: string | null;
    taxRateBps: number;
    subtotalCents: number;
    taxCents: number;
    totalCents: number;
  };
  customer: {
    companyName: string;
    contactName: string | null;
    email: string | null;
    phone: string | null;
    billingAddress: string | null;
    paymentTermsDays: number;
  };
  items: { description: string; quantity: number; unitPriceCents: number; discountBps: number; lineTotalCents: number }[];
  preparedBy: { name: string; email: string };
}

/**
 * The PDF uses the standard Helvetica fonts, which cover the Windows-1252 character set (English and most
 * Western European text, plus €, £ and ¥). Other characters would render as garbage, so they are replaced.
 */
const WIN_ANSI_EXTRAS = new Set('€‚ƒ„…†‡ˆ‰Š‹ŒŽ‘’“”•–—˜™š›œžŸ');
export function pdfSafe(text: string): string {
  return [...text]
    .map((c) => {
      const code = c.codePointAt(0)!;
      if (c === '\n' || (code >= 0x20 && code <= 0x7e) || (code >= 0xa0 && code <= 0xff) || WIN_ANSI_EXTRAS.has(c)) return c;
      return '?';
    })
    .join('');
}

/** Formats cents in the document currency, falling back to the ISO code where the symbol can't be shown (e.g. ₹). */
export function formatAmount(cents: number, currency: string): string {
  const amount = cents / 100;
  const symbol = new Intl.NumberFormat('en-US', { style: 'currency', currency }).format(amount);
  if (pdfSafe(symbol) === symbol) return symbol;
  return new Intl.NumberFormat('en-US', { style: 'currency', currency, currencyDisplay: 'code' }).format(amount);
}

const formatPercent = (bps: number) => `${Number((bps / 100).toFixed(2))}%`;
const formatDateTime = (date: Date, timeZone: string) =>
  new Intl.DateTimeFormat('en-US', { timeZone, year: 'numeric', month: 'short', day: 'numeric' }).format(date);
/** `validUntil` is a calendar date, not an instant, so it is formatted without any time zone shift. */
const formatCalendarDate = (isoDate: string) =>
  new Intl.DateTimeFormat('en-US', { timeZone: 'UTC', year: 'numeric', month: 'short', day: 'numeric' }).format(new Date(`${isoDate}T00:00:00Z`));

const WATERMARKS: Record<string, string> = { draft: 'DRAFT', expired: 'EXPIRED', rejected: 'REJECTED' };

const MARGIN = 50;
const FOOTER_SPACE = 40;
const COLOR = { text: '#18181b', muted: '#71717a', rule: '#e4e4e7', band: '#f4f4f5' };
const FONT = { regular: 'Helvetica', bold: 'Helvetica-Bold' };

export function renderQuotePdf(data: QuotePdfData): Promise<Buffer> {
  const { organization: org, quote, customer, items, preparedBy } = data;
  const doc = new PDFDocument({
    size: 'A4',
    margins: { top: MARGIN, bottom: MARGIN + FOOTER_SPACE, left: MARGIN, right: MARGIN },
    bufferPages: true,
    info: { Title: `Quote ${quote.number}`, Author: pdfSafe(org.name), Creator: 'B2B Order Management' },
  });
  const chunks: Buffer[] = [];
  doc.on('data', (chunk: Buffer) => chunks.push(chunk));
  const done = new Promise<Buffer>((resolve, reject) => {
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);
  });

  const left = MARGIN;
  const width = doc.page.width - MARGIN * 2;
  const right = left + width;
  const bottom = () => doc.page.height - doc.page.margins.bottom;
  const money = (cents: number) => formatAmount(cents, quote.currency);
  doc.fillColor(COLOR.text);

  // --- Header: organization on the left, document title on the right ---
  doc.font(FONT.bold).fontSize(18).text(pdfSafe(org.name), left, MARGIN, { width: width * 0.6 });
  const afterName = doc.y;
  doc.font(FONT.bold).fontSize(22).text('QUOTE', left, MARGIN, { width, align: 'right' });
  let y = Math.max(afterName, doc.y) + 24;

  // --- Bill-to block (left) and quote details (right) ---
  const blockTop = y;
  doc.font(FONT.bold).fontSize(9).fillColor(COLOR.muted).text('BILL TO', left, y);
  doc.font(FONT.bold).fontSize(11).fillColor(COLOR.text).text(pdfSafe(customer.companyName), left, doc.y + 4, { width: width * 0.5 });
  doc.font(FONT.regular).fontSize(10);
  for (const line of [customer.contactName, customer.billingAddress, customer.email, customer.phone]) {
    if (line) doc.text(pdfSafe(line), { width: width * 0.5 });
  }
  const leftEnd = doc.y;

  const details: [string, string][] = [
    ['Quote number', quote.number],
    ['Date', formatDateTime(quote.createdAt, org.timezone)],
    ['Valid until', quote.validUntil ? formatCalendarDate(quote.validUntil) : 'No expiry date'],
    ['Payment terms', `Net ${customer.paymentTermsDays} days`],
    ['Prepared by', pdfSafe(preparedBy.name)],
  ];
  const labelX = left + width * 0.55;
  const labelWidth = width * 0.2;
  y = blockTop;
  for (const [label, value] of details) {
    doc.font(FONT.regular).fontSize(10).fillColor(COLOR.muted).text(label, labelX, y, { width: labelWidth });
    doc.fillColor(COLOR.text).text(value, labelX + labelWidth, y, { width: right - labelX - labelWidth, align: 'right' });
    y = Math.max(doc.y, y + 15);
  }
  y = Math.max(leftEnd, y) + 28;

  // --- Line items ---
  const columns = [
    { key: '#', width: 24, align: 'left' as const },
    { key: 'Description', width: 0, align: 'left' as const },
    { key: 'Qty', width: 48, align: 'right' as const },
    { key: 'Unit price', width: 82, align: 'right' as const },
    { key: 'Discount', width: 56, align: 'right' as const },
    { key: 'Amount', width: 86, align: 'right' as const },
  ];
  columns[1]!.width = width - columns.reduce((sum, c) => sum + c.width, 0);
  const gap = 6;

  const drawRow = (cells: string[], top: number, font: string) => {
    let x = left;
    let height = 0;
    doc.font(font).fontSize(9.5).fillColor(COLOR.text);
    cells.forEach((cell, i) => {
      const column = columns[i]!;
      doc.text(cell, x + (i === 0 ? 4 : 0), top, { width: column.width - gap, align: column.align });
      height = Math.max(height, doc.y - top);
      x += column.width;
    });
    return height;
  };
  const drawHeader = (top: number) => {
    doc.rect(left, top, width, 20).fill(COLOR.band);
    drawRow(columns.map((c) => c.key), top + 6, FONT.bold);
    return top + 26;
  };

  y = drawHeader(y);
  items.forEach((item, index) => {
    const cells = [
      String(index + 1),
      pdfSafe(item.description),
      item.quantity.toLocaleString('en-US'),
      money(item.unitPriceCents),
      item.discountBps > 0 ? formatPercent(item.discountBps) : '—',
      money(item.lineTotalCents),
    ];
    doc.font(FONT.regular).fontSize(9.5);
    const height = doc.heightOfString(cells[1]!, { width: columns[1]!.width - gap });
    // Keep each row on one page, repeating the column headings on the next.
    if (y + height + 8 > bottom()) {
      doc.addPage();
      y = drawHeader(doc.page.margins.top);
    }
    const drawn = drawRow(cells, y, FONT.regular);
    y += drawn + 6;
    doc.moveTo(left, y - 3).lineTo(right, y - 3).lineWidth(0.5).strokeColor(COLOR.rule).stroke();
  });

  // --- Totals ---
  const totals: [string, string, boolean][] = [
    ['Subtotal', money(quote.subtotalCents), false],
    [`Tax (${formatPercent(quote.taxRateBps)})`, money(quote.taxCents), false],
    [`Total (${quote.currency})`, money(quote.totalCents), true],
  ];
  if (y + 70 > bottom()) {
    doc.addPage();
    y = doc.page.margins.top;
  }
  y += 8;
  const totalsX = left + width * 0.55;
  for (const [label, value, strong] of totals) {
    if (strong) {
      doc.moveTo(totalsX, y - 4).lineTo(right, y - 4).lineWidth(1).strokeColor(COLOR.text).stroke();
      y += 2;
    }
    doc.font(strong ? FONT.bold : FONT.regular).fontSize(strong ? 12 : 10).fillColor(COLOR.text);
    doc.text(label, totalsX, y, { width: width * 0.25 });
    doc.text(value, totalsX + width * 0.25, y, { width: width * 0.2, align: 'right' });
    y = doc.y + 6;
  }

  // --- Notes and terms (pdfkit flows long notes onto further pages) ---
  y += 16;
  const validity = quote.validUntil
    ? `This quote is valid through the end of ${formatCalendarDate(quote.validUntil)} (${org.timezone} time).`
    : 'This quote has no expiry date.';
  if (y + 60 > bottom()) {
    doc.addPage();
    y = doc.page.margins.top;
  }
  if (quote.notes) {
    doc.font(FONT.bold).fontSize(10).fillColor(COLOR.text).text('Notes', left, y);
    doc.font(FONT.regular).fontSize(10).text(pdfSafe(quote.notes), left, doc.y + 4, { width });
    y = doc.y + 14;
  }
  doc.font(FONT.regular).fontSize(9).fillColor(COLOR.muted)
    .text(`${validity} Prices are in ${quote.currency}. Questions? Contact ${pdfSafe(preparedBy.name)} at ${pdfSafe(preparedBy.email)}.`, left, y, { width });

  // --- Watermark and footer on every page ---
  const watermark = WATERMARKS[quote.status];
  const range = doc.bufferedPageRange();
  for (let i = range.start; i < range.start + range.count; i++) {
    doc.switchToPage(i);
    // Writing into the bottom margin would otherwise start a new page.
    const { bottom: savedBottom } = doc.page.margins;
    doc.page.margins.bottom = 0;
    if (watermark) {
      const cx = doc.page.width / 2;
      const cy = doc.page.height / 2;
      doc.save().rotate(-30, { origin: [cx, cy] }).fillOpacity(0.07).fillColor(COLOR.text)
        .font(FONT.bold).fontSize(110).text(watermark, 0, cy - 55, { width: doc.page.width, align: 'center', lineBreak: false })
        .restore();
      doc.fillOpacity(1);
    }
    doc.font(FONT.regular).fontSize(8).fillColor(COLOR.muted).text(
      `${quote.number}  ·  Page ${i - range.start + 1} of ${range.count}`,
      left, doc.page.height - MARGIN - 10, { width, align: 'right', lineBreak: false },
    );
    doc.page.margins.bottom = savedBottom;
  }

  doc.end();
  return done;
}
