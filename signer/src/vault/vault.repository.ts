import { PrismaPg } from '@prisma/adapter-pg'
import { redactSensitive } from '@da/shared'
import {
  PrismaClient,
  type Prisma,
  type VaultConfig,
  type VaultEventType,
} from '../generated/prisma/client'

export type VaultDatabase = PrismaClient

export function createVaultDatabase(connectionString: string): VaultDatabase {
  return new PrismaClient({ adapter: new PrismaPg({ connectionString }) })
}

export function createVaultRepository(db: VaultDatabase) {
  return {
    getConfig(): Promise<VaultConfig | null> {
      return db.vaultConfig.findUnique({ where: { id: 1 } })
    },

    createConfig(
      data: Omit<VaultConfig, 'id' | 'formatVersion' | 'createdAt' | 'updatedAt'>,
    ): Promise<VaultConfig> {
      return db.vaultConfig.create({ data: { id: 1, ...data } })
    },

    updateConfig(
      data: Partial<
        Pick<VaultConfig, 'mainSalt' | 'mainWrappedKey' | 'recoverySalt' | 'recoveryWrappedKey'>
      >,
    ): Promise<VaultConfig> {
      return db.vaultConfig.update({ where: { id: 1 }, data })
    },

    /** Append-only event log. Metadata is redacted defensively before storage. */
    async event(
      type: VaultEventType,
      entry: {
        actor?: string | null
        address?: string | null
        metadata?: Record<string, unknown>
      } = {},
    ): Promise<void> {
      await db.vaultEvent.create({
        data: {
          type,
          actor: entry.actor ?? null,
          address: entry.address ?? null,
          metadata:
            entry.metadata === undefined
              ? undefined
              : (redactSensitive(entry.metadata) as Prisma.InputJsonValue),
        },
      })
    },
  }
}

export type VaultRepository = ReturnType<typeof createVaultRepository>
