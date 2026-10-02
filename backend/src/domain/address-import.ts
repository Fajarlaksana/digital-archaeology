/**
 * Row-level validation for the address CSV import (Phase 4). Pure: the chain-specific address
 * check is injected, and the DB lookup for already-registered addresses happens in the service.
 */

export const IMPORT_COLUMNS = ['address', 'network', 'label', 'owner_reference'] as const
export const REQUIRED_IMPORT_COLUMNS = ['address', 'network', 'owner_reference'] as const
export const MAX_IMPORT_ROWS = 5000
export const MAX_LABEL_LENGTH = 120
export const MAX_OWNER_REFERENCE_LENGTH = 200

export type ImportRejection =
  | 'INVALID_FORMAT'
  | 'BAD_CHECKSUM'
  | 'ZERO_ADDRESS'
  | 'UNKNOWN_NETWORK'
  | 'NETWORK_DISABLED'
  | 'MISSING_OWNER_REFERENCE'
  | 'FIELD_TOO_LONG'
  | 'DUPLICATE_IN_FILE'
  | 'ALREADY_EXISTS'

export interface ImportInputRow {
  /** 1-based line number in the file (header is line 1). */
  line: number
  address: string
  network: string
  label: string
  ownerReference: string
}

export interface ImportNetwork {
  id: string
  name: string
  active: boolean
  checkAddress(
    input: string,
  ): { ok: true; address: string } | { ok: false; reason: ImportRejection; message: string }
}

export type ImportRowResult =
  | {
      line: number
      input: Omit<ImportInputRow, 'line'>
      status: 'VALID'
      networkId: string
      address: string
      label: string | null
      ownerReference: string
    }
  | {
      line: number
      input: Omit<ImportInputRow, 'line'>
      status: 'REJECTED'
      reason: ImportRejection
      message: string
    }

export interface ImportSummary {
  total: number
  valid: number
  rejected: number
  byReason: Partial<Record<ImportRejection, number>>
}

/** Stable key for "this address on this network". */
export const addressKey = (networkId: string, address: string) => `${networkId}:${address}`

export function validateImportRows(
  rows: readonly ImportInputRow[],
  networksByName: ReadonlyMap<string, ImportNetwork>,
): ImportRowResult[] {
  const seen = new Map<string, number>()

  return rows.map((row): ImportRowResult => {
    const input = {
      address: row.address,
      network: row.network,
      label: row.label,
      ownerReference: row.ownerReference,
    }
    const reject = (reason: ImportRejection, message: string): ImportRowResult => ({
      line: row.line,
      input,
      status: 'REJECTED',
      reason,
      message,
    })

    const network = networksByName.get(row.network.trim().toLowerCase())
    if (!network) return reject('UNKNOWN_NETWORK', `Network "${row.network}" is not registered`)
    if (!network.active) return reject('NETWORK_DISABLED', `Network "${network.name}" is disabled`)

    const ownerReference = row.ownerReference.trim()
    if (!ownerReference) {
      return reject(
        'MISSING_OWNER_REFERENCE',
        'owner_reference is required (who owns this / which mandate)',
      )
    }
    if (ownerReference.length > MAX_OWNER_REFERENCE_LENGTH) {
      return reject(
        'FIELD_TOO_LONG',
        `owner_reference exceeds ${MAX_OWNER_REFERENCE_LENGTH} characters`,
      )
    }
    const label = row.label.trim()
    if (label.length > MAX_LABEL_LENGTH) {
      return reject('FIELD_TOO_LONG', `label exceeds ${MAX_LABEL_LENGTH} characters`)
    }

    const check = network.checkAddress(row.address)
    if (!check.ok) return reject(check.reason, check.message)

    const key = addressKey(network.id, check.address)
    const firstLine = seen.get(key)
    if (firstLine !== undefined) {
      return reject('DUPLICATE_IN_FILE', `Same address as line ${firstLine}`)
    }
    seen.set(key, row.line)

    return {
      line: row.line,
      input,
      status: 'VALID',
      networkId: network.id,
      address: check.address,
      label: label || null,
      ownerReference,
    }
  })
}

/** Second pass, after the service has looked the valid rows up in the database. */
export function markExisting(
  results: readonly ImportRowResult[],
  existingKeys: ReadonlySet<string>,
): ImportRowResult[] {
  return results.map((result) =>
    result.status === 'VALID' && existingKeys.has(addressKey(result.networkId, result.address))
      ? {
          line: result.line,
          input: result.input,
          status: 'REJECTED',
          reason: 'ALREADY_EXISTS',
          message: 'This address is already registered on this network',
        }
      : result,
  )
}

export function summarize(results: readonly ImportRowResult[]): ImportSummary {
  const byReason: Partial<Record<ImportRejection, number>> = {}
  let valid = 0
  for (const result of results) {
    if (result.status === 'VALID') valid += 1
    else byReason[result.reason] = (byReason[result.reason] ?? 0) + 1
  }
  return { total: results.length, valid, rejected: results.length - valid, byReason }
}
