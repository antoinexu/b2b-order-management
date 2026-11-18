import type { components } from './schema';

type Schemas = components['schemas'];

export type User = Schemas['User'];
export type Me = Schemas['MeResponse'];
export type Customer = Schemas['Customer'];
export type Product = Schemas['Product'];
export type LineItem = Schemas['LineItem'];
export type LineItemInput = Schemas['LineItemInput'];
export type Quote = Schemas['Quote'];
export type QuoteSummary = Schemas['QuoteSummary'];
export type Order = Schemas['Order'];
export type OrderSummary = Schemas['OrderSummary'];
export type QuoteStatusChange = Schemas['QuoteStatusChange'];
export type Organization = Schemas['Organization'];

export type UserRole = User['role'];
export type QuoteStatus = Quote['status'];
export type OrderStatus = Order['status'];

export type Permission =
  | 'users:read' | 'users:write' | 'organization:write'
  | 'customers:read' | 'customers:write' | 'customers:delete'
  | 'products:read' | 'products:write' | 'pricing:override'
  | 'quotes:read' | 'quotes:write'
  | 'orders:read' | 'orders:write' | 'orders:status';

/** Mirrors the backend's ORDER_TRANSITIONS so the UI only offers valid moves. */
export const ORDER_TRANSITIONS: Record<OrderStatus, OrderStatus[]> = {
  pending: ['confirmed', 'cancelled'],
  confirmed: ['shipped', 'cancelled'],
  shipped: ['delivered'],
  delivered: [],
  cancelled: [],
};

export const USER_ROLES: UserRole[] = ['admin', 'manager', 'sales', 'viewer'];
export const QUOTE_STATUSES: QuoteStatus[] = ['draft', 'sent', 'accepted', 'rejected', 'expired'];
export const ORDER_STATUSES: OrderStatus[] = ['pending', 'confirmed', 'shipped', 'delivered', 'cancelled'];
