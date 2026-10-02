import { custom, encodeAbiParameters, HttpRequestError } from 'viem'
import { describe, expect, it, vi } from 'vitest'
import { AppError } from '@da/shared'
import { createEtherscanProvider } from '../../src/chains/evm/etherscan'
import { createEvmReader } from '../../src/chains/evm/evm-reader'
import { createThrottle } from '../../src/lib/throttle'

const ME = '0x5aAeb6053F3E94C9b9A09f33669435E7Ef1BeAed'
const OTHER = '0xfB6916095ca1df60bB79Ce92cE3Ea74c37c5d359'
const API_KEY = 'SECRET-API-KEY-123'
const noThrottle = <T>(task: () => Promise<T>) => task()
const noSleep = async () => {}

const tx = (hash: string, from: string, to: string, unixSeconds: number) => ({
  hash,
  from: from.toLowerCase(),
  to: to.toLowerCase(),
  timeStamp: String(unixSeconds),
})

type Page = { status: string; message: string; result: unknown }
const ok = (result: unknown[]): Page => ({ status: '1', message: 'OK', result })
const none: Page = { status: '0', message: 'No transactions found', result: [] }

/** Fake explorer: responses keyed by action, one entry per page (or a function). */
function fakeExplorer(pages: Partial<Record<string, Array<Page | (() => Response)>>>) {
  const calls: URL[] = []
  const fetchMock = vi.fn(async (input: string | URL | Request) => {
    const url = new URL(String(input))
    calls.push(url)
    const action = url.searchParams.get('action')!
    const page = Number(url.searchParams.get('page'))
    const entry = pages[action]?.[page - 1] ?? none
    if (typeof entry === 'function') return entry()
    return new Response(JSON.stringify(entry), { status: 200 })
  })
  return { fetch: fetchMock as unknown as typeof fetch, calls }
}

const provider = (f: typeof fetch) =>
  createEtherscanProvider({
    apiKey: API_KEY,
    chainId: 11155111,
    throttle: noThrottle,
    fetch: f,
    sleep: noSleep,
  })

describe('Etherscan activity provider', () => {
  it('summarises normal, internal and token transfers', async () => {
    const { fetch, calls } = fakeExplorer({
      txlist: [ok([tx('0x1', OTHER, ME, 1_600_000_000), tx('0x2', ME, OTHER, 1_650_000_000)])],
      txlistinternal: [ok([tx('0x3', OTHER, ME, 1_700_000_000)])],
      tokentx: [ok([tx('0x4', OTHER, ME, 1_750_000_000), tx('0x5', ME, OTHER, 1_760_000_000)])],
    })
    const summary = await provider(fetch).getActivity(ME)

    expect(summary).toEqual({
      firstActivityAt: new Date(1_600_000_000_000),
      lastIncomingAt: new Date(1_750_000_000_000),
      lastOutgoingAt: new Date(1_650_000_000_000), // token transfer "from" me is not a signed tx of mine
      incomingTxCount: 3,
      outgoingTxCount: 1,
      truncated: false,
    })
    expect(calls[0]?.searchParams.get('chainid')).toBe('11155111')
    expect(calls.map((u) => u.searchParams.get('action'))).toEqual([
      'txlist',
      'txlistinternal',
      'tokentx',
    ])
  })

  it('returns an empty summary for an address without transactions', async () => {
    const { fetch } = fakeExplorer({})
    expect(await provider(fetch).getActivity(ME)).toEqual({
      firstActivityAt: null,
      lastIncomingAt: null,
      lastOutgoingAt: null,
      incomingTxCount: 0,
      outgoingTxCount: 0,
      truncated: false,
    })
  })

  it('follows pagination and marks truncation at the 10,000 limit', async () => {
    const full = (start: number) =>
      ok(
        Array.from({ length: 1000 }, (_, i) =>
          tx(`0x${start + i}`, ME, OTHER, 1_600_000_000 + start + i),
        ),
      )
    const { fetch, calls } = fakeExplorer({
      txlist: Array.from({ length: 10 }, (_, p) => full(p * 1000)),
    })
    const summary = await provider(fetch).getActivity(ME)
    expect(summary).toMatchObject({ outgoingTxCount: 10_000, truncated: true })
    expect(calls.filter((u) => u.searchParams.get('action') === 'txlist')).toHaveLength(10)
  })

  it('stops paging on a short page', async () => {
    const { fetch, calls } = fakeExplorer({
      txlist: [
        ok(Array.from({ length: 1000 }, (_, i) => tx(`0x${i}`, ME, OTHER, 1_600_000_000 + i))),
        ok([tx('0xz', ME, OTHER, 1)]),
      ],
    })
    expect((await provider(fetch).getActivity(ME)).outgoingTxCount).toBe(1001)
    expect(calls.filter((u) => u.searchParams.get('action') === 'txlist')).toHaveLength(2)
  })

  it('retries when rate-limited, then succeeds', async () => {
    const limited: Page = {
      status: '0',
      message: 'NOTOK',
      result: 'Max calls per sec rate limit reached (5/sec)',
    }
    let n = 0
    const fetch = vi.fn(async (input: string | URL | Request) => {
      const action = new URL(String(input)).searchParams.get('action')
      if (action === 'txlist' && n++ < 2) return new Response(JSON.stringify(limited))
      return new Response(JSON.stringify(none))
    }) as unknown as typeof globalThis.fetch
    await expect(provider(fetch).getActivity(ME)).resolves.toMatchObject({ outgoingTxCount: 0 })
  })

  it('gives up with RPC_RATE_LIMIT after repeated 429s', async () => {
    const fetch = vi.fn(
      async () => new Response('slow down', { status: 429 }),
    ) as unknown as typeof globalThis.fetch
    await expect(provider(fetch).getActivity(ME)).rejects.toMatchObject({ code: 'RPC_RATE_LIMIT' })
  })

  it('reports explorer errors without leaking the API key or URL', async () => {
    const { fetch } = fakeExplorer({
      txlist: [{ status: '0', message: 'NOTOK', result: 'Invalid API Key (#err2)|1' }],
    })
    const error = await provider(fetch)
      .getActivity(ME)
      .catch((e: unknown) => e)
    expect(error).toBeInstanceOf(AppError)
    expect(error).toMatchObject({ code: 'ACTIVITY_READ_FAILED' })
    expect(String((error as Error).message)).toContain('Invalid API Key')
    expect(JSON.stringify(error) + String(error)).not.toContain(API_KEY)
  })

  it('maps network failures to ACTIVITY_READ_FAILED without the URL', async () => {
    const fetch = vi.fn(async () => {
      throw new TypeError(`fetch failed for https://api.etherscan.io/v2/api?apikey=${API_KEY}`)
    }) as unknown as typeof globalThis.fetch
    const error = (await provider(fetch)
      .getActivity(ME)
      .catch((e: unknown) => e)) as Error
    expect(error).toMatchObject({ code: 'ACTIVITY_READ_FAILED' })
    expect(error.message).not.toContain(API_KEY)
  })
})

