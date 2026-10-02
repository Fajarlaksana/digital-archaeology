import { AppError, type Logger } from '@da/shared'
import type { ChainClientFactory, ChainClients } from '../chains/clients'
import { analyzeActivity } from '../domain/activity-analyzer'
import { displayFiat } from '../domain/valuation'
import { AmountError, fromBaseUnit, parseBaseUnits, toBaseUnit } from '../domain/money'
import type { Asset } from '../generated/prisma/client'
import type { AuditLogRepository } from '../repositories/audit-log.repository'
import type { NetworkRepository } from '../repositories/network.repository'
import { fromDbAmountOrNull } from '../repositories/amount'
import type {
  ResultFilter,
  ScanRepository,
  ScanResultWithAddress,
  ScanWithNetwork,
  StoredBalance,
} from '../repositories/scan.repository'
import { recordAction } from './audit-trail'
import type { AuthContext, RequestMeta } from './auth.service'

export interface PublicScan {
  id: string
  network: { id: string; name: string; displayName: string; nativeSymbol: string | null }
  status: string
  /** MANUAL (a user) or SCHEDULED (the system scheduler). */
  trigger: string
  thresholdDays: number
  /** Native-asset amounts in whole units (e.g. "0.01"), null = no bound. */
  minimumBalance: string | null
  maximumBalance: string | null
  totalAddresses: number
  processedAddresses: number
  totalInactive: number
  totalFailed: number
  errorMessage: string | null
  createdAt: string
  startedAt: string | null
  completedAt: string | null
}

export interface ScanServiceDeps {
  scans: ScanRepository
  networks: NetworkRepository
  audit: AuditLogRepository
  clientsFor: ChainClientFactory
  enqueue: (scanId: string) => Promise<void>
  defaultThresholdDays: number
  logger: Logger
  now: () => Date
  /** Fiat currency for valuation display (Phase 6). */
  fiatCurrency: string
  /** Called after a scan finished (e.g. re-apply prices to the new balances). Errors are logged. */
  afterScan?: (networkId: string) => Promise<void>
}

