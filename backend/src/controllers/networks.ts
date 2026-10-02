import type { FastifyInstance } from 'fastify'
import { z } from 'zod'
import { ChainType, NetworkStatus } from '../generated/prisma/enums'
import { requestMeta, type Guards } from '../auth/plugin'
import type { AuthContext } from '../services/auth.service'
import type { NetworkService } from '../services/network.service'

const symbol = z
  .string()
  .trim()
  .regex(/^[A-Za-z0-9.]{1,16}$/, 'letters, digits or dots, max 16')
const assetName = z.string().trim().min(1).max(60)
const decimals = z.number().int().min(0).max(36)
const envVarName = z
  .string()
  .trim()
  .regex(/^[A-Z][A-Z0-9_]{0,63}$/, 'must be an UPPER_SNAKE_CASE env var name (never the URL)')
const explorerUrl = z.url({ protocol: /^https$/ }).max(200)

const createBody = z.object({
  name: z
    .string()
    .trim()
    .regex(/^[a-z0-9][a-z0-9-]{1,39}$/, 'lowercase letters, digits and dashes, 2–40 chars'),
  displayName: z.string().trim().min(1).max(80),
  chainType: z.enum(ChainType),
  chainId: z.number().int().positive().nullable(),
  isTestnet: z.boolean(),
  rpcUrlEnv: envVarName.nullable(),
  explorerUrl: explorerUrl.nullable(),
  nativeAsset: z.object({ symbol, name: assetName, decimals }),
})

const updateBody = z
  .object({
    displayName: z.string().trim().min(1).max(80).optional(),
    rpcUrlEnv: envVarName.nullable().optional(),
    explorerUrl: explorerUrl.nullable().optional(),
    status: z.enum(NetworkStatus).optional(),
  })
  .refine((body) => Object.keys(body).length > 0, 'Nothing to update')

const tokenBody = z.object({
  contractAddress: z.string().trim().max(100),
  symbol,
  name: assetName,
  decimals,
})

const idParams = z.object({ id: z.uuid() })

export function registerNetworkRoutes(
  app: FastifyInstance,
  deps: { networks: NetworkService; guards: Guards },
): void {
  const { networks, guards } = deps

  app.get('/api/networks', { preHandler: guards.permission('networks:read') }, async () => ({
    networks: await networks.list(),
  }))

  app.post(
    '/api/networks',
    { preHandler: guards.permission('networks:manage') },
    async (request, reply) => {
      const body = createBody.parse(request.body)
      const network = await networks.create(request.auth as AuthContext, body, requestMeta(request))
      return reply.status(201).send({ network })
    },
  )

  app.patch(
    '/api/networks/:id',
    { preHandler: guards.permission('networks:manage') },
    async (request) => {
      const { id } = idParams.parse(request.params)
      const body = updateBody.parse(request.body)
      return {
        network: await networks.update(request.auth as AuthContext, id, body, requestMeta(request)),
      }
    },
  )

  app.post(
    '/api/networks/:id/assets',
    { preHandler: guards.permission('networks:manage') },
    async (request, reply) => {
      const { id } = idParams.parse(request.params)
      const body = tokenBody.parse(request.body)
      const asset = await networks.addToken(
        request.auth as AuthContext,
        id,
        body,
        requestMeta(request),
      )
      return reply.status(201).send({ asset })
    },
  )
}
