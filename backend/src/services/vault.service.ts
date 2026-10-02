import { AppError, type Logger } from '@da/shared'
import { chainAdapterFor } from '../chains'
import type { AddressRepository } from '../repositories/address.repository'
import type { AuditLogRepository } from '../repositories/audit-log.repository'
import type { SignerClient } from '../signer/client'
import type { AuthContext, RequestMeta } from './auth.service'

/**
 * Backend side of the key vault (Phase 7b). Enforces inventory rules (the address must be
 * registered with an owner reference and not archived) and writes the application audit log.
 * Secrets pass straight through to the signer; nothing here stores or logs them.
 */
export function createVaultService(deps: {
  signer: SignerClient
  addresses: AddressRepository
  audit: AuditLogRepository
  logger: Logger
}) {
  const { signer, addresses, audit, logger } = deps

  function record(
    actor: AuthContext,
    meta: RequestMeta,
    action: string,
    result: 'SUCCESS' | 'FAILURE' | 'DENIED',
    extra: { resourceType?: string; resourceId?: string; metadata?: Record<string, unknown> } = {},
  ) {
    return audit.create({
      action,
      result,
      userId: actor.user.id,
      resourceType: extra.resourceType ?? 'vault',
      resourceId: extra.resourceId ?? 'vault',
      ipAddress: meta.ip,
      userAgent: meta.userAgent,
      requestId: meta.requestId,
      metadata: extra.metadata,
    })
  }

  /** Runs a signer call; a failure is audited (code only) and rethrown. */
  async function audited<T>(
    actor: AuthContext,
    meta: RequestMeta,
    action: string,
    fn: () => Promise<T>,
    extra: { resourceType?: string; resourceId?: string; metadata?: Record<string, unknown> } = {},
  ): Promise<T> {
    try {
      const result = await fn()
      await record(actor, meta, action, 'SUCCESS', extra)
      return result
    } catch (error) {
      const code = error instanceof AppError ? error.code : 'INTERNAL_ERROR'
      await record(
        actor,
        meta,
        `${action}_FAILED`,
        code === 'PASSPHRASE_INVALID' ? 'DENIED' : 'FAILURE',
        {
          ...extra,
          metadata: { ...extra.metadata, code },
        },
      )
      throw error
    }
  }

  async function inventoryAddress(addressId: string) {
    const address = await addresses.findById(addressId)
    if (!address) throw new AppError('NOT_FOUND', 'Address not found', { resourceId: addressId })
    if (address.archivedAt) {
      throw new AppError('CONFLICT', 'Archived addresses cannot hold keys — restore it first', {
        resourceId: addressId,
      })
    }
    if (address.network.chainType !== 'EVM') {
      throw new AppError('INVALID_NETWORK', 'Only EVM keys are supported for now')
    }
    return address
  }

  const service = {
    status: () => signer.status(),

    async listKeys() {
      const keys = await signer.listKeys()
      // One EVM key controls the same address on EVERY EVM network, so a key can match several
      // inventory entries. The signer stores lower-case; the inventory stores EIP-55 checksums.
      const canonical = keys.flatMap((k) => {
        const check = chainAdapterFor('EVM').checkAddress(k.address)
        return check.ok ? [check.address] : []
      })
      const entries = await addresses.findByAddresses(canonical)
      return keys.map((key) => {
        const matches = entries.filter((a) => a.address.toLowerCase() === key.address.toLowerCase())
        return {
          ...key,
          checksumAddress: matches[0]?.address ?? key.address,
          inventory: matches.map((a) => ({
            addressId: a.id,
            label: a.label,
            archived: a.archivedAt !== null,
            network: { id: a.network.id, displayName: a.network.displayName },
          })),
        }
      })
    },

    init: (
      actor: AuthContext,
      input: { passphrase: string; recoveryPassphrase: string },
      meta: RequestMeta,
    ) =>
      audited(actor, meta, 'VAULT_INITIALIZED', () =>
        signer.init({ actor: actor.user.id, ...input }),
      ),

    unlock: (actor: AuthContext, input: { passphrase: string }, meta: RequestMeta) =>
      audited(actor, meta, 'VAULT_UNLOCKED', () =>
        signer.unlock({ actor: actor.user.id, ...input }),
      ),

    lock: (actor: AuthContext, meta: RequestMeta) =>
      audited(actor, meta, 'VAULT_LOCKED', () => signer.lock({ actor: actor.user.id })),

    changePassphrase: (
      actor: AuthContext,
      input: { currentPassphrase: string; newPassphrase: string },
      meta: RequestMeta,
    ) =>
      audited(actor, meta, 'VAULT_PASSPHRASE_CHANGED', () =>
        signer.changePassphrase({ actor: actor.user.id, ...input }),
      ),

    recover: (
      actor: AuthContext,
      input: { recoveryPassphrase: string; newPassphrase: string },
      meta: RequestMeta,
    ) =>
      audited(actor, meta, 'VAULT_RECOVERED', () =>
        signer.recover({ actor: actor.user.id, ...input }),
      ),

    async importKey(
      actor: AuthContext,
      input: {
        addressId: string
        secretType: 'PRIVATE_KEY' | 'MNEMONIC'
        secret: string
        derivationPath?: string | null
      },
      meta: RequestMeta,
    ) {
      const address = await inventoryAddress(input.addressId)
      return audited(
        actor,
        meta,
        'KEY_IMPORTED',
        () =>
          signer.importKey({
            actor: actor.user.id,
            expectedAddress: address.address,
            secretType: input.secretType,
            secret: input.secret,
            derivationPath: input.derivationPath ?? null,
          }),
        {
          resourceType: 'address',
          resourceId: address.id,
          // Never the secret — only what kind of input was used.
          metadata: {
            address: address.address,
            secretType: input.secretType,
            derivationPath: input.derivationPath ?? null,
          },
        },
      )
    },

    async revealKey(
      actor: AuthContext,
      input: { addressId: string; passphrase: string },
      meta: RequestMeta,
    ) {
      const address = await addresses.findById(input.addressId)
      if (!address)
        throw new AppError('NOT_FOUND', 'Address not found', { resourceId: input.addressId })
      const result = await audited(
        actor,
        meta,
        'KEY_REVEALED',
        () =>
          signer.revealKey({
            actor: actor.user.id,
            address: address.address,
            passphrase: input.passphrase,
          }),
        { resourceType: 'address', resourceId: address.id, metadata: { address: address.address } },
      )
      logger.warn({ addressId: address.id, userId: actor.user.id }, 'KEY_REVEALED')
      return result
    },

    /** Locks the vault when a SUPER_ADMIN logs out (best effort: logout must never fail). */
    async lockOnLogout(actor: AuthContext, meta: RequestMeta): Promise<void> {
      if (!actor.roles.includes('SUPER_ADMIN')) return
      try {
        const status = await signer.status()
        if (status.unlocked) await service.lock(actor, meta)
      } catch (err) {
        logger.warn({ err, userId: actor.user.id }, 'VAULT_LOCK_ON_LOGOUT_FAILED')
      }
    },
  }
  return service
}

export type VaultService = ReturnType<typeof createVaultService>
