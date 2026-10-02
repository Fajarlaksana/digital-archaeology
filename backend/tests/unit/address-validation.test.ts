import { describe, expect, it } from 'vitest'
import { checkEvmAddress } from '../../src/chains/evm/evm-adapter'
import {
  addressKey,
  markExisting,
  summarize,
  validateImportRows,
  type ImportInputRow,
  type ImportNetwork,
} from '../../src/domain/address-import'
import { parseImportCsv } from '../../src/services/address.service'

// Test vectors from the EIP-55 specification.
const CHECKSUMMED = [
  '0x5aAeb6053F3E94C9b9A09f33669435E7Ef1BeAed',
  '0xfB6916095ca1df60bB79Ce92cE3Ea74c37c5d359',
  '0xdbF03B407c01E7cD3CBea99509d93f8DDDC8C6FB',
  '0xD1220A0cf47c7B9Be7A2E6BA89F429762e7b9aDb',
]

describe('EVM address check (EIP-55)', () => {
  it.each(CHECKSUMMED)('accepts the checksummed vector %s unchanged', (address) => {
    expect(checkEvmAddress(address)).toEqual({ ok: true, address })
  })

  it.each(CHECKSUMMED)('accepts all-lowercase %s and stores the checksummed form', (address) => {
    expect(checkEvmAddress(address.toLowerCase())).toEqual({ ok: true, address })
  })

  it('accepts all-uppercase hex (no checksum) and normalises it', () => {
    const address = CHECKSUMMED[0]!
    expect(checkEvmAddress('0x' + address.slice(2).toUpperCase())).toEqual({ ok: true, address })
  })

  it('rejects a mixed-case address with a wrong checksum (likely typo)', () => {
    const typo = '0x5AAeb6053F3E94C9b9A09f33669435E7Ef1BeAed' // one letter case flipped
    expect(checkEvmAddress(typo)).toMatchObject({ ok: false, reason: 'BAD_CHECKSUM' })
  })

  it.each([
    '',
    '5aAeb6053F3E94C9b9A09f33669435E7Ef1BeAed',
    '0x5aAeb6053F3E94C9b9A09f33669435E7Ef1BeAe',
    '0x5aAeb6053F3E94C9b9A09f33669435E7Ef1BeAedd',
    '0xZZAeb6053F3E94C9b9A09f33669435E7Ef1BeAed',
    'vitalik.eth',
  ])('rejects malformed input %j', (input) => {
    expect(checkEvmAddress(input)).toMatchObject({ ok: false, reason: 'INVALID_FORMAT' })
  })

  it('rejects the zero address', () => {
    expect(checkEvmAddress('0x' + '0'.repeat(40))).toMatchObject({
      ok: false,
      reason: 'ZERO_ADDRESS',
    })
  })

  it('trims surrounding whitespace', () => {
    expect(checkEvmAddress(`  ${CHECKSUMMED[1]}  `)).toEqual({ ok: true, address: CHECKSUMMED[1] })
  })
})

const sepolia: ImportNetwork = {
  id: 'net-1',
  name: 'sepolia',
  active: true,
  checkAddress: checkEvmAddress,
}
const disabled: ImportNetwork = {
  id: 'net-2',
  name: 'old',
  active: false,
  checkAddress: checkEvmAddress,
}
const NETWORKS = new Map([
  ['sepolia', sepolia],
  ['old', disabled],
])

function row(line: number, overrides: Partial<ImportInputRow> = {}): ImportInputRow {
  return {
    line,
    address: CHECKSUMMED[0]!,
    network: 'sepolia',
    label: '',
    ownerReference: 'SELF',
    ...overrides,
  }
}

