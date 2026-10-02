import { AppError, type Logger } from '@da/shared'
import { fiatValue } from '../domain/valuation'
import type { PriceProvider } from '../pricing/coingecko'
import type { AuditLogRepository } from '../repositories/audit-log.repository'
import type { PricedAsset, PriceRepository } from '../repositories/price.repository'
import { recordAction } from './audit-trail'
import type { AuthContext, RequestMeta } from './auth.service'

export interface ValuationServiceDeps {
  prices: PriceRepository
  provider: PriceProvider
  audit: AuditLogRepository
  fiatCurrency: string
  logger: Logger
}

export interface PriceUpdateResult {
  priced: number
  missing: string[]
  revaluedBalances: number
}

/**
 * Fetches prices, stores snapshots and recomputes balances.fiat_value (SA 4.4, ADR-016).
 * Values are estimates; testnet assets use their mainnet price and are flagged SIMULATED on read.
 */
export function createValuationService(deps: ValuationServiceDeps) {
  const { prices, provider, fiatCurrency, logger } = deps

  async function revalue(
    asset: PricedAsset,
    snapshot: { id: string; price: { toString(): string } },
  ) {
    const balances = await prices.balancesForAsset(asset.id)
    const price = snapshot.price.toString()
    await prices.setFiatValues(
      balances.map((b) => ({
        id: b.id,
        fiatValue: fiatValue(b.quantity, asset.decimals, price),
        priceSnapshotId: snapshot.id,
      })),
    )
    return balances.length
  }

  const service = {
    fiatCurrency,

    /** Pulls fresh prices for every asset with a price id and revalues all balances. */
    async updatePrices(): Promise<PriceUpdateResult> {
      const assets = await prices.assetsWithPriceId()
      if (assets.length === 0) return { priced: 0, missing: [], revaluedBalances: 0 }

      const quotes = await provider.getPrices(
        assets.map((a) => a.priceId!),
        fiatCurrency,
      )
      const byId = new Map(quotes.map((q) => [q.priceId, q]))
      let priced = 0
      let revaluedBalances = 0
      const missing: string[] = []

      for (const asset of assets) {
        const quote = byId.get(asset.priceId!)
        if (!quote) {
          missing.push(asset.priceId!)
          continue
        }
        const snapshot = await prices.createSnapshot({
          assetId: asset.id,
          fiatCurrency,
          price: quote.price,
          source: provider.source,
          pricedAt: quote.pricedAt,
        })
        revaluedBalances += await revalue(asset, snapshot)
        priced += 1
      }
      logger.info({ priced, missing: missing.length, revaluedBalances }, 'PRICES_UPDATED')
      return { priced, missing: [...new Set(missing)], revaluedBalances }
    },

    /** Re-applies the latest stored prices to one network (after a scan wrote new balances). */
    async revalueNetwork(networkId: string): Promise<number> {
      let count = 0
      for (const asset of await prices.assetsWithPriceId(networkId)) {
        const snapshot = await prices.latestSnapshot(asset.id, fiatCurrency)
        if (snapshot) count += await revalue(asset, snapshot)
      }
      return count
    },

    /** ADMIN sets / clears the CoinGecko id of an asset. */
    async setPriceId(
      actor: AuthContext,
      networkId: string,
      assetId: string,
      priceId: string | null,
      meta: RequestMeta,
    ) {
      const asset = await prices.findAsset(networkId, assetId)
      if (!asset) throw new AppError('NOT_FOUND', 'Asset not found', { resourceId: assetId })
      const updated = await prices.setPriceId(assetId, priceId)
      await recordAction(deps.audit, actor, meta, {
        action: 'ASSET_UPDATED',
        resourceType: 'asset',
        resourceId: assetId,
        metadata: { before: { priceId: asset.priceId }, after: { priceId } },
      })
      return updated
    },
  }
  return service
}

export type ValuationService = ReturnType<typeof createValuationService>
