import { relations, sql } from 'drizzle-orm';
import {
  pgTable, pgEnum, uuid, text, integer, timestamp, date, uniqueIndex, index, check, customType,
} from 'drizzle-orm/pg-core';

/** Raw bytes, e.g. a PDF snapshot. */
const bytea = customType<{ data: Buffer; driverData: Buffer | Uint8Array }>({
  dataType: () => 'bytea',
  fromDriver: (value) => Buffer.from(value),
});

export const USER_ROLES = ['admin', 'manager', 'sales', 'viewer'] as const;
export const QUOTE_STATUSES = ['draft', 'sent', 'accepted', 'rejected', 'expired'] as const;
export const ORDER_STATUSES = ['pending', 'confirmed', 'shipped', 'delivered', 'cancelled'] as const;
export const USER_TOKEN_PURPOSES = ['invite', 'password_reset'] as const;
/** `sending` is held while a delivery attempt is in flight, so concurrent attempts cannot send the same email twice. */
export const QUOTE_DELIVERY_STATUSES = ['sending', 'sent', 'failed'] as const;

export const userRole = pgEnum('user_role', USER_ROLES);
export const quoteStatus = pgEnum('quote_status', QUOTE_STATUSES);
export const orderStatus = pgEnum('order_status', ORDER_STATUSES);
export const userTokenPurpose = pgEnum('user_token_purpose', USER_TOKEN_PURPOSES);
export const quoteDeliveryStatus = pgEnum('quote_delivery_status', QUOTE_DELIVERY_STATUSES);

const timestamps = {
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow().$onUpdate(() => new Date()),
};

/** A tenant. Every business record belongs to exactly one organization. */
export const organizations = pgTable('organizations', {
  id: uuid('id').primaryKey().defaultRandom(),
  name: text('name').notNull(),
  /** IANA time zone; quote validity dates end at midnight in this zone. */
  timezone: text('timezone').notNull().default('UTC'),
  /** Largest effective discount (bps) that users without `pricing:override` may give on a line. */
  maxDiscountBps: integer('max_discount_bps').notNull().default(2000),
  /** ISO 4217 code the catalog is priced in. Users without `pricing:override` can only quote and order in it. */
  currency: text('currency').notNull().default('USD'),
  quoteSeq: integer('quote_seq').notNull().default(0),
  orderSeq: integer('order_seq').notNull().default(0),
  ...timestamps,
});

export const users = pgTable('users', {
  id: uuid('id').primaryKey().defaultRandom(),
  organizationId: uuid('organization_id').notNull().references(() => organizations.id, { onDelete: 'cascade' }),
  email: text('email').notNull(),
  name: text('name').notNull(),
  /** Null while an invitation is pending: the user cannot sign in until they accept it and choose a password. */
  passwordHash: text('password_hash'),
  role: userRole('role').notNull().default('viewer'),
  /** Embedded in each JWT; incrementing it revokes every token issued before. */
  tokenVersion: integer('token_version').notNull().default(0),
  deletedAt: timestamp('deleted_at', { withTimezone: true }),
  ...timestamps,
}, (t) => [uniqueIndex('users_email_uq').on(t.email)]);

/**
 * Single-use links emailed to a user (invitations and password resets). Only a SHA-256 hash of the token
 * is stored, so a database leak does not expose working links. A user has at most one live token per purpose.
 */
