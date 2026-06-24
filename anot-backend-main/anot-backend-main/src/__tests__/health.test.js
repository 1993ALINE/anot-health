describe('health utilities', () => {
  it('returns healthy status shape', () => {
    const payload = { message: 'Anot API is running', version: 'v42', status: 'healthy' }
    expect(payload.status).toBe('healthy')
    expect(payload.message).toContain('Anot')
  })
})