import { createHash } from 'node:crypto'
import { parse } from 'csv-parse/sync'
import { AppError } from '@da/shared'
import { chainAdapterFor, isSupportedChain } from '../chains'
import {
  MAX_IMPORT_ROWS,
  REQUIRED_IMPORT_COLUMNS,
  markExisting,
  summarize,
  validateImportRows,
  type ImportInputRow,
  type ImportNetwork,
  type ImportRowResult,
  type ImportSummary,
} from '../domain/address-import'
import { sumFiat } from '../domain/valuation'
import type { ActivityStatus } from '../generated/prisma/client'
import type { AddressRepository, AddressWithNetwork } from '../repositories/address.repository'
import type { AuditLogRepository } from '../repositories/audit-log.repository'
import type { NetworkRepository } from '../repositories/network.repository'
import { recordAction } from './audit-trail'
import type { AuthContext, RequestMeta } from './auth.service'

export const MAX_CSV_CHARS = 2_000_000

export interface PublicAddress {
  id: string
  network: { id: string; name: string; displayName: string }
  address: string
  label: string | null
  ownerReference: string
  activityStatus: string
  balanceStatus: string
  authorizationStatus: string
  recoveryStatus: string
  reviewFlag: boolean
  lastActivityAt: string | null
  inactiveDays: number | null
  lastScannedAt: string | null
  archivedAt: string | null
  createdAt: string
  /** Link to the public block explorer, when the network has one. */
  explorerUrl: string | null
  /** Sum of the priced balances in fiatCurrency (ESTIMATE, SA 4.4); null when nothing is priced. */
  estimatedValue: string | null
  fiatCurrency: string
  /** True on testnets: value uses mainnet prices and is NOT real money (ADR-016). */
  valueSimulated: boolean
}

export function toPublicAddress(row: AddressWithNetwork, fiatCurrency: string): PublicAddress {
  const iso = (d: Date | null) => d?.toISOString() ?? null
  const priced = row.balances.filter(
    (b) => b.fiatValue !== null && b.priceSnapshot?.fiatCurrency === fiatCurrency,
  )
  return {
    id: row.id,
    network: { id: row.network.id, name: row.network.name, displayName: row.network.displayName },
    address: row.address,
    label: row.label,
    ownerReference: row.ownerReference,
    activityStatus: row.activityStatus,
    balanceStatus: row.balanceStatus,
    authorizationStatus: row.authorizationStatus,
    recoveryStatus: row.recoveryStatus,
    reviewFlag: row.reviewFlag,
    lastActivityAt: iso(row.lastActivityAt),
    inactiveDays: row.inactiveDays,
    lastScannedAt: iso(row.lastScannedAt),
    archivedAt: iso(row.archivedAt),
    createdAt: row.createdAt.toISOString(),
    explorerUrl: row.network.explorerUrl
      ? `${row.network.explorerUrl.replace(/\/$/, '')}/address/${row.address}`
      : null,
    estimatedValue: priced.length ? sumFiat(priced.map((b) => b.fiatValue!.toFixed(8))) : null,
    fiatCurrency,
    valueSimulated: row.network.isTestnet,
  }
}

/** Parses CSV text into rows; structural problems (missing columns, broken quoting) fail the whole file. */
export function parseImportCsv(csv: string): ImportInputRow[] {
  if (csv.length > MAX_CSV_CHARS) {
    throw new AppError('VALIDATION_ERROR', 'File too large (maximum 2 MB)')
  }
  let records: Array<{ record: Record<string, string>; info: { lines: number; columns?: unknown } }>
  try {
    records = parse(csv, {
      columns: (header: string[]) => header.map((h) => h.trim().toLowerCase()),
      skip_empty_lines: true,
      trim: true,
      bom: true,
      info: true,
    }) as typeof records
  } catch (error) {
    const reason = error instanceof Error ? error.message : 'unreadable file'
    throw new AppError('VALIDATION_ERROR', `CSV could not be read: ${reason}`)
  }
  if (records.length === 0) throw new AppError('VALIDATION_ERROR', 'The CSV has no data rows')
  if (records.length > MAX_IMPORT_ROWS) {
    throw new AppError('VALIDATION_ERROR', `Too many rows (maximum ${MAX_IMPORT_ROWS} per file)`)
  }

  const present = new Set(Object.keys(records[0]?.record ?? {}))
  const missing = REQUIRED_IMPORT_COLUMNS.filter((column) => !present.has(column))
  if (missing.length > 0) {
    throw new AppError(
      'VALIDATION_ERROR',
      `Missing column(s): ${missing.join(', ')}. Expected header: address,network,label,owner_reference`,
    )
  }

  return records.map(({ record, info }) => ({
    line: info.lines,
    address: record.address ?? '',
    network: record.network ?? '',
    label: record.label ?? '',
    ownerReference: record.owner_reference ?? '',
  }))
}

export interface AddressServiceDeps {
  addresses: AddressRepository
  networks: NetworkRepository
  audit: AuditLogRepository
  fiatCurrency: string
  now: () => Date
}

