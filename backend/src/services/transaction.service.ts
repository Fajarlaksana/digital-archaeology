import { AppError, type Logger } from '@da/shared'
import { chainAdapterFor } from '../chains'
import type { ChainClientFactory } from '../chains/clients'
import type { ChainReader } from '../chains/types'
import { fromBaseUnit, toBaseUnit } from '../domain/money'
import { checkStillValid, planTransfer, type PlanError } from '../domain/transfer-plan'
import { fiatValue } from '../domain/valuation'
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

  /** Live re-check of a stored transaction (approval now; signing in Phase 10). */
  async function invalidReason(t: TransactionWithContext): Promise<string | null> {
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
      approvalExpiresAt: t.status === 'APPROVED' ? (approval?.expiresAt ?? null) : null,
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

    /** For Phase 10: the signer path re-checks right before signing. */
    invalidReason: async (id: string) => invalidReason(await getOrThrow(id)),
  }
}

export type TransactionService = ReturnType<typeof createTransactionService>
