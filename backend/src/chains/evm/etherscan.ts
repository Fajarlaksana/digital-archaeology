import { AppError } from '@da/shared'
import type { Throttle } from '../../lib/throttle'
import type { ActivityProvider, ActivitySummary } from '../types'

/** Etherscan API v2 (one endpoint for all supported EVM chains, selected by `chainid`). */
export const ETHERSCAN_V2_URL = 'https://api.etherscan.io/v2/api'

const PAGE_SIZE = 1000
/** Etherscan caps page × offset at 10,000 results per query. */
const MAX_PAGES = 10
const MAX_ATTEMPTS = 4
const REQUEST_TIMEOUT_MS = 15_000

type Action = 'txlist' | 'txlistinternal' | 'tokentx'

interface ExplorerTx {
  hash: string
  from: string
  to: string
  timeStamp: string
}

export interface EtherscanOptions {
  apiKey: string
  chainId: number
  throttle: Throttle
  baseUrl?: string
  fetch?: typeof fetch
  sleep?: (ms: number) => Promise<void>
}

export function createEtherscanProvider(options: EtherscanOptions): ActivityProvider {
  const doFetch = options.fetch ?? fetch
  const sleep = options.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)))
  const baseUrl = options.baseUrl ?? ETHERSCAN_V2_URL

  async function request(action: Action, address: string, page: number): Promise<ExplorerTx[]> {
    const url = new URL(baseUrl)
    url.search = new URLSearchParams({
      chainid: String(options.chainId),
      module: 'account',
      action,
      address,
      startblock: '0',
      endblock: '999999999',
      page: String(page),
      offset: String(PAGE_SIZE),
      sort: 'asc',
      apikey: options.apiKey,
    }).toString()

    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
      const backoff = () => sleep(500 * 2 ** (attempt - 1))
      let res: Response
      try {
        res = await options.throttle(() =>
          doFetch(url, { signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) }),
        )
      } catch {
        // Network error / timeout. Never include the URL: it carries the API key.
        if (attempt < MAX_ATTEMPTS) {
          await backoff()
          continue
        }
        throw new AppError('ACTIVITY_READ_FAILED', 'Block explorer is unreachable')
      }

      if (res.status === 429 || res.status >= 500) {
        if (attempt < MAX_ATTEMPTS) {
          await backoff()
          continue
        }
        throw new AppError(
          res.status === 429 ? 'RPC_RATE_LIMIT' : 'ACTIVITY_READ_FAILED',
          `Block explorer answered HTTP ${res.status}`,
        )
      }
      if (!res.ok)
        throw new AppError('ACTIVITY_READ_FAILED', `Block explorer answered HTTP ${res.status}`)

      const body = (await res.json().catch(() => null)) as {
        status?: string
        message?: string
        result?: unknown
      } | null
      if (body?.status === '1' && Array.isArray(body.result)) return body.result as ExplorerTx[]

      const text =
        typeof body?.result === 'string' ? body.result : (body?.message ?? 'unexpected response')
      if (
        /no transactions found/i.test(body?.message ?? '') ||
        (Array.isArray(body?.result) && body.result.length === 0)
      ) {
        return []
      }
      if (/rate limit/i.test(text)) {
        if (attempt < MAX_ATTEMPTS) {
          await backoff()
          continue
        }
        throw new AppError('RPC_RATE_LIMIT', 'Block explorer rate limit reached')
      }
      throw new AppError('ACTIVITY_READ_FAILED', `Block explorer error: ${text.slice(0, 120)}`)
    }
    throw new AppError('ACTIVITY_READ_FAILED', 'Block explorer request failed')
  }

  async function fetchAll(
    action: Action,
    address: string,
  ): Promise<{ txs: ExplorerTx[]; truncated: boolean }> {
    const txs: ExplorerTx[] = []
    for (let page = 1; page <= MAX_PAGES; page++) {
      const batch = await request(action, address, page)
      txs.push(...batch)
      if (batch.length < PAGE_SIZE) return { txs, truncated: false }
    }
    return { txs, truncated: true }
  }

  return {
    async getActivity(address: string): Promise<ActivitySummary> {
      const self = address.toLowerCase()
      const normal = await fetchAll('txlist', address)
      const internal = await fetchAll('txlistinternal', address)
      const tokens = await fetchAll('tokentx', address)

      const time = (tx: ExplorerTx) => Number(tx.timeStamp) * 1000
      const isTo = (tx: ExplorerTx) => tx.to?.toLowerCase() === self
      const isFrom = (tx: ExplorerTx) => tx.from?.toLowerCase() === self

      // Outgoing = transactions the key holder signed. Token transfers *from* the address can be
      // pulled by an approved spender, so only normal transactions count (comparable to the nonce).
      const outgoing = normal.txs.filter(isFrom)
      const incoming = [...normal.txs, ...internal.txs, ...tokens.txs].filter(isTo)
      const involved = [...normal.txs, ...internal.txs, ...tokens.txs].filter(
        (tx) => isTo(tx) || isFrom(tx),
      )

      // Loops instead of Math.max(...spread): histories can hold tens of thousands of entries.
      const pick = (txs: ExplorerTx[], better: (a: number, b: number) => boolean) => {
        let best: number | null = null
        for (const tx of txs) {
          const t = time(tx)
          if (best === null || better(t, best)) best = t
        }
        return best === null ? null : new Date(best)
      }
      const latest = (txs: ExplorerTx[]) => pick(txs, (a, b) => a > b)
      const earliest = (txs: ExplorerTx[]) => pick(txs, (a, b) => a < b)

      return {
        firstActivityAt: earliest(involved),
        lastIncomingAt: latest(incoming),
        lastOutgoingAt: latest(outgoing),
        incomingTxCount: new Set(incoming.map((tx) => tx.hash)).size,
        outgoingTxCount: new Set(outgoing.map((tx) => tx.hash)).size,
        truncated: normal.truncated || internal.truncated || tokens.truncated,
      }
    },
  }
}
