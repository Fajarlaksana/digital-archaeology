/**
 * Error codes from system_analysis section 9, plus generic HTTP-level codes.
 * The value is the HTTP status the API responds with.
 */
export const ERROR_HTTP_STATUS = {
  // Generic
  VALIDATION_ERROR: 400,
  UNAUTHORIZED: 401,
  FORBIDDEN: 403,
  NOT_FOUND: 404,
  CONFLICT: 409,
  RATE_LIMITED: 429,

  // Authentication (Phase 3)
  INVALID_CREDENTIALS: 401,
  MFA_INVALID: 401,
  MFA_REQUIRED: 403,
  MFA_SETUP_REQUIRED: 403,
  REAUTH_REQUIRED: 403,
  INTERNAL_ERROR: 500,
  DATABASE_UNAVAILABLE: 503,

  // Domain (SA section 9)
  RPC_TIMEOUT: 504,
  RPC_RATE_LIMIT: 503,
  INVALID_ADDRESS: 400,
  INVALID_NETWORK: 400,
  BALANCE_READ_FAILED: 502,
  ACTIVITY_READ_FAILED: 502,
  PRICE_UNAVAILABLE: 503,
  AUTHORIZATION_FAILED: 403,
  SIGNATURE_INVALID: 400,
  INSUFFICIENT_BALANCE: 422,
  FEE_ESTIMATION_FAILED: 502,
  TRANSACTION_FAILED: 502,
} as const

export type ErrorCode = keyof typeof ERROR_HTTP_STATUS

export class AppError extends Error {
  readonly code: ErrorCode
  readonly statusCode: number
  readonly resourceId: string | null

  constructor(
    code: ErrorCode,
    message: string,
    options: { resourceId?: string; cause?: unknown } = {},
  ) {
    super(message, { cause: options.cause })
    this.name = 'AppError'
    this.code = code
    this.statusCode = ERROR_HTTP_STATUS[code]
    this.resourceId = options.resourceId ?? null
  }
}

export interface ErrorBody {
  error: {
    code: ErrorCode
    message: string
    timestamp: string
    request_id: string
    resource_id: string | null
  }
}

export function toErrorBody(
  code: ErrorCode,
  message: string,
  requestId: string,
  resourceId: string | null = null,
): ErrorBody {
  return {
    error: {
      code,
      message,
      timestamp: new Date().toISOString(),
      request_id: requestId,
      resource_id: resourceId,
    },
  }
}
