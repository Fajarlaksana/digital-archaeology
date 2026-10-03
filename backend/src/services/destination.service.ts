import { randomBytes } from 'node:crypto'
import { AppError, buildDestinationChallengeMessage, type Logger } from '@da/shared'
import { chainAdapterFor } from '../chains'
import type { DestinationStatus } from '../generated/prisma/client'
import type { AuditLogRepository } from '../repositories/audit-log.repository'
import type {
  DestinationRepository,
  DestinationWithContext,
} from '../repositories/destination.repository'
import type { NetworkRepository } from '../repositories/network.repository'
import { recordAction } from './audit-trail'
import type { AuthContext, RequestMeta } from './auth.service'

type Person = { id: string; name: string } | null

export interface PublicDestination {
  id: string
  network: { id: string; name: string; displayName: string; isTestnet: boolean }
  address: string
  label: string
  status: DestinationStatus
  statusReason: string | null
  controlVerifiedAt: string | null
  controlVerifiedBy: Person
  createdBy: Person
  createdAt: string
  approvals: Array<{
    id: string
    requestedBy: Person
    decidedBy: Person
    decision: 'APPROVED' | 'REJECTED' | null
    reason: string | null
    decidedAt: string | null
    createdAt: string
  }>
  challenges: Array<{
    id: string
    method: string | null
    result: string
    issuedAt: string
    expiresAt: string
    usedAt: string | null
  }>
}

const iso = (d: Date | null) => d?.toISOString() ?? null

function toPublic(d: DestinationWithContext): PublicDestination {
  return {
    id: d.id,
    network: {
      id: d.network.id,
      name: d.network.name,
      displayName: d.network.displayName,
      isTestnet: d.network.isTestnet,
    },
    address: d.address,
    label: d.label,
    status: d.status,
    statusReason: d.statusReason,
    controlVerifiedAt: iso(d.controlVerifiedAt),
    controlVerifiedBy: d.controlVerifier,
    createdBy: d.createdBy,
    createdAt: d.createdAt.toISOString(),
    approvals: d.approvals.map((a) => ({
      id: a.id,
      requestedBy: a.requestedBy,
      decidedBy: a.decidedBy,
      decision: a.decision,
      reason: a.reason,
      decidedAt: iso(a.decidedAt),
      createdAt: a.createdAt.toISOString(),
    })),
    challenges: d.challenges.map((c) => ({
      id: c.id,
      method: c.method,
      result: c.result,
      issuedAt: c.issuedAt.toISOString(),
      expiresAt: c.expiresAt.toISOString(),
      usedAt: iso(c.usedAt),
    })),
  }
}

/**
 * Destination whitelist (Phase 8a, ADR-020). A destination becomes APPROVED only when
 *  1. its owner proved control by signing a single-use challenge, and
 *  2. a REVIEWER who neither requested, created nor proved it approves it (maker-checker).
 * Nothing here moves assets; recovery (Phase 9+) may only target APPROVED destinations.
 */
