// Lightweight SMTP mailer for transactional support emails.
// nodemailer is loaded defensively so the API still boots if it is not installed.
let nodemailer
try {
  nodemailer = require('nodemailer')
} catch {
  nodemailer = null
}

const DEFAULT_SUPPORT_EMAIL = 'support@anot.health'

function getTransport() {
  const host = process.env.SMTP_HOST?.trim()
  const user = process.env.SMTP_USER?.trim()
  const pass = process.env.SMTP_PASS?.trim()
  const port = parseInt(process.env.SMTP_PORT || '587', 10)

  if (!nodemailer || !host || !user || !pass) return null

  return nodemailer.createTransport({
    host,
    port,
    secure: port === 465,
    auth: { user, pass },
  })
}

/**
 * Send a clinician support message to the support inbox.
 * Returns { sent: true } on delivery, or { sent: false, reason } when SMTP
 * is not configured (so callers can accept the message without failing).
 */
async function sendSupportEmail({ name, fromEmail, subject, message, clinicianName }) {
  const to = process.env.SUPPORT_EMAIL?.trim() || DEFAULT_SUPPORT_EMAIL
  const transport = getTransport()
  if (!transport) {
    return { sent: false, reason: 'SMTP not configured' }
  }

  const from = process.env.SMTP_FROM?.trim() || process.env.SMTP_USER
  const displayName = name || clinicianName || 'Clinician'
  const accountLine = clinicianName && clinicianName !== name ? ` (account: ${clinicianName})` : ''
  const text =
    `Support message from ${displayName}${accountLine}\n` +
    `Subject: ${subject}\n\n` +
    `${message}`

  await transport.sendMail({
    from,
    to,
    replyTo: fromEmail || undefined,
    subject: `[Clinician Support] ${subject} — ${displayName}`,
    text,
  })

  return { sent: true }
}

module.exports = { sendSupportEmail }
