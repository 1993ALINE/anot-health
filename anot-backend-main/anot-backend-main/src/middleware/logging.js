const auditLogger = require('../utils/logger')
const { redactSensitiveData } = require('../utils/phiSafeLogger')

// Resolve the client IP the SAME way the canonical Postgres audit trail does:
// trust Express's `req.ip`, which honors the configured `trust proxy` hop count
// (see server.js). We deliberately do NOT hand-parse X-Forwarded-For â€” that
// header is fully attacker-controlled, so parsing it would let any client spoof
// the IP recorded in the HIPAA audit log.
function getClientIp(req) {
    const ip = req.ip || req.socket?.remoteAddress || null
    return ip ? String(ip).slice(0, 64) : null
}

function loggingMiddleware(req, res, next) {
    req.clientIp = getClientIp(req)

    // Log any error response once the response is fully sent. Using the
    // 'finish' event (instead of monkey-patching res.send) is robust for
    // redirects, streamed bodies, and res.json/res.end alike.
    res.on('finish', () => {
        if (res.statusCode >= 400) {
            auditLogger.logError(
                'HTTP_ERROR',
                `[${req.correlationId || 'no-corr-id'}] ${req.method} ${req.originalUrl || req.path} returned ${res.statusCode}`,
                req.user?.id ?? null,
                `${req.method} ${req.path}`,
                res.statusCode,
                req.clientIp,
                redactSensitiveData({
                    query: req.query,
                    body: req.body,
                }),
            )
        }
    })

    next()
}

module.exports = loggingMiddleware
