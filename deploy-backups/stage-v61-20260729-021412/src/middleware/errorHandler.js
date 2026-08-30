const { buildErrorPayload, logServerError } = require('../utils/errorMessages')

function errorHandler(err, req, res, next) {
  if (res.headersSent) {
    return next(err)
  }

  if (err.message && String(err.message).startsWith('CORS:')) {
    return res.status(403).json({ error: 'Access denied' })
  }

  const status = err.status || err.statusCode || 500
  logServerError('express', err, req)
  res.status(status).json(buildErrorPayload(err, status))
}

module.exports = errorHandler
