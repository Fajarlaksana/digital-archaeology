import type { FastifyInstance } from 'fastify'
import { z } from 'zod'
import { TransactionStatus } from '../generated/prisma/enums'
import { requestMeta, type Guards } from '../auth/plugin'
import type { AuthContext } from '../services/auth.service'
import type { TransactionService } from '../services/transaction.service'

/** Approving decides that assets may move: re-confirm identity first (like destinations). */
export const TRANSACTION_REAUTH_WINDOW_MS = 5 * 60_000

const idParams = z.object({ id: z.uuid() })
const listQuery = z.object({
  status: z.enum(TransactionStatus).optional(),
  addressId: z.uuid().optional(),
})
const previewBody = z.object({
  addressId: z.uuid(),
  assetId: z.uuid(),
  destinationId: z.uuid(),
  /** Decimal amount in whole units for a test transfer; null = sweep. */
  amount: z
    .string()
    .trim()
    .regex(/^\d+(\.\d+)?$/, 'must be a decimal amount, e.g. 0.001')
    .nullable()
    .default(null),
})
const reasonBody = z.object({ reason: z.string().trim().min(3).max(500) })

export function registerTransactionRoutes(
  app: FastifyInstance,
  deps: { transactions: TransactionService; guards: Guards },
): void {
  const { transactions, guards } = deps
  const read = { preHandler: guards.permission('transactions:read') }
  const create = {
    config: { skipGenericAudit: true },
    preHandler: guards.permission('transactions:create'),
  }
  const decide = {
    config: { skipGenericAudit: true },
    preHandler: [
      guards.permission('transactions:approve'),
      guards.recentAuth(TRANSACTION_REAUTH_WINDOW_MS),
    ],
  }
  const ctx = (request: { auth: AuthContext | null }) => request.auth as AuthContext
  const id = (request: { params: unknown }) => idParams.parse(request.params).id

  app.get('/api/transactions', read, async (request) => ({
    transactions: await transactions.list(listQuery.parse(request.query)),
  }))
  app.get('/api/transactions/:id', read, async (request) => ({
    transaction: await transactions.get(id(request)),
  }))

  app.post('/api/transactions/preview', create, async (request, reply) => {
    const transaction = await transactions.preview(
      ctx(request),
      previewBody.parse(request.body),
      requestMeta(request),
    )
    return reply.status(201).send({ transaction })
  })
  app.post('/api/transactions/:id/cancel', create, async (request) => ({
    transaction: await transactions.cancel(
      ctx(request),
      id(request),
      reasonBody.parse(request.body),
      requestMeta(request),
    ),
  }))

  app.post('/api/transactions/:id/approve', decide, async (request) => ({
    transaction: await transactions.approve(
      ctx(request),
      id(request),
      reasonBody.parse(request.body),
      requestMeta(request),
    ),
  }))
  // SUPER_ADMIN only; only the id is accepted — never a payload (ADR-023).
  app.post(
    '/api/transactions/:id/sign',
    {
      config: { skipGenericAudit: true },
      preHandler: [
        guards.permission('transactions:sign'),
        guards.recentAuth(TRANSACTION_REAUTH_WINDOW_MS),
      ],
    },
    async (request) => ({
      transaction: await transactions.sign(ctx(request), id(request), requestMeta(request)),
    }),
  )

  app.post('/api/transactions/:id/reject', decide, async (request) => ({
    transaction: await transactions.reject(
      ctx(request),
      id(request),
      reasonBody.parse(request.body),
      requestMeta(request),
    ),
  }))
}
