import { relations, sql } from 'drizzle-orm';
import {
  pgTable, pgEnum, uuid, text, integer, timestamp, date, uniqueIndex, index, check,
} from 'drizzle-orm/pg-core';

export const USER_ROLES = ['admin', 'manager', 'sales', 'viewer'] as const;
export const QUOTE_STATUSES = ['draft', 'sent', 'accepted', 'rejected', 'expired'] as const;
export const ORDER_STATUSES = ['pending', 'confirmed', 'shipped', 'delivered', 'cancelled'] as const;

export const userRole = pgEnum('user_role', USER_ROLES);
export const quoteStatus = pgEnum('quote_status', QUOTE_STATUSES);
export const orderStatus = pgEnum('order_status', ORDER_STATUSES);

const timestamps = {
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow().$onUpdate(() => new Date()),
};

/** A tenant. Every business record belongs to exactly one organization. */
export const organizations = pgTable('organizations', {
  id: uuid('id').primaryKey().defaultRandom(),
  name: text('name').notNull(),
  quoteSeq: integer('quote_seq').notNull().default(0),
  orderSeq: integer('order_seq').notNull().default(0),
  ...timestamps,
});

export const users = pgTable('users', {
  id: uuid('id').primaryKey().defaultRandom(),
  organizationId: uuid('organization_id').notNull().references(() => organizations.id, { onDelete: 'cascade' }),
  email: text('email').notNull(),
  name: text('name').notNull(),
  passwordHash: text('password_hash').notNull(),
  role: userRole('role').notNull().default('viewer'),
  deletedAt: timestamp('deleted_at', { withTimezone: true }),
  ...timestamps,
}, (t) => [uniqueIndex('users_email_uq').on(t.email)]);

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

export const quotesRelations = relations(quotes, ({ many }) => ({ items: many(quoteItems) }));
export const quoteItemsRelations = relations(quoteItems, ({ one }) => ({
  quote: one(quotes, { fields: [quoteItems.quoteId], references: [quotes.id] }),
}));
export const ordersRelations = relations(orders, ({ many }) => ({
  items: many(orderItems),
  history: many(orderStatusHistory),
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
