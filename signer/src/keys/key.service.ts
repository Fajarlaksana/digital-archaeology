import { createHash } from 'node:crypto'
import { privateKeyToAccount } from 'viem/accounts'
import { AppError, parseChallengeMessage, type Logger } from '@da/shared'
import { open, seal, wipe } from '../crypto/aead'
import type { VaultDatabase, VaultRepository } from '../vault/vault.repository'
import type { VaultService } from '../vault/vault.service'
import { deriveEvmKey, type SecretType } from './derive'

const CHAIN = 'EVM'
/** Break-glass reveals per hour, across all users (ADR-009). */
const MAX_REVEALS_PER_HOUR = 3

/** AAD binds a key ciphertext to its chain + address: a row moved elsewhere will not decrypt. */
export const keyAad = (chainType: string, address: string) =>
  `da-vault/key/v1/${chainType}:${address.toLowerCase()}`

export interface PublicVaultKey {
  chainType: string
  address: string
  keyType: string
  derivationPath: string | null
  importedBy: string
  createdAt: string
  lastUsedAt: string | null
}

export interface KeyServiceDeps {
  db: VaultDatabase
  repo: VaultRepository
  vault: VaultService
  logger: Logger
  revealEnabled: boolean
  now?: () => number
}

export function createKeyService(deps: KeyServiceDeps) {
  const { db, repo, vault, logger } = deps
  const now = deps.now ?? Date.now
  let reveals: number[] = []

  return {
    async list(): Promise<PublicVaultKey[]> {
      const rows = await db.vaultKey.findMany({
        orderBy: { createdAt: 'asc' },
        // Never select key material for listings.
        select: {
          chainType: true,
          address: true,
          keyType: true,
          derivationPath: true,
          importedBy: true,
          createdAt: true,
          lastUsedAt: true,
        },
      })
      return rows.map((r) => ({
        ...r,
        createdAt: r.createdAt.toISOString(),
        lastUsedAt: r.lastUsedAt?.toISOString() ?? null,
      }))
    },

    /**
     * Imports a key for `expectedAddress` (taken by the backend from the inventory).
     * The key must control exactly that address — otherwise nothing is stored.
     */
    async import(input: {
      actor: string
      expectedAddress: string
      secretType: SecretType
      secret: string
      derivationPath?: string | null
    }): Promise<PublicVaultKey> {
      const derived = deriveEvmKey(input)
      try {
        if (derived.address !== input.expectedAddress.toLowerCase()) {
          throw new AppError(
            'KEY_ADDRESS_MISMATCH',
            input.secretType === 'MNEMONIC'
              ? 'The key at this derivation path does not control the selected address'
              : 'This private key does not control the selected address',
          )
        }
        const existing = await db.vaultKey.findUnique({
          where: { chainType_address: { chainType: CHAIN, address: derived.address } },
          select: { id: true },
        })
        if (existing)
          throw new AppError('CONFLICT', 'A key for this address is already in the vault')

        const sealed = await vault.withMasterKey((masterKey) =>
          seal(masterKey, derived.privateKey, keyAad(CHAIN, derived.address)),
        )
        const row = await db.vaultKey.create({
          data: {
            chainType: CHAIN,
            address: derived.address,
            keyType: derived.keyType,
            derivationPath: derived.derivationPath,
            iv: new Uint8Array(sealed.iv),
            authTag: new Uint8Array(sealed.tag),
            ciphertext: new Uint8Array(sealed.ciphertext),
            importedBy: input.actor,
          },
        })
        await repo.event('KEY_IMPORTED', {
          actor: input.actor,
          address: derived.address,
          metadata: { keyType: derived.keyType, derivationPath: derived.derivationPath },
        })
        logger.info({ address: derived.address, keyType: derived.keyType }, 'KEY_IMPORTED')
        return {
          chainType: row.chainType,
          address: row.address,
          keyType: row.keyType,
          derivationPath: row.derivationPath,
          importedBy: row.importedBy,
          createdAt: row.createdAt.toISOString(),
          lastUsedAt: null,
        }
      } finally {
        wipe(derived.privateKey)
      }
    },

    /**
     * Signs an ownership challenge with the stored key (EIP-191 personal_sign).
     * Refuses ANY other message: even a compromised backend cannot make the signer sign
     * logins, permits or arbitrary text (ADR-018). Requires the vault to be unlocked.
     */
    async signChallenge(input: {
      actor: string
      address: string
      message: string
    }): Promise<{ signature: string }> {
      const challenge = parseChallengeMessage(input.message)
      if (!challenge) {
        throw new AppError(
          'VALIDATION_ERROR',
          'Only ownership-verification challenges can be signed',
        )
      }
      const address = input.address.toLowerCase()
      if (challenge.address.toLowerCase() !== address) {
        throw new AppError('VALIDATION_ERROR', 'The challenge is for a different address')
      }
      if (challenge.expiresAt.getTime() <= now()) {
        throw new AppError('VALIDATION_ERROR', 'The challenge has expired')
      }
      const row = await db.vaultKey.findUnique({
        where: { chainType_address: { chainType: CHAIN, address } },
      })
      if (!row) throw new AppError('NOT_FOUND', 'No key for this address in the vault')

      const signature = await vault.withMasterKey(async (masterKey) => {
        const plain = open(
          masterKey,
          {
            iv: Buffer.from(row.iv),
            tag: Buffer.from(row.authTag),
            ciphertext: Buffer.from(row.ciphertext),
          },
          keyAad(CHAIN, address),
        )
        try {
          // viem needs the key as a hex string (cannot be wiped; ADR-017 limitation).
          return await privateKeyToAccount(`0x${plain.toString('hex')}`).signMessage({
            message: input.message,
          })
        } finally {
          wipe(plain)
        }
      })
      await db.vaultKey.update({ where: { id: row.id }, data: { lastUsedAt: new Date(now()) } })
      await repo.event('MESSAGE_SIGNED', {
        actor: input.actor,
        address,
        metadata: {
          kind: 'OWNERSHIP_CHALLENGE',
          authorizationId: challenge.authorizationId,
          messageSha256: createHash('sha256').update(input.message).digest('hex'),
        },
      })
      return { signature }
    },

    /**
     * Break-glass (ADR-009): returns the plaintext key ONLY when the passphrase is re-entered.
     * Works regardless of the unlock state; limited to 3 per hour; always recorded.
     */
    async reveal(input: {
      actor: string
      address: string
      passphrase: string
    }): Promise<{ privateKey: string }> {
      if (!deps.revealEnabled)
        throw new AppError('FORBIDDEN', 'Key reveal is disabled on this server')
      reveals = reveals.filter((t) => now() - t < 3_600_000)
      if (reveals.length >= MAX_REVEALS_PER_HOUR) {
        throw new AppError('RATE_LIMITED', 'Reveal limit reached (3 per hour)')
      }
      // Reserve the slot BEFORE any await, so parallel requests cannot all pass the check.
      // It is released again only when nothing was revealed.
      const slot = now()
      reveals.push(slot)
      const address = input.address.toLowerCase()
      let privateKey: string
      try {
        const row = await db.vaultKey.findUnique({
          where: { chainType_address: { chainType: CHAIN, address } },
        })
        if (!row) throw new AppError('NOT_FOUND', 'No key for this address in the vault')

        privateKey = await vault.withPassphrase(input.passphrase, input.actor, (masterKey) => {
          const plain = open(
            masterKey,
            {
              iv: Buffer.from(row.iv),
              tag: Buffer.from(row.authTag),
              ciphertext: Buffer.from(row.ciphertext),
            },
            keyAad(CHAIN, address),
          )
          try {
            return `0x${plain.toString('hex')}`
          } finally {
            wipe(plain)
          }
        })
      } catch (error) {
        const index = reveals.indexOf(slot)
        if (index !== -1) reveals.splice(index, 1)
        throw error
      }
      await repo.event('KEY_REVEALED', { actor: input.actor, address })
      logger.warn({ address }, 'KEY_REVEALED')
      return { privateKey }
    },
  }
}

export type KeyService = ReturnType<typeof createKeyService>
