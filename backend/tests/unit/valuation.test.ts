import { describe, expect, it, vi } from 'vitest'
import { displayFiat, fiatValue, normalizePrice, sumFiat } from '../../src/domain/valuation'
import { createCoinGeckoProvider } from '../../src/pricing/coingecko'

const UINT256_MAX = 2n ** 256n - 1n

describe('fiatValue', () => {
  it.each([
    [10n ** 18n, 18, '2500', '2500.00000000'], // 1 ETH
    [5n * 10n ** 17n, 18, '2500.5', '1250.25000000'], // 0.5 ETH
    [1_500_000n, 6, '1.0001', '1.50015000'], // 1.5 USDC
    [1n, 18, '2500', '0.00000000'], // 1 wei rounds to zero at 8 dp
    [0n, 18, '2500', '0.00000000'],
    [1n, 8, '65000', '0.00065000'], // 1 satoshi
  ])('%s units (%i dp) × %s = %s', (quantity, decimals, price, expected) => {
    expect(fiatValue(quantity, decimals, price)).toBe(expected)
  })

  it('handles uint256 max without overflow or precision loss', () => {
    expect(fiatValue(UINT256_MAX, 18, '1')).toBe(
      '115792089237316195423570985008687907853269984665640564039457.58400791',
    )
  })

  it('is exact where floats are not', () => {
    // 0.1 + 0.2 style trap: 3 × 0.1 ETH at price 1 is exactly 0.3.
    expect(
      sumFiat([
        fiatValue(10n ** 17n, 18, '1'),
        fiatValue(10n ** 17n, 18, '1'),
        fiatValue(10n ** 17n, 18, '1'),
      ]),
    ).toBe('0.30000000')
  })
})

describe('normalizePrice', () => {
  it.each([
    [2500.12, '2500.12'],
    [0.000123, '0.000123'],
    [3.0123456789e-7, '0.00000030123456789'],
    ['1.5', '1.5'],
    [0, '0'],
  ])('%s → %s', (raw, expected) => {
    expect(normalizePrice(raw)).toBe(expected)
  })

  it.each([-1, Number.NaN, Number.POSITIVE_INFINITY, 'abc', '1,5'])('rejects %s', (raw) => {
    expect(() => normalizePrice(raw)).toThrow()
  })
})

describe('displayFiat', () => {
  it.each([
    ['1250.25000000', '1250.25'],
    ['0.00000000', '0.00'],
    ['0.00065000', '0.00065'],
    ['0.00000001', '0.00000001'],
  ])('%s → %s', (value, expected) => {
    expect(displayFiat(value)).toBe(expected)
  })
})

describe('CoinGecko provider', () => {
  const ok = (body: unknown) => new Response(JSON.stringify(body), { status: 200 })

  it('returns quotes for known ids, skips unknown ones, sends the key in a header', async () => {
    const fetch = vi.fn(async (_url: string | URL | Request, _init?: RequestInit) =>
      ok({ ethereum: { usd: 2500.5, last_updated_at: 1_790_000_000 }, 'usd-coin': { usd: 1 } }),
    )
    const provider = createCoinGeckoProvider({
      apiKey: 'CG-SECRET',
      fetch: fetch as unknown as typeof globalThis.fetch,
      now: () => new Date('2026-10-03T00:00:00Z'),
    })
    const quotes = await provider.getPrices(
      ['ethereum', 'usd-coin', 'no-such-coin', 'ethereum'],
      'USD',
    )

    expect(quotes).toEqual([
      { priceId: 'ethereum', price: '2500.5', pricedAt: new Date(1_790_000_000_000) },
      { priceId: 'usd-coin', price: '1', pricedAt: new Date('2026-10-03T00:00:00Z') },
    ])
    const [url, init] = fetch.mock.calls[0]!
    expect(String(url)).toContain('vs_currencies=usd')
    expect(String(url)).toContain('ids=ethereum%2Cusd-coin%2Cno-such-coin')
    expect(String(url)).not.toContain('CG-SECRET')
    expect((init?.headers as Record<string, string>)['x-cg-demo-api-key']).toBe('CG-SECRET')
  })

  it('retries on 429 and reports PRICE_UNAVAILABLE without leaking the key', async () => {
    const fetch = vi.fn(async () => new Response('slow', { status: 429 }))
    const provider = createCoinGeckoProvider({
      apiKey: 'CG-SECRET',
      fetch: fetch as unknown as typeof globalThis.fetch,
      sleep: async () => {},
    })
    const error = (await provider
      .getPrices(['ethereum'], 'usd')
      .catch((e: unknown) => e)) as Error & {
      code: string
    }
    expect(error.code).toBe('PRICE_UNAVAILABLE')
    expect(error.message).not.toContain('CG-SECRET')
    expect(fetch).toHaveBeenCalledTimes(3)
  })

  it('ignores a malformed price for one coin', async () => {
    const fetch = vi.fn(async () => ok({ ethereum: { usd: -5 }, bitcoin: { usd: 65000 } }))
    const provider = createCoinGeckoProvider({ fetch: fetch as unknown as typeof globalThis.fetch })
    expect(
      (await provider.getPrices(['ethereum', 'bitcoin'], 'usd')).map((q) => q.priceId),
    ).toEqual(['bitcoin'])
  })

  it('makes no request when there is nothing to price', async () => {
    const fetch = vi.fn()
    const provider = createCoinGeckoProvider({ fetch: fetch as unknown as typeof globalThis.fetch })
    expect(await provider.getPrices([], 'usd')).toEqual([])
    expect(fetch).not.toHaveBeenCalled()
  })
})
