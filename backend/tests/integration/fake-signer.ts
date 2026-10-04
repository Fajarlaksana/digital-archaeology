import { keccak256, parseTransaction, type TransactionSerializableEIP1559 } from 'viem'
import { mnemonicToAccount, privateKeyToAccount } from 'viem/accounts'
import { AppError, parseChallengeMessage } from '@da/shared'
import type { SignerClient, SignerKey, VaultStatus } from '../../src/signer/client'

/**
 * In-memory stand-in for the signer service with the same contract and error codes.
 * TEST ONLY: it keeps "secrets" in plain memory — the real signer never does (ADR-008).
 */
/** What the real signer reads from the application DB (here: provided by the harness). */
export type ApprovedLoader = (
  transactionId: string,
) => Promise<{ status: string; address: string; serialized: string } | null>

export function createFakeSigner(options: { loadTransaction?: ApprovedLoader } = {}) {
  let loadTransaction = options.loadTransaction
  /** Test hook: change the tx before signing, to prove the backend verifier catches it. */
  let tamper: ((tx: TransactionSerializableEIP1559) => TransactionSerializableEIP1559) | null = null
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
    async signChallenge(input) {
      guard('signChallenge')
      requireInit()
      if (!unlockedBy) throw new AppError('VAULT_LOCKED', 'The vault is locked')
      if (!parseChallengeMessage(input.message)) {
        throw new AppError(
          'VALIDATION_ERROR',
          'Only ownership-verification challenges can be signed',
        )
      }
      const key = keys.get(input.address.toLowerCase())
      if (!key || !key.secret.startsWith('0x') || key.secret.length !== 66) {
        throw new AppError('NOT_FOUND', 'No key for this address in the vault')
      }
      const signature = await privateKeyToAccount(key.secret as `0x${string}`).signMessage({
        message: input.message,
      })
      return { signature }
    },
    async signTransaction(input) {
      guard('signTransaction')
      requireInit()
      if (!unlockedBy) throw new AppError('VAULT_LOCKED', 'The vault is locked')
      const tx = loadTransaction ? await loadTransaction(input.transactionId) : null
      if (!tx) throw new AppError('NOT_FOUND', 'Transaction not found')
      if (tx.status !== 'APPROVED') {
        throw new AppError('CONFLICT', 'Only APPROVED transactions can be signed')
      }
      const key = keys.get(tx.address.toLowerCase())
      if (!key) throw new AppError('NOT_FOUND', 'No key for this address in the vault')
      let parsed = parseTransaction(
        tx.serialized as `0x${string}`,
      ) as TransactionSerializableEIP1559
      if (tamper) parsed = tamper(parsed)
      const signedTransaction = await privateKeyToAccount(
        key.secret as `0x${string}`,
      ).signTransaction(parsed)
      return { signedTransaction, txHash: keccak256(signedTransaction) }
    },
  }

  return {
    client,
    calls,
    isUnlocked: () => unlockedBy !== null,
    setLoader(loader: ApprovedLoader) {
      loadTransaction = loader
    },
    setTamper(fn: typeof tamper) {
      tamper = fn
    },
    setAvailable(value: boolean) {
      available = value
    },
  }
}

export type FakeSigner = ReturnType<typeof createFakeSigner>
