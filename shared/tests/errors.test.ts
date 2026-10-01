import { describe, expect, it } from 'vitest'
import { AppError, toErrorBody } from '../src/errors'

describe('AppError', () => {
  it('maps the code to its HTTP status', () => {
    const error = new AppError('INVALID_ADDRESS', 'Address is not valid', { resourceId: 'addr-1' })
    expect(error.statusCode).toBe(400)
    expect(error.resourceId).toBe('addr-1')
    expect(error).toBeInstanceOf(Error)
  })

  it('defaults resourceId to null', () => {
    expect(new AppError('RPC_TIMEOUT', 'timeout').resourceId).toBeNull()
  })
})

describe('toErrorBody', () => {
  it('produces the standard error shape', () => {
    const body = toErrorBody('NOT_FOUND', 'Route not found', 'req-123')
    expect(body.error).toMatchObject({
      code: 'NOT_FOUND',
      message: 'Route not found',
      request_id: 'req-123',
      resource_id: null,
    })
    expect(new Date(body.error.timestamp).toString()).not.toBe('Invalid Date')
  })
})
