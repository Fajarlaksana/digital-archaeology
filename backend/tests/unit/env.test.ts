import { describe, expect, it } from 'vitest'
import { parseEnv } from '../../src/config/env'

const VALID = {
  DATABASE_URL: 'postgresql://da:pw@127.0.0.1:5432/digital_archaeology',
  REDIS_URL: 'redis://127.0.0.1:6379',
  MFA_ENCRYPTION_KEY: Buffer.alloc(32, 7).toString('base64'),
}

describe('parseEnv', () => {
  it('applies safe defaults', () => {
    const env = parseEnv(VALID)
    expect(env).toMatchObject({
      APP_ENV: 'development',
      NETWORK_MODE: 'testnet',
      BACKEND_HOST: '127.0.0.1',
      BACKEND_PORT: 3000,
    })
    expect(env.SEPOLIA_RPC_URL).toBeUndefined()
  })

  it('fails when required variables are missing and names them', () => {
    expect(() => parseEnv({})).toThrow(/DATABASE_URL.*REDIS_URL.*MFA_ENCRYPTION_KEY/)
  })

  it('never includes variable values in the error message', () => {
    const secretUrl = 'mysql://user:SuperSecret123@host/db'
    expect(() => parseEnv({ ...VALID, DATABASE_URL: secretUrl })).toThrow(/DATABASE_URL/)
    try {
      parseEnv({ ...VALID, DATABASE_URL: secretUrl })
    } catch (error) {
      expect(String(error)).not.toContain('SuperSecret123')
    }
  })

  it('treats empty optional values as unset', () => {
    expect(parseEnv({ ...VALID, SEPOLIA_RPC_URL: '' }).SEPOLIA_RPC_URL).toBeUndefined()
  })

  it('rejects an unknown NETWORK_MODE', () => {
    expect(() => parseEnv({ ...VALID, NETWORK_MODE: 'prod' })).toThrow(/NETWORK_MODE/)
  })

  it('accepts mainnet only when set explicitly', () => {
    expect(parseEnv({ ...VALID, NETWORK_MODE: 'mainnet' }).NETWORK_MODE).toBe('mainnet')
  })

  it('requires a 32-byte base64 MFA_ENCRYPTION_KEY', () => {
    expect(() => parseEnv({ ...VALID, MFA_ENCRYPTION_KEY: undefined })).toThrow(
      /MFA_ENCRYPTION_KEY/,
    )
    const short = Buffer.alloc(16, 1).toString('base64')
    expect(() => parseEnv({ ...VALID, MFA_ENCRYPTION_KEY: short })).toThrow(/MFA_ENCRYPTION_KEY/)
  })

  it('applies session defaults', () => {
    expect(parseEnv(VALID)).toMatchObject({ SESSION_TTL_HOURS: 12, SESSION_IDLE_MINUTES: 30 })
  })

  it('coerces and validates the port', () => {
    expect(parseEnv({ ...VALID, BACKEND_PORT: '4100' }).BACKEND_PORT).toBe(4100)
    expect(() => parseEnv({ ...VALID, BACKEND_PORT: '70000' })).toThrow(/BACKEND_PORT/)
  })
})
