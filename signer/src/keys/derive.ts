import { validateMnemonic } from '@scure/bip39'
import { wordlist } from '@scure/bip39/wordlists/english.js'
import { mnemonicToAccount, privateKeyToAccount } from 'viem/accounts'
import { AppError } from '@da/shared'

export type SecretType = 'PRIVATE_KEY' | 'MNEMONIC'

/** BIP-44 Ethereum path; only the final index normally changes. */
export const DEFAULT_EVM_PATH = "m/44'/60'/0'/0/0"
const PATH_PATTERN = /^m(\/\d{1,10}'?){1,8}$/

export interface DerivedKey {
  /** 32 raw bytes. The caller must wipe() it after use. */
  privateKey: Buffer
  /** Lower-case 0x address. */
  address: string
  keyType: 'PRIVATE_KEY' | 'DERIVED_FROM_MNEMONIC'
  derivationPath: string | null
}

/**
 * Turns user input into ONE private key + its address. For a seed phrase, only the key at
 * `derivationPath` is derived; the seed itself is never returned or stored (ADR-017).
 * Error messages never quote the input.
 */
export function deriveEvmKey(input: {
  secretType: SecretType
  secret: string
  derivationPath?: string | null
}): DerivedKey {
  if (input.secretType === 'PRIVATE_KEY') {
    const hex = input.secret.trim().toLowerCase()
    const normalized = hex.startsWith('0x') ? hex : `0x${hex}`
    if (!/^0x[0-9a-f]{64}$/.test(normalized)) {
      throw new AppError('VALIDATION_ERROR', 'Private key must be 64 hexadecimal characters')
    }
    let address: string
    try {
      address = privateKeyToAccount(normalized as `0x${string}`).address
    } catch {
      throw new AppError('VALIDATION_ERROR', 'Not a valid secp256k1 private key')
    }
    return {
      privateKey: Buffer.from(normalized.slice(2), 'hex'),
      address: address.toLowerCase(),
      keyType: 'PRIVATE_KEY',
      derivationPath: null,
    }
  }

  const phrase = input.secret.trim().toLowerCase().split(/\s+/).join(' ')
  if (!validateMnemonic(phrase, wordlist)) {
    throw new AppError(
      'VALIDATION_ERROR',
      'Seed phrase is not a valid BIP-39 phrase (check the words and their order)',
    )
  }
  const path = input.derivationPath?.trim() || DEFAULT_EVM_PATH
  if (!PATH_PATTERN.test(path)) {
    throw new AppError('VALIDATION_ERROR', "Derivation path must look like m/44'/60'/0'/0/0")
  }
  const account = mnemonicToAccount(phrase, { path: path as `m/44'/60'/${string}` })
  const raw = account.getHdKey().privateKey
  if (!raw) throw new AppError('VALIDATION_ERROR', 'Could not derive a key at this path')
  return {
    privateKey: Buffer.from(raw),
    address: account.address.toLowerCase(),
    keyType: 'DERIVED_FROM_MNEMONIC',
    derivationPath: path,
  }
}
