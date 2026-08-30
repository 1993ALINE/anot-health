let nodemailer
try {
  nodemailer = require('nodemailer')
} catch {
  nodemailer = null
}

let twilioClient = null
let twilioFrom = null

function getEmailTransport() {
  const host = process.env.SMTP_HOST?.trim() || process.env.EMAIL_HOST?.trim()
  const user = process.env.SMTP_USER?.trim() || process.env.EMAIL_USER?.trim()
  const pass = process.env.SMTP_PASS?.trim() || process.env.EMAIL_PASSWORD?.trim()
  const port = parseInt(process.env.SMTP_PORT || process.env.EMAIL_PORT || '587', 10)

  if (!nodemailer || !host || !user || !pass) return null

  return nodemailer.createTransport({
    host,
    port,
    secure: port === 465,
    auth: { user, pass },
  })
}

function getTwilioClient() {
  if (twilioClient !== null) return twilioClient

  const sid = process.env.TWILIO_ACCOUNT_SID?.trim()
  const token = process.env.TWILIO_AUTH_TOKEN?.trim()
  twilioFrom = process.env.TWILIO_PHONE_NUMBER?.trim() || null

  if (!sid || !token || !twilioFrom) {
    twilioClient = false
    return null
  }

  try {
    const twilio = require('twilio')
    twilioClient = twilio(sid, token)
    return twilioClient
  } catch {
    twilioClient = false
    return null
  }
}

async function sendMfaEmail(to, code) {
  const sendgridKey = process.env.SENDGRID_API_KEY?.trim()
  if (sendgridKey && nodemailer) {
    const transport = nodemailer.createTransport({
      host: 'smtp.sendgrid.net',
      port: 587,
      auth: { user: 'apikey', pass: sendgridKey },
    })
    const from = process.env.SMTP_FROM?.trim() || process.env.EMAIL_FROM?.trim() || 'noreply@anot.health'
    await transport.sendMail({
      from,
      to,
      subject: 'Your Anot sign-in code',
      text: `Your verification code is ${code}. It expires in 10 minutes. If you did not request this, ignore this email.`,
    })
    return { sent: true, channel: 'email' }
  }

  const transport = getEmailTransport()
  if (!transport) {
    return { sent: false, reason: 'Email delivery not configured' }
  }

  const from = process.env.SMTP_FROM?.trim() || process.env.EMAIL_FROM?.trim() || process.env.SMTP_USER || process.env.EMAIL_USER
  await transport.sendMail({
    from,
    to,
    subject: 'Your Anot sign-in code',
    text: `Your verification code is ${code}. It expires in 10 minutes. If you did not request this, ignore this email.`,
  })
  return { sent: true, channel: 'email' }
}

async function sendMfaSms(to, code) {
  const client = getTwilioClient()
  if (!client) {
    return { sent: false, reason: 'SMS delivery not configured' }
  }

  await client.messages.create({
    from: twilioFrom,
    to,
    body: `Your Anot verification code is ${code}. It expires in 10 minutes.`,
  })
  return { sent: true, channel: 'sms' }
}

module.exports = { sendMfaEmail, sendMfaSms, getEmailTransport, getTwilioClient }
