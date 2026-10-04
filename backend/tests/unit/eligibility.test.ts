import { describe, expect, it } from 'vitest'
import {
  estimateFee,
  evaluateAddress,
  maxFeePerGas,
  NATIVE_TRANSFER_GAS,
  type AddressGates,
  type AssetInput,
} from '../../src/domain/eligibility'

const GWEI = 1_000_000_000n
const ETH = 10n ** 18n
const FEES = { baseFeePerGas: 10n * GWEI, maxPriorityFeePerGas: 1n * GWEI }
/** 21 000 gas × 21 gwei × 1.2 = 0.0005292 ETH ($1.0584 at $2000). */
const NATIVE_FEE = estimateFee(NATIVE_TRANSFER_GAS, FEES, 20)
/** 50 000 gas × 21 gwei × 1.2 = 0.00126 ETH ($2.52). */
const TOKEN_FEE = estimateFee(50_000n, FEES, 20)

const OK: AddressGates = {
  authorization: 'VERIFIED',
  approvedDestination: true,
  keyInVault: true,
  balanceFresh: true,
}

const eth = (quantity: bigint, overrides: Partial<AssetInput> = {}): AssetInput => ({
  assetId: 'eth',
  isNative: true,
  decimals: 18,
  quantity,
  price: '2000',
  fee: NATIVE_FEE,
  ...overrides,
})
const usdc = (whole: bigint, overrides: Partial<AssetInput> = {}): AssetInput => ({
  assetId: 'usdc',
  isNative: false,
  decimals: 6,
  quantity: whole * 1_000_000n,
  price: '1',
  fee: TOKEN_FEE,
  ...overrides,
})

const run = (assets: AssetInput[], gates: Partial<AddressGates> = {}) =>
  evaluateAddress({ gates: { ...OK, ...gates }, assets, minNetValue: '10' })
const byId = (result: ReturnType<typeof run>, id: string) =>
  result.assets.find((a) => a.assetId === id)!

describe('fee estimation (EIP-1559)', () => {
  it('caps at 2 × baseFee + tip and adds the margin, rounding up', () => {
    expect(maxFeePerGas(FEES)).toBe(21n * GWEI)
    expect(estimateFee(21_000n, FEES, 0)).toBe(441_000n * GWEI)
    expect(NATIVE_FEE).toBe(529_200n * GWEI)
    // 1 wei × 133% = 1.33 → 2 (never underestimate)
    expect(estimateFee(1n, { baseFeePerGas: 0n, maxPriorityFeePerGas: 1n }, 33)).toBe(2n)
  })

  it('rejects a negative or fractional margin', () => {
    expect(() => estimateFee(1n, FEES, -1)).toThrow()
    expect(() => estimateFee(1n, FEES, 1.5)).toThrow()
  })
})

describe('address-level rules', () => {
  it('a stale balance overrides everything', () => {
    const r = run([eth(ETH)], { balanceFresh: false, authorization: 'MISSING' })
    expect(r).toMatchObject({ status: 'NOT_ELIGIBLE', reasons: ['STALE_BALANCE'] })
    expect(byId(r, 'eth')).toMatchObject({ status: 'NOT_ELIGIBLE', reason: 'STALE_BALANCE' })
  })

  it('nothing held → NO_BALANCE (before asking for authorization)', () => {
    const r = run([eth(0n), usdc(0n)], { authorization: 'MISSING' })
    expect(r).toEqual({ status: 'NOT_ELIGIBLE', reasons: ['NO_BALANCE'], assets: [] })
  })

  it.each([
    [{ authorization: 'MISSING' }, 'AUTH_NOT_VERIFIED'],
    [{ authorization: 'EXPIRED' }, 'AUTH_EXPIRED'],
    [{ approvedDestination: false }, 'NO_APPROVED_DESTINATION'],
    [{ keyInVault: null }, 'SIGNER_UNAVAILABLE'],
    [{ keyInVault: false }, 'NO_KEY_IN_VAULT'],
  ] as const)('gate %j → %s for every held asset', (gates, reason) => {
    const r = run([eth(ETH), usdc(500n), usdc(0n, { assetId: 'empty' })], gates)
    expect(r).toMatchObject({ status: 'NOT_ELIGIBLE', reasons: [reason] })
    expect(r.assets.map((a) => [a.assetId, a.status, a.reason])).toEqual([
      ['eth', 'NOT_ELIGIBLE', reason],
      ['usdc', 'NOT_ELIGIBLE', reason],
    ])
  })

  it('checks the gates in order: authorization, destination, key', () => {
    expect(
      run([eth(ETH)], { authorization: 'EXPIRED', approvedDestination: false, keyInVault: false })
        .reasons,
    ).toEqual(['AUTH_EXPIRED'])
    expect(run([eth(ETH)], { approvedDestination: false, keyInVault: false }).reasons).toEqual([
      'NO_APPROVED_DESTINATION',
    ])
  })
})

