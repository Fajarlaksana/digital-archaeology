import { describe, expect, it } from 'vitest'
import { parseEnv, productionProblems } from '../../src/config/env'

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

  it('allows plain http to the signer only on loopback', () => {
    expect(parseEnv(VALID).SIGNER_URL).toBe('http://127.0.0.1:4000')
    for (const url of ['http://localhost:4000', 'http://[::1]:4000', 'http://127.0.0.2:4000']) {
      expect(parseEnv({ ...VALID, SIGNER_URL: url }).SIGNER_URL).toBe(url)
    }
    expect(() => parseEnv({ ...VALID, SIGNER_URL: 'http://signer:4000' })).toThrow(/SIGNER_URL/)
    expect(() => parseEnv({ ...VALID, SIGNER_URL: 'http://10.0.0.5:4000' })).toThrow(/SIGNER_URL/)
    expect(() => parseEnv({ ...VALID, SIGNER_URL: 'http://127.0.0.1.evil.example:4000' })).toThrow(
      /SIGNER_URL/,
    )
    expect(parseEnv({ ...VALID, SIGNER_URL: 'https://signer.internal:4443' }).SIGNER_URL).toBe(
      'https://signer.internal:4443',
    )
    expect(
      parseEnv({ ...VALID, SIGNER_URL: 'http://signer:4000', SIGNER_ALLOW_INSECURE_HTTP: 'true' })
        .SIGNER_URL,
    ).toBe('http://signer:4000')
  })

  it('applies eligibility defaults and validates the minimum net value', () => {
    expect(parseEnv(VALID)).toMatchObject({
      RECOVERY_MIN_NET_VALUE: '10',
      FEE_MARGIN_PERCENT: 20,
      ELIGIBILITY_BALANCE_MAX_AGE_HOURS: 36,
    })
    expect(parseEnv({ ...VALID, RECOVERY_MIN_NET_VALUE: '12.50' }).RECOVERY_MIN_NET_VALUE).toBe(
      '12.50',
    )
    for (const bad of ['-1', '1e3', 'ten', '1.123456789']) {
      expect(() => parseEnv({ ...VALID, RECOVERY_MIN_NET_VALUE: bad })).toThrow(
        /RECOVERY_MIN_NET_VALUE/,
      )
    }
    expect(() => parseEnv({ ...VALID, FEE_MARGIN_PERCENT: '-5' })).toThrow(/FEE_MARGIN_PERCENT/)
  })

  it('applies session defaults', () => {
    expect(parseEnv(VALID)).toMatchObject({ SESSION_TTL_HOURS: 12, SESSION_IDLE_MINUTES: 30 })
  })

  it('coerces and validates the port', () => {
    expect(parseEnv({ ...VALID, BACKEND_PORT: '4100' }).BACKEND_PORT).toBe(4100)
    expect(() => parseEnv({ ...VALID, BACKEND_PORT: '70000' })).toThrow(/BACKEND_PORT/)
  })
})

describe('TRUST_PROXY', () => {
  it('accepts IPs and CIDRs, rejects wildcards', () => {
    expect(parseEnv({ ...VALID, TRUST_PROXY: '172.30.0.0/24, 10.0.0.5' }).TRUST_PROXY).toBe(
      '172.30.0.0/24, 10.0.0.5',
    )
    expect(() => parseEnv({ ...VALID, TRUST_PROXY: 'true' })).toThrow(/TRUST_PROXY/)
    expect(() => parseEnv({ ...VALID, TRUST_PROXY: '*' })).toThrow(/TRUST_PROXY/)
  })
})

describe('productionProblems (Phase 14)', () => {
  const PROD = {
    APP_ENV: 'production',
    DATABASE_URL: 'postgresql://da:Str0ng-Secret@postgres:5432/digital_archaeology',
    REDIS_URL: 'redis://:redis-secret@redis:6379',
    MFA_ENCRYPTION_KEY: Buffer.alloc(32, 7).toString('base64'),
    APP_ORIGIN: 'https://da.example.com',
    SIGNER_HMAC_SECRET: 's'.repeat(48),
    TRUST_PROXY: '172.30.0.0/24',
  }

  it('accepts a proper production configuration and ignores development', () => {
    expect(productionProblems(parseEnv(PROD), PROD)).toEqual([])
    expect(productionProblems(parseEnv(VALID), VALID)).toEqual([])
  })

  it('names every unsafe setting — without revealing values', () => {
    const raw = {
      ...PROD,
      DATABASE_URL: 'postgresql://da:da_dev_only@postgres:5432/digital_archaeology',
      REDIS_URL: 'redis://redis:6379',
      APP_ORIGIN: 'http://da.example.com',
      COOKIE_SECURE: 'false',
      SIGNER_HMAC_SECRET: '',
      TRUST_PROXY: '',
      VAULT_DATABASE_URL: 'postgresql://da_vault:x@postgres/da_vault',
    }
    const problems = productionProblems(parseEnv(raw), raw)
    expect(problems).toEqual([
      'DATABASE_URL uses a development password',
      'REDIS_URL must include a password',
      'APP_ORIGIN must be https',
      'COOKIE_SECURE must not be false',
      'SIGNER_HMAC_SECRET is required',
      'TRUST_PROXY is required (the reverse proxy subnet)',
      'VAULT_DATABASE_URL must not be in the backend environment',
    ])
    expect(problems.join(' ')).not.toMatch(/da_dev_only|da_vault:x/)
  })
})
