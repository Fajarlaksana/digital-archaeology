import { mnemonicToAccount, privateKeyToAccount } from 'viem/accounts'
import { AppError } from '@da/shared'
import type { SignerClient, SignerKey, VaultStatus } from '../../src/signer/client'

/**
 * In-memory stand-in for the signer service with the same contract and error codes.
 * TEST ONLY: it keeps "secrets" in plain memory — the real signer never does (ADR-008).
 */
export function createFakeSigner() {
  let passphrase: string | null = null
  let unlockedBy: string | null = null
  let available = true
  const keys = new Map<string, SignerKey & { secret: string }>()
  const calls: string[] = []

  const status = (): VaultStatus => ({
    initialized: passphrase !== null,
    unlocked: unlockedBy !== null,
    unlockedBy,
    expiresAt: unlockedBy ? new Date(Date.now() + 600_000).toISOString() : null,
    unlockTtlMinutes: 10,
  })
  const guard = (name: string) => {
    calls.push(name)
    if (!available) throw new AppError('SIGNER_UNAVAILABLE', 'The signer service is not reachable')
  }
  const requireInit = () => {
    if (passphrase === null)
      throw new AppError('VAULT_NOT_INITIALIZED', 'The vault has not been initialised')
  }

  const client: SignerClient = {
    async status() {
      guard('status')
      return status()
    },
    async init(input) {
      guard('init')
      if (passphrase !== null)
        throw new AppError('VAULT_ALREADY_INITIALIZED', 'The vault is already initialised')
      passphrase = input.passphrase
      return status()
    },
    async unlock(input) {
      guard('unlock')
      requireInit()
      if (input.passphrase !== passphrase)
        throw new AppError('PASSPHRASE_INVALID', 'Wrong passphrase')
      unlockedBy = input.actor
      return status()
    },
    async lock() {
      guard('lock')
      unlockedBy = null
      return status()
    },
    async changePassphrase(input) {
      guard('changePassphrase')
      requireInit()
      if (input.currentPassphrase !== passphrase)
        throw new AppError('PASSPHRASE_INVALID', 'Wrong current passphrase')
      passphrase = input.newPassphrase
      return status()
    },
    async recover(input) {
      guard('recover')
      requireInit()
      passphrase = input.newPassphrase
      unlockedBy = null
      return status()
    },
    async listKeys() {
      guard('listKeys')
      return [...keys.values()].map(({ secret: _secret, ...key }) => key)
    },
    async importKey(input) {
      guard('importKey')
      requireInit()
      if (!unlockedBy) throw new AppError('VAULT_LOCKED', 'The vault is locked')
      const account =
        input.secretType === 'PRIVATE_KEY'
          ? privateKeyToAccount(input.secret as `0x${string}`)
          : mnemonicToAccount(input.secret, {
              path: (input.derivationPath ?? "m/44'/60'/0'/0/0") as `m/44'/60'/${string}`,
            })
      const address = account.address.toLowerCase()
      if (address !== input.expectedAddress.toLowerCase()) {
        throw new AppError(
          'KEY_ADDRESS_MISMATCH',
          'This private key does not control the selected address',
        )
      }
      if (keys.has(address))
        throw new AppError('CONFLICT', 'A key for this address is already in the vault')
      const key = {
        chainType: 'EVM',
        address,
        keyType:
          input.secretType === 'PRIVATE_KEY'
            ? ('PRIVATE_KEY' as const)
            : ('DERIVED_FROM_MNEMONIC' as const),
        derivationPath:
          input.secretType === 'MNEMONIC' ? (input.derivationPath ?? "m/44'/60'/0'/0/0") : null,
        importedBy: input.actor,
        createdAt: new Date().toISOString(),
        lastUsedAt: null,
        secret: input.secretType === 'PRIVATE_KEY' ? input.secret : '0xderived',
      }
      keys.set(address, key)
      const { secret: _secret, ...publicKey } = key
      return publicKey
    },
    async revealKey(input) {
      guard('revealKey')
      requireInit()
      if (input.passphrase !== passphrase)
        throw new AppError('PASSPHRASE_INVALID', 'Wrong passphrase')
      const key = keys.get(input.address.toLowerCase())
      if (!key) throw new AppError('NOT_FOUND', 'No key for this address in the vault')
      return { privateKey: key.secret }
    },
  }

  return {
    client,
    calls,
    isUnlocked: () => unlockedBy !== null,
    setAvailable(value: boolean) {
      available = value
    },
  }
}

export type FakeSigner = ReturnType<typeof createFakeSigner>
