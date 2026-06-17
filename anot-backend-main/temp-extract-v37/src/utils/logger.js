// ─────────────────────────────────────────────────────────────────────────────
// CloudWatch HIPAA audit logger
//
// This ships structured audit events to AWS CloudWatch Logs. It is intentionally
// independent of the Postgres `auditLogger.js` (which remains the canonical,
// queryable audit trail); CloudWatch gives an append-only, tamper-evident copy
// outside the application database for HIPAA retention.
//
// Design notes vs. a naive implementation:
//   • Uses AWS SDK v3 (@aws-sdk/client-cloudwatch-logs) — the project already
//     ships v3 (@aws-sdk/client-s3); SDK v2 ("aws-sdk") is in maintenance mode
//     and is NOT a dependency here.
//   • Graceful no-op: if AUDIT_CLOUDWATCH_ENABLED !== 'true' (or the SDK/creds
//     are unavailable) nothing is shipped to AWS and the app keeps running. This
//     matters because the service may run on Railway, where there is no
//     CloudWatch IAM role. Set AUDIT_CLOUDWATCH_ENABLED=true on AWS.
//   • Sequence-token aware: CloudWatch Logs `PutLogEvents` returns the next
//     sequence token, which the following call must echo back. We track it and
//     self-heal on InvalidSequenceToken / DataAlreadyAccepted.
//   • The flush timer is unref()'d so it never keeps the process (or tests)
//     alive on its own.
//
// IMPORTANT (PHI): audit events legitimately carry identifiers (user id, email,
// patient id). We do NOT print event bodies to stdout by default — set
// AUDIT_CONSOLE=true to echo them locally. Never log clinical note content here.
// ─────────────────────────────────────────────────────────────────────────────

const REGION = process.env.AUDIT_CLOUDWATCH_REGION || process.env.AWS_REGION || 'ap-southeast-1'
const LOG_GROUP = process.env.AUDIT_LOG_GROUP || '/aws/elasticbeanstalk/anot-backend-prod'
const LOG_STREAM = process.env.AUDIT_LOG_STREAM || 'audit-logs'

const CLOUDWATCH_ENABLED = process.env.AUDIT_CLOUDWATCH_ENABLED === 'true'
const CONSOLE_ENABLED = process.env.AUDIT_CONSOLE === 'true'

const MAX_BUFFER = 100
const FLUSH_INTERVAL_MS = 5000

// Lazy SDK handles so a missing package never crashes import in environments
// where CloudWatch isn't used.
let cwClient = null
let PutLogEventsCommand = null
let CreateLogGroupCommand = null
let CreateLogStreamCommand = null
let DescribeLogStreamsCommand = null

function loadSdk() {
    if (cwClient) return true
    try {
        const sdk = require('@aws-sdk/client-cloudwatch-logs')
        cwClient = new sdk.CloudWatchLogsClient({ region: REGION })
        PutLogEventsCommand = sdk.PutLogEventsCommand
        CreateLogGroupCommand = sdk.CreateLogGroupCommand
        CreateLogStreamCommand = sdk.CreateLogStreamCommand
        DescribeLogStreamsCommand = sdk.DescribeLogStreamsCommand
        return true
    } catch (err) {
        console.error('[AUDIT] CloudWatch SDK unavailable — audit shipping disabled:', err.message)
        return false
    }
}

class AuditLogger {
    constructor() {
        this.buffer = []
        this.sequenceToken = undefined
        this.flushing = false
        this.timer = null
        if (CLOUDWATCH_ENABLED) this.startFlushTimer()
    }

    log(event) {
        const logEntry = {
            timestamp: new Date().toISOString(),
            ...event,
        }

        if (CONSOLE_ENABLED) {
            console.log('[AUDIT]', JSON.stringify(logEntry))
        }

        if (!CLOUDWATCH_ENABLED) return

        this.buffer.push(logEntry)
        if (this.buffer.length >= MAX_BUFFER) {
            // Fire-and-forget; flush handles its own errors.
            this.flush().catch(() => {})
        }
    }

    async ensureStream() {
        if (this.sequenceToken !== undefined) return
        try {
            const res = await cwClient.send(
                new DescribeLogStreamsCommand({
                    logGroupName: LOG_GROUP,
                    logStreamNamePrefix: LOG_STREAM,
                }),
            )
            const stream = (res.logStreams || []).find((s) => s.logStreamName === LOG_STREAM)
            // A brand-new stream has no token; null is the correct "first call" value.
            this.sequenceToken = stream ? stream.uploadSequenceToken || null : null
        } catch {
            this.sequenceToken = null
        }
    }

