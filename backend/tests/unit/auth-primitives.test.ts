import { describe, expect, it } from 'vitest'
import { ROLES } from '@da/shared/rbac'
import { Role } from '../../src/generated/prisma/enums'
import {
  CLI_ONLY_ROLES,
  MFA_REQUIRED_ROLES,
  PERMISSIONS,
  ROLE_PERMISSIONS,
  permissionsFor,
  requiresMfa,
} from '../../src/auth/permissions'
import { passwordPolicyViolation } from '../../src/auth/password'
import { createSecretBox } from '../../src/auth/secret-box'
import { hashSessionToken, newSessionToken } from '../../src/auth/session-token'
import { checkTotp, newTotpSecret, totpCodeAt } from '../../src/auth/totp'
import { createRateLimiter } from '../../src/lib/rate-limiter'

describe('permissions', () => {
  it('keeps the shared role list in sync with the database enum', () => {
    expect([...ROLES].sort()).toEqual(Object.values(Role).sort())
  })

  it('maps every role to at least one permission', () => {
    for (const role of ROLES) expect(ROLE_PERMISSIONS[role].length, role).toBeGreaterThan(0)
  })

  it('keeps vault and signing exclusive to SUPER_ADMIN (CLAUDE.md rule 3)', () => {
    for (const [role, perms] of Object.entries(ROLE_PERMISSIONS)) {
      const hasVault = perms.includes('vault:manage') || perms.includes('transactions:sign')
      expect(hasVault, role).toBe(role === 'SUPER_ADMIN')
    }
  })

  it('gives SUPER_ADMIN no user management (separation of duties)', () => {
    expect(ROLE_PERMISSIONS.SUPER_ADMIN).not.toContain('users:manage')
  })

  it('never lets one role both create and approve transactions (maker-checker)', () => {
    for (const perms of Object.values(ROLE_PERMISSIONS)) {
      expect(perms.includes('transactions:create') && perms.includes('transactions:approve')).toBe(
        false,
      )
    }
  })

  it('restricts audit log access to AUDITOR', () => {
    const readers = Object.entries(ROLE_PERMISSIONS).filter(([, p]) => p.includes('audit:read'))
    expect(readers.map(([role]) => role)).toEqual(['AUDITOR'])
  })

  it('merges permissions of multiple roles without duplicates, in canonical order', () => {
    const merged = permissionsFor(['ANALYST', 'AUDITOR'])
    expect(new Set(merged).size).toBe(merged.length)
    expect(merged).toEqual(PERMISSIONS.filter((p) => merged.includes(p)))
    expect(merged).toContain('scans:run')
    expect(merged).toContain('audit:read')
  })

  it('requires MFA for SUPER_ADMIN, ADMIN and REVIEWER only (ADR-012)', () => {
    expect([...MFA_REQUIRED_ROLES].sort()).toEqual(['ADMIN', 'REVIEWER', 'SUPER_ADMIN'])
    expect(requiresMfa(['ANALYST'])).toBe(false)
    expect(requiresMfa(['ANALYST', 'REVIEWER'])).toBe(true)
    expect([...CLI_ONLY_ROLES]).toEqual(['SUPER_ADMIN'])
  })
})

describe('password policy', () => {
  it.each([
    ['short', 'Password must be at least 12 characters'],
    [' leading-space-pw', 'Password must not start or end with whitespace'],
    ['x'.repeat(257), 'Password must be at most 256 characters'],
  ])('rejects %j', (password, message) => {
    expect(passwordPolicyViolation(password)).toBe(message)
  })

  it('accepts a long passphrase', () => {
    expect(passwordPolicyViolation('correct horse battery staple')).toBeNull()
  })
})

describe('secret box (AES-256-GCM)', () => {
  const box = createSecretBox(Buffer.alloc(32, 9).toString('base64'))

  it('round-trips and never produces the same ciphertext twice', () => {
    const a = box.encrypt('JBSWY3DPEHPK3PXP')
    const b = box.encrypt('JBSWY3DPEHPK3PXP')
    expect(a).not.toBe(b)
    expect(a).not.toContain('JBSWY3DPEHPK3PXP')
    expect(box.decrypt(a)).toBe('JBSWY3DPEHPK3PXP')
  })

  it('detects tampering', () => {
    const payload = box.encrypt('secret')
    const raw = Buffer.from(payload.slice(3), 'base64')
    raw[raw.length - 1] = (raw[raw.length - 1] ?? 0) ^ 1
    expect(() => box.decrypt('v1:' + raw.toString('base64'))).toThrow()
  })

  it('fails with a different key', () => {
    const other = createSecretBox(Buffer.alloc(32, 8).toString('base64'))
    expect(() => other.decrypt(box.encrypt('secret'))).toThrow()
  })

  it('rejects keys that are not 32 bytes', () => {
    expect(() => createSecretBox(Buffer.alloc(16).toString('base64'))).toThrow(/32 bytes/)
  })
})

describe('TOTP', () => {
  const secret = newTotpSecret()
  const t0 = new Date('2026-10-02T08:00:00Z')

  it('accepts the current code and tolerates ±1 window of drift', () => {
    const code = totpCodeAt(secret, t0)
    expect(checkTotp(secret, code, t0, null).valid).toBe(true)
    expect(checkTotp(secret, code, new Date(t0.getTime() + 30_000), null).valid).toBe(true)
  })

  it('rejects codes outside the drift window', () => {
    const code = totpCodeAt(secret, t0)
    expect(checkTotp(secret, code, new Date(t0.getTime() + 120_000), null).valid).toBe(false)
  })

  it('rejects a replay of an already-used time step', () => {
    const code = totpCodeAt(secret, t0)
    const first = checkTotp(secret, code, t0, null)
    expect(first.valid).toBe(true)
    if (!first.valid) return
    expect(checkTotp(secret, code, t0, first.timeStep).valid).toBe(false)
  })

  it.each(['', '12345', '1234567', 'abcdef', '12 456'])('rejects malformed code %j', (code) => {
    expect(checkTotp(secret, code, t0, null).valid).toBe(false)
  })
})

describe('session tokens', () => {
  it('are random, URL-safe and stored only as a SHA-256 hash', () => {
    const a = newSessionToken()
    const b = newSessionToken()
    expect(a).not.toBe(b)
    expect(a).toMatch(/^[A-Za-z0-9_-]{43}$/)
    expect(hashSessionToken(a)).toMatch(/^[0-9a-f]{64}$/)
    expect(hashSessionToken(a)).toBe(hashSessionToken(a))
  })
})

describe('rate limiter', () => {
  it('limits after N hits within the window and resets afterwards', () => {
    let t = 0
    const limiter = createRateLimiter({ limit: 3, windowMs: 1000, now: () => t })
    for (let i = 0; i < 3; i++) limiter.hit('k')
    expect(limiter.isLimited('k')).toBe(true)
    expect(limiter.isLimited('other')).toBe(false)
    expect(limiter.retryAfterMs('k')).toBe(1000)
    t = 1000
    expect(limiter.isLimited('k')).toBe(false)
  })

  it('can be reset explicitly', () => {
    const limiter = createRateLimiter({ limit: 1, windowMs: 1000 })
    limiter.hit('k')
    limiter.reset('k')
    expect(limiter.isLimited('k')).toBe(false)
  })
})
