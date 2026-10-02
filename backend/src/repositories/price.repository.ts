import type { Asset, Network, PriceSnapshot } from '../generated/prisma/client'
import { Prisma } from '../generated/prisma/client'
import type { Database } from '../lib/prisma'
import { fromDbAmount } from './amount'

export type PricedAsset = Asset & { network: Network }

export function createPriceRepository(db: Database) {
  return {
    /** Assets that have a CoinGecko id, optionally limited to one network. */
    assetsWithPriceId(networkId?: string): Promise<PricedAsset[]> {
      return db.asset.findMany({
        where: { priceId: { not: null }, ...(networkId ? { networkId } : {}) },
        include: { network: true },
      })
    },

    createSnapshot(data: {
      assetId: string
      fiatCurrency: string
      price: string
      source: string
      pricedAt: Date
    }): Promise<PriceSnapshot> {
      return db.priceSnapshot.create({ data: { ...data, price: new Prisma.Decimal(data.price) } })
    },

    latestSnapshot(assetId: string, fiatCurrency: string): Promise<PriceSnapshot | null> {
      return db.priceSnapshot.findFirst({
        where: { assetId, fiatCurrency },
        orderBy: [{ pricedAt: 'desc' }, { createdAt: 'desc' }],
      })
    },

    async balancesForAsset(assetId: string): Promise<Array<{ id: string; quantity: bigint }>> {
      const rows = await db.balance.findMany({
        where: { assetId },
        select: { id: true, quantity: true },
      })
      return rows.map((r) => ({ id: r.id, quantity: fromDbAmount(r.quantity) }))
    },

    /** Writes computed fiat values (strings) in chunks, each chunk atomically. */
    async setFiatValues(
      updates: Array<{ id: string; fiatValue: string; priceSnapshotId: string }>,
    ): Promise<void> {
      for (let i = 0; i < updates.length; i += 200) {
        await db.$transaction(
          updates.slice(i, i + 200).map((u) =>
            db.balance.update({
              where: { id: u.id },
              data: {
                fiatValue: new Prisma.Decimal(u.fiatValue),
                priceSnapshotId: u.priceSnapshotId,
              },
            }),
          ),
        )
      }
    },

    findAsset(networkId: string, assetId: string): Promise<Asset | null> {
      return db.asset.findFirst({ where: { id: assetId, networkId } })
    },

    setPriceId(assetId: string, priceId: string | null): Promise<Asset> {
      return db.asset.update({ where: { id: assetId }, data: { priceId } })
    },
  }
}

export type PriceRepository = ReturnType<typeof createPriceRepository>
