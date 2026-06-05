import { useEffect, useRef, useState } from 'react'
import PortalTooltip from '../../components/PortalTooltip'
import { authAPI } from '../../services/api'

const CONTACT_SUBJECTS = ['Technical Issue', 'Billing', 'General Question', 'Feature Request']
const PHONE_STORAGE_KEY = 'anot_cl_support_phone'

const SUPPORT_SYSTEM_PROMPT =
  'You are Anot Support, a helpful assistant for the Anot Health clinician portal. You help doctors with questions about using the platform including adding patients, recording encounters, understanding note statuses, and troubleshooting common issues. Be concise, friendly, and professional. If the issue requires human intervention say: I will flag this for our support team to follow up with you directly.'

const CHAT_ERROR_MESSAGE =
  'Sorry, I am having trouble connecting right now. Please email support@anot.health for assistance.'

function toConversationHistory(messages) {
  return messages
    .filter((m) => m.role === 'user' || m.role === 'support')
    .map((m) => ({
      role: m.role === 'user' ? 'user' : 'assistant',
      content: m.text,
    }))
}

async function fetchClaudeSupportReply(conversationHistory) {
  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': import.meta.env.VITE_ANTHROPIC_API_KEY,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({
      model: 'claude-sonnet-4-20250514',
      max_tokens: 1000,
      system: SUPPORT_SYSTEM_PROMPT,
      messages: conversationHistory,
    }),
  })

  const data = await res.json().catch(() => ({}))
  if (!res.ok) {
    throw new Error(data.error?.message || `Request failed (${res.status})`)
  }

  const reply = data.content?.find((block) => block.type === 'text')?.text?.trim()
  if (!reply) throw new Error('Empty response from support assistant')
  return reply
}
function contactDrName(name) {
  const parts = (name || '').trim().split(/\s+/).filter(Boolean)
  return parts.length ? parts[parts.length - 1] : 'Doctor'
}

function contactInitials(name) {
  return (name || 'C')
    .split(' ')
    .filter(Boolean)
    .slice(0, 2)
    .map((w) => w[0])
    .join('')
    .toUpperCase() || 'C'
}

function getEstParts(date = new Date()) {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/New_York',
    weekday: 'short',
    hour: 'numeric',
    minute: 'numeric',
    hour12: false,
  }).formatToParts(date)
  const get = (type) => parts.find((p) => p.type === type)?.value
  return {
    weekday: get('weekday'),
    hour: parseInt(get('hour') || '0', 10),
    minute: parseInt(get('minute') || '0', 10),
  }
}

function isSupportOnlineEST() {
  const { weekday, hour, minute } = getEstParts()
  if (!['Mon', 'Tue', 'Wed', 'Thu', 'Fri'].includes(weekday)) return false
  const totalMins = hour * 60 + minute
  return totalMins >= 9 * 60 && totalMins < 18 * 60
}

function buildWelcomeMessage(name, namePrefix = 'Dr.') {
  const dr = contactDrName(name)
  const who = namePrefix ? `${namePrefix} ${dr}` : dr
  if (isSupportOnlineEST()) {
    return `Hi ${who}, welcome to Anot Support! How can we help you today? Our team is online and will respond shortly.`
  }
  return `Hi ${who}, our team is currently offline. Business hours are Monday to Friday, 9 AM to 6 PM EST. Leave your message and we will get back to you as soon as we are online.`
}

function IconEmail() {
  return (
    <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden>
      <rect x="2" y="4" width="20" height="16" rx="2" />
      <path d="m2 7 10 7 10-7" />
    </svg>
  )
}

function IconPhone() {
  return (
    <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden>
      <path d="M22 16.92v3a2 2 0 0 1-2.18 2 19.79 19.79 0 0 1-8.63-3.07 19.5 19.5 0 0 1-6-6 19.79 19.79 0 0 1-3.07-8.67A2 2 0 0 1 4.11 2h3a2 2 0 0 1 2 1.72 12.84 12.84 0 0 0 .7 2.81 2 2 0 0 1-.45 2.11L8.09 9.91a16 16 0 0 0 6 6l1.27-1.27a2 2 0 0 1 2.11-.45 12.84 12.84 0 0 0 2.81.7A2 2 0 0 1 22 16.92z" />
    </svg>
  )
}