export const userTokens = pgTable('user_tokens', {
  id: uuid('id').primaryKey().defaultRandom(),
  userId: uuid('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
  purpose: userTokenPurpose('purpose').notNull(),
  tokenHash: text('token_hash').notNull(),
  expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => [uniqueIndex('user_tokens_hash_uq').on(t.tokenHash), index('user_tokens_user_idx').on(t.userId, t.purpose)]);

export const customers = pgTable('customers', {
  id: uuid('id').primaryKey().defaultRandom(),
  organizationId: uuid('organization_id').notNull().references(() => organizations.id, { onDelete: 'cascade' }),
  companyName: text('company_name').notNull(),
  contactName: text('contact_name'),
  email: text('email'),
  phone: text('phone'),
  billingAddress: text('billing_address'),
  shippingAddress: text('shipping_address'),
  paymentTermsDays: integer('payment_terms_days').notNull().default(30),
  notes: text('notes'),
  ...timestamps,
}, (t) => [index('customers_org_idx').on(t.organizationId)]);

export const products = pgTable('products', {
  id: uuid('id').primaryKey().defaultRandom(),
  organizationId: uuid('organization_id').notNull().references(() => organizations.id, { onDelete: 'cascade' }),
  sku: text('sku').notNull(),
  name: text('name').notNull(),
  description: text('description'),
  unit: text('unit').notNull().default('each'),
  unitPriceCents: integer('unit_price_cents').notNull(),
  ...timestamps,
}, (t) => [
  uniqueIndex('products_org_sku_uq').on(t.organizationId, t.sku),
  check('products_price_nonneg', sql`${t.unitPriceCents} >= 0`),
]);

export const quotes = pgTable('quotes', {
  id: uuid('id').primaryKey().defaultRandom(),
  organizationId: uuid('organization_id').notNull().references(() => organizations.id, { onDelete: 'cascade' }),
  number: text('number').notNull(),
  customerId: uuid('customer_id').notNull().references(() => customers.id, { onDelete: 'restrict' }),
  status: quoteStatus('status').notNull().default('draft'),
  validUntil: date('valid_until'),
  currency: text('currency').notNull().default('USD'),
  notes: text('notes'),
  taxRateBps: integer('tax_rate_bps').notNull().default(0),
  subtotalCents: integer('subtotal_cents').notNull().default(0),
  taxCents: integer('tax_cents').notNull().default(0),
  totalCents: integer('total_cents').notNull().default(0),
  /** Incremented by every edit, so an email prepared from an older version is never sent. */
  revision: integer('revision').notNull().default(0),
  createdById: uuid('created_by_id').notNull().references(() => users.id),
  ...timestamps,
}, (t) => [
  uniqueIndex('quotes_org_number_uq').on(t.organizationId, t.number),
  index('quotes_org_status_idx').on(t.organizationId, t.status),
]);

export const quoteItems = pgTable('quote_items', {
  id: uuid('id').primaryKey().defaultRandom(),
  quoteId: uuid('quote_id').notNull().references(() => quotes.id, { onDelete: 'cascade' }),
  productId: uuid('product_id').references(() => products.id, { onDelete: 'set null' }),
  description: text('description').notNull(),
  quantity: integer('quantity').notNull(),
  unitPriceCents: integer('unit_price_cents').notNull(),
  discountBps: integer('discount_bps').notNull().default(0),
  lineTotalCents: integer('line_total_cents').notNull(),
  position: integer('position').notNull(),
});

export const quoteStatusHistory = pgTable('quote_status_history', {
  id: uuid('id').primaryKey().defaultRandom(),
  quoteId: uuid('quote_id').notNull().references(() => quotes.id, { onDelete: 'cascade' }),
  fromStatus: quoteStatus('from_status'),
  toStatus: quoteStatus('to_status').notNull(),
  /** The staff member who made the change, or null when the customer responded through an emailed link. */
  changedById: uuid('changed_by_id').references(() => users.id),
  /** The customer who responded, as "Name <email>". */
  changedByCustomer: text('changed_by_customer'),
  /** E.g. the reason a customer gave for rejecting. */
  note: text('note'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  index('quote_status_history_quote_idx').on(t.quoteId),
  check('quote_status_history_actor', sql`(${t.changedById} IS NULL) <> (${t.changedByCustomer} IS NULL)`),
]);

/**
 * One email of a quote to a customer: a durable job with a snapshot of what was sent and to whom.
 * Created in `sending`; becomes `sent` only after the mail provider accepts the message, or `failed` with the error.
 */
export const quoteDeliveries = pgTable('quote_deliveries', {
  id: uuid('id').primaryKey().defaultRandom(),
  organizationId: uuid('organization_id').notNull().references(() => organizations.id, { onDelete: 'cascade' }),
  quoteId: uuid('quote_id').notNull().references(() => quotes.id, { onDelete: 'cascade' }),
  /** Client-chosen key: repeating a request with the same key returns this delivery instead of sending again. */
  idempotencyKey: text('idempotency_key').notNull(),
  status: quoteDeliveryStatus('status').notNull(),
  recipientEmail: text('recipient_email').notNull(),
  recipientName: text('recipient_name'),
  message: text('message'),
  subject: text('subject').notNull(),
  /** The email body as sent, with QUOTE_LINK_PLACEHOLDER where each attempt puts its own link. */
  bodyText: text('body_text').notNull(),
  bodyHtml: text('body_html').notNull(),
  /** The PDF exactly as attached, and the quote revision it shows. */
  pdf: bytea('pdf').notNull(),
  quoteRevision: integer('quote_revision').notNull(),
  sentById: uuid('sent_by_id').notNull().references(() => users.id),
  attempts: integer('attempts').notNull().default(0),
  lastAttemptAt: timestamp('last_attempt_at', { withTimezone: true }),
  lastError: text('last_error'),
  sentAt: timestamp('sent_at', { withTimezone: true }),
  providerMessageId: text('provider_message_id'),
  /** SHA-256 of the token in the customer's link; replaced on each attempt and usable once the email is sent. */
  accessTokenHash: text('access_token_hash'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  uniqueIndex('quote_deliveries_idempotency_uq').on(t.quoteId, t.idempotencyKey),
  uniqueIndex('quote_deliveries_token_uq').on(t.accessTokenHash),
  index('quote_deliveries_quote_idx').on(t.quoteId),
]);

export const orders = pgTable('orders', {
  id: uuid('id').primaryKey().defaultRandom(),
  organizationId: uuid('organization_id').notNull().references(() => organizations.id, { onDelete: 'cascade' }),
  number: text('number').notNull(),
  customerId: uuid('customer_id').notNull().references(() => customers.id, { onDelete: 'restrict' }),
  quoteId: uuid('quote_id').references(() => quotes.id, { onDelete: 'set null' }),
  status: orderStatus('status').notNull().default('pending'),
  poNumber: text('po_number'),
  currency: text('currency').notNull().default('USD'),
  notes: text('notes'),
  taxRateBps: integer('tax_rate_bps').notNull().default(0),
  subtotalCents: integer('subtotal_cents').notNull().default(0),
  taxCents: integer('tax_cents').notNull().default(0),
  totalCents: integer('total_cents').notNull().default(0),
  createdById: uuid('created_by_id').notNull().references(() => users.id),
  ...timestamps,
}, (t) => [
  uniqueIndex('orders_org_number_uq').on(t.organizationId, t.number),
  uniqueIndex('orders_quote_uq').on(t.quoteId),
  index('orders_org_status_idx').on(t.organizationId, t.status),
]);

export const orderItems = pgTable('order_items', {
  id: uuid('id').primaryKey().defaultRandom(),
  orderId: uuid('order_id').notNull().references(() => orders.id, { onDelete: 'cascade' }),
  productId: uuid('product_id').references(() => products.id, { onDelete: 'set null' }),
  description: text('description').notNull(),
  quantity: integer('quantity').notNull(),
  unitPriceCents: integer('unit_price_cents').notNull(),
  discountBps: integer('discount_bps').notNull().default(0),
  lineTotalCents: integer('line_total_cents').notNull(),
  position: integer('position').notNull(),
});

export const orderStatusHistory = pgTable('order_status_history', {
  id: uuid('id').primaryKey().defaultRandom(),
  orderId: uuid('order_id').notNull().references(() => orders.id, { onDelete: 'cascade' }),
  fromStatus: orderStatus('from_status'),
  toStatus: orderStatus('to_status').notNull(),
  changedById: uuid('changed_by_id').notNull().references(() => users.id),
  note: text('note'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});

export const quotesRelations = relations(quotes, ({ many, one }) => ({
  items: many(quoteItems),
  history: many(quoteStatusHistory),
  customer: one(customers, { fields: [quotes.customerId], references: [customers.id] }),
}));
export const quoteItemsRelations = relations(quoteItems, ({ one }) => ({
  quote: one(quotes, { fields: [quoteItems.quoteId], references: [quotes.id] }),
}));
export const quoteDeliveriesRelations = relations(quoteDeliveries, ({ one }) => ({
  quote: one(quotes, { fields: [quoteDeliveries.quoteId], references: [quotes.id] }),
  sentBy: one(users, { fields: [quoteDeliveries.sentById], references: [users.id] }),
}));
export const quoteStatusHistoryRelations = relations(quoteStatusHistory, ({ one }) => ({
  quote: one(quotes, { fields: [quoteStatusHistory.quoteId], references: [quotes.id] }),
  changedBy: one(users, { fields: [quoteStatusHistory.changedById], references: [users.id] }),
}));
export const ordersRelations = relations(orders, ({ many, one }) => ({
  items: many(orderItems),
  history: many(orderStatusHistory),
  customer: one(customers, { fields: [orders.customerId], references: [customers.id] }),
}));
export const orderItemsRelations = relations(orderItems, ({ one }) => ({
  order: one(orders, { fields: [orderItems.orderId], references: [orders.id] }),
}));
export const orderStatusHistoryRelations = relations(orderStatusHistory, ({ one }) => ({
  order: one(orders, { fields: [orderStatusHistory.orderId], references: [orders.id] }),
}));

export type UserRole = (typeof USER_ROLES)[number];
export type QuoteStatus = (typeof QUOTE_STATUSES)[number];
export type OrderStatus = (typeof ORDER_STATUSES)[number];
export type UserTokenPurpose = (typeof USER_TOKEN_PURPOSES)[number];
export type QuoteDeliveryStatus = (typeof QUOTE_DELIVERY_STATUSES)[number];
