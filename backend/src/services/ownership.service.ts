import { randomBytes } from 'node:crypto'
import { AppError, buildChallengeMessage, type Logger } from '@da/shared'
import { chainAdapterFor } from '../chains'
import type { AuthorizationStatus, AuthorizationType } from '../generated/prisma/client'
import type { AuditLogRepository } from '../repositories/audit-log.repository'
import type {
  AuthorizationRepository,
  AuthorizationWithAddress,
  ChallengeWithContext,
} from '../repositories/authorization.repository'
import type { SignerClient } from '../signer/client'
import { recordAction } from './audit-trail'
import type { AuthContext, RequestMeta } from './auth.service'

const SIGNATURE = /^0x[0-9a-fA-F]{130}$/

export interface PublicAuthorization {
  id: string
  address: { id: string; address: string; label: string | null; network: string }
  type: AuthorizationType
  reference: string
  documentName: string | null
  documentSha256: string | null
  /** Effective status: EXPIRED once `expiresAt` has passed. */
  status: AuthorizationStatus
  verifiedAt: string | null
  expiresAt: string | null
  createdAt: string
  challenges: Array<{
    id: string
    method: string | null
    result: string
    issuedAt: string
    expiresAt: string
    usedAt: string | null
  }>
}

/**
 * Proof of control over an address (SA 4.5, Phase 7c): an authorization record (legal basis +
 * optional document fingerprint) and a single-use signed challenge. The signature proves who
 * holds the key; it does not replace the legal basis, which is the authorization itself.
 */
