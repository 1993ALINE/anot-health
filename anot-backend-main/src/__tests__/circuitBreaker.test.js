const { createCircuitBreaker } = require('../utils/circuitBreaker')

describe('circuit breaker', () => {
  test('opens after repeated failures and fails fast', async () => {
    const breaker = createCircuitBreaker('test', { failureThreshold: 2, resetMs: 60000, windowMs: 60000 })

    await expect(breaker.exec(async () => { throw new Error('503') })).rejects.toThrow('503')
    await expect(breaker.exec(async () => { throw new Error('503') })).rejects.toThrow('503')
    expect(breaker.status().state).toBe('open')

    await expect(breaker.exec(async () => 'ok')).rejects.toMatchObject({ code: 'CIRCUIT_OPEN' })
  })

  test('closes after successful probe in half-open state', async () => {
    const breaker = createCircuitBreaker('test2', { failureThreshold: 1, resetMs: 1, windowMs: 60000 })
    await expect(breaker.exec(async () => { throw new Error('fail') })).rejects.toThrow('fail')
    expect(breaker.status().state).toBe('open')

    await new Promise((r) => setTimeout(r, 5))
    const value = await breaker.exec(async () => 'recovered')
    expect(value).toBe('recovered')
    expect(breaker.status().state).toBe('closed')
  })
})
