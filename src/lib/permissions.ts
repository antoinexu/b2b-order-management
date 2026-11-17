import type { UserRole } from '../db/schema';

export const PERMISSIONS = [
  'users:read',
  'users:write',
  'customers:read',
  'customers:write',
  'customers:delete',
  'products:read',
  'products:write',
  'quotes:read',
  'quotes:write',
  'orders:read',
  'orders:write',
  'orders:status',
] as const;

export type Permission = (typeof PERMISSIONS)[number];

const READ_ALL: Permission[] = ['customers:read', 'products:read', 'quotes:read', 'orders:read'];

/**
 * Role-based access control matrix.
 * - admin:   full access, including user management
 * - manager: runs the business (pricing, catalog, order fulfilment), cannot manage users
 * - sales:   manages customers, builds quotes, places orders
 * - viewer:  read-only access to business data
 */
export const ROLE_PERMISSIONS: Record<UserRole, ReadonlySet<Permission>> = {
  admin: new Set(PERMISSIONS),
  manager: new Set(PERMISSIONS.filter((p) => p !== 'users:write')),
  sales: new Set<Permission>([...READ_ALL, 'customers:write', 'quotes:write', 'orders:write']),
  viewer: new Set<Permission>(READ_ALL),
};

export function hasPermission(role: UserRole, permission: Permission): boolean {
  return ROLE_PERMISSIONS[role].has(permission);
}
