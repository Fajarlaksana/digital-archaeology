/**
 * Development seed: Sepolia network + its native asset + common ERC-20 test tokens.
 * Idempotent — safe to run repeatedly.
 *
 * Users are NOT seeded here: password hashing arrives in Phase 3, and the SUPER_ADMIN
 * account is created only through the server-side CLI (ADR-003).
 */
import { createLogger } from '@da/shared'
import { loadEnvFile } from '../src/config/env'
import { createPrismaClient } from '../src/lib/prisma'

interface TokenSeed {
  symbol: string
  name: string
  decimals: number
  /** EIP-55 checksummed. Verify on https://sepolia.etherscan.io before relying on it. */
  contractAddress: string
}

const SEPOLIA = {
  name: 'sepolia',
  displayName: 'Ethereum Sepolia (testnet)',
  chainType: 'EVM',
  chainId: 11155111,
  isTestnet: true,
  rpcUrlEnv: 'SEPOLIA_RPC_URL',
  explorerUrl: 'https://sepolia.etherscan.io',
} as const

const SEPOLIA_TOKENS: TokenSeed[] = [
  {
    symbol: 'USDC',
    name: 'USD Coin (Circle testnet)',
    decimals: 6,
    contractAddress: '0x1c7D4B196Cb0C7B01d743Fbc6116a902379C7238',
  },
  {
    symbol: 'LINK',
    name: 'Chainlink Token (testnet)',
    decimals: 18,
    contractAddress: '0x779877A7B0D9E8603169DdbD7836e478b4624789',
  },
]

loadEnvFile()
const logger = createLogger({ name: 'seed' })
const url = process.env.DATABASE_URL
if (!url) {
  logger.fatal('DATABASE_URL is not set')
  process.exit(1)
}
const db = createPrismaClient(url)

try {
  const network = await db.network.upsert({
    where: { name: SEPOLIA.name },
    create: SEPOLIA,
    update: SEPOLIA,
  })

  const native = await db.asset.findFirst({ where: { networkId: network.id, isNative: true } })
  if (!native) {
    await db.asset.create({
      data: {
        networkId: network.id,
        isNative: true,
        symbol: 'ETH',
        name: 'Sepolia Ether',
        decimals: 18,
      },
    })
  }

  for (const token of SEPOLIA_TOKENS) {
    await db.asset.upsert({
      where: {
        networkId_contractAddress: {
          networkId: network.id,
          contractAddress: token.contractAddress,
        },
      },
      create: { networkId: network.id, isNative: false, ...token },
      update: { symbol: token.symbol, name: token.name, decimals: token.decimals },
    })
  }

  const assets = await db.asset.count({ where: { networkId: network.id } })
  logger.info({ network: network.name, assets }, 'SEED_COMPLETED')
} finally {
  await db.$disconnect()
}
