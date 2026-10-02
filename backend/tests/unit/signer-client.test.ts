import { describe, expect, it, vi } from 'vitest'
import { HMAC_SIGNATURE_HEADER, HMAC_TIMESTAMP_HEADER, verifyRequest } from '@da/shared'
import { createHttpSignerClient } from '../../src/signer/client'

const SECRET = 's'.repeat(40)
const NOW = 1_790_000_000_000

// No default parameter: a default would silently replace an explicit `undefined`.
function client(response: () => Response | Promise<Response>, secret: string | undefined) {
  const fetch = vi.fn(async (_url: string | URL | Request, _init?: RequestInit) => response())
  return {
    fetch,
    signer: createHttpSignerClient({
      baseUrl: 'http://127.0.0.1:4000/',
      secret,
      fetch: fetch as unknown as typeof globalThis.fetch,
      now: () => NOW,
    }),
  }
}

const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status })

describe('HTTP signer client', () => {
  it('signs every request so the signer can verify it (method, path, exact body)', async () => {
    const { fetch, signer } = client(() => json(200, { initialized: true, unlocked: true }), SECRET)
    await signer.unlock({ actor: 'a', passphrase: 'marble orbit cactus lantern' })

    const [url, init] = fetch.mock.calls[0]!
    expect(String(url)).toBe('http://127.0.0.1:4000/vault/unlock')
    const headers = init!.headers as Record<string, string>
    const check = verifyRequest(SECRET, {
      method: 'POST',
      path: '/vault/unlock',
      body: String(init!.body),
      timestamp: headers[HMAC_TIMESTAMP_HEADER],
      signature: headers[HMAC_SIGNATURE_HEADER],
      now: NOW,
    })
    expect(check.ok).toBe(true)
  })

  it('passes signer error codes through', async () => {
    const { signer } = client(
      () => json(401, { error: { code: 'PASSPHRASE_INVALID', message: 'Wrong passphrase' } }),
      SECRET,
    )
    await expect(signer.unlock({ actor: 'a', passphrase: 'x' })).rejects.toMatchObject({
      code: 'PASSPHRASE_INVALID',
      message: 'Wrong passphrase',
    })
  })

  it('treats a rejected signature as a server misconfiguration, not a user error', async () => {
    const { signer } = client(
      () => json(401, { error: { code: 'UNAUTHORIZED', message: 'Request rejected' } }),
      SECRET,
    )
    await expect(signer.status()).rejects.toMatchObject({
      code: 'SIGNER_UNAVAILABLE',
      message: /SIGNER_HMAC_SECRET/,
    })
  })

  it('maps network failures and missing configuration to SIGNER_UNAVAILABLE', async () => {
    const down = client(() => {
      throw new TypeError('fetch failed')
    }, SECRET)
    await expect(down.signer.status()).rejects.toMatchObject({ code: 'SIGNER_UNAVAILABLE' })

    const unconfigured = client(() => json(200, {}), undefined) // explicitly unconfigured
    await expect(unconfigured.signer.status()).rejects.toMatchObject({
      code: 'SIGNER_UNAVAILABLE',
    })
    expect(unconfigured.fetch).not.toHaveBeenCalled()
  })

  it('maps unknown error codes to SIGNER_UNAVAILABLE', async () => {
    const { signer } = client(
      () => json(500, { error: { code: 'SOMETHING_NEW', message: 'x' } }),
      SECRET,
    )
    await expect(signer.status()).rejects.toMatchObject({ code: 'SIGNER_UNAVAILABLE' })
  })
})
