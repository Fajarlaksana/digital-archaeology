/**
 * RBAC vocabulary shared by backend and frontend (browser-safe: no Node imports).
 * The role → permission mapping lives in backend/src/auth/permissions.ts.
 */
export const ROLES = ['SUPER_ADMIN', 'ADMIN', 'ANALYST', 'REVIEWER', 'AUDITOR'] as const
export type RoleName = (typeof ROLES)[number]

/** Roles that can only be granted from the server CLI, never through the API or UI. */
export const CLI_ONLY_ROLES: readonly RoleName[] = ['SUPER_ADMIN']

export const PERMISSIONS = [
  'users:read',
  'users:manage',
  'networks:read',
  'networks:manage',
  'addresses:read',
  'addresses:manage',
  'scans:read',
  'scans:run',
  'reports:read',
  'authorizations:read',
  'authorizations:review',
  'destinations:create',
  'destinations:approve',
  'transactions:read',
  'transactions:create',
  'transactions:approve',
  'transactions:sign',
  'transactions:broadcast',
  'vault:manage',
  'audit:read',
] as const

export type Permission = (typeof PERMISSIONS)[number]
