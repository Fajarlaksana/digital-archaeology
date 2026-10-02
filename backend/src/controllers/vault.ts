import type { FastifyInstance } from 'fastify'
import { z } from 'zod'
import { requestMeta, type Guards } from '../auth/plugin'
import type { AuthContext, AuthService } from '../services/auth.service'
import type { VaultService } from '../services/vault.service'

/** Vault actions need a password(+TOTP) re-confirmation within this window (ADR-009). */
export const VAULT_REAUTH_WINDOW_MS = 5 * 60_000

const passphrase = z.string().min(1).max(1024)
const totp = z.string().regex(/^\d{6}$/, 'must be a 6-digit code')

const initBody = z.object({ passphrase, recoveryPassphrase: passphrase })
const unlockBody = z.object({ passphrase })
const changeBody = z.object({ currentPassphrase: passphrase, newPassphrase: passphrase })
const recoverBody = z.object({ recoveryPassphrase: passphrase, newPassphrase: passphrase })
const importBody = z.object({
  addressId: z.uuid(),
  secretType: z.enum(['PRIVATE_KEY', 'MNEMONIC']),
  secret: z.string().min(1).max(1024),
  derivationPath: z.string().trim().max(100).nullable().optional(),
})
const revealBody = z.object({ addressId: z.uuid(), passphrase, code: totp })

/**
 * Key vault API (SUPER_ADMIN only, CLAUDE.md rule 3). Bodies carry passphrases / keys:
 * they are never logged, the generic body-free audit is replaced by explicit events, and
 * every response is no-store.
 */
export function registerVaultRoutes(
  app: FastifyInstance,
  deps: { vault: VaultService; auth: AuthService; guards: Guards },
): void {
  const { vault, guards } = deps
  const manage = guards.permission('vault:manage')
  const sensitive = {
    config: { skipGenericAudit: true },
    preHandler: [manage, guards.recentAuth(VAULT_REAUTH_WINDOW_MS)],
  }
  const ctx = (request: { auth: AuthContext | null }) => request.auth as AuthContext

  app.addHook('onSend', async (request, reply) => {
    if (request.url.startsWith('/api/vault')) reply.header('cache-control', 'no-store')
  })

  app.get('/api/vault/status', { preHandler: manage }, async () => vault.status())
  app.get('/api/vault/keys', { preHandler: manage }, async () => ({ keys: await vault.listKeys() }))

  app.post('/api/vault/init', sensitive, async (request) =>
    vault.init(ctx(request), initBody.parse(request.body), requestMeta(request)),
  )
  app.post('/api/vault/unlock', sensitive, async (request) =>
    vault.unlock(ctx(request), unlockBody.parse(request.body), requestMeta(request)),
  )
  // Locking is always safe: no re-authentication needed.
  app.post(
    '/api/vault/lock',
    { config: { skipGenericAudit: true }, preHandler: manage },
    async (request) => vault.lock(ctx(request), requestMeta(request)),
  )
  app.post('/api/vault/passphrase', sensitive, async (request) =>
    vault.changePassphrase(ctx(request), changeBody.parse(request.body), requestMeta(request)),
  )
  app.post('/api/vault/recover', sensitive, async (request) =>
    vault.recover(ctx(request), recoverBody.parse(request.body), requestMeta(request)),
  )
  app.post('/api/vault/keys', sensitive, async (request, reply) => {
    const key = await vault.importKey(
      ctx(request),
      importBody.parse(request.body),
      requestMeta(request),
    )
    return reply.status(201).send({ key })
  })

  // Break-glass: recent re-auth + a fresh TOTP code now + the vault passphrase (ADR-009).
  app.post('/api/vault/keys/reveal', sensitive, async (request) => {
    const body = revealBody.parse(request.body)
    await deps.auth.confirmTotp(ctx(request), body.code, requestMeta(request))
    return vault.revealKey(
      ctx(request),
      { addressId: body.addressId, passphrase: body.passphrase },
      requestMeta(request),
    )
  })
}
