import { AppError } from '@da/shared'
import { normalizePrice } from '../domain/valuation'

export const COINGECKO_PUBLIC_URL = 'https://api.coingecko.com/api/v3'

export interface PriceQuote {
  priceId: string
  /** Decimal string, price of ONE whole unit in the fiat currency. */
  price: string
  pricedAt: Date
}

export interface PriceProvider {
  readonly source: string
  getPrices(priceIds: readonly string[], fiat: string): Promise<PriceQuote[]>
}

const MAX_ATTEMPTS = 3
const BATCH = 100

export interface CoinGeckoOptions {
  baseUrl?: string
  apiKey?: string
  fetch?: typeof fetch
  sleep?: (ms: number) => Promise<void>
  now?: () => Date
}

/**
 * CoinGecko /simple/price. Unknown ids are simply absent from the result (no price → no value).
 * The API key goes in a header, never in the URL, and never into error messages.
 */
export function createCoinGeckoProvider(options: CoinGeckoOptions = {}): PriceProvider {
  const baseUrl = (options.baseUrl ?? COINGECKO_PUBLIC_URL).replace(/\/$/, '')
  const doFetch = options.fetch ?? fetch
  const sleep = options.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)))
  const now = options.now ?? (() => new Date())
  const headers: Record<string, string> = { accept: 'application/json' }
  if (options.apiKey) {
    headers[baseUrl.includes('pro-api') ? 'x-cg-pro-api-key' : 'x-cg-demo-api-key'] = options.apiKey
  }

  async function fetchBatch(ids: readonly string[], fiat: string): Promise<PriceQuote[]> {
    const url = new URL(`${baseUrl}/simple/price`)
    url.search = new URLSearchParams({
      ids: ids.join(','),
      vs_currencies: fiat,
      include_last_updated_at: 'true',
      precision: 'full',
    }).toString()

    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
      let res: Response
      try {
        res = await doFetch(url, { headers, signal: AbortSignal.timeout(15_000) })
      } catch {
        if (attempt < MAX_ATTEMPTS) {
          await sleep(1000 * attempt)
          continue
        }
        throw new AppError('PRICE_UNAVAILABLE', 'Price provider is unreachable')
      }
      if (res.status === 429 || res.status >= 500) {
        if (attempt < MAX_ATTEMPTS) {
          await sleep(2000 * attempt)
          continue
        }
        throw new AppError('PRICE_UNAVAILABLE', `Price provider answered HTTP ${res.status}`)
      }
      if (!res.ok)
        throw new AppError('PRICE_UNAVAILABLE', `Price provider answered HTTP ${res.status}`)

      const body = (await res.json().catch(() => null)) as Record<
        string,
        Record<string, number | undefined> | undefined
      > | null
      if (!body || typeof body !== 'object') {
        throw new AppError('PRICE_UNAVAILABLE', 'Price provider returned an unexpected response')
      }
      const quotes: PriceQuote[] = []
      for (const id of ids) {
        const entry = body[id]
        const raw = entry?.[fiat]
        if (raw === undefined || raw === null) continue
        let price: string
        try {
          price = normalizePrice(raw)
        } catch {
          continue // malformed value for one coin must not discard the others
        }
        const updated = entry?.last_updated_at
        quotes.push({ priceId: id, price, pricedAt: updated ? new Date(updated * 1000) : now() })
      }
      return quotes
    }
    throw new AppError('PRICE_UNAVAILABLE', 'Price provider request failed')
  }

  return {
    source: 'coingecko',
    async getPrices(priceIds, fiat) {
      const ids = [...new Set(priceIds)].filter(Boolean)
      const quotes: PriceQuote[] = []
      for (let i = 0; i < ids.length; i += BATCH) {
        quotes.push(...(await fetchBatch(ids.slice(i, i + BATCH), fiat.toLowerCase())))
      }
      return quotes
    },
  }
}