export function createAddressService({
  addresses,
  networks,
  audit,
  fiatCurrency,
  now,
}: AddressServiceDeps) {
  const toPublic = (row: AddressWithNetwork) => toPublicAddress(row, fiatCurrency)
  async function getOrThrow(id: string): Promise<AddressWithNetwork> {
    const row = await addresses.findById(id)
    if (!row) throw new AppError('NOT_FOUND', 'Address not found', { resourceId: id })
    return row
  }

  /** Full server-side validation; the client's preview is never trusted for the commit. */
  async function evaluate(
    csv: string,
  ): Promise<{ results: ImportRowResult[]; summary: ImportSummary }> {
    const rows = parseImportCsv(csv)
    const byName = new Map<string, ImportNetwork>()
    for (const network of await networks.list()) {
      byName.set(network.name.toLowerCase(), {
        id: network.id,
        name: network.name,
        active: network.status === 'ACTIVE',
        checkAddress: isSupportedChain(network.chainType)
          ? (input) => chainAdapterFor(network.chainType).checkAddress(input)
          : () => ({
              ok: false,
              reason: 'INVALID_FORMAT',
              message: 'Chain type not supported yet',
            }),
      })
    }
    const firstPass = validateImportRows(rows, byName)
    const candidates = firstPass.flatMap((r) =>
      r.status === 'VALID' ? [{ networkId: r.networkId, address: r.address }] : [],
    )
    const results = markExisting(firstPass, await addresses.existingKeys(candidates))
    return { results, summary: summarize(results) }
  }

  return {
    async list(query: {
      networkId?: string
      activityStatus?: ActivityStatus
      search?: string
      archived?: 'exclude' | 'include' | 'only'
      page: number
      pageSize: number
    }) {
      const { items, total } = await addresses.list({
        networkId: query.networkId,
        activityStatus: query.activityStatus,
        search: query.search,
        includeArchived: query.archived === 'include',
        onlyArchived: query.archived === 'only',
        skip: (query.page - 1) * query.pageSize,
        take: query.pageSize,
      })
      return {
        items: items.map(toPublic),
        total,
        page: query.page,
        pageSize: query.pageSize,
      }
    },

    async get(id: string): Promise<PublicAddress> {
      return toPublic(await getOrThrow(id))
    },

    async create(
      actor: AuthContext,
      input: { networkId: string; address: string; label: string | null; ownerReference: string },
      meta: RequestMeta,
    ): Promise<PublicAddress> {
      const network = await networks.findById(input.networkId)
      if (!network) throw new AppError('INVALID_NETWORK', 'Network not found')
      if (network.status !== 'ACTIVE') {
        throw new AppError('INVALID_NETWORK', `Network "${network.name}" is disabled`)
      }
      const check = chainAdapterFor(network.chainType).checkAddress(input.address)
      if (!check.ok) throw new AppError('INVALID_ADDRESS', check.message)

      const existing = await addresses.findByNetworkAndAddress(network.id, check.address)
      if (existing) {
        throw new AppError(
          'CONFLICT',
          existing.archivedAt
            ? 'This address is already registered but archived — restore it instead'
            : 'This address is already registered on this network',
          { resourceId: existing.id },
        )
      }
      const created = await addresses.create({
        networkId: network.id,
        address: check.address,
        label: input.label,
        ownerReference: input.ownerReference,
        createdById: actor.user.id,
      })
      await recordAction(audit, actor, meta, {
        action: 'ADDRESS_CREATED',
        resourceType: 'address',
        resourceId: created.id,
        metadata: {
          network: network.name,
          address: check.address,
          ownerReference: created.ownerReference,
        },
      })
      return toPublic(await getOrThrow(created.id))
    },

    async update(
      actor: AuthContext,
      id: string,
      input: { label?: string | null; ownerReference?: string },
      meta: RequestMeta,
    ): Promise<PublicAddress> {
      const before = await getOrThrow(id)
      if (before.archivedAt) {
        throw new AppError('CONFLICT', 'Restore the address before editing it', { resourceId: id })
      }
      const updated = await addresses.update(id, {
        label: input.label,
        ownerReference: input.ownerReference?.trim(),
      })
      await recordAction(audit, actor, meta, {
        action: 'ADDRESS_UPDATED',
        resourceType: 'address',
        resourceId: id,
        metadata: {
          before: { label: before.label, ownerReference: before.ownerReference },
          after: { label: updated.label, ownerReference: updated.ownerReference },
        },
      })
      return toPublic(updated)
    },

    async archive(actor: AuthContext, id: string, reason: string | null, meta: RequestMeta) {
      const row = await getOrThrow(id)
      if (row.archivedAt)
        throw new AppError('CONFLICT', 'Address is already archived', { resourceId: id })
      const updated = await addresses.update(id, { archivedAt: now() })
      await recordAction(audit, actor, meta, {
        action: 'ADDRESS_ARCHIVED',
        resourceType: 'address',
        resourceId: id,
        metadata: { address: row.address, reason },
      })
      return toPublic(updated)
    },

    async restore(actor: AuthContext, id: string, meta: RequestMeta) {
      const row = await getOrThrow(id)
      if (!row.archivedAt)
        throw new AppError('CONFLICT', 'Address is not archived', { resourceId: id })
      const updated = await addresses.update(id, { archivedAt: null })
      await recordAction(audit, actor, meta, {
        action: 'ADDRESS_RESTORED',
        resourceType: 'address',
        resourceId: id,
        metadata: { address: row.address },
      })
      return toPublic(updated)
    },

    /** Dry run: validates every row and saves nothing. */
    previewImport(csv: string) {
      return evaluate(csv)
    },

    /** Re-validates the file server-side and stores only the valid rows. */
    async commitImport(actor: AuthContext, csv: string, meta: RequestMeta) {
      const { results, summary } = await evaluate(csv)
      const valid = results.flatMap((r) => (r.status === 'VALID' ? [r] : []))
      const created = await addresses.createMany(
        valid.map((r) => ({
          networkId: r.networkId,
          address: r.address,
          label: r.label,
          ownerReference: r.ownerReference,
          createdById: actor.user.id,
        })),
      )
      await recordAction(audit, actor, meta, {
        action: 'ADDRESSES_IMPORTED',
        resourceType: 'address-import',
        resourceId: createHash('sha256').update(csv).digest('hex'),
        metadata: { ...summary, created },
      })
      return { summary, created, results }
    },
  }
}

export type AddressService = ReturnType<typeof createAddressService>