export function createDestinationService(deps: {
  destinations: DestinationRepository
  networks: NetworkRepository
  audit: AuditLogRepository
  logger: Logger
  challengeTtlMs: number
  now: () => Date
}) {
  const { destinations, audit, now } = deps

  async function getOrThrow(id: string): Promise<DestinationWithContext> {
    const destination = await destinations.findById(id)
    if (!destination) throw new AppError('NOT_FOUND', 'Destination not found', { resourceId: id })
    return destination
  }

  async function refreshed(id: string): Promise<PublicDestination> {
    return toPublic(await getOrThrow(id))
  }

  const record = (
    actor: AuthContext,
    meta: RequestMeta,
    action: string,
    destination: { id: string; address: string },
    metadata: Record<string, unknown> = {},
  ) =>
    recordAction(audit, actor, meta, {
      action,
      resourceType: 'destination',
      resourceId: destination.id,
      metadata: { address: destination.address, ...metadata },
    })

  /** Maker-checker: whoever requested, created or proved a destination cannot decide on it. */
  function assertIndependent(
    actor: AuthContext,
    destination: DestinationWithContext,
    requestedById: string,
  ) {
    const involved = [requestedById, destination.createdById, destination.controlVerifiedById]
    if (involved.includes(actor.user.id)) {
      throw new AppError(
        'SELF_APPROVAL',
        'You requested, created or verified this destination — another REVIEWER must decide',
        { resourceId: destination.id },
      )
    }
  }

  async function decisionContext(actor: AuthContext, id: string) {
    const destination = await getOrThrow(id)
    if (destination.status !== 'PENDING_APPROVAL') {
      throw new AppError('CONFLICT', 'This destination is not awaiting a decision', {
        resourceId: id,
      })
    }
    const approval = await destinations.openApproval(id)
    if (!approval) throw new AppError('CONFLICT', 'No open approval request', { resourceId: id })
    assertIndependent(actor, destination, approval.requestedById)
    return { destination, approval }
  }

  return {
    async list(filter: { networkId?: string; status?: DestinationStatus }) {
      return (await destinations.list(filter)).map(toPublic)
    },

    get: refreshed,

    async create(
      actor: AuthContext,
      input: { networkId: string; address: string; label: string },
      meta: RequestMeta,
    ): Promise<PublicDestination> {
      const network = await deps.networks.findById(input.networkId)
      if (!network) throw new AppError('INVALID_NETWORK', 'Network not found')
      if (network.status !== 'ACTIVE') {
        throw new AppError('INVALID_NETWORK', `Network "${network.name}" is disabled`)
      }
      const check = chainAdapterFor(network.chainType).checkAddress(input.address)
      if (!check.ok) throw new AppError('INVALID_ADDRESS', check.message)
      const existing = await destinations.findByNetworkAndAddress(network.id, check.address)
      if (existing) {
        throw new AppError('CONFLICT', 'This destination already exists on this network', {
          resourceId: existing.id,
        })
      }
      const created = await destinations.create({
        networkId: network.id,
        address: check.address,
        label: input.label,
        createdById: actor.user.id,
      })
      await record(
        actor,
        meta,
        'DESTINATION_CREATED',
        { id: created.id, address: check.address },
        {
          network: network.name,
          label: input.label,
        },
      )
      return refreshed(created.id)
    },

    async createChallenge(actor: AuthContext, id: string, meta: RequestMeta) {
      const destination = await getOrThrow(id)
      if (destination.status !== 'PENDING_APPROVAL') {
        throw new AppError('CONFLICT', 'Only destinations awaiting approval can be verified', {
          resourceId: id,
        })
      }
      const issuedAt = now()
      const expiresAt = new Date(issuedAt.getTime() + deps.challengeTtlMs)
      const nonce = randomBytes(32).toString('hex')
      const message = buildDestinationChallengeMessage({
        address: destination.address,
        networkName: destination.network.name,
        chainId: destination.network.chainId,
        destinationId: id,
        nonce,
        issuedAt,
        expiresAt,
      })
      const challenge = await destinations.createChallenge({
        destinationId: id,
        nonce,
        message,
        issuedAt,
        expiresAt,
        createdById: actor.user.id,
      })
      await record(actor, meta, 'DESTINATION_CHALLENGE_CREATED', destination, {
        challengeId: challenge.id,
      })
      return { id: challenge.id, address: destination.address, message, expiresAt: iso(expiresAt) }
    },

    async submitSignature(
      actor: AuthContext,
      challengeId: string,
      input: { signature: string; method: 'WALLET' | 'MANUAL' },
      meta: RequestMeta,
    ): Promise<{ result: 'VERIFIED'; destination: PublicDestination }> {
      const challenge = await destinations.findChallenge(challengeId)
      if (!challenge) {
        throw new AppError('NOT_FOUND', 'Challenge not found', { resourceId: challengeId })
      }
      const destination = challenge.destination
      const at = now()
      // Consume first: whatever happens next, this challenge can never be tried again.
      if (!(await destinations.consumeChallenge(challenge.id, at))) {
        throw new AppError('CONFLICT', 'This challenge was already used — create a new one', {
          resourceId: challenge.id,
        })
      }
      const audit_ = (action: string) =>
        record(actor, meta, action, destination, {
          challengeId: challenge.id,
          method: input.method,
        })

      if (challenge.expiresAt <= at) {
        await destinations.setChallengeResult(challenge.id, {
          result: 'EXPIRED',
          method: input.method,
          signature: null,
        })
        await audit_('DESTINATION_CHALLENGE_EXPIRED')
        throw new AppError('CONFLICT', 'The challenge has expired — create a new one')
      }
      const signature = input.signature.trim()
      const valid = await chainAdapterFor(destination.network.chainType).verifyMessage({
        address: destination.address,
        message: challenge.message,
        signature,
      })
      await destinations.setChallengeResult(challenge.id, {
        result: valid ? 'VERIFIED' : 'REJECTED',
        method: input.method,
        signature: valid ? signature : null,
      })
      if (!valid) {
        await audit_('DESTINATION_CONTROL_REJECTED')
        throw new AppError(
          'SIGNATURE_INVALID',
          'The signature was not made by this address for this challenge',
        )
      }
      if (!(await destinations.markControlVerified(destination.id, actor.user.id, at))) {
        throw new AppError('CONFLICT', 'This destination is no longer awaiting approval')
      }
      await audit_('DESTINATION_CONTROL_VERIFIED')
      return { result: 'VERIFIED', destination: await refreshed(destination.id) }
    },

    async approve(
      actor: AuthContext,
      id: string,
      input: { note: string | null },
      meta: RequestMeta,
    ) {
      const { destination, approval } = await decisionContext(actor, id)
      if (!destination.controlVerifiedAt) {
        throw new AppError(
          'CONFLICT',
          'Control of this address has not been proven yet (signed challenge required)',
          { resourceId: id },
        )
      }
      const decided = await destinations.decide({
        destinationId: id,
        approvalId: approval.id,
        decision: 'APPROVED',
        decidedById: actor.user.id,
        reason: input.note,
        at: now(),
      })
      if (!decided) throw new AppError('CONFLICT', 'This destination was decided concurrently')
      await record(actor, meta, 'DESTINATION_APPROVED', destination, { approvalId: approval.id })
      deps.logger.info({ destinationId: id }, 'DESTINATION_APPROVED')
      return refreshed(id)
    },

    async reject(actor: AuthContext, id: string, input: { reason: string }, meta: RequestMeta) {
      const { destination, approval } = await decisionContext(actor, id)
      const decided = await destinations.decide({
        destinationId: id,
        approvalId: approval.id,
        decision: 'REJECTED',
        decidedById: actor.user.id,
        reason: input.reason,
        at: now(),
      })
      if (!decided) throw new AppError('CONFLICT', 'This destination was decided concurrently')
      await record(actor, meta, 'DESTINATION_REJECTED', destination, {
        approvalId: approval.id,
        reason: input.reason,
      })
      return refreshed(id)
    },

    /** Takes an approved destination out of use immediately (e.g. wallet compromised). */
    async disable(actor: AuthContext, id: string, input: { reason: string }, meta: RequestMeta) {
      const destination = await getOrThrow(id)
      if (!(await destinations.disable(id, input.reason))) {
        throw new AppError('CONFLICT', 'Only approved destinations can be disabled', {
          resourceId: id,
        })
      }
      await record(actor, meta, 'DESTINATION_DISABLED', destination, { reason: input.reason })
      return refreshed(id)
    },

    /** A rejected/disabled destination goes through proof + approval again from scratch. */
    async resubmit(actor: AuthContext, id: string, meta: RequestMeta) {
      const destination = await getOrThrow(id)
      if (!(await destinations.resubmit(id, actor.user.id))) {
        throw new AppError(
          'CONFLICT',
          'Only rejected or disabled destinations can be resubmitted',
          {
            resourceId: id,
          },
        )
      }
      await record(actor, meta, 'DESTINATION_RESUBMITTED', destination)
      return refreshed(id)
    },
  }
}

export type DestinationService = ReturnType<typeof createDestinationService>
