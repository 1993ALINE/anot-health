const { auditLog } = require('../utils/auditLogger')
const { sendSupportEmail } = require('../utils/mailer')

// POST /api/support/message — clinician sends a support message; emailed to support inbox.
const supportMessage = async (req, res) => {
  try {
    const { name, subject, message, clinicianName, email } = req.body

    if (typeof message !== 'string' || !message.trim()) {
      return res.status(400).json({ error: 'Message is required.' })
    }

    const cleanMessage = message.trim().slice(0, 5000)
    const cleanSubject =
      typeof subject === 'string' && subject.trim() ? subject.trim().slice(0, 200) : 'General Question'
    const cleanName =
      typeof name === 'string' && name.trim()
        ? name.trim().slice(0, 200)
        : (req.user?.name || clinicianName || 'Clinician')
    const replyTo =
      typeof email === 'string' && email.trim() ? email.trim().slice(0, 320) : (req.user?.email || '')

    // Audit trail — metadata only. NEVER persist the message body (may contain PHI).
    try {
      await auditLog(
        req.user,
        'SUPPORT_MESSAGE_SENT',
        'support',
        null,
        `Support message: ${cleanSubject}`,
        {
          req,
          module_key: 'clinician',
          action_category: 'other',
          metadata: { subject: cleanSubject, name: cleanName, messageLength: cleanMessage.length },
        },
      )
    } catch (auditErr) {
      console.error('Support message audit log failed:', auditErr.message)
    }

    let delivery
    try {
      delivery = await sendSupportEmail({
        name: cleanName,
        fromEmail: replyTo,
        subject: cleanSubject,
        message: cleanMessage,
        clinicianName: req.user?.name || clinicianName,
      })
    } catch (mailErr) {
      console.error('Support message email failed:', mailErr.message)
      return res
        .status(502)
        .json({ error: 'Could not send your message. Please try again or email support@anot.health.' })
    }

    if (delivery && delivery.sent === false) {
      // Message accepted and audited, but SMTP isn't configured (e.g. local dev).
      console.warn(`Support message accepted but not emailed (${delivery.reason}). Subject: ${cleanSubject}`)
    }

    res.status(200).json({ ok: true })
  } catch (err) {
    console.error('Support message error:', err.message)
    res.status(500).json({ error: 'Could not send your message. Please try again.' })
  }
}

module.exports = { supportMessage }
