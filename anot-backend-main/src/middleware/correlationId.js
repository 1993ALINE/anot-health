const crypto = require('crypto')

const HEADER = 'x-correlation-id'
const REQUEST_HEADER = 'x-request-id'

function correlationIdMiddleware(req, res, next) {
  const incoming =
    req.get(HEADER) ||
    req.get(REQUEST_HEADER) ||
    req.get('x-amzn-trace-id')

  const correlationId = incoming || crypto.randomUUID()
  req.correlationId = correlationId
  req.requestId = correlationId

  res.setHeader(HEADER, correlationId)
  res.setHeader(REQUEST_HEADER, correlationId)
  next()
}

module.exports = { correlationIdMiddleware, HEADER, REQUEST_HEADER }