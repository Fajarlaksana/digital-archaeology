import { AppError, type Logger } from '@da/shared'
import { chainAdapterFor } from '../chains'
import type { ChainClientFactory } from '../chains/clients'
import type { ChainReader } from '../chains/types'
import { evaluateConfirmation } from '../domain/confirmation'
import { fromBaseUnit, toBaseUnit } from '../domain/money'
import { checkStillValid, planTransfer, type PlanError } from '../domain/transfer-plan'
import { compareFiat, fiatValue } from '../domain/valuation'
import type { TransactionStatus } from '../generated/prisma/client'
import { fromDbAmount, fromDbAmountOrNull } from '../repositories/amount'
import type { AuditLogRepository } from '../repositories/audit-log.repository'
import type { PriceRepository } from '../repositories/price.repository'
import type {
  TransactionRepository,
  TransactionWithContext,
} from '../repositories/transaction.repository'
import type { SignerClient } from '../signer/client'
import { recordAction } from './audit-trail'
import type { AuthContext, RequestMeta } from './auth.service'

type Person = { id: string; name: string } | null

export interface PublicTransaction {
  id: string
  status: TransactionStatus
  statusReason: string | null
  network: {
    id: string
    name: string
    displayName: string
    isTestnet: boolean
    chainId: number | null
  }
  source: { addressId: string; address: string; label: string | null }
  destination: { id: string; address: string; label: string }
  asset: {
    id: string
    symbol: string
    decimals: number
    isNative: boolean
    contractAddress: string | null
  }
  /** Base units (string) and the exact decimal form — never floats. */
  amount: string
  amountFormatted: string
  sweep: boolean
  nonce: number | null
  gasLimit: string | null
  maxFeePerGas: string | null
  maxPriorityFeePerGas: string | null
  /** Maximum fee in native base units, and formatted in the native asset. */
  networkFee: string | null
  networkFeeFormatted: string | null
  nativeSymbol: string
  estimatedValue: string | null
  valueSimulated: boolean
  fiatCurrency: string
  unsignedHash: string | null
  unsignedPayload: unknown
  /** Hash of the signed transaction (Phase 10). The signed raw tx itself is never returned. */
  txHash: string | null
  /** Phase 11: chain progress. */
  explorerTxUrl: string | null
  broadcastAt: string | null
  confirmations: number
  requiredConfirmations: number
  blockNumber: string | null
  /** Actual fee paid once mined (native base units + formatted). */
  feePaid: string | null
  feePaidFormatted: string | null
  confirmedAt: string | null
  failureReason: string | null
  /** No receipt for longer than the STUCK threshold (ADR-024). */
  stuck: boolean
  createdBy: Person
  createdAt: string
  approvals: Array<{
    id: string
    requestedBy: Person
    decidedBy: Person
    decision: 'APPROVED' | 'REJECTED' | null
    reason: string | null
    decidedAt: string | null
    expiresAt: string | null
  }>
}

const PLAN_ERRORS: Record<
  PlanError,
  { code: 'INSUFFICIENT_BALANCE' | 'VALIDATION_ERROR'; message: string }
> = {
  NO_BALANCE: { code: 'INSUFFICIENT_BALANCE', message: 'The address holds none of this asset' },
  FEE_EXCEEDS_BALANCE: {
    code: 'INSUFFICIENT_BALANCE',
    message: 'The network fee would consume the whole balance',
  },
  NEEDS_GAS_FUNDING: {
    code: 'INSUFFICIENT_BALANCE',
    message: 'Not enough native coin on the address to pay gas (NEEDS_GAS_FUNDING)',
  },
  AMOUNT_NOT_POSITIVE: { code: 'VALIDATION_ERROR', message: 'Amount must be greater than zero' },
  AMOUNT_TOO_LARGE: {
    code: 'VALIDATION_ERROR',
    message: 'Amount is larger than what can be sent after the fee',
  },
}

