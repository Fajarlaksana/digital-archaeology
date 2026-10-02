import { getAddress } from 'viem'
import type { AddressCheck, ChainAdapter } from '../types'

const HEX_ADDRESS = /^0x[0-9a-fA-F]{40}$/
const ZERO = '0x0000000000000000000000000000000000000000'

/**
 * EIP-55: a mixed-case address carries a checksum. If it does not match, the address was
 * almost certainly mistyped — reject it instead of "fixing" it. All-lower / all-upper hex
 * has no checksum and is accepted, then stored in checksummed form.
 */
export function checkEvmAddress(input: string): AddressCheck {
  const value = input.trim()
  if (!HEX_ADDRESS.test(value)) {
    return {
      ok: false,
      reason: 'INVALID_FORMAT',
      message: 'Must be 0x followed by 40 hexadecimal characters',
    }
  }
  const body = value.slice(2)
  const hasChecksum = body !== body.toLowerCase() && body !== body.toUpperCase()
  const canonical = getAddress(value.toLowerCase())
  if (hasChecksum && canonical !== value) {
    return {
      ok: false,
      reason: 'BAD_CHECKSUM',
      message: 'Checksum (upper/lower case) does not match — the address is probably mistyped',
    }
  }
  if (canonical.toLowerCase() === ZERO) {
    return { ok: false, reason: 'ZERO_ADDRESS', message: 'The zero address cannot be owned' }
  }
  return { ok: true, address: canonical }
}

export const evmAdapter: ChainAdapter = {
  chainType: 'EVM',
  checkAddress: checkEvmAddress,
}