describe('throttle', () => {
  it('spaces calls to the configured rate', async () => {
    let clock = 0
    const sleeps: number[] = []
    const throttle = createThrottle(4, {
      now: () => clock,
      sleep: async (ms) => {
        sleeps.push(ms)
        clock += ms
      },
    })
    await Promise.all([1, 2, 3].map((n) => throttle(async () => n)))
    expect(sleeps).toEqual([250, 250])
  })
})

describe('EVM RPC reader', () => {
  /** Minimal JSON-RPC node for viem's custom transport. */
  function fakeNode(handlers: Record<string, (params: unknown[]) => unknown>) {
    return createEvmReader({
      transport: custom({
        async request({ method, params }: { method: string; params: unknown[] }) {
          const handler = handlers[method]
          if (!handler) throw new Error(`unexpected ${method}`)
          return handler(params)
        },
      }),
    })
  }

  it('reads native balance, token balance, nonce, chain id and block', async () => {
    const reader = fakeNode({
      eth_getBalance: () => '0xde0b6b3a7640000', // 1 ETH
      eth_getTransactionCount: () => '0x3',
      eth_chainId: () => '0xaa36a7',
      eth_blockNumber: () => '0x10',
      eth_call: () => encodeAbiParameters([{ type: 'uint256' }], [2n ** 256n - 1n]),
    })
    expect(await reader.getNativeBalance(ME)).toBe(10n ** 18n)
    expect(await reader.getOutgoingNonce(ME)).toBe(3)
    expect(await reader.getChainId()).toBe(11155111)
    expect(await reader.getBlockNumber()).toBe(16n)
    expect(await reader.getTokenBalance(ME, OTHER)).toBe(2n ** 256n - 1n)
  })

  it('maps HTTP 429 to RPC_RATE_LIMIT', async () => {
    const reader = fakeNode({
      eth_getBalance: () => {
        throw new HttpRequestError({ url: `https://rpc.example/${API_KEY}`, status: 429 })
      },
    })
    const error = (await reader.getNativeBalance(ME).catch((e: unknown) => e)) as AppError
    expect(error.code).toBe('RPC_RATE_LIMIT')
    expect(error.message).not.toContain(API_KEY)
  })

  it('maps other failures to BALANCE_READ_FAILED with a generic message', async () => {
    const reader = fakeNode({
      eth_call: () => {
        throw new Error(`execution reverted at https://rpc.example/${API_KEY}`)
      },
    })
    const error = (await reader.getTokenBalance(ME, OTHER).catch((e: unknown) => e)) as AppError
    expect(error.code).toBe('BALANCE_READ_FAILED')
    expect(error.message).not.toContain(API_KEY)
  })
})