describe('native asset', () => {
  it('READY when the sweep (balance − fee) is worth more than the minimum', () => {
    const r = run([eth(ETH / 10n)]) // 0.1 ETH = $200
    expect(r).toMatchObject({ status: 'READY', reasons: [] })
    expect(byId(r, 'eth')).toMatchObject({
      status: 'READY',
      reason: null,
      valueFiat: '200.00000000',
      feeFiat: '1.05840000',
      netFiat: '198.94160000',
    })
  })

  it('NOT_ECONOMIC at or below the minimum (boundary included)', () => {
    const exactlyTen = NATIVE_FEE + 5n * 10n ** 15n // fee + 0.005 ETH = fee + $10
    expect(byId(run([eth(exactlyTen)]), 'eth')).toMatchObject({
      status: 'NOT_ECONOMIC',
      reason: 'BELOW_MINIMUM',
      netFiat: '10.00000000',
    })
    // $0.002 above: READY (one wei would round away at 8 fiat decimals)
    expect(byId(run([eth(exactlyTen + 10n ** 12n)]), 'eth').status).toBe('READY')
  })

  it('NOT_ECONOMIC when the fee eats the whole balance', () => {
    const r = run([eth(NATIVE_FEE)])
    expect(r).toMatchObject({ status: 'NOT_ECONOMIC', reasons: ['FEE_EXCEEDS_BALANCE'] })
    expect(byId(r, 'eth').netFiat).toBe('0.00000000')
  })

  it.each([
    ['NO_PRICE', { price: null }],
    ['FEE_UNAVAILABLE', { fee: null }],
  ] as const)('%s without a price or fee estimate', (reason, overrides) => {
    expect(byId(run([eth(ETH, overrides)]), 'eth')).toMatchObject({
      status: 'NOT_ELIGIBLE',
      reason,
    })
  })
})

describe('tokens', () => {
  it('READY when worth it and the address holds enough native coin for gas', () => {
    const r = run([eth(TOKEN_FEE), usdc(500n)])
    expect(byId(r, 'usdc')).toMatchObject({
      status: 'READY',
      valueFiat: '500.00000000',
      feeFiat: '2.52000000',
      netFiat: '497.48000000',
    })
    expect(r.status).toBe('READY')
  })

  it('NEEDS_GAS_FUNDING when worth it but there is no native coin for gas (docs/02 §2.6)', () => {
    const r = run([eth(0n), usdc(500n)])
    expect(r).toMatchObject({ status: 'NOT_ELIGIBLE', reasons: ['NEEDS_GAS_FUNDING'] })
    expect(byId(r, 'usdc')).toMatchObject({ status: 'NOT_ELIGIBLE', reason: 'NEEDS_GAS_FUNDING' })
  })

  it('a token below the minimum is NOT_ECONOMIC, not a gas-funding case', () => {
    expect(byId(run([eth(0n), usdc(5n)]), 'usdc')).toMatchObject({
      status: 'NOT_ECONOMIC',
      reason: 'BELOW_MINIMUM',
    })
  })

  it.each([
    ['token without a price', [eth(ETH), usdc(500n, { price: null })], 'NO_PRICE'],
    [
      'native without a price (gas cannot be valued)',
      [eth(ETH, { price: null }), usdc(500n)],
      'NO_PRICE',
    ],
    ['no gas estimate', [eth(ETH), usdc(500n, { fee: null })], 'FEE_UNAVAILABLE'],
  ] as const)('%s → %s', (_label, assets, reason) => {
    expect(byId(run([...assets]), 'usdc')).toMatchObject({ status: 'NOT_ELIGIBLE', reason })
  })

  it('reserves token gas from the native balance before valuing the native sweep', () => {
    const native = 6n * 10n ** 15n // 0.006 ETH: alone it nets ≈ $10.94 → READY
    expect(byId(run([eth(native)]), 'eth').status).toBe('READY')
    const r = run([eth(native), usdc(500n)])
    expect(byId(r, 'usdc').status).toBe('READY')
    // 0.006 − 0.00126 (token gas) − 0.0005292 (own fee) = 0.0042108 ETH = $8.4216
    expect(byId(r, 'eth')).toMatchObject({ status: 'NOT_ECONOMIC', netFiat: '8.42160000' })
  })

  it('two tokens compete for limited gas: the second one needs funding', () => {
    const r = run([eth(TOKEN_FEE), usdc(500n), usdc(800n, { assetId: 'dai' })])
    expect(byId(r, 'usdc').status).toBe('READY')
    expect(byId(r, 'dai')).toMatchObject({ status: 'NOT_ELIGIBLE', reason: 'NEEDS_GAS_FUNDING' })
  })
})

describe('address status', () => {
  it('one READY asset makes the address READY', () => {
    const r = run([eth(ETH / 10n), usdc(500n, { fee: null })])
    expect(r).toMatchObject({ status: 'READY', reasons: [] })
  })

  it('otherwise the best status wins and every reason is listed, most relevant first', () => {
    const r = run([eth(NATIVE_FEE), usdc(500n)]) // native: fee eats it; token: no gas left
    expect(r.status).toBe('NOT_ECONOMIC')
    expect(r.reasons).toEqual(['FEE_EXCEEDS_BALANCE', 'NEEDS_GAS_FUNDING'])
  })
})
