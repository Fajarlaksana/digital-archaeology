import { AppError } from '@da/shared'
import type { ChainType } from '../generated/prisma/enums'
import { evmAdapter } from './evm/evm-adapter'
import type { ChainAdapter } from './types'

const ADAPTERS: Partial<Record<ChainType, ChainAdapter>> = { EVM: evmAdapter }

export function chainAdapterFor(chainType: ChainType): ChainAdapter {
  const adapter = ADAPTERS[chainType]
  if (!adapter) {
    throw new AppError('INVALID_NETWORK', `Chain type ${chainType} is not supported yet`)
  }
  return adapter
}

export function isSupportedChain(chainType: ChainType): boolean {
  return ADAPTERS[chainType] !== undefined
}

export type { AddressCheck, AddressRejection, ChainAdapter } from './types'