describe('import row validation', () => {
  it('accepts a valid row and normalises network name case', () => {
    const [result] = validateImportRows([row(2, { network: 'Sepolia', label: ' Cold ' })], NETWORKS)
    expect(result).toMatchObject({
      status: 'VALID',
      networkId: 'net-1',
      address: CHECKSUMMED[0],
      label: 'Cold',
      ownerReference: 'SELF',
    })
  })

  it.each([
    [{ network: 'mainnet' }, 'UNKNOWN_NETWORK'],
    [{ network: 'old' }, 'NETWORK_DISABLED'],
    [{ ownerReference: '   ' }, 'MISSING_OWNER_REFERENCE'],
    [{ ownerReference: 'x'.repeat(201) }, 'FIELD_TOO_LONG'],
    [{ label: 'x'.repeat(121) }, 'FIELD_TOO_LONG'],
    [{ address: 'nope' }, 'INVALID_FORMAT'],
    [{ address: '0x5AAeb6053F3E94C9b9A09f33669435E7Ef1BeAed' }, 'BAD_CHECKSUM'],
  ] as const)('rejects %j with %s', (overrides, reason) => {
    const [result] = validateImportRows([row(2, overrides)], NETWORKS)
    expect(result).toMatchObject({ status: 'REJECTED', reason, line: 2 })
  })

  it('rejects later duplicates in the same file, even with different case', () => {
    const results = validateImportRows(
      [
        row(2),
        row(3, { address: CHECKSUMMED[0]!.toLowerCase() }),
        row(4, { address: CHECKSUMMED[1] }),
      ],
      NETWORKS,
    )
    expect(results.map((r) => r.status)).toEqual(['VALID', 'REJECTED', 'VALID'])
    expect(results[1]).toMatchObject({
      reason: 'DUPLICATE_IN_FILE',
      message: 'Same address as line 2',
    })
  })

  it('marks rows already in the database and summarises by reason', () => {
    const first = validateImportRows(
      [row(2), row(3, { address: CHECKSUMMED[1] }), row(4, { network: 'x' })],
      NETWORKS,
    )
    const results = markExisting(first, new Set([addressKey('net-1', CHECKSUMMED[1]!)]))
    expect(results.map((r) => r.status)).toEqual(['VALID', 'REJECTED', 'REJECTED'])
    expect(summarize(results)).toEqual({
      total: 3,
      valid: 1,
      rejected: 2,
      byReason: { ALREADY_EXISTS: 1, UNKNOWN_NETWORK: 1 },
    })
  })
})

describe('CSV parsing', () => {
  it('reads rows with line numbers, quotes, BOM and case-insensitive headers', () => {
    const csv =
      '﻿Address,Network,Label,Owner_Reference\n' +
      `${CHECKSUMMED[0]},sepolia,"Cold, wallet",SELF\n\n` +
      `${CHECKSUMMED[1]},sepolia,,CASE-1\n`
    expect(parseImportCsv(csv)).toEqual([
      {
        line: 2,
        address: CHECKSUMMED[0],
        network: 'sepolia',
        label: 'Cold, wallet',
        ownerReference: 'SELF',
      },
      { line: 4, address: CHECKSUMMED[1], network: 'sepolia', label: '', ownerReference: 'CASE-1' },
    ])
  })

  it('accepts a file without the optional label column', () => {
    expect(
      parseImportCsv(`address,network,owner_reference\n${CHECKSUMMED[0]},sepolia,SELF\n`)[0],
    ).toMatchObject({ label: '', ownerReference: 'SELF' })
  })

  it('rejects a file missing required columns', () => {
    expect(() => parseImportCsv(`address,network\n${CHECKSUMMED[0]},sepolia\n`)).toThrow(
      /Missing column\(s\): owner_reference/,
    )
  })

  it('rejects an empty file and a header-only file', () => {
    expect(() => parseImportCsv('address,network,owner_reference\n')).toThrow(/no data rows/)
  })

  it('rejects broken quoting with a readable error', () => {
    expect(() => parseImportCsv('address,network,owner_reference\n"0xabc,sepolia,SELF\n')).toThrow(
      /CSV could not be read/,
    )
  })

  it('rejects more than 5000 rows', () => {
    const body = Array.from({ length: 5001 }, () => `${CHECKSUMMED[0]},sepolia,SELF`).join('\n')
    expect(() => parseImportCsv(`address,network,owner_reference\n${body}\n`)).toThrow(
      /Too many rows/,
    )
  })
})