    async flush() {
        if (this.buffer.length === 0) return
        if (this.flushing) return
        if (!CLOUDWATCH_ENABLED) {
            this.buffer.length = 0
            return
        }
        if (!loadSdk()) {
            // SDK genuinely unavailable — drop buffer so it can't grow unbounded.
            this.buffer.length = 0
            return
        }

        this.flushing = true
        const logs = this.buffer.splice(0)
        try {
            await this.ensureStream()

            // CloudWatch requires events sorted by timestamp ascending.
            const logEvents = logs
                .map((entry) => ({
                    message: JSON.stringify(entry),
                    timestamp: Date.parse(entry.timestamp) || Date.now(),
                }))
                .sort((a, b) => a.timestamp - b.timestamp)

            const params = {
                logGroupName: LOG_GROUP,
                logStreamName: LOG_STREAM,
                logEvents,
            }
            if (this.sequenceToken) params.sequenceToken = this.sequenceToken

            const res = await cwClient.send(new PutLogEventsCommand(params))
            this.sequenceToken = res.nextSequenceToken
        } catch (error) {
            const name = error?.name || ''
            const expected = error?.expectedSequenceToken
            if ((name === 'InvalidSequenceTokenException' || name === 'DataAlreadyAcceptedException') && expected) {
                // Recover the correct token and retry once on the next flush.
                this.sequenceToken = expected
                this.buffer.unshift(...logs)
            } else if (name === 'ResourceNotFoundException') {
                // Group/stream missing — reset so initCloudWatch / ensureStream re-resolves.
                this.sequenceToken = undefined
                console.error('[AUDIT] CloudWatch log group/stream missing — call initCloudWatch().')
            } else {
                console.error('[AUDIT] Failed to flush logs:', error.message)
            }
        } finally {
            this.flushing = false
        }
    }

    startFlushTimer() {
        if (this.timer) return
        this.timer = setInterval(() => {
            this.flush().catch(() => {})
        }, FLUSH_INTERVAL_MS)
        // Don't let the audit timer hold the event loop / process open.
        if (typeof this.timer.unref === 'function') this.timer.unref()
    }

    // ── Convenience methods ──────────────────────────────────────────────────

    logLogin(userId, email, role, ipAddress, status = 'success') {
        this.log({
            event: 'user_login',
            user_id: userId,
            email,
            role,
            ip_address: ipAddress,
            status,
        })
    }

    logLogout(userId, email, ipAddress) {
        this.log({
            event: 'user_logout',
            user_id: userId,
            email,
            ip_address: ipAddress,
        })
    }

    logDataAccess(userId, userRole, resource, resourceId, action, ipAddress, details = {}) {
        this.log({
            event: `${resource}_${String(action).toLowerCase()}`,
            user_id: userId,
            user_role: userRole,
            resource,
            resource_id: resourceId,
            action,
            ip_address: ipAddress,
            details,
        })
    }

    logSettingChange(userId, userRole, settingName, oldValue, newValue, ipAddress) {
        this.log({
            event: 'settings_updated',
            user_id: userId,
            user_role: userRole,
            setting_name: settingName,
            old_value: oldValue,
            new_value: newValue,
            ip_address: ipAddress,
        })
    }

    logError(errorType, errorMessage, userId, endpoint, statusCode, ipAddress) {
        this.log({
            event: 'error',
            error_type: errorType,
            error_message: errorMessage,
            user_id: userId,
            endpoint,
            status_code: statusCode,
            ip_address: ipAddress,
        })
    }
}

const auditLogger = new AuditLogger()

/**
 * Create the CloudWatch log group + stream if they don't exist. Safe to call on
 * startup; no-ops (and never throws) when CloudWatch is disabled or the SDK is
 * unavailable so it can't take down the server.
 */
async function initCloudWatch() {
    if (!CLOUDWATCH_ENABLED) {
        console.log('ℹ️  CloudWatch audit logging disabled (set AUDIT_CLOUDWATCH_ENABLED=true to enable).')
        return
    }
    if (!loadSdk()) return

    try {
        try {
            await cwClient.send(new CreateLogGroupCommand({ logGroupName: LOG_GROUP }))
        } catch (e) {
            if (e?.name !== 'ResourceAlreadyExistsException') throw e
        }

        try {
            await cwClient.send(
                new CreateLogStreamCommand({ logGroupName: LOG_GROUP, logStreamName: LOG_STREAM }),
            )
        } catch (e) {
            if (e?.name !== 'ResourceAlreadyExistsException') throw e
        }

        console.log('✅ CloudWatch audit logging initialized')
    } catch (error) {
        console.error('❌ CloudWatch initialization failed:', error.message)
    }
}

module.exports = auditLogger
module.exports.initCloudWatch = initCloudWatch