export function createScanService(deps: ScanServiceDeps) {
  const { scans, networks, audit, clientsFor, logger, now } = deps

  async function nativeAsset(networkId: string): Promise<Asset | null> {
    return networks.findNativeAsset(networkId)
  }

  async function toPublic(scan: ScanWithNetwork): Promise<PublicScan> {
    const native = await nativeAsset(scan.networkId)
    const fmt = (value: bigint | null) =>
      value === null || !native ? null : fromBaseUnit(value, native.decimals)
    return {
      id: scan.id,
      network: {
        id: scan.network.id,
        name: scan.network.name,
        displayName: scan.network.displayName,
        nativeSymbol: native?.symbol ?? null,
      },
      status: scan.status,
      trigger: scan.trigger,
      thresholdDays: scan.thresholdDays,
      minimumBalance: fmt(fromDbAmountOrNull(scan.minimumBalance)),
      maximumBalance: fmt(fromDbAmountOrNull(scan.maximumBalance)),
      totalAddresses: scan.totalAddresses,
      processedAddresses: scan._count.results,
      totalInactive: scan.totalInactive,
      totalFailed: scan.totalFailed,
      errorMessage: scan.errorMessage,
      createdAt: scan.createdAt.toISOString(),
      startedAt: scan.startedAt?.toISOString() ?? null,
      completedAt: scan.completedAt?.toISOString() ?? null,
    }
  }

  async function getOrThrow(id: string): Promise<ScanWithNetwork> {
    const scan = await scans.findById(id)
    if (!scan) throw new AppError('NOT_FOUND', 'Scan not found', { resourceId: id })
    return scan
  }

  const service = {
    async create(
      actor: AuthContext,
      input: {
        networkId: string
        thresholdDays?: number
        minimumBalance?: string | null
        maximumBalance?: string | null
      },
      meta: RequestMeta,
    ): Promise<PublicScan> {
      const network = await networks.findById(input.networkId)
      if (!network) throw new AppError('INVALID_NETWORK', 'Network not found')
      if (network.status !== 'ACTIVE') {
        throw new AppError('INVALID_NETWORK', `Network "${network.name}" is disabled`)
      }
      clientsFor(network) // fail fast with a clear message when RPC / explorer is not configured

      if (await scans.findActiveForNetwork(network.id)) {
        throw new AppError('CONFLICT', 'A scan for this network is already queued or running')
      }

      const native = network.assets.find((a) => a.isNative)
      const parse = (value: string | null | undefined, field: string): bigint | null => {
        if (value === null || value === undefined || value.trim() === '') return null
        try {
          return toBaseUnit(value, native?.decimals ?? 18)
        } catch (error) {
          throw new AppError(
            'VALIDATION_ERROR',
            `${field}: ${error instanceof AmountError ? error.message : 'invalid amount'}`,
          )
        }
      }
      const minimumBalance = parse(input.minimumBalance, 'minimumBalance')
      const maximumBalance = parse(input.maximumBalance, 'maximumBalance')
      if (minimumBalance !== null && maximumBalance !== null && minimumBalance > maximumBalance) {
        throw new AppError('VALIDATION_ERROR', 'minimumBalance must not exceed maximumBalance')
      }

      const targets = await scans.listTargets(network.id)
      const scan = await scans.create({
        networkId: network.id,
        thresholdDays: input.thresholdDays ?? deps.defaultThresholdDays,
        minimumBalance,
        maximumBalance,
        totalAddresses: targets.length,
        createdById: actor.user.id,
        trigger: 'MANUAL',
      })
      await recordAction(audit, actor, meta, {
        action: 'SCAN_CREATED',
        resourceType: 'scan',
        resourceId: scan.id,
        metadata: {
          network: network.name,
          thresholdDays: scan.thresholdDays,
          addresses: targets.length,
        },
      })
      await deps.enqueue(scan.id)
      return toPublic(await getOrThrow(scan.id))
    },

    /**
     * Scheduler entry point: queues a scan for every active, configured network that is not
     * already being scanned. Recorded as a SYSTEM action (no user). Never moves assets (rule 5).
     */
    async startScheduledScans(): Promise<{
      started: string[]
      skipped: Array<{ network: string; reason: string }>
    }> {
      const started: string[] = []
      const skipped: Array<{ network: string; reason: string }> = []
      for (const network of await networks.list()) {
        if (network.status !== 'ACTIVE') continue
        try {
          clientsFor(network)
        } catch (error) {
          skipped.push({
            network: network.name,
            reason: error instanceof AppError ? error.message : 'not configured',
          })
          continue
        }
        if (await scans.findActiveForNetwork(network.id)) {
          skipped.push({ network: network.name, reason: 'a scan is already queued or running' })
          continue
        }
        const targets = await scans.listTargets(network.id)
        if (targets.length === 0) {
          skipped.push({ network: network.name, reason: 'no addresses' })
          continue
        }
        const scan = await scans.create({
          networkId: network.id,
          thresholdDays: deps.defaultThresholdDays,
          minimumBalance: null,
          maximumBalance: null,
          totalAddresses: targets.length,
          createdById: null,
          trigger: 'SCHEDULED',
        })
        await audit.create({
          action: 'SCAN_SCHEDULED',
          result: 'SUCCESS',
          resourceType: 'scan',
          resourceId: scan.id,
          metadata: { actor: 'SYSTEM', network: network.name, addresses: targets.length },
        })
        await deps.enqueue(scan.id)
        started.push(scan.id)
      }
      if (skipped.length > 0) logger.warn({ skipped }, 'SCHEDULED_SCANS_SKIPPED')
      return { started, skipped }
    },

    async list(page: number, pageSize: number) {
      const { items, total } = await scans.list((page - 1) * pageSize, pageSize)
      return { items: await Promise.all(items.map(toPublic)), total, page, pageSize }
    },

    async get(id: string): Promise<PublicScan> {
      return toPublic(await getOrThrow(id))
    },

    async results(id: string, filter: ResultFilter | 'criteria', page: number, pageSize: number) {
      const scan = await getOrThrow(id)
      const native = await nativeAsset(scan.networkId)
      const min = fromDbAmountOrNull(scan.minimumBalance)
      const max = fromDbAmountOrNull(scan.maximumBalance)
      const nativeOf = (r: ScanResultWithAddress): bigint | null => {
        const entry = (r.balances as StoredBalance[] | null)?.find((b) => b.assetId === native?.id)
        return entry ? parseBaseUnits(entry.quantity) : null
      }
      // Criteria (SA 4.2): inactive, scanned OK, and native balance inside [min, max].
      const matches = (r: ScanResultWithAddress) => {
        const balance = nativeOf(r)
        return (
          r.errorCode === null &&
          r.activityStatus === 'INACTIVE' &&
          balance !== null &&
          (min === null || balance >= min) &&
          (max === null || balance <= max)
        )
      }

      let rows: ScanResultWithAddress[]
      let total: number
      if (filter === 'criteria') {
        // Criteria needs the JSON balance, so it is filtered in memory over the inactive results.
        const all = await scans.results(id, 'inactive', 0, 100_000)
        const matching = all.items.filter(matches)
        total = matching.length
        rows = matching.slice((page - 1) * pageSize, page * pageSize)
      } else {
        const result = await scans.results(id, filter, (page - 1) * pageSize, pageSize)
        rows = result.items
        total = result.total
      }

      return {
        total,
        page,
        pageSize,
        items: rows.map((r) => ({
          addressId: r.addressId,
          address: r.address.address,
          label: r.address.label,
          activityStatus: r.activityStatus,
          balanceStatus: r.balanceStatus,
          inactiveDays: r.inactiveDays,
          lastActivityAt: r.lastActivityAt?.toISOString() ?? null,
          lastOutgoingAt: r.lastOutgoingAt?.toISOString() ?? null,
          incomingTxCount: r.incomingTxCount,
          outgoingTxCount: r.outgoingTxCount,
          nonce: r.nonce,
          reviewFlag: r.reviewFlag,
          errorCode: r.errorCode,
          nativeBalance: (() => {
            const value = nativeOf(r)
            return value === null || !native ? null : fromBaseUnit(value, native.decimals)
          })(),
          matchesCriteria: matches(r),
        })),
      }
    },

    async addressHistory(addressId: string) {
      const rows = await scans.historyForAddress(addressId, 20)
      return rows.map((r) => ({
        scanId: r.scan.id,
        scannedAt: r.createdAt.toISOString(),
        thresholdDays: r.scan.thresholdDays,
        activityStatus: r.activityStatus,
        balanceStatus: r.balanceStatus,
        inactiveDays: r.inactiveDays,
        lastIncomingAt: r.lastIncomingAt?.toISOString() ?? null,
        lastOutgoingAt: r.lastOutgoingAt?.toISOString() ?? null,
        incomingTxCount: r.incomingTxCount,
        outgoingTxCount: r.outgoingTxCount,
        nonce: r.nonce,
        reviewFlag: r.reviewFlag,
        errorCode: r.errorCode,
      }))
    },

    async addressBalances(addressId: string) {
      const rows = await scans.balancesForAddress(addressId)
      return rows.map((r) => ({
        assetId: r.asset.id,
        symbol: r.asset.symbol,
        name: r.asset.name,
        isNative: r.asset.isNative,
        decimals: r.asset.decimals,
        quantity: r.quantity.toString(),
        formatted: fromBaseUnit(r.quantity, r.asset.decimals),
        updatedAt: r.updatedAt.toISOString(),
        // Valuation (Phase 6): an ESTIMATE, shown with its source and time (SA 4.4 / 13).
        ...(() => {
          const snap = r.priceSnapshot
          const usable =
            snap !== null && snap.fiatCurrency === deps.fiatCurrency && r.fiatValue !== null
          return {
            fiatCurrency: deps.fiatCurrency,
            fiatValue: usable ? displayFiat(r.fiatValue!) : null,
            price: usable ? snap.price.toFixed() : null,
            priceSource: usable ? snap.source : null,
            pricedAt: usable ? snap.pricedAt.toISOString() : null,
            simulated: r.asset.network.isTestnet,
          }
        })(),
      }))
    },

    /**
     * Worker entry point. Idempotent: addresses already recorded for this scan are skipped,
     * so a crashed/restarted job resumes where it stopped.
     */
    async process(scanId: string): Promise<void> {
      const scan = await scans.findById(scanId)
      if (!scan || ['COMPLETED', 'FAILED', 'CANCELLED'].includes(scan.status)) return
      await scans.setStatus(scanId, 'RUNNING', { startedAt: scan.startedAt ?? now() })
      logger.info({ scanId, network: scan.network.name }, 'SCAN_STARTED')

      let clients: ChainClients
      try {
        clients = clientsFor(scan.network)
      } catch (error) {
        const message = error instanceof AppError ? error.message : 'Chain clients unavailable'
        await scans.setStatus(scanId, 'FAILED', { completedAt: now(), errorMessage: message })
        logger.error({ scanId, code: (error as AppError).code }, 'SCAN_FAILED')
        return
      }

      try {
        await runTargets(scan, clients)
      } catch (error) {
        // Unexpected failure (e.g. database down): never leave the scan stuck in RUNNING.
        logger.error({ err: error, scanId }, 'SCAN_ABORTED')
        await scans
          .setStatus(scanId, 'FAILED', {
            completedAt: now(),
            errorMessage: 'Scan aborted by an internal error',
          })
          .catch(() => undefined)
        throw error
      }
    },
  }
  return service

  async function runTargets(scan: ScanWithNetwork, clients: ChainClients): Promise<void> {
    const scanId = scan.id
    const assets = await networks.listAssets(scan.networkId)
    const native = assets.find((a) => a.isNative)
    const tokens = assets.filter((a) => !a.isNative && a.contractAddress)
    const done = await scans.doneAddressIds(scanId)
    const targets = (await scans.listTargets(scan.networkId)).filter((t) => !done.has(t.id))

    for (const target of targets) {
      try {
        const nonce = await clients.reader.getOutgoingNonce(target.address)
        const nativeBalance = await clients.reader.getNativeBalance(target.address)
        const tokenBalances: bigint[] = []
        for (const token of tokens) {
          tokenBalances.push(
            await clients.reader.getTokenBalance(target.address, token.contractAddress!),
          )
        }
        const activity = await clients.activity.getActivity(target.address)
        const scannedAt = now()
        const result = analyzeActivity({
          scanDate: scannedAt,
          thresholdDays: scan.thresholdDays,
          nonce,
          nativeBalance,
          tokenBalances,
          activity,
        })
        await scans.recordSuccess(
          scanId,
          target.id,
          {
            ...result,
            lastIncomingAt: activity.lastIncomingAt,
            lastOutgoingAt: activity.lastOutgoingAt,
            incomingTxCount: activity.incomingTxCount,
            outgoingTxCount: activity.outgoingTxCount,
            nonce,
            balances: [
              ...(native
                ? [{ assetId: native.id, symbol: native.symbol, quantity: nativeBalance }]
                : []),
              ...tokens.map((t, i) => ({
                assetId: t.id,
                symbol: t.symbol,
                quantity: tokenBalances[i]!,
              })),
            ],
          },
          scannedAt,
        )
      } catch (error) {
        const code = error instanceof AppError ? error.code : 'INTERNAL_ERROR'
        logger.warn({ scanId, addressId: target.id, code }, 'SCAN_ADDRESS_FAILED')
        await scans.recordFailure(scanId, target.id, code)
      }
    }

    const totals = await scans.totals(scanId)
    await scans.saveTotals(scanId, totals)
    const allFailed = totals.done > 0 && totals.failed === totals.done
    let errorMessage: string | null = null
    if (allFailed) {
      const [top] = await scans.failureCodes(scanId)
      errorMessage = `Every address failed (most common: ${top?.code ?? 'UNKNOWN'})`
    }
    await scans.setStatus(scanId, allFailed ? 'FAILED' : 'COMPLETED', {
      completedAt: now(),
      errorMessage,
    })
    await audit.create({
      action: allFailed ? 'SCAN_FAILED' : 'SCAN_COMPLETED',
      result: allFailed ? 'FAILURE' : 'SUCCESS',
      userId: scan.createdById,
      resourceType: 'scan',
      resourceId: scanId,
      metadata: { network: scan.network.name, ...totals },
    })
    logger.info({ scanId, ...totals }, allFailed ? 'SCAN_FAILED' : 'SCAN_COMPLETED')
    if (deps.afterScan) {
      await deps
        .afterScan(scan.networkId)
        .catch((err: unknown) => logger.error({ err, scanId }, 'AFTER_SCAN_HOOK_FAILED'))
    }
  }
}

export type ScanService = ReturnType<typeof createScanService>
