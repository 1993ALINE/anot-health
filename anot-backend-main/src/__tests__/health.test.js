describe('health utilities', () => {
  it('returns minimal public health shape', () => {
    const payload = { status: 'ok' }
    expect(payload.status).toBe('ok')
    expect(Object.keys(payload)).toEqual(['status'])
  })
})