/**
 * Transaction preview & approval (Phase 9, ADR-022). Builds the unsigned transfer from LIVE chain
 * data, stores exactly what will be signed, and lets an independent REVIEWER approve it.
 * Nothing here signs or broadcasts (Phases 10–11) — and nothing runs without a human.
 */
export function createTransactionService(deps: {
  transactions: TransactionRepository
  prices: PriceRepository
  signer: SignerClient
  clientsFor: ChainClientFactory
  audit: AuditLogRepository
  logger: Logger
  fiatCurrency: string
  feeMarginPercent: number
  approvalTtlMs: number
  networkMode: 'testnet' | 'mainnet'
  /**
   * Mainnet only (ADR-028): until one transfer to a destination is CONFIRMED, transfers to it must
   * be test transfers worth at most this much (fiat).
   */
  mainnetFirstTransferMax: string
  /** Blocks on top of (and including) the inclusion block before CONFIRMED (default 3). */
  requiredConfirmations: number
  /** Without a receipt for this long, a broadcast transaction is flagged STUCK. */
  stuckAfterMs: number
  /** After CONFIRMED (e.g. refresh the address's balances). Errors are logged, not thrown. */
  afterConfirmed?: (t: { addressId: string; networkId: string }) => Promise<void>
  now: () => Date
}) {
  const { transactions, audit, now } = deps

  function toPublic(t: TransactionWithContext): PublicTransaction {
    const amount = fromDbAmount(t.amount)
    const fee = fromDbAmountOrNull(t.networkFee)
    const native = t.address.network.assets[0]
    return {
      id: t.id,
      status: t.status,
      statusReason: t.statusReason,
      network: {
        id: t.address.network.id,
        name: t.address.network.name,
        displayName: t.address.network.displayName,
        isTestnet: t.address.network.isTestnet,
        chainId: t.address.network.chainId,
      },
      source: { addressId: t.addressId, address: t.address.address, label: t.address.label },
      destination: {
        id: t.destination.id,
        address: t.destination.address,
        label: t.destination.label,
      },
      asset: {
        id: t.asset.id,
        symbol: t.asset.symbol,
        decimals: t.asset.decimals,
        isNative: t.asset.isNative,
        contractAddress: t.asset.contractAddress,
      },
      amount: amount.toString(),
      amountFormatted: fromBaseUnit(amount, t.asset.decimals),
      sweep: t.sweep,
      nonce: t.nonce,
      gasLimit: fromDbAmountOrNull(t.gasLimit)?.toString() ?? null,
      maxFeePerGas: fromDbAmountOrNull(t.maxFeePerGas)?.toString() ?? null,
      maxPriorityFeePerGas: fromDbAmountOrNull(t.maxPriorityFeePerGas)?.toString() ?? null,
      networkFee: fee?.toString() ?? null,
      networkFeeFormatted: fee === null || !native ? null : fromBaseUnit(fee, native.decimals),
      nativeSymbol: native?.symbol ?? '',
      estimatedValue: t.estimatedValue?.toFixed(8) ?? null,
      valueSimulated: t.valueSimulated,
      fiatCurrency: deps.fiatCurrency,
      unsignedHash: t.unsignedHash,
      unsignedPayload: t.unsignedPayload,
      txHash: t.txHash,
      explorerTxUrl:
        t.txHash && t.address.network.explorerUrl
          ? `${t.address.network.explorerUrl.replace(/\/$/, '')}/tx/${t.txHash}`
          : null,
      broadcastAt: t.broadcastAt?.toISOString() ?? null,
      confirmations: t.confirmations,
      requiredConfirmations: deps.requiredConfirmations,
      blockNumber: t.blockNumber?.toString() ?? null,
      feePaid: fromDbAmountOrNull(t.feePaid)?.toString() ?? null,
      feePaidFormatted:
        t.feePaid === null || !native
          ? null
          : fromBaseUnit(fromDbAmount(t.feePaid), native.decimals),
      confirmedAt: t.confirmedAt?.toISOString() ?? null,
      failureReason: t.failureReason,
      stuck: t.stuckSince !== null,
      createdBy: t.createdBy,
      createdAt: t.createdAt.toISOString(),
      approvals: t.approvals.map((a) => ({
        id: a.id,
        requestedBy: a.requestedBy,
        decidedBy: a.decidedBy,
        decision: a.decision,
        reason: a.reason,
        decidedAt: a.decidedAt?.toISOString() ?? null,
        expiresAt: a.expiresAt?.toISOString() ?? null,
      })),
    }
  }

  async function getOrThrow(id: string) {
    const t = await transactions.findById(id)
    if (!t) throw new AppError('NOT_FOUND', 'Transaction not found', { resourceId: id })
    return t
  }

  const record = (
    actor: AuthContext | null,
    meta: RequestMeta | null,
    action: string,
    t: { id: string },
    metadata: Record<string, unknown> = {},
  ) =>
    actor && meta
      ? recordAction(audit, actor, meta, {
          action,
          resourceType: 'transaction',
          resourceId: t.id,
          metadata,
        })
      : audit.create({
          action,
          result: 'SUCCESS',
          userId: null,
          resourceType: 'transaction',
          resourceId: t.id,
          metadata,
        })

  /** Approval windows pass without anyone looking: close them before reading. */
  async function expireOverdue() {
    for (const t of await transactions.overdueApprovals(now())) {
      if (
        await transactions.close(t.id, t.addressId, ['APPROVED'], 'EXPIRED', 'APPROVAL_TIMEOUT')
      ) {
        await record(null, null, 'TRANSACTION_EXPIRED', t, { reason: 'APPROVAL_TIMEOUT' })
      }
    }
  }

  function authorizationValid(auths: Array<{ expiresAt: Date | null }>, at: Date) {
    return auths.some((a) => a.expiresAt === null || a.expiresAt > at)
  }

  /** The RPC must serve the chain the transaction is for — never sign for the wrong chain. */
  async function readerFor(network: Parameters<ChainClientFactory>[0]): Promise<ChainReader> {
    const reader = deps.clientsFor(network).reader
    if (network.chainId === null || (await reader.getChainId()) !== network.chainId) {
      throw new AppError('INVALID_NETWORK', `The RPC does not serve chain ${network.chainId}`)
    }
    return reader
  }

  /**
   * Live re-check of a stored transaction (approve, sign, broadcast). The approval window only
   * applies until signing; a signed transaction is checked for nonce, fee cap and balance.
   */
  async function invalidReason(
    t: TransactionWithContext,
    opts: { approvalWindow: boolean } = { approvalWindow: true },
  ): Promise<string | null> {
    const at = now()
    if (t.destination.status !== 'APPROVED') return 'DESTINATION_NOT_APPROVED'
    if (!authorizationValid(await transactions.verifiedAuthorizations(t.addressId), at)) {
      return 'AUTHORIZATION_INVALID'
    }
    const reader = await readerFor(t.address.network)
    const [nonce, fees, nativeBalance, assetBalance] = await Promise.all([
      reader.getOutgoingNonce(t.address.address),
      reader.getFeeData(),
      reader.getNativeBalance(t.address.address),
      t.asset.isNative
        ? Promise.resolve(0n)
        : reader.getTokenBalance(t.address.address, t.asset.contractAddress!),
    ])
    const approval = t.approvals.find((a) => a.decision === 'APPROVED')
    return checkStillValid({
      tx: {
        isNative: t.asset.isNative,
        nonce: t.nonce!,
        amount: fromDbAmount(t.amount),
        networkFee: fromDbAmount(t.networkFee!),
        maxFeePerGas: fromDbAmount(t.maxFeePerGas!),
      },
      current: {
        nonce,
        fees,
        nativeBalance,
        assetBalance: t.asset.isNative ? nativeBalance : assetBalance,
      },
      approvalExpiresAt:
        t.status === 'APPROVED' && opts.approvalWindow ? (approval?.expiresAt ?? null) : null,
      now: at,
    })
  }

  function assertNotCreator(actor: AuthContext, t: TransactionWithContext) {
    if (actor.user.id === t.createdById) {
      throw new AppError(
        'SELF_APPROVAL',
        'You created this transaction — another REVIEWER must decide',
        { resourceId: t.id },
      )
    }
  }

  return {
    async list(filter: { status?: TransactionStatus; addressId?: string }) {
      await expireOverdue()
      return (await transactions.list(filter)).map(toPublic)
    },

    async get(id: string) {
      await expireOverdue()
      return toPublic(await getOrThrow(id))
    },

    async preview(
      actor: AuthContext,
      input: { addressId: string; assetId: string; destinationId: string; amount: string | null },
      meta: RequestMeta,
    ): Promise<PublicTransaction> {
      const [address, destination] = await transactions.previewContext(
        input.addressId,
        input.destinationId,
      )
      if (!address)
        throw new AppError('NOT_FOUND', 'Address not found', { resourceId: input.addressId })
      if (address.archivedAt) throw new AppError('CONFLICT', 'The address is archived')
      const network = address.network
      if (network.status !== 'ACTIVE') {
        throw new AppError('INVALID_NETWORK', `Network "${network.name}" is disabled`)
      }
      if (!network.isTestnet && deps.networkMode !== 'mainnet') {
        throw new AppError('INVALID_NETWORK', 'Mainnet transactions need NETWORK_MODE=mainnet')
      }
      const asset = network.assets.find((a) => a.id === input.assetId)
      if (!asset)
        throw new AppError('VALIDATION_ERROR', 'The asset does not belong to this network')
      const native = network.assets.find((a) => a.isNative)
      if (!native) throw new AppError('INVALID_NETWORK', 'The network has no native asset')

      const at = now()
      if (!authorizationValid(address.authorizations, at)) {
        throw new AppError(
          'AUTHORIZATION_FAILED',
          'Ownership of this address is not verified (or the authorization expired)',
        )
      }
      if (
        !destination ||
        destination.networkId !== network.id ||
        destination.status !== 'APPROVED'
      ) {
        throw new AppError('CONFLICT', 'Choose an APPROVED destination on the same network')
      }
      if (destination.address.toLowerCase() === address.address.toLowerCase()) {
        throw new AppError('VALIDATION_ERROR', 'The destination is the source address itself')
      }
      const keys = await deps.signer.listKeys() // SIGNER_UNAVAILABLE propagates
      if (!keys.some((k) => k.address.toLowerCase() === address.address.toLowerCase())) {
        throw new AppError('CONFLICT', 'The key of this address is not in the vault')
      }

      let requested: bigint | null = null
      if (input.amount !== null) {
        try {
          requested = toBaseUnit(input.amount, asset.decimals)
        } catch {
          throw new AppError(
            'VALIDATION_ERROR',
            `Amount must be a decimal with at most ${asset.decimals} decimals`,
          )
        }
      }

      // Everything below is read live, right now (docs/02 §2.6: preview always uses fresh fees).
      const reader = await readerFor(network)
      const [nonce, fees, nativeBalance, tokenBalance] = await Promise.all([
        reader.getOutgoingNonce(address.address),
        reader.getFeeData(),
        reader.getNativeBalance(address.address),
        asset.isNative
          ? Promise.resolve(0n)
          : reader.getTokenBalance(address.address, asset.contractAddress!),
      ])
      const assetBalance = asset.isNative ? nativeBalance : tokenBalance
      let tokenGasEstimate: bigint | null = null
      if (!asset.isNative && assetBalance > 0n) {
        tokenGasEstimate = await reader.estimateTokenTransferGas({
          from: address.address,
          token: asset.contractAddress!,
          to: destination.address,
          amount:
            requested !== null && requested > 0n && requested <= assetBalance
              ? requested
              : assetBalance,
        })
      }
      const planned = planTransfer({
        isNative: asset.isNative,
        assetBalance,
        nativeBalance,
        fees,
        marginPercent: deps.feeMarginPercent,
        tokenGasEstimate,
        requestedAmount: requested,
      })
      if (!planned.ok) {
        const e = PLAN_ERRORS[planned.error]
        throw new AppError(e.code, e.message)
      }
      const plan = planned.plan

      // Mainnet: the first transfer to a destination proves the path with a small amount (ADR-028).
      if (!network.isTestnet && !(await transactions.hasConfirmedTo(destination.id))) {
        if (plan.sweep) {
          throw new AppError(
            'VALIDATION_ERROR',
            'First mainnet transfer to this destination must be a small test transfer, not a sweep',
          )
        }
        const price = await deps.prices.latestSnapshot(asset.id, deps.fiatCurrency)
        if (!price) {
          throw new AppError(
            'VALIDATION_ERROR',
            'A price is needed to check the first-transfer limit for this asset',
          )
        }
        const value = fiatValue(plan.amount, asset.decimals, price.price.toFixed())
        if (compareFiat(value, deps.mainnetFirstTransferMax) > 0) {
          throw new AppError(
            'VALIDATION_ERROR',
            `First mainnet transfer to this destination may be worth at most ${deps.mainnetFirstTransferMax} ${deps.fiatCurrency}`,
          )
        }
      }

      const unsigned = chainAdapterFor(network.chainType).buildUnsignedTransfer({
        chainId: network.chainId!,
        nonce,
        recipient: destination.address,
        asset: { isNative: asset.isNative, contractAddress: asset.contractAddress },
        amount: plan.amount,
        gasLimit: plan.gasLimit,
        maxFeePerGas: plan.maxFeePerGas,
        maxPriorityFeePerGas: plan.maxPriorityFeePerGas,
      })
      const snapshot = await deps.prices.latestSnapshot(asset.id, deps.fiatCurrency)
      const created = await transactions.create({
        addressId: address.id,
        networkId: network.id,
        assetId: asset.id,
        destinationId: destination.id,
        createdById: actor.user.id,
        amount: plan.amount,
        sweep: plan.sweep,
        nonce,
        gasLimit: plan.gasLimit,
        maxFeePerGas: plan.maxFeePerGas,
        maxPriorityFeePerGas: plan.maxPriorityFeePerGas,
        networkFee: plan.networkFee,
        recipient: destination.address,
        estimatedValue: snapshot
          ? fiatValue(plan.amount, asset.decimals, snapshot.price.toFixed())
          : null,
        valueSimulated: network.isTestnet,
        unsignedPayload: unsigned.payload,
        unsignedHash: unsigned.hash,
      })
      if (!created) {
        throw new AppError('CONFLICT', 'This address already has a transaction in progress')
      }
      await record(actor, meta, 'TRANSACTION_PREVIEWED', created, {
        address: address.address,
        asset: asset.symbol,
        amount: plan.amount.toString(),
        sweep: plan.sweep,
        destination: destination.address,
        nonce,
        networkFee: plan.networkFee.toString(),
        unsignedHash: unsigned.hash,
      })
      deps.logger.info(
        { transactionId: created.id, unsignedHash: unsigned.hash },
        'TRANSACTION_PREVIEWED',
      )
      return toPublic(await getOrThrow(created.id))
    },

    async approve(actor: AuthContext, id: string, input: { reason: string }, meta: RequestMeta) {
      const t = await getOrThrow(id)
      if (t.status !== 'CREATED') {
        throw new AppError('CONFLICT', 'Only a previewed (CREATED) transaction can be approved')
      }
      assertNotCreator(actor, t)
      const approval = await transactions.openApproval(id)
      if (!approval) throw new AppError('CONFLICT', 'No open approval request')

      const invalid = await invalidReason(t)
      if (invalid) {
        await transactions.close(id, t.addressId, ['CREATED'], 'EXPIRED', invalid)
        await record(actor, meta, 'TRANSACTION_EXPIRED', t, { reason: invalid })
        throw new AppError(
          'TRANSACTION_EXPIRED',
          `The preview is no longer valid (${invalid}) — create a new preview`,
          { resourceId: id },
        )
      }
      const at = now()
      const expiresAt = new Date(at.getTime() + deps.approvalTtlMs)
      const ok = await transactions.approve({
        id,
        approvalId: approval.id,
        decidedById: actor.user.id,
        reason: input.reason,
        at,
        expiresAt,
      })
      if (!ok) throw new AppError('CONFLICT', 'This transaction was decided concurrently')
      await record(actor, meta, 'TRANSACTION_APPROVED', t, {
        reason: input.reason,
        unsignedHash: t.unsignedHash,
        approvalExpiresAt: expiresAt.toISOString(),
      })
      return toPublic(await getOrThrow(id))
    },

    async reject(actor: AuthContext, id: string, input: { reason: string }, meta: RequestMeta) {
      const t = await getOrThrow(id)
      if (t.status !== 'CREATED') {
        throw new AppError('CONFLICT', 'Only a previewed (CREATED) transaction can be rejected')
      }
      assertNotCreator(actor, t)
      const approval = await transactions.openApproval(id)
      if (!approval) throw new AppError('CONFLICT', 'No open approval request')
      const ok = await transactions.reject({
        id,
        addressId: t.addressId,
        approvalId: approval.id,
        decidedById: actor.user.id,
        reason: input.reason,
        at: now(),
      })
      if (!ok) throw new AppError('CONFLICT', 'This transaction was decided concurrently')
      await record(actor, meta, 'TRANSACTION_REJECTED', t, { reason: input.reason })
      return toPublic(await getOrThrow(id))
    },

    async cancel(actor: AuthContext, id: string, input: { reason: string }, meta: RequestMeta) {
      const t = await getOrThrow(id)
      if (
        !(await transactions.close(
          id,
          t.addressId,
          ['CREATED', 'APPROVED'],
          'CANCELLED',
          input.reason,
        ))
      ) {
        throw new AppError('CONFLICT', 'Only CREATED or APPROVED transactions can be cancelled')
      }
      await record(actor, meta, 'TRANSACTION_CANCELLED', t, { reason: input.reason })
      return toPublic(await getOrThrow(id))
    },

    /**
     * SUPER_ADMIN signs an APPROVED transaction (Phase 10, ADR-023). Order matters:
     * three-person rule → live re-check (may expire it) → signer (verifies the approval in the
     * DB itself) → Signed Tx Verifier → SIGNED. Only the transaction id reaches the signer.
     */
    async sign(actor: AuthContext, id: string, meta: RequestMeta) {
      const t = await getOrThrow(id)
      if (t.status !== 'APPROVED') {
        throw new AppError('CONFLICT', 'Only APPROVED transactions can be signed')
      }
      const approval = t.approvals.find((a) => a.decision === 'APPROVED')
      if (actor.user.id === t.createdById || actor.user.id === approval?.decidedById) {
        throw new AppError(
          'SELF_APPROVAL',
          'The signer must be a third person: neither the creator nor the approver',
          { resourceId: id },
        )
      }
      const invalid = await invalidReason(t)
      if (invalid) {
        await transactions.close(id, t.addressId, ['APPROVED'], 'EXPIRED', invalid)
        await record(actor, meta, 'TRANSACTION_EXPIRED', t, { reason: invalid })
        throw new AppError(
          'TRANSACTION_EXPIRED',
          `The approval is no longer valid (${invalid}) — create a new preview`,
          { resourceId: id },
        )
      }

      const { signedTransaction } = await deps.signer.signTransaction({
        actor: actor.user.id,
        transactionId: id,
      })
      const serialized = (t.unsignedPayload as { serialized?: string } | null)?.serialized ?? ''
      const verdict = await chainAdapterFor(t.address.network.chainType).verifySignedTransfer({
        signed: signedTransaction,
        unsignedSerialized: serialized,
        from: t.address.address,
      })
      if (!verdict.ok) {
        // Never store or log the mismatching transaction — only why it was refused.
        await audit.create({
          action: 'TX_SIGNATURE_REJECTED',
          result: 'FAILURE',
          userId: actor.user.id,
          resourceType: 'transaction',
          resourceId: id,
          ipAddress: meta.ip,
          userAgent: meta.userAgent,
          requestId: meta.requestId,
          metadata: { reason: verdict.reason, unsignedHash: t.unsignedHash },
        })
        deps.logger.error({ transactionId: id, reason: verdict.reason }, 'TX_SIGNATURE_REJECTED')
        throw new AppError(
          'TRANSACTION_FAILED',
          'The signed transaction does not match the approved one — it was discarded',
        )
      }
      if (!(await transactions.markSigned(id, signedTransaction, verdict.txHash))) {
        throw new AppError('CONFLICT', 'This transaction changed concurrently')
      }
      await record(actor, meta, 'TX_SIGNED', t, {
        txHash: verdict.txHash,
        unsignedHash: t.unsignedHash,
      })
      return toPublic(await getOrThrow(id))
    },

    /**
     * SUPER_ADMIN sends a SIGNED transaction (Phase 11, ADR-024). The stored raw transaction is
     * verified against the approval once more, the chain is re-checked (nonce, fee cap, balance),
     * and the hash the node returns must be the one recorded at signing.
     */
    async broadcast(actor: AuthContext, id: string, meta: RequestMeta) {
      const t = await getOrThrow(id)
      if (t.status !== 'SIGNED' || !t.signedPayload || !t.txHash) {
        throw new AppError('CONFLICT', 'Only SIGNED transactions can be broadcast')
      }
      const network = t.address.network
      if (!network.isTestnet && deps.networkMode !== 'mainnet') {
        throw new AppError('INVALID_NETWORK', 'Mainnet transactions need NETWORK_MODE=mainnet')
      }
      const serialized = (t.unsignedPayload as { serialized?: string } | null)?.serialized ?? ''
      const verdict = await chainAdapterFor(network.chainType).verifySignedTransfer({
        signed: t.signedPayload,
        unsignedSerialized: serialized,
        from: t.address.address,
      })
      if (!verdict.ok || verdict.txHash !== t.txHash) {
        throw new AppError(
          'TRANSACTION_FAILED',
          'The stored signed transaction failed verification',
        )
      }
      const invalid = await invalidReason(t, { approvalWindow: false })
      if (invalid) {
        await transactions.close(id, t.addressId, ['SIGNED'], 'EXPIRED', invalid)
        await record(actor, meta, 'TRANSACTION_EXPIRED', t, { reason: invalid })
        throw new AppError(
          'TRANSACTION_EXPIRED',
          `The signed transaction can no longer be sent (${invalid}) — create a new preview`,
          { resourceId: id },
        )
      }

      const reader = await readerFor(network)
      let sentHash: string
      try {
        sentHash = (await reader.sendRawTransaction(t.signedPayload)).toLowerCase()
      } catch (error) {
        const code = error instanceof AppError ? error.code : 'TRANSACTION_FAILED'
        await audit.create({
          action: 'TX_BROADCAST_FAILED',
          result: 'FAILURE',
          userId: actor.user.id,
          resourceType: 'transaction',
          resourceId: id,
          ipAddress: meta.ip,
          userAgent: meta.userAgent,
          requestId: meta.requestId,
          metadata: { code, txHash: t.txHash },
        })
        throw error
      }
      if (sentHash !== t.txHash) {
        deps.logger.error({ transactionId: id }, 'TX_BROADCAST_HASH_MISMATCH')
        throw new AppError('TRANSACTION_FAILED', 'The node returned an unexpected transaction hash')
      }
      if (!(await transactions.markBroadcast(id, now()))) {
        throw new AppError('CONFLICT', 'This transaction changed concurrently')
      }
      await record(actor, meta, 'TX_BROADCASTED', t, { txHash: t.txHash, network: network.name })
      deps.logger.info({ transactionId: id, txHash: t.txHash }, 'TX_BROADCASTED')
      return toPublic(await getOrThrow(id))
    },

    /**
     * CHECK_PENDING_TRANSACTIONS (ADR-024): moves broadcast transactions to PENDING / CONFIRMED /
     * FAILED from receipts, flags STUCK ones. Read-only towards the chain.
     */
    async checkInFlight() {
      const summary = { checked: 0, confirmed: 0, failed: 0, stuck: 0, errors: 0 }
      for (const t of await transactions.inFlight()) {
        summary.checked++
        try {
          const reader = await readerFor(t.address.network)
          const [receipt, currentBlock, latestNonce] = await Promise.all([
            reader.getTransactionReceipt(t.txHash!),
            reader.getBlockNumber(),
            reader.getOutgoingNonce(t.address.address),
          ])
          const at = now()
          const from = t.status as 'BROADCASTED' | 'PENDING'
          const state = evaluateConfirmation({
            current: from,
            receipt,
            currentBlock,
            required: deps.requiredConfirmations,
            latestNonce,
            txNonce: t.nonce!,
            broadcastAt: t.broadcastAt!,
            now: at,
            stuckAfterMs: deps.stuckAfterMs,
          })
          const newlyStuck = state.stuck && t.stuckSince === null
          await transactions.track({
            id: t.id,
            addressId: t.addressId,
            from,
            status: state.status,
            confirmations: state.confirmations,
            blockNumber: receipt?.blockNumber ?? null,
            gasUsed: receipt?.gasUsed ?? null,
            feePaid: receipt ? receipt.gasUsed * receipt.effectiveGasPrice : null,
            failureReason: state.failureReason,
            stuckSince: state.stuck ? (t.stuckSince ?? at) : null,
            at,
          })
          const meta = { txHash: t.txHash, confirmations: state.confirmations }
          if (state.status === 'CONFIRMED') {
            summary.confirmed++
            await record(null, null, 'TX_CONFIRMED', t, {
              ...meta,
              blockNumber: receipt?.blockNumber.toString(),
              feePaid: receipt ? (receipt.gasUsed * receipt.effectiveGasPrice).toString() : null,
            })
            await deps
              .afterConfirmed?.({ addressId: t.addressId, networkId: t.networkId })
              .catch((err: unknown) =>
                deps.logger.error({ err, transactionId: t.id }, 'AFTER_CONFIRMED_FAILED'),
              )
          } else if (state.status === 'FAILED') {
            summary.failed++
            await record(null, null, 'TX_FAILED', t, { ...meta, reason: state.failureReason })
          } else if (newlyStuck) {
            summary.stuck++
            await record(null, null, 'TX_STUCK', t, meta)
            deps.logger.warn({ transactionId: t.id, txHash: t.txHash }, 'TX_STUCK')
          }
        } catch (err) {
          summary.errors++
          deps.logger.warn(
            { transactionId: t.id, code: err instanceof AppError ? err.code : 'UNKNOWN' },
            'TX_CHECK_FAILED',
          )
        }
      }
      return summary
    },

    /** Live re-check of a stored transaction. */
    invalidReason: async (id: string) => invalidReason(await getOrThrow(id)),
  }
}

export type TransactionService = ReturnType<typeof createTransactionService>
