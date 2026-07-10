const { logServerError, sendHttpError, buildErrorPayload } = require('../utils/errorMessages')

describe('errorMessages helpers', () => {
  test('logServerError includes correlation id when present', () => {
    const spy = jest.spyOn(console, 'error').mockImplementation(() => {})
    logServerError('test.ctx', new Error('boom'), { correlationId: 'cid-1' })
    expect(spy).toHaveBeenCalledWith(expect.stringContaining('cid-1'))
    spy.mockRestore()
  })

  test('sendHttpError returns sanitized JSON body', () => {
    process.env.NODE_ENV = 'production'
    const json = jest.fn()
    const res = { status: jest.fn().mockReturnValue({ json }) }
    sendHttpError(res, 500, new Error('secret detail'), { context: 'x', req: {} })
    expect(res.status).toHaveBeenCalledWith(500)
    expect(json).toHaveBeenCalledWith({ error: 'Something went wrong' })
  })

  test('buildErrorPayload omits stack in production', () => {
    process.env.NODE_ENV = 'production'
    const payload = buildErrorPayload(new Error('x'), 500)
    expect(payload.stack).toBeUndefined()
  })
})
