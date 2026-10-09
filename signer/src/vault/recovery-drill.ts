import { randomBytes, randomUUID } from 'node:crypto'
import { secp256k1 } from '@noble/curves/secp256k1.js'
import {
  getAddress,
  hexToBytes,
  keccak256,
  numberToHex,
  recoverTransactionAddress,
  serializeTransaction,
  type TransactionSerializableEIP1559,
} from 'viem'
import { AppError, type Logger } from '@da/shared'
import { open, wipe } from '../crypto/aead'
import { DEFAULT_KDF } from '../crypto/kdf'
import { keyAad } from '../keys/key.service'
import type { VaultDatabase, VaultRepository } from './vault.repository'
import { createVaultService } from './vault.service'

export interface DrillResult {
  keysChecked: number
  /** Addresses whose decrypted key does not derive the stored address (must be empty). */
  mismatches: string[]
  /** A dummy Sepolia transaction was signed and recovered to the first key's address. */
  signedTestTransaction: boolean
}

/** Address of a raw secp256k1 private key, computed from bytes (the key never becomes a string). */
function addressOf(privateKey: Buffer): string {
  const publicKey = secp256k1.getPublicKey(privateKey, false) // 65 bytes, 0x04 prefix
  return `0x${keccak256(publicKey.slice(1)).slice(-40)}`.toLowerCase()
}

/**
 * Vault recovery drill (Phase 14, ADR-028) — run ONLY against a restored COPY of da_vault on a
 * clean machine. Proves that a backup + the offline recovery passphrase are enough to get every
 * key back and sign: recover → unlock → decrypt + re-derive every address → sign a dummy testnet
 * transaction (never broadcast) → lock. It changes the copy's main passphrase to a random,
 * discarded one, so the copy cannot be confused with the live vault afterwards.
 */
export async function runRecoveryDrill(deps: {
  db: VaultDatabase
  repo: VaultRepository
  logger: Logger
  recoveryPassphrase: string
}): Promise<DrillResult> {
  const actor = randomUUID()
  const vault = createVaultService({
    repo: deps.repo,
    logger: deps.logger,
    unlockTtlMs: 5 * 60_000,
    kdf: DEFAULT_KDF,
  })
  try {
    if (!(await vault.status()).initialized) {
      throw new AppError('VAULT_NOT_INITIALIZED', 'This database holds no vault')
    }
    const drillPassphrase = randomBytes(24).toString('base64url')
    await vault.recover({
      recoveryPassphrase: deps.recoveryPassphrase,
      newPassphrase: drillPassphrase,
      actor,
    })
    await vault.unlock({ passphrase: drillPassphrase, actor })

    const rows = await deps.db.vaultKey.findMany({ orderBy: { createdAt: 'asc' } })
    const mismatches: string[] = []
    let signedTestTransaction = false
    for (const [index, row] of rows.entries()) {
      await vault.withMasterKey(async (masterKey) => {
        const plain = open(
          masterKey,
          {
            iv: Buffer.from(row.iv),
            tag: Buffer.from(row.authTag),
            ciphertext: Buffer.from(row.ciphertext),
          },
          keyAad(row.chainType, row.address),
        )
        try {
          if (addressOf(plain) !== row.address.toLowerCase()) mismatches.push(row.address)
          if (index === 0) {
            const tx: TransactionSerializableEIP1559 = {
              type: 'eip1559',
              chainId: 11155111, // Sepolia — the drill transaction is never broadcast
              nonce: 0,
              to: getAddress(row.address),
              value: 0n,
              gas: 21_000n,
              maxFeePerGas: 1_000_000_000n,
              maxPriorityFeePerGas: 1_000_000_000n,
            }
            const hash = keccak256(serializeTransaction(tx))
            const sig = secp256k1.Signature.fromBytes(
              secp256k1.sign(hexToBytes(hash), plain, { prehash: false, format: 'recovered' }),
              'recovered',
            )
            const signed = serializeTransaction(tx, {
              r: numberToHex(sig.r, { size: 32 }),
              s: numberToHex(sig.s, { size: 32 }),
              yParity: sig.recovery!,
            })
            const recovered = await recoverTransactionAddress({ serializedTransaction: signed })
            signedTestTransaction = recovered.toLowerCase() === row.address.toLowerCase()
          }
        } finally {
          wipe(plain)
        }
      })
    }
    await vault.lock({ actor })
    deps.logger.info(
      { keysChecked: rows.length, mismatches: mismatches.length, signedTestTransaction },
      'VAULT_RECOVERY_DRILL_FINISHED',
    )
    return { keysChecked: rows.length, mismatches, signedTestTransaction }
  } finally {
    vault.shutdown()
  }
}
