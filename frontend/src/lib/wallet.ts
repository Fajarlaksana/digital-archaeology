/**
 * Browser-side helpers for ownership verification (Phase 7c, ADR-018).
 * Nothing here touches private keys: the document is only hashed locally and signing
 * happens inside the user's own wallet extension.
 */

interface Eip1193Provider {
  request(args: { method: string; params?: unknown[] }): Promise<unknown>
}

function provider(): Eip1193Provider | null {
  const candidate = (globalThis as { ethereum?: Eip1193Provider }).ethereum
  return candidate && typeof candidate.request === 'function' ? candidate : null
}

export function hasBrowserWallet(): boolean {
  return provider() !== null
}

/** SHA-256 of a file, computed in the browser; the file itself is never uploaded. */
export async function sha256File(file: Blob): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', await file.arrayBuffer())
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('')
}

function utf8Hex(text: string): string {
  return `0x${[...new TextEncoder().encode(text)].map((b) => b.toString(16).padStart(2, '0')).join('')}`
}

/**
 * Asks the injected wallet (EIP-1193, e.g. MetaMask) to sign the challenge with
 * `personal_sign` (EIP-191). The wallet's active account must be the address being verified.
 */
export async function signWithBrowserWallet(address: string, message: string): Promise<string> {
  const wallet = provider()
  if (!wallet) throw new Error('Tidak ada wallet browser (mis. MetaMask) yang terdeteksi.')
  const accounts = (await wallet.request({ method: 'eth_requestAccounts' })) as string[]
  const account = accounts.find((a) => a.toLowerCase() === address.toLowerCase())
  if (!account) {
    throw new Error(
      `Akun aktif di wallet bukan ${address}. Pilih akun tersebut di wallet lalu coba lagi.`,
    )
  }
  const signature = await wallet.request({
    method: 'personal_sign',
    params: [utf8Hex(message), account],
  })
  if (typeof signature !== 'string') throw new Error('Wallet tidak mengembalikan signature.')
  return signature
}