function IconChat() {
  return (
    <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden>
      <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" />
    </svg>
  )
}

function SectionTitle({ icon, children }) {
  return (
    <h2 className="cl-contact-section__title">
      <span className="cl-contact-section__icon">{icon}</span>
      {children}
    </h2>
  )
}

function contactEmailFromUser(user) {
  const email = user?.email?.trim()
  if (!email) return ''
  const lower = email.toLowerCase()
  if (/@dev\.anot\.local$/i.test(lower) || lower.endsWith('.local')) return ''
  return email
}

function formatUsPhoneInput(value) {
  const digits = value.replace(/\D/g, '')
  let d = digits
  if (d.length > 0 && d[0] !== '1') d = `1${d}`
  d = d.slice(0, 11)
  if (!d.length) return ''
  if (d.length <= 1) return '+1'
  if (d.length <= 4) return `+1 (${d.slice(1)}`
  if (d.length <= 7) return `+1 (${d.slice(1, 4)}) ${d.slice(4)}`
  return `+1 (${d.slice(1, 4)}) ${d.slice(4, 7)}-${d.slice(7)}`
}

export default function ContactScreen({ currentUser, showToast, namePrefix = 'Dr.' }) {
  const [emailForm, setEmailForm] = useState(() => ({
    email: contactEmailFromUser(currentUser),
    subject: 'General Question',
    message: '',
  }))
  const [phone, setPhone] = useState(() => {
    try {
      const raw = localStorage.getItem(PHONE_STORAGE_KEY) || currentUser.phone || ''
      return raw ? formatUsPhoneInput(raw) : ''
    } catch {
      const raw = currentUser.phone || ''
      return raw ? formatUsPhoneInput(raw) : ''
    }
  })
  const [chatInput, setChatInput] = useState('')
  const [chatTyping, setChatTyping] = useState(false)
  const [chatMessages, setChatMessages] = useState(() => [
    {
      id: 'welcome',
      role: 'support',
      text: buildWelcomeMessage(currentUser.name, namePrefix),
      label: 'Anot Support',
    },
  ])
  const chatEndRef = useRef(null)
  const chatListRef = useRef(null)

  useEffect(() => {
    chatEndRef.current?.scrollIntoView({ behavior: 'smooth' })
  }, [chatMessages, chatTyping])

  useEffect(() => {
    const email = contactEmailFromUser(currentUser)
    setEmailForm((prev) => (prev.email === email ? prev : { ...prev, email }))
  }, [currentUser?.email])

  useEffect(() => {
    let cancelled = false
    authAPI
      .getMe()
      .then((data) => {
        if (cancelled) return
        const email = contactEmailFromUser(data?.user)
        setEmailForm((prev) => (prev.email === email ? prev : { ...prev, email }))
      })
      .catch(() => {})
    return () => {
      cancelled = true
    }
  }, [])

  const hasUserChatMessages = chatMessages.some((msg) => msg.role === 'user')

  const handleEmailSend = (e) => {
    e.preventDefault()
    if (!emailForm.message.trim()) {
      showToast('Please enter a message', 'error')
      return
    }
    const subject = encodeURIComponent(`[${emailForm.subject}]`)
    const body = encodeURIComponent(
      `From: ${emailForm.email}\nSubject: ${emailForm.subject}\n\n${emailForm.message.trim()}`,
    )
    window.location.href = `mailto:support@anot.health?subject=${subject}&body=${body}`
    showToast('Opening your email client…')
  }

  const handleSavePhone = (e) => {
    e.preventDefault()
    const trimmed = phone.trim()
    if (!trimmed) {
      showToast('Please enter a phone number', 'error')
      return
    }
    try {
      localStorage.setItem(PHONE_STORAGE_KEY, trimmed)
    } catch {
      /* ignore quota errors */
    }
    showToast('Phone number saved')
  }

  const sendChatMessage = async () => {
    const text = chatInput.trim()
    if (!text || chatTyping) return

    const userMsg = {
      id: `u-${Date.now()}`,
      role: 'user',
      text,
    }
    const nextMessages = [...chatMessages, userMsg]
    setChatMessages(nextMessages)
    setChatInput('')
    setChatTyping(true)

    try {
      const conversationHistory = toConversationHistory(nextMessages)
      const reply = await fetchClaudeSupportReply(conversationHistory)
      setChatMessages((prev) => [
        ...prev,
        {
          id: `s-${Date.now()}`,
          role: 'support',
          text: reply,
          label: 'Anot Support',
        },
      ])
    } catch {
      setChatMessages((prev) => [
        ...prev,
        {
          id: `err-${Date.now()}`,
          role: 'support',
          text: CHAT_ERROR_MESSAGE,
          label: 'Anot Support',
        },
      ])
    } finally {
      setChatTyping(false)
    }
  }
  const onChatKeyDown = (e) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault()
      void sendChatMessage()
    }
  }

  return (
    <div className="cl-contact-page">
      <section className="cl-contact-section">
        <SectionTitle icon={<IconEmail />}>Email Support</SectionTitle>
        <p className="cl-contact-section__lead">
          <a href="mailto:support@anot.health" className="cl-contact-mailto">
            support@anot.health
          </a>
        </p>
        <form className="cl-contact-section__form" onSubmit={handleEmailSend}>
          <div className="cl-contact-field">
            <label className="cl-contact-label" htmlFor="cl-contact-email">
              Your email
            </label>
            <input
              id="cl-contact-email"
              className="cl-contact-input"
              type="email"
              placeholder="your@email.com"
              value={emailForm.email}
              onChange={(e) => setEmailForm({ ...emailForm, email: e.target.value })}
              required
            />
          </div>
          <div className="cl-contact-field">
            <label className="cl-contact-label" htmlFor="cl-contact-subject">
              Subject
            </label>
            <select
              id="cl-contact-subject"
              className="cl-contact-input"
              value={emailForm.subject}
              onChange={(e) => setEmailForm({ ...emailForm, subject: e.target.value })}
            >
              {CONTACT_SUBJECTS.map((option) => (
                <option key={option} value={option}>
                  {option}
                </option>
              ))}
            </select>
          </div>
          <div className="cl-contact-field">
            <label className="cl-contact-label" htmlFor="cl-contact-message">
              Message
            </label>
            <textarea
              id="cl-contact-message"
              className="cl-contact-input cl-contact-textarea"
              rows={4}
              placeholder="Describe your issue..."
              value={emailForm.message}
              onChange={(e) => setEmailForm({ ...emailForm, message: e.target.value })}
              required
            />
          </div>
          <PortalTooltip tip="Send your message to the support team by email" placement="below">
            <button type="submit" className="cl-contact-btn">
              Send Email
            </button>
          </PortalTooltip>
          <p className="cl-contact-note">We respond within 24 hours on business days</p>
        </form>
      </section>

      <section className="cl-contact-section">
        <SectionTitle icon={<IconPhone />}>Call or Text Us</SectionTitle>
        <form className="cl-contact-section__form" onSubmit={handleSavePhone}>
          <div className="cl-contact-field">
            <label className="cl-contact-label" htmlFor="cl-contact-phone">
              Your cell phone number
            </label>
            <span className="cl-schedule-tooltip-wrap cl-schedule-tooltip-wrap--icon cl-contact-phone-wrap">
              <input
                id="cl-contact-phone"
                className="cl-contact-input"
                type="tel"
                placeholder="+1 (555) 000-0000"
                value={phone}
                onChange={(e) => setPhone(formatUsPhoneInput(e.target.value))}
                autoComplete="tel"
              />
              <span className="cl-schedule-tooltip cl-schedule-tooltip--icon" role="tooltip">
                Enter your number in this format: +1 (555) 000-0000
              </span>
            </span>
            <p className="cl-contact-phone-hint">Format: +1 (555) 000-0000</p>
          </div>
          <PortalTooltip tip="Save your phone number so support can call or text you back" placement="below">
            <button type="submit" className="cl-contact-btn">
              Save Number
            </button>
          </PortalTooltip>
          <p className="cl-contact-note">We will text or call you back within 1 business day</p>
          <p className="cl-contact-note cl-contact-note--muted">
            Phone support: Monday to Friday, 9 AM to 6 PM EST
          </p>
        </form>
      </section>

      <section className="cl-contact-section cl-contact-section--chat">
        <SectionTitle icon={<IconChat />}>Live Chat</SectionTitle>
        <div className="cl-contact-chat">
          <div className="cl-contact-chat__messages" ref={chatListRef} aria-live="polite">
            {chatMessages.map((msg) =>
              msg.role === 'user' ? (
                <div key={msg.id} className="cl-contact-chat__row cl-contact-chat__row--user">
                  <div className="cl-contact-chat__bubble cl-contact-chat__bubble--user">{msg.text}</div>
                  <div className="cl-contact-chat__avatar cl-contact-chat__avatar--user" aria-hidden>
                    {contactInitials(currentUser.name)}
                  </div>
                </div>
              ) : (
                <div key={msg.id} className="cl-contact-chat__row cl-contact-chat__row--support">
                  <div className="cl-contact-chat__avatar cl-contact-chat__avatar--support" aria-hidden>
                    AS
                  </div>
                  <div className="cl-contact-chat__support-body">
                    {msg.label ? <div className="cl-contact-chat__label">{msg.label}</div> : null}
                    <div className="cl-contact-chat__bubble cl-contact-chat__bubble--support">{msg.text}</div>
                  </div>
                </div>
              ),
            )}
            {chatTyping ? (
              <div className="cl-contact-chat__row cl-contact-chat__row--support">
                <div className="cl-contact-chat__avatar cl-contact-chat__avatar--support" aria-hidden>
                  AS
                </div>
                <div className="cl-contact-chat__support-body">
                  <div className="cl-contact-chat__label">Anot Support</div>
                  <div className="cl-contact-chat__bubble cl-contact-chat__bubble--support cl-contact-chat__typing">
                    <span />
                    <span />
                    <span />
                  </div>
                </div>
              </div>
            ) : null}
            {!hasUserChatMessages && !chatTyping ? (
              <p className="cl-contact-chat__empty-hint">Type a message below to start the conversation</p>
            ) : null}
            <div ref={chatEndRef} />
          </div>
          <PortalTooltip
            tip="Live chat: Mon–Fri 9 AM–6 PM EST. Expect a reply within a few minutes when online, otherwise by the next business day."
            placement="above"
            block
          >
          <div className="cl-contact-chat__composer">
            <span className="cl-contact-chat__composer-icon" aria-hidden="true" title="Attachments (coming soon)">
              <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <path d="M21.44 11.05l-9.19 9.19a6 6 0 0 1-8.49-8.49l9.19-9.19a4 4 0 0 1 5.66 5.66l-9.2 9.19a2 2 0 0 1-2.83-2.83l8.49-8.48" />
              </svg>
            </span>
            <input
              className="cl-contact-input cl-contact-chat__input"
              type="text"
              placeholder="Type your message..."
              value={chatInput}
              onChange={(e) => setChatInput(e.target.value)}
              onKeyDown={onChatKeyDown}
              disabled={chatTyping}
              aria-label="Chat message"
            />
            <PortalTooltip tip="Send your message to Anot support chat" placement="left">
              <button
                type="button"
                className="cl-contact-btn cl-contact-chat__send"
                onClick={() => void sendChatMessage()}
                disabled={chatTyping || !chatInput.trim()}
              >
                Send
              </button>
            </PortalTooltip>
          </div>
          </PortalTooltip>
        </div>
      </section>
    </div>
  )
}
