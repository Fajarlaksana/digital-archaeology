import {
  encodeFunctionData,
  erc20Abi,
  getAddress,
  keccak256,
  serializeTransaction,
  verifyMessage,
} from 'viem'
import type { AddressCheck, ChainAdapter, UnsignedTransfer, UnsignedTransferInput } from '../types'

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

const SIGNATURE = /^0x[0-9a-fA-F]{130}$/

/** EIP-191 signature check by public-key recovery (EOA only; EIP-1271 is not supported). */
export async function verifyEvmMessage(input: {
  address: string
  message: string
  signature: string
}): Promise<boolean> {
  if (!SIGNATURE.test(input.signature) || !HEX_ADDRESS.test(input.address)) return false
  try {
    return await verifyMessage({
      address: input.address as `0x${string}`,
      message: input.message,
      signature: input.signature as `0x${string}`,
    })
  } catch {
    return false
  }
}

/**
 * EIP-1559 transfer. Native: value to the recipient. ERC-20: value 0 to the token contract with
 * `transfer(recipient, amount)` calldata. The hash is keccak256 of the serialized unsigned tx —
 * exactly what an EIP-1559 signature covers.
 */
export function buildEvmUnsignedTransfer(input: UnsignedTransferInput): UnsignedTransfer {
  const recipient = getAddress(input.recipient)
  const native = input.asset.isNative
  if (!native && !input.asset.contractAddress) throw new Error('Token transfer needs a contract')
  const tx = {
    type: 'eip1559' as const,
    chainId: input.chainId,
    nonce: input.nonce,
    to: native ? recipient : getAddress(input.asset.contractAddress!),
    value: native ? input.amount : 0n,
    data: native
      ? ('0x' as const)
      : encodeFunctionData({
          abi: erc20Abi,
          functionName: 'transfer',
          args: [recipient, input.amount],
        }),
    gas: input.gasLimit,
    maxFeePerGas: input.maxFeePerGas,
    maxPriorityFeePerGas: input.maxPriorityFeePerGas,
  }
  const serialized = serializeTransaction(tx)
  return {
    payload: {
      type: tx.type,
      chainId: tx.chainId,
      nonce: tx.nonce,
      to: tx.to,
      value: tx.value.toString(),
      data: tx.data,
      gas: tx.gas.toString(),
      maxFeePerGas: tx.maxFeePerGas.toString(),
      maxPriorityFeePerGas: tx.maxPriorityFeePerGas.toString(),
      serialized,
    },
    hash: keccak256(serialized).toLowerCase(),
  }
}

export const evmAdapter: ChainAdapter = {
  chainType: 'EVM',
  checkAddress: checkEvmAddress,
  verifyMessage: verifyEvmMessage,
  buildUnsignedTransfer: buildEvmUnsignedTransfer,
}
