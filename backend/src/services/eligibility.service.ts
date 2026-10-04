import { AppError, type Logger } from '@da/shared'
import type { ChainClientFactory } from '../chains/clients'
import type { FeeData } from '../chains/types'
import {
  estimateFee,
  evaluateAddress,
  NATIVE_TRANSFER_GAS,
  type AddressGates,
  type AssetInput,
} from '../domain/eligibility'
import { fromBaseUnit } from '../domain/money'
import type { AuditLogRepository } from '../repositories/audit-log.repository'
import type {
  EligibilityCandidate,
  EligibilityRepository,
} from '../repositories/eligibility.repository'
import type { NetworkRepository } from '../repositories/network.repository'
import type { PriceRepository } from '../repositories/price.repository'
import type { SignerClient } from '../signer/client'
import type { AuthContext, RequestMeta } from './auth.service'

export interface EligibilitySummary {
  networkId: string
  evaluated: number
  ready: number
  notEligible: number
  notEconomic: number
  /** Why fees could not be estimated (every held asset is then FEE_UNAVAILABLE). */
  feeError: string | null
  computedAt: string
}

/**
 * Runs the eligibility rules (domain/eligibility.ts) over a network's addresses and stores the
 * result (Phase 8b, ADR-021). Reads only: balances from the last scan, fresh fee data from RPC,
 * the vault key list from the signer. It never creates, signs or sends a transaction.
 */
