import { describe, expect, it } from 'vitest'
import { parseEnv, productionProblems } from '../../src/config/env'

const PROD = {
  APP_ENV: 'production',
  VAULT_DATABASE_URL: 'postgresql://da_vault:V4ult-Secret@postgres:5432/da_vault',
  SIGNER_HMAC_SECRET: 's'.repeat(48),
  APP_DATABASE_URL_READONLY:
    'postgresql://da_signer_ro:R0-Secret@postgres:5432/digital_archaeology',
}

describe('signer productionProblems (Phase 14)', () => {
  it('accepts a proper production configuration', () => {
    expect(productionProblems(parseEnv(PROD), PROD)).toEqual([])
  })

  it('refuses dev passwords, a non-read-only app login and backend secrets in its env', () => {
    const raw = {
      ...PROD,
      VAULT_DATABASE_URL: 'postgresql://da_vault:vault_dev_only@postgres:5432/da_vault',
      APP_DATABASE_URL_READONLY: 'postgresql://da:owner@postgres:5432/digital_archaeology',
      SIGNER_HOST: '0.0.0.0',
      SIGNER_ALLOW_NON_LOOPBACK: 'true',
      DATABASE_URL: 'postgresql://da:owner@postgres/digital_archaeology',
      MFA_ENCRYPTION_KEY: 'x',
    }
    const problems = productionProblems(parseEnv(raw), raw)
    expect(problems).toEqual([
      'VAULT_DATABASE_URL uses a development password',
      'SIGNER_ALLOW_NON_LOOPBACK must not be used (share the backend network namespace instead)',
      'APP_DATABASE_URL_READONLY must use the read-only login da_signer_ro',
      'DATABASE_URL must not be in the signer environment',
      'MFA_ENCRYPTION_KEY must not be in the signer environment',
    ])
    expect(problems.join(' ')).not.toMatch(/vault_dev_only|owner/)
  })

  it('requires the read-only login in production', () => {
    const { APP_DATABASE_URL_READONLY: _omit, ...raw } = PROD
    expect(productionProblems(parseEnv(raw), raw)).toContain(
      'APP_DATABASE_URL_READONLY is required (transaction signing)',
    )
  })
})
