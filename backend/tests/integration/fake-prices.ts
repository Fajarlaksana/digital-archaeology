import { AppError } from '@da/shared'
import type { PriceProvider, PriceQuote } from '../../src/pricing/coingecko'

/** In-memory price provider: tests set prices per CoinGecko id. */
export function createFakePrices() {
  const prices = new Map<string, string>()
  let failing = false
  const requested: string[][] = []

  const provider: PriceProvider = {
    source: 'fake-prices',
    async getPrices(ids) {
      requested.push([...ids])
      if (failing) throw new AppError('PRICE_UNAVAILABLE', 'simulated outage')
      const quotes: PriceQuote[] = []
      for (const id of new Set(ids)) {
        const price = prices.get(id)
        if (price !== undefined)
          quotes.push({ priceId: id, price, pricedAt: new Date('2026-10-03T00:00:00Z') })
      }
      return quotes
    },
  }

  return {
    provider,
    requested,
    set(priceId: string, price: string) {
      prices.set(priceId, price)
    },
    fail(value: boolean) {
      failing = value
    },
  }
}

export type FakePrices = ReturnType<typeof createFakePrices>