export function createEligibilityService(deps: {
  eligibility: EligibilityRepository
  networks: NetworkRepository
  prices: PriceRepository
  signer: SignerClient
  clientsFor: ChainClientFactory
  audit: AuditLogRepository
  logger: Logger
  fiatCurrency: string
  minNetValue: string
  feeMarginPercent: number
  balanceMaxAgeMs: number
  now: () => Date
}) {
  const { eligibility, logger, now } = deps

  function authorizationGate(c: EligibilityCandidate, at: Date): AddressGates['authorization'] {
    if (c.verifiedAuthorizations.length === 0) return 'MISSING'
    const valid = c.verifiedAuthorizations.some((a) => a.expiresAt === null || a.expiresAt > at)
    return valid ? 'VERIFIED' : 'EXPIRED'
  }

  async function vaultKeys(): Promise<Set<string> | null> {
    try {
      return new Set((await deps.signer.listKeys()).map((k) => k.address.toLowerCase()))
    } catch (err) {
      logger.warn(
        { code: err instanceof AppError ? err.code : 'UNKNOWN' },
        'ELIGIBILITY_SIGNER_UNAVAILABLE',
      )
      return null
    }
  }

  return {
    async evaluateNetwork(
      networkId: string,
      context: { actor: AuthContext; meta: RequestMeta } | null = null,
    ): Promise<EligibilitySummary> {
      const network = await deps.networks.findById(networkId)
      if (!network) throw new AppError('NOT_FOUND', 'Network not found', { resourceId: networkId })
      const at = now()
      const candidates = await eligibility.candidates(network.id)
      const destination = await eligibility.approvedDestination(network.id)
      const keys = candidates.length ? await vaultKeys() : null

      const prices = new Map<string, string | null>()
      for (const asset of network.assets) {
        const snapshot = await deps.prices.latestSnapshot(asset.id, deps.fiatCurrency)
        prices.set(asset.id, snapshot ? snapshot.price.toFixed() : null)
      }
      const native = network.assets.find((a) => a.isNative) ?? null

      // Fee data is read once per run, right now (docs/02 §2.6: never reuse an old estimate).
      let fees: FeeData | null = null
      let feeError: string | null = null
      let reader: ReturnType<ChainClientFactory>['reader'] | null = null
      const needsFees = candidates.length > 0 && destination !== null
      if (needsFees) {
        try {
          reader = deps.clientsFor(network).reader
          fees = await reader.getFeeData()
        } catch (err) {
          feeError = err instanceof AppError ? err.code : 'FEE_ESTIMATION_FAILED'
          logger.warn({ networkId, code: feeError }, 'ELIGIBILITY_FEES_UNAVAILABLE')
        }
      }

      const counts = { ready: 0, notEligible: 0, notEconomic: 0 }
      for (const candidate of candidates) {
        const gates: AddressGates = {
          authorization: authorizationGate(candidate, at),
          approvedDestination: destination !== null,
          keyInVault: keys === null ? null : keys.has(candidate.address.toLowerCase()),
          balanceFresh:
            candidate.lastScannedAt !== null &&
            at.getTime() - candidate.lastScannedAt.getTime() <= deps.balanceMaxAgeMs,
        }
        const gatesPass =
          gates.authorization === 'VERIFIED' &&
          gates.approvedDestination &&
          gates.keyInVault === true &&
          gates.balanceFresh

        const balances = [...candidate.balances]
        if (native && !balances.some((b) => b.assetId === native.id)) {
          balances.push({
            assetId: native.id,
            isNative: true,
            contractAddress: null,
            decimals: native.decimals,
            quantity: 0n,
          })
        }

        const assets: AssetInput[] = []
        for (const b of balances) {
          let fee: bigint | null = null
          if (fees && gatesPass && b.quantity > 0n) {
            if (b.isNative) {
              fee = estimateFee(NATIVE_TRANSFER_GAS, fees, deps.feeMarginPercent)
            } else if (reader && destination && b.contractAddress) {
              try {
                const gas = await reader.estimateTokenTransferGas({
                  from: candidate.address,
                  token: b.contractAddress,
                  to: destination.address,
                  amount: b.quantity,
                })
                fee = estimateFee(gas, fees, deps.feeMarginPercent)
              } catch (err) {
                logger.warn(
                  { addressId: candidate.id, code: err instanceof AppError ? err.code : 'UNKNOWN' },
                  'ELIGIBILITY_TOKEN_GAS_FAILED',
                )
              }
            }
          }
          assets.push({
            assetId: b.assetId,
            isNative: b.isNative,
            decimals: b.decimals,
            quantity: b.quantity,
            price: prices.get(b.assetId) ?? null,
            fee,
          })
        }

        const result = evaluateAddress({ gates, assets, minNetValue: deps.minNetValue })
        await eligibility.save(candidate.id, result, network.isTestnet, at)
        if (result.status === 'READY') counts.ready++
        else if (result.status === 'NOT_ECONOMIC') counts.notEconomic++
        else counts.notEligible++
      }

      const summary: EligibilitySummary = {
        networkId: network.id,
        evaluated: candidates.length,
        ...counts,
        feeError,
        computedAt: at.toISOString(),
      }
      await deps.audit.create({
        action: 'ELIGIBILITY_EVALUATED',
        result: 'SUCCESS',
        userId: context?.actor.user.id ?? null,
        resourceType: 'network',
        resourceId: network.id,
        ipAddress: context?.meta.ip ?? null,
        userAgent: context?.meta.userAgent ?? null,
        requestId: context?.meta.requestId ?? null,
        metadata: {
          network: network.name,
          trigger: context ? 'MANUAL' : 'AFTER_SCAN',
          minNetValue: deps.minNetValue,
          feeMarginPercent: deps.feeMarginPercent,
          ...summary,
        },
      })
      logger.info({ ...summary }, 'ELIGIBILITY_EVALUATED')
      return summary
    },

    async forAddress(addressId: string) {
      return (await eligibility.forAddress(addressId)).map((r) => ({
        assetId: r.assetId,
        symbol: r.symbol,
        isNative: r.isNative,
        status: r.status,
        reason: r.reason,
        quantity: r.quantity.toString(),
        formatted: fromBaseUnit(r.quantity, r.decimals),
        feeEstimate: r.feeEstimate?.toString() ?? null,
        valueFiat: r.valueFiat,
        feeFiat: r.feeFiat,
        netFiat: r.netFiat,
        fiatCurrency: deps.fiatCurrency,
        simulated: r.simulated,
        computedAt: r.computedAt.toISOString(),
      }))
    },

    config: () => ({
      minNetValue: deps.minNetValue,
      feeMarginPercent: deps.feeMarginPercent,
      balanceMaxAgeHours: Math.round(deps.balanceMaxAgeMs / 3_600_000),
      fiatCurrency: deps.fiatCurrency,
    }),
  }
}

export type EligibilityService = ReturnType<typeof createEligibilityService>
