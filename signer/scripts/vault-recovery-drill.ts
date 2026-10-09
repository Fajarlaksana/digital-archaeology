/**
 * Vault recovery drill (Phase 14, ADR-028) — on a RESTORED COPY of da_vault, on a clean machine.
 *
 *   VAULT_DATABASE_URL=postgresql://…/da_vault_restore_check \
 *     pnpm --filter signer vault:drill --restored-copy
 *
 * Asks for the offline recovery passphrase (no echo), recovers + unlocks the copy, checks that
 * every key decrypts to its address and signs a dummy Sepolia transaction (never broadcast).
 * The copy's main passphrase is replaced by a random one that is thrown away.
 */
import { createInterface } from 'node:readline'
import { parseArgs } from 'node:util'
import { createLogger } from '@da/shared'
import { loadEnvFile } from '../src/config/env'
import { runRecoveryDrill } from '../src/vault/recovery-drill'
import { createVaultDatabase, createVaultRepository } from '../src/vault/vault.repository'

const logger = createLogger({ name: 'vault-drill' })
function fail(message: string): never {
  logger.error(message)
  process.exit(1)
}

function readHidden(prompt: string): Promise<string> {
  return new Promise((resolve) => {
    const stdin = process.stdin
    process.stderr.write(prompt)
    if (!stdin.isTTY) {
      const rl = createInterface({ input: stdin })
      rl.once('line', (line) => {
        rl.close()
        process.stderr.write('\n')
        resolve(line)
      })
      return
    }
    let value = ''
    stdin.setRawMode(true)
    stdin.resume()
    stdin.setEncoding('utf8')
    const onData = (key: string) => {
      for (const char of key) {
        if (char === '\u0003') process.exit(130)
        if (char === '\r' || char === '\n') {
          stdin.setRawMode(false)
          stdin.pause()
          stdin.off('data', onData)
          process.stderr.write('\n')
          resolve(value)
          return
        }
        value = char === '\u007f' || char === '\b' ? value.slice(0, -1) : value + char
      }
    }
    stdin.on('data', onData)
  })
}

const { values } = parseArgs({ options: { 'restored-copy': { type: 'boolean' } } })
if (!values['restored-copy']) {
  fail('Refusing to run: pass --restored-copy (this drill modifies the database it runs on).')
}
loadEnvFile()
const url = process.env.VAULT_DATABASE_URL ?? fail('VAULT_DATABASE_URL is not set')
// The live vault database is called da_vault: never drill on it.
if (new URL(url).pathname.replace(/^\//, '') === 'da_vault') {
  fail('VAULT_DATABASE_URL points at "da_vault" — restore the backup into another database first.')
}

const recoveryPassphrase = await readHidden('Recovery passphrase: ')
const db = createVaultDatabase(url)
try {
  const result = await runRecoveryDrill({
    db,
    repo: createVaultRepository(db),
    logger,
    recoveryPassphrase,
  })
  if (result.keysChecked === 0) fail('The restored vault holds no keys')
  if (result.mismatches.length > 0 || !result.signedTestTransaction) {
    fail(`DRILL FAILED: ${result.mismatches.length} key(s) do not match their address`)
  }
  logger.info(
    { keysChecked: result.keysChecked },
    'DRILL PASSED: backup + recovery passphrase restore every key',
  )
} catch (error) {
  fail(`DRILL FAILED: ${error instanceof Error ? error.message : 'unknown error'}`)
} finally {
  await db.$disconnect()
}
