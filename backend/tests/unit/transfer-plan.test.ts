import { parseTransaction, decodeFunctionData, erc20Abi, keccak256 } from 'viem'
import { describe, expect, it } from 'vitest'
import { buildEvmUnsignedTransfer } from '../../src/chains/evm/evm-adapter'
import { checkStillValid, planTransfer } from '../../src/domain/transfer-plan'

const GWEI = 10n ** 9n
const ETH = 10n ** 18n
const FEES = { baseFeePerGas: 10n * GWEI, maxPriorityFeePerGas: 1n * GWEI }
/** (2×10 + 1) gwei × 1.2 = 25.2 gwei */
const CAP = 25_200_000_000n

const native = (overrides = {}) =>
  planTransfer({
    isNative: true,
    assetBalance: ETH,
    nativeBalance: ETH,
    fees: FEES,
    marginPercent: 20,
    tokenGasEstimate: null,
    requestedAmount: null,
    ...overrides,
  })
const token = (overrides = {}) =>
  planTransfer({
    isNative: false,
    assetBalance: 500_000_000n,
    nativeBalance: ETH / 100n,
    fees: FEES,
    marginPercent: 20,
    tokenGasEstimate: 50_000n,
    requestedAmount: null,
    ...overrides,
  })

describe('planTransfer', () => {
  it('native sweep: everything minus the maximum fee', () => {
    const r = native()
    expect(r).toEqual({
      ok: true,
      plan: {
        amount: ETH - 21_000n * CAP,
        sweep: true,
        gasLimit: 21_000n,
        maxFeePerGas: CAP,
        maxPriorityFeePerGas: 1n * GWEI,
        networkFee: 21_000n * CAP,
      },
    })
  })

  it('native test transfer: a smaller amount, not a sweep', () => {
    const r = native({ requestedAmount: ETH / 1000n })
    expect(r).toMatchObject({ ok: true, plan: { amount: ETH / 1000n, sweep: false } })
    // Asking for exactly the sweep amount counts as a sweep.
    expect(native({ requestedAmount: ETH - 21_000n * CAP })).toMatchObject({
      plan: { sweep: true },
    })
  })

  it('token: the whole token balance, gas limit with margin, gas paid from native', () => {
    expect(token()).toMatchObject({
      ok: true,
      plan: { amount: 500_000_000n, gasLimit: 60_000n, networkFee: 60_000n * CAP, sweep: true },
    })
  })

  it.each([
    ['NO_BALANCE', () => native({ assetBalance: 0n })],
    ['FEE_EXCEEDS_BALANCE', () => native({ assetBalance: 21_000n * CAP })],
    ['NEEDS_GAS_FUNDING', () => token({ nativeBalance: 60_000n * CAP - 1n })],
    ['AMOUNT_NOT_POSITIVE', () => native({ requestedAmount: 0n })],
    ['AMOUNT_TOO_LARGE', () => native({ requestedAmount: ETH })],
    ['AMOUNT_TOO_LARGE', () => token({ requestedAmount: 500_000_001n })],
  ])('%s', (error, run) => {
    expect(run()).toEqual({ ok: false, error })
  })
})

describe('checkStillValid (approval tolerance)', () => {
  const tx = {
    isNative: true,
    nonce: 7,
    amount: ETH / 2n,
    networkFee: 21_000n * CAP,
    maxFeePerGas: CAP,
  }
  const current = { nonce: 7, fees: FEES, nativeBalance: ETH, assetBalance: ETH }
  const now = new Date('2026-10-05T10:00:00Z')
  const check = (overrides: Record<string, unknown> = {}, extra: Record<string, unknown> = {}) =>
    checkStillValid({
      tx: { ...tx, ...(extra.tx as object) },
      current: { ...current, ...overrides },
      approvalExpiresAt: (extra.approvalExpiresAt as Date | null) ?? null,
      now,
    })

  it('valid while nonce, fee cap and balance still hold', () => {
    expect(check()).toBeNull()
    // Base fee may rise as long as 2 × base + tip stays within the approved cap (25.2 gwei).
    expect(check({ fees: { baseFeePerGas: 12n * GWEI, maxPriorityFeePerGas: GWEI } })).toBeNull()
  })

  it('expires after the approval window', () => {
    expect(check({}, { approvalExpiresAt: now })).toBe('APPROVAL_TIMEOUT')
    expect(check({}, { approvalExpiresAt: new Date(now.getTime() + 1) })).toBeNull()
  })

  it('expires when the nonce moved, the fee left the cap, or the balance no longer covers it', () => {
    expect(check({ nonce: 8 })).toBe('NONCE_CHANGED')
    expect(check({ fees: { baseFeePerGas: 13n * GWEI, maxPriorityFeePerGas: GWEI } })).toBe(
      'FEE_ABOVE_CAP',
    )
    expect(check({ nativeBalance: ETH / 2n + 21_000n * CAP - 1n })).toBe('BALANCE_INSUFFICIENT')
    const tokenTx = { tx: { isNative: false, amount: 500n } }
    expect(check({ assetBalance: 499n }, tokenTx)).toBe('BALANCE_INSUFFICIENT')
    expect(check({ assetBalance: 500n, nativeBalance: 21_000n * CAP - 1n }, tokenTx)).toBe(
      'BALANCE_INSUFFICIENT',
    )
  })
})

describe('EVM unsigned transfer', () => {
  const base = {
    chainId: 11155111,
    nonce: 4,
    recipient: '0x70997970c51812dc3a010c7d01b50e0d17dc79c8',
    amount: 123n,
    gasLimit: 21_000n,
    maxFeePerGas: CAP,
    maxPriorityFeePerGas: GWEI,
  }

  it('native: serializes exactly the approved parameters; the hash is keccak of it', () => {
    const built = buildEvmUnsignedTransfer({
      ...base,
      asset: { isNative: true, contractAddress: null },
    })
    const parsed = parseTransaction(built.payload.serialized as `0x${string}`)
    expect(parsed).toMatchObject({
      type: 'eip1559',
      chainId: 11155111,
      nonce: 4,
      to: '0x70997970c51812dc3a010c7d01b50e0d17dc79c8',
      value: 123n,
      gas: 21_000n,
      maxFeePerGas: CAP,
      maxPriorityFeePerGas: GWEI,
    })
    expect(built.hash).toBe(keccak256(built.payload.serialized as `0x${string}`))
    expect(built.payload).toMatchObject({ value: '123', gas: '21000', nonce: 4 })
  })

  it('token: value 0 to the contract, transfer(recipient, amount) calldata', () => {
    const contract = '0x1c7d4b196cb0c7b01d743fbc6116a902379c7238'
    const built = buildEvmUnsignedTransfer({
      ...base,
      gasLimit: 60_000n,
      asset: { isNative: false, contractAddress: contract },
    })
    const parsed = parseTransaction(built.payload.serialized as `0x${string}`)
    expect(parsed.to?.toLowerCase()).toBe(contract)
    expect(parsed.value ?? 0n).toBe(0n)
    expect(decodeFunctionData({ abi: erc20Abi, data: parsed.data! })).toEqual({
      functionName: 'transfer',
      args: ['0x70997970C51812dc3A010C7d01b50e0d17dc79C8', 123n],
    })
  })

  it('a different nonce or fee changes the hash', () => {
    const a = buildEvmUnsignedTransfer({
      ...base,
      asset: { isNative: true, contractAddress: null },
    })
    const b = buildEvmUnsignedTransfer({
      ...base,
      nonce: 5,
      asset: { isNative: true, contractAddress: null },
    })
    expect(a.hash).not.toBe(b.hash)
  })
})
