import { PrismaPg } from '@prisma/adapter-pg'
import { PrismaClient } from '../generated/prisma/client'

export type Database = PrismaClient

export function createPrismaClient(connectionString: string): Database {
  return new PrismaClient({ adapter: new PrismaPg({ connectionString }) })
}

/** Runs `SELECT 1` and returns the round-trip latency in milliseconds. */
export async function checkDatabase(db: Database): Promise<number> {
  const start = performance.now()
  await db.$queryRaw`SELECT 1`
  return Math.round(performance.now() - start)
}
