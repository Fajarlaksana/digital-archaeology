import { secp256k1 } from '@noble/curves/secp256k1.js'
import {
  getAddress,
  hexToBytes,
  keccak256,
  numberToHex,
  parseTransaction,
  recoverTransactionAddress,
  serializeTransaction,
  type TransactionSerializableEIP1559,
} from 'viem'
import { AppError, type Logger } from '@da/shared'
import { open, wipe } from '../crypto/aead'
import { keyAad } from '../keys/key.service'
import type { VaultDatabase, VaultRepository } from '../vault/vault.repository'
import type { VaultService } from '../vault/vault.service'
import type { ApprovedTransactionSource } from './approved-source'

const CHAIN = 'EVM'

/**
 * Signs an APPROVED recovery transaction (Phase 10, ADR-023). The backend only names the
 * transaction; everything that matters is read and re-verified here:
 *  - status APPROVED, the newest decision is an APPROVAL by an ACTIVE REVIEWER who is not the
 *    creator, still within its window;
 *  - the signing user is neither the creator nor the approver (three different people);
 *  - keccak256(serialized unsigned tx) equals the approved hash, chain and nonce match;
 *  - this vault never signed a DIFFERENT transaction for the same address + chain + nonce.
 * The key is decrypted into a Buffer, used for one ECDSA signature and wiped. Only the signed
 * raw transaction leaves the signer.
 */
export function createTransactionSigner(deps: {
  source: ApprovedTransactionSource | null
  db: VaultDatabase
  repo: VaultRepository
  vault: VaultService
  logger: Logger
  now?: () => number
}) {
  const now = deps.now ?? Date.now

  return {
    async sign(input: { actor: string; transactionId: string }) {
      if (!deps.source) {
        throw new AppError(
          'SIGNER_UNAVAILABLE',
          'Transaction signing is not configured (APP_DATABASE_URL_READONLY)',
        )
      }
      const tx = await deps.source.load(input.transactionId)
      if (!tx) throw new AppError('NOT_FOUND', 'Transaction not found')
      if (tx.status !== 'APPROVED') {
        throw new AppError('CONFLICT', 'Only APPROVED transactions can be signed')
      }

      const latest = tx.decisions[0]
      if (!latest || latest.decision !== 'APPROVED' || !latest.decidedBy) {
        throw new AppError('CONFLICT', 'The transaction has no valid approval')
      }
      if (latest.decidedBy === tx.createdBy) {
        throw new AppError('SELF_APPROVAL', 'The approval was given by the creator')
      }
      if (!latest.approverActive || !latest.approverIsReviewer) {
        throw new AppError('CONFLICT', 'The approver is no longer an active REVIEWER')
      }
      if (!latest.expiresAt || latest.expiresAt.getTime() <= now()) {
        throw new AppError('TRANSACTION_EXPIRED', 'The approval has expired — preview again')
      }
      if (input.actor === tx.createdBy || input.actor === latest.decidedBy) {
        throw new AppError(
          'SELF_APPROVAL',
          'The signer must be a third person: neither the creator nor the approver',
        )
      }

      // The approved bytes, exactly: recompute the hash instead of trusting any stored field.
      const serialized = (tx.unsignedPayload as { serialized?: unknown } | null)?.serialized
      if (typeof serialized !== 'string' || !/^0x02[0-9a-f]+$/i.test(serialized)) {
        throw new AppError(
          'VALIDATION_ERROR',
          'The approved payload is not an EIP-1559 transaction',
        )
      }
      const unsignedHash = keccak256(serialized as `0x${string}`)
      if (unsignedHash.toLowerCase() !== tx.unsignedHash?.toLowerCase()) {
        throw new AppError('VALIDATION_ERROR', 'The payload does not match the approved hash')
      }
      const parsed = parseTransaction(serialized as `0x${string}`)
      if (
        parsed.type !== 'eip1559' ||
        parsed.chainId !== tx.chainId ||
        parsed.nonce !== tx.nonce ||
        tx.nonce === null
      ) {
        throw new AppError(
          'VALIDATION_ERROR',
          'Chain or nonce do not match the approved transaction',
        )
      }

      const address = tx.address.toLowerCase()
      const row = await deps.db.vaultKey.findUnique({
        where: { chainType_address: { chainType: CHAIN, address } },
      })
      if (!row) throw new AppError('NOT_FOUND', 'No key for this address in the vault')

      // Never two different signed transactions for one nonce (they would compete on chain).
      const earlier = await deps.db.vaultEvent.findMany({
        where: { type: 'TRANSACTION_SIGNED', address },
        select: { metadata: true },
      })
      const conflict = earlier.some((e) => {
        const m = e.metadata as { chainId?: number; nonce?: number; unsignedHash?: string } | null
        return (
          m?.chainId === tx.chainId && m?.nonce === tx.nonce && m?.unsignedHash !== unsignedHash
        )
      })
      if (conflict) {
        throw new AppError(
          'CONFLICT',
          'A different transaction was already signed for this address and nonce',
        )
      }

      const signature = await deps.vault.withMasterKey((masterKey) => {
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
          const bytes = secp256k1.sign(hexToBytes(unsignedHash), plain, {
            prehash: false,
            format: 'recovered',
          })
          return secp256k1.Signature.fromBytes(bytes, 'recovered')
        } finally {
          wipe(plain)
        }
      })

      const signed = serializeTransaction(parsed as TransactionSerializableEIP1559, {
        r: numberToHex(signature.r, { size: 32 }),
        s: numberToHex(signature.s, { size: 32 }),
        yParity: signature.recovery!,
      })
      // Self-check: the signature must recover to the source address of the transaction.
      const recovered = await recoverTransactionAddress({ serializedTransaction: signed })
      if (getAddress(recovered) !== getAddress(tx.address)) {
        throw new AppError('INTERNAL_ERROR', 'Signature self-check failed')
      }
      const txHash = keccak256(signed)

      await deps.db.vaultKey.update({
        where: { id: row.id },
        data: { lastUsedAt: new Date(now()) },
      })
      await deps.repo.event('TRANSACTION_SIGNED', {
        actor: input.actor,
        address,
        metadata: {
          transactionId: tx.id,
          chainId: tx.chainId,
          nonce: tx.nonce,
          unsignedHash,
          txHash,
        },
      })
      deps.logger.info({ transactionId: tx.id, txHash }, 'TRANSACTION_SIGNED')
      return { signedTransaction: signed, txHash }
    },
  }
}

export type TransactionSigner = ReturnType<typeof createTransactionSigner>
