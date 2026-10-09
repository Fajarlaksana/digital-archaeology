import type { Logger } from '@da/shared'

/**
 * Out-of-band alerts for security-relevant events (Phase 13b, ADR-027).
 * A notification is a short, plain-text summary — never secrets, never raw transactions.
 */
export interface Notifier {
  send(text: string): Promise<void>
}

const TELEGRAM_TIMEOUT_MS = 5_000
const MAX_TEXT = 3_500 // Telegram's limit is 4096 characters

/**
 * Telegram Bot API (sendMessage). The bot token is part of the URL, so neither the URL nor any
 * fetch error message is ever logged — only the HTTP status or a generic failure code.
 */
export function createTelegramNotifier(options: {
  botToken: string
  chatId: string
  logger: Logger
  fetch?: typeof fetch
}): Notifier {
  const doFetch = options.fetch ?? fetch
  const url = `https://api.telegram.org/bot${options.botToken}/sendMessage`
  return {
    async send(text) {
      try {
        const res = await doFetch(url, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          // Plain text on purpose (no parse_mode): user-controlled values cannot inject markup.
          body: JSON.stringify({
            chat_id: options.chatId,
            text: text.slice(0, MAX_TEXT),
            disable_web_page_preview: true,
          }),
          signal: AbortSignal.timeout(TELEGRAM_TIMEOUT_MS),
        })
        if (!res.ok) options.logger.warn({ status: res.status }, 'NOTIFICATION_FAILED')
      } catch {
        options.logger.warn({ code: 'NETWORK' }, 'NOTIFICATION_FAILED')
      }
    },
  }
}
