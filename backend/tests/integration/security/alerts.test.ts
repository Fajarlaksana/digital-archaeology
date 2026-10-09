import { Writable } from 'node:stream'
import { afterAll, afterEach, beforeAll, describe, expect, inject, it, vi } from 'vitest'
import { createLogger } from '@da/shared'
import { createTelegramNotifier, type Notifier } from '../../../src/lib/notifier'
import { createPrismaClient, type Database } from '../../../src/lib/prisma'
import { alertText } from '../../../src/services/alerts'
import { createHarness, type Harness } from '../auth/harness'

const testDatabaseUrl = inject('testDatabaseUrl')
const BOT_TOKEN = '123456789:AAHdqTcvCH1vGWJxfSeofSAs0K5PALDsaw0'
const PASSPHRASE = 'marble orbit cactus lantern'

describe('alert messages', () => {
  const ctx = {
    actor: 'root@dev.local',
    environment: 'test/testnet',
    at: new Date('2026-10-09T01:00:00Z'),
  }

  it('only listed actions alert; only whitelisted fields are included', () => {
    expect(alertText({ action: 'ADDRESS_CREATED', result: 'SUCCESS' }, ctx)).toBeNull()
    const text = alertText(
      {
        action: 'TX_SIGNED',
        result: 'SUCCESS',
        resourceType: 'transaction',
        resourceId: 'tx-1',
        metadata: {
          txHash: '0xabc',
          unsignedHash: '0xdef',
          privateKey: '0xsecret',
          nested: { a: 1 },
        },
      },
      ctx,
    )!
    expect(text).toContain('[Digital Archaeology · test/testnet] Transaksi ditandatangani')
    expect(text).toContain('Oleh: root@dev.local')
    expect(text).toContain('Resource: transaction tx-1')
    expect(text).toContain('txHash: 0xabc')
    expect(text).not.toMatch(/0xsecret|unsignedHash|nested/)
  })

  it('free-text reasons (personal data) never leave; reason codes do', () => {
    const reset = alertText(
      {
        action: 'MFA_RESET',
        result: 'SUCCESS',
        metadata: { reason: 'KTP 3171234567890001 dicocokkan via video call' },
      },
      ctx,
    )!
    expect(reset).toContain('MFA user direset')
    expect(reset).not.toContain('3171234567890001')
    expect(
      alertText({ action: 'TX_FAILED', result: 'SUCCESS', metadata: { reason: 'REVERTED' } }, ctx),
    ).toContain('reason: REVERTED')
  })

  it('the audit chain alerts only when it is broken', () => {
    expect(
      alertText({ action: 'AUDIT_CHAIN_VERIFIED', result: 'SUCCESS', metadata: { ok: true } }, ctx),
    ).toBeNull()
    expect(
      alertText(
        {
          action: 'AUDIT_CHAIN_VERIFIED',
          result: 'SUCCESS',
          metadata: { ok: false, firstBrokenSequence: '57' },
        },
        ctx,
      ),
    ).toContain('RANTAI AUDIT RUSAK')
  })
})

describe('Telegram notifier', () => {
  function logger() {
    const lines: string[] = []
    const log = createLogger({
      name: 'notify-test',
      level: 'trace',
      destination: new Writable({
        write(chunk: Buffer, _e, cb) {
          lines.push(chunk.toString())
          cb()
        },
      }),
    })
    return { log, lines }
  }

  it('posts plain text to sendMessage', async () => {
    const fetchMock = vi.fn(async () => new Response('{"ok":true}', { status: 200 }))
    const { log } = logger()
    await createTelegramNotifier({
      botToken: BOT_TOKEN,
      chatId: '-1001234567890',
      logger: log,
      fetch: fetchMock,
    }).send('hello')
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit]
    expect(url).toBe(`https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`)
    expect(JSON.parse(String(init.body))).toEqual({
      chat_id: '-1001234567890',
      text: 'hello',
      disable_web_page_preview: true,
    })
  })

  it('never throws and never logs the bot token', async () => {
    for (const fetchMock of [
      vi.fn(async () => new Response('unauthorized', { status: 401 })),
      vi.fn(async () => {
        throw new Error(`connect failed https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`)
      }),
    ]) {
      const { log, lines } = logger()
      await expect(
        createTelegramNotifier({
          botToken: BOT_TOKEN,
          chatId: '-100123',
          logger: log,
          fetch: fetchMock,
        }).send('x'),
      ).resolves.toBeUndefined()
      expect(lines.join('')).toContain('NOTIFICATION_FAILED')
      expect(lines.join('')).not.toContain(BOT_TOKEN.split(':')[1]!)
    }
  })
})

describe.skipIf(!testDatabaseUrl)('alerts from audited actions', () => {
  let db: Database
  let h: Harness

  beforeAll(() => {
    db = createPrismaClient(testDatabaseUrl!)
  })
  afterAll(async () => {
    await db?.$disconnect()
  })
  afterEach(async () => {
    await h?.app.close()
  })

  const until = async (check: () => boolean) => {
    for (let i = 0; i < 50 && !check(); i++) await new Promise((r) => setTimeout(r, 20))
  }

  it('vault unlock, a failed unlock and MFA reset alert; routine actions do not; no secrets', async () => {
    const sent: string[] = []
    h = await createHarness(db, { notifier: { send: async (text) => void sent.push(text) } })
    const superAdmin = await h.createUser(['SUPER_ADMIN'], { mfa: true })
    const token = await h.activeSession(superAdmin)
    await h.call('POST', '/api/vault/init', token, {
      passphrase: PASSPHRASE,
      recoveryPassphrase: 'violet harbor tundra pencil quartz',
    })
    await h.call('POST', '/api/vault/unlock', token, { passphrase: `${PASSPHRASE} wrong` })
    await h.call('POST', '/api/vault/unlock', token, { passphrase: PASSPHRASE })
    const admin = await h.createUser(['ADMIN'], { mfa: true })
    const adminToken = await h.activeSession(admin)
    const reviewer = await h.createUser(['REVIEWER'], { mfa: true })
    await h.call('POST', `/api/users/${reviewer.id}/mfa/reset`, adminToken, {
      reason: 'Identity verified by video call',
    })

    await until(() => sent.length >= 3)
    expect(
      sent.some((t) => t.includes('Percobaan buka vault GAGAL') && t.includes(superAdmin.email)),
    ).toBe(true)
    expect(sent.some((t) => t.includes('Vault dibuka') && t.includes(superAdmin.email))).toBe(true)
    expect(sent.some((t) => t.includes('MFA user direset') && t.includes(admin.email))).toBe(true)
    expect(sent.some((t) => t.includes('VAULT_INITIALIZED'))).toBe(false) // not on the list
    expect(sent.join('\n')).not.toContain(PASSPHRASE)
  })

  it('a failing notifier never breaks the action', async () => {
    const broken: Notifier = { send: async () => Promise.reject(new Error('telegram down')) }
    h = await createHarness(db, { notifier: broken })
    const superAdmin = await h.createUser(['SUPER_ADMIN'], { mfa: true })
    const token = await h.activeSession(superAdmin)
    await h.call('POST', '/api/vault/init', token, {
      passphrase: PASSPHRASE,
      recoveryPassphrase: 'violet harbor tundra pencil quartz',
    })
    expect(
      (await h.call('POST', '/api/vault/unlock', token, { passphrase: PASSPHRASE })).statusCode,
    ).toBe(200)
  })
})