export function createOwnershipService(deps: {
  authorizations: AuthorizationRepository
  signer: SignerClient
  audit: AuditLogRepository
  logger: Logger
  challengeTtlMs: number
  now: () => Date
}) {
  const { authorizations, signer, audit, now } = deps

  function toPublic(a: AuthorizationWithAddress): PublicAuthorization {
    const expired = a.expiresAt !== null && a.expiresAt <= now()
    return {
      id: a.id,
      address: {
        id: a.address.id,
        address: a.address.address,
        label: a.address.label,
        network: a.address.network.displayName,
      },
      type: a.type,
      reference: a.reference,
      documentName: a.documentName,
      documentSha256: a.documentSha256,
      status: expired ? 'EXPIRED' : a.verificationStatus,
      verifiedAt: a.verifiedAt?.toISOString() ?? null,
      expiresAt: a.expiresAt?.toISOString() ?? null,
      createdAt: a.createdAt.toISOString(),
      challenges: a.challenges.map((c) => ({
        id: c.id,
        method: c.method,
        result: c.result,
        issuedAt: c.issuedAt.toISOString(),
        expiresAt: c.expiresAt.toISOString(),
        usedAt: c.usedAt?.toISOString() ?? null,
      })),
    }
  }

  async function loadChallenge(id: string): Promise<ChallengeWithContext> {
    const challenge = await authorizations.findChallenge(id)
    if (!challenge) throw new AppError('NOT_FOUND', 'Challenge not found', { resourceId: id })
    return challenge
  }

  /** Single evaluation path for wallet, manual and vault signatures. */
  async function evaluate(
    actor: AuthContext,
    challenge: ChallengeWithContext,
    signature: string,
    method: 'VAULT' | 'WALLET' | 'MANUAL',
    meta: RequestMeta,
  ) {
    const at = now()
    // Consume first: whatever happens next, this challenge can never be tried again.
    if (!(await authorizations.consume(challenge.id, at))) {
      throw new AppError('CONFLICT', 'This challenge was already used — create a new one', {
        resourceId: challenge.id,
      })
    }
    const base = { resourceType: 'authorization', resourceId: challenge.authorizationId! }
    const audit_ = (action: string, metadata: Record<string, unknown>) =>
      recordAction(audit, actor, meta, {
        ...base,
        action,
        metadata: {
          address: challenge.address.address,
          method,
          challengeId: challenge.id,
          ...metadata,
        },
      })

    const authorizationExpiry = challenge.authorization?.expiresAt ?? null
    if (challenge.expiresAt <= at || (authorizationExpiry !== null && authorizationExpiry <= at)) {
      await authorizations.setResult(challenge.id, { result: 'EXPIRED', method, signature: null })
      await audit_('OWNERSHIP_CHALLENGE_EXPIRED', {})
      throw new AppError('CONFLICT', 'The challenge has expired — create a new one', {
        resourceId: challenge.id,
      })
    }

    const valid = await chainAdapterFor(challenge.address.network.chainType).verifyMessage({
      address: challenge.address.address,
      message: challenge.message,
      signature,
    })
    await authorizations.setResult(challenge.id, {
      result: valid ? 'VERIFIED' : 'REJECTED',
      method,
      signature: SIGNATURE.test(signature) ? signature : null,
    })
    if (!valid) {
      await audit_('OWNERSHIP_REJECTED', {})
      throw new AppError(
        'SIGNATURE_INVALID',
        'The signature was not made by this address for this challenge',
      )
    }
    await authorizations.markVerified(challenge.authorizationId!, challenge.addressId, at)
    await audit_('OWNERSHIP_VERIFIED', {})
    deps.logger.info({ addressId: challenge.addressId, method }, 'OWNERSHIP_VERIFIED')
    const updated = await authorizations.findById(challenge.authorizationId!)
    return { result: 'VERIFIED' as const, authorization: toPublic(updated!) }
  }

  return {
    async listForAddress(addressId: string) {
      return (await authorizations.listForAddress(addressId)).map(toPublic)
    },

    async listRecent(status?: AuthorizationStatus) {
      return (await authorizations.listRecent(status, 200)).map(toPublic)
    },

    async createAuthorization(
      actor: AuthContext,
      address: { id: string; archivedAt: Date | null },
      input: {
        type: AuthorizationType
        reference: string
        documentSha256: string | null
        documentName: string | null
        expiresAt: Date | null
      },
      meta: RequestMeta,
    ): Promise<PublicAuthorization> {
      if (address.archivedAt)
        throw new AppError('CONFLICT', 'Restore the address before adding an authorization')
      if (input.expiresAt && input.expiresAt <= now()) {
        throw new AppError('VALIDATION_ERROR', 'expiresAt must be in the future')
      }
      const created = await authorizations.create({
        ...input,
        addressId: address.id,
        createdById: actor.user.id,
      })
      await authorizations.markAddressPending(address.id)
      await recordAction(audit, actor, meta, {
        action: 'AUTHORIZATION_CREATED',
        resourceType: 'authorization',
        resourceId: created.id,
        metadata: {
          addressId: address.id,
          type: input.type,
          reference: input.reference,
          documentSha256: input.documentSha256,
        },
      })
      return toPublic(created)
    },

    async createChallenge(actor: AuthContext, authorizationId: string, meta: RequestMeta) {
      const authorization = await authorizations.findById(authorizationId)
      if (!authorization)
        throw new AppError('NOT_FOUND', 'Authorization not found', { resourceId: authorizationId })
      if (authorization.address.archivedAt)
        throw new AppError('CONFLICT', 'The address is archived')
      if (authorization.expiresAt && authorization.expiresAt <= now()) {
        throw new AppError('CONFLICT', 'This authorization has expired')
      }
      const issuedAt = now()
      const expiresAt = new Date(issuedAt.getTime() + deps.challengeTtlMs)
      const nonce = randomBytes(32).toString('hex')
      const message = buildChallengeMessage({
        address: authorization.address.address,
        networkName: authorization.address.network.name,
        chainId: authorization.address.network.chainId,
        authorizationId,
        nonce,
        issuedAt,
        expiresAt,
      })
      const challenge = await authorizations.createChallenge({
        addressId: authorization.addressId,
        authorizationId,
        nonce,
        message,
        issuedAt,
        expiresAt,
        createdById: actor.user.id,
      })
      await recordAction(audit, actor, meta, {
        action: 'OWNERSHIP_CHALLENGE_CREATED',
        resourceType: 'authorization',
        resourceId: authorizationId,
        metadata: { challengeId: challenge.id, address: authorization.address.address },
      })
      return {
        id: challenge.id,
        address: authorization.address.address,
        message,
        expiresAt: expiresAt.toISOString(),
      }
    },

    async submitSignature(
      actor: AuthContext,
      challengeId: string,
      input: { signature: string; method: 'WALLET' | 'MANUAL' },
      meta: RequestMeta,
    ) {
      return evaluate(
        actor,
        await loadChallenge(challengeId),
        input.signature.trim(),
        input.method,
        meta,
      )
    },

    /** SUPER_ADMIN path: the signer signs the challenge with the stored key (vault must be unlocked). */
    async signWithVault(actor: AuthContext, challengeId: string, meta: RequestMeta) {
      const challenge = await loadChallenge(challengeId)
      if (challenge.usedAt)
        throw new AppError('CONFLICT', 'This challenge was already used — create a new one')
      const { signature } = await signer.signChallenge({
        actor: actor.user.id,
        address: challenge.address.address,
        message: challenge.message,
      })
      return evaluate(actor, challenge, signature, 'VAULT', meta)
    },
  }
}

export type OwnershipService = ReturnType<typeof createOwnershipService>
