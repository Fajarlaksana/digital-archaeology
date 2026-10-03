import {
  CLI_ONLY_ROLES as CLI_ONLY_ROLE_NAMES,
  PERMISSIONS,
  type Permission,
} from '@da/shared/rbac'
import type { Role } from '../generated/prisma/client'

/**
 * Single source of truth for who may do what (SA 8.2 + ADR-003).
 * Endpoints check permissions, never roles directly.
 */
export { PERMISSIONS, type Permission }

const READ_INVENTORY: Permission[] = [
  'networks:read',
  'addresses:read',
  'scans:read',
  'reports:read',
  'transactions:read',
  'authorizations:read',
]

export const ROLE_PERMISSIONS: Record<Role, readonly Permission[]> = {
  // Key holder: vault + signing only. Deliberately no user management (separation of duties).
  SUPER_ADMIN: [
    ...READ_INVENTORY,
    'vault:manage',
    'ownership:verify',
    'transactions:sign',
    'transactions:broadcast',
  ],
  ADMIN: [...READ_INVENTORY, 'users:read', 'users:manage', 'networks:manage'],
  ANALYST: [
    ...READ_INVENTORY,
    'addresses:manage',
    'ownership:verify',
    'scans:run',
    'destinations:create',
    'transactions:create',
  ],
  REVIEWER: [
    ...READ_INVENTORY,
    'authorizations:review',
    'destinations:approve',
    'transactions:approve',
  ],
  AUDITOR: [...READ_INVENTORY, 'users:read', 'audit:read'],
}

/** Roles that must use TOTP (ADR-012: SUPER_ADMIN, ADMIN, REVIEWER). */
export const MFA_REQUIRED_ROLES: ReadonlySet<Role> = new Set<Role>([
  'SUPER_ADMIN',
  'ADMIN',
  'REVIEWER',
])

/** Roles that can only be granted from the server CLI, never through the API. */
export const CLI_ONLY_ROLES: ReadonlySet<Role> = new Set<Role>(CLI_ONLY_ROLE_NAMES)

export function permissionsFor(roles: readonly Role[]): Permission[] {
  const granted = new Set<Permission>()
  for (const role of roles) for (const permission of ROLE_PERMISSIONS[role]) granted.add(permission)
  return PERMISSIONS.filter((permission) => granted.has(permission))
}

export function requiresMfa(roles: readonly Role[]): boolean {
  return roles.some((role) => MFA_REQUIRED_ROLES.has(role))
}
