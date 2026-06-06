import { useState } from 'react'
import { API_BASE } from '../../services/api'

const CONTACT_SUBJECTS = ['General Question', 'Technical Issue', 'Billing', 'Feature Request']

const cardStyle = {
  background: '#FFFFFF',
  borderRadius: 12,
  boxShadow: '0 1px 4px rgba(0,0,0,0.08)',
  padding: 40,
  maxWidth: 800,
  margin: '40px auto',
}

const fieldStyle = { display: 'flex', flexDirection: 'column', gap: 8, marginBottom: 24 }
const labelStyle = { fontSize: 15, fontWeight: 500, color: '#374151', marginBottom: 8 }
const inputBaseStyle = {
  border: '1px solid #E5E7EB',
  borderRadius: 8,
  padding: '14px 16px',
  fontSize: 16,
  color: '#111827',
  outline: 'none',
  width: '100%',
  boxSizing: 'border-box',
  height: 52,
}
const buttonStyle = {
  width: '100%',
  background: '#4F46E5',
  color: '#FFFFFF',
  border: 'none',
  borderRadius: 8,
  padding: 12,
  fontWeight: 600,
  fontSize: 16,
  cursor: 'pointer',
  height: 52,
}

export default function ContactScreen({ currentUser, showToast }) {
  const [form, setForm] = useState(() => ({
    name: currentUser?.name || '',
    subject: 'General Question',
    message: '',
  }))
  const [sending, setSending] = useState(false)
  const [sent, setSent] = useState(false)

  const handleFocus = (e) => {
    e.target.style.borderColor = '#4F46E5'
  }
  const handleBlur = (e) => {
    e.target.style.borderColor = '#E5E7EB'
  }

  const handleSubmit = async (e) => {
    e.preventDefault()
    if (!form.message.trim()) {
      showToast?.('Please enter a message', 'error')
      return
    }
    setSending(true)
    try {
      const token = localStorage.getItem('token')
      const res = await fetch(`${API_BASE}/support/message`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...(token ? { Authorization: `Bearer ${token}` } : {}),
        },
        body: JSON.stringify({
          name: form.name.trim(),
          subject: form.subject,
          message: form.message.trim(),
          clinicianName: currentUser?.name,
        }),
      })
      const data = await res.json().catch(() => ({}))
      if (!res.ok) {
        throw new Error(data.error || `Request failed (${res.status})`)
      }
      setSent(true)
      setForm((prev) => ({ ...prev, message: '' }))
    } catch (err) {
      showToast?.(err.message || 'Could not send your message. Please try again.', 'error')
    } finally {
      setSending(false)
    }
  }

  return (
    <div className="cl-contact-page">
      <div style={cardStyle}>
        {sent ? (
          <p role="status" style={{ fontSize: 15, color: '#374151', margin: 0 }}>
            Your message has been sent. We will get back to you within 24 hours.
          </p>
        ) : (
          <form onSubmit={handleSubmit}>
            <div style={fieldStyle}>
              <label style={labelStyle} htmlFor="cl-contact-name">
                Name
              </label>
              <input
                id="cl-contact-name"
                type="text"
                style={inputBaseStyle}
                value={form.name}
                onChange={(e) => setForm({ ...form, name: e.target.value })}
                onFocus={handleFocus}
                onBlur={handleBlur}
                required
              />
            </div>

            <div style={fieldStyle}>
              <label style={labelStyle} htmlFor="cl-contact-subject">
                Subject
              </label>
              <select
                id="cl-contact-subject"
                style={inputBaseStyle}
                value={form.subject}
                onChange={(e) => setForm({ ...form, subject: e.target.value })}
                onFocus={handleFocus}
                onBlur={handleBlur}
              >
                {CONTACT_SUBJECTS.map((option) => (
                  <option key={option} value={option}>
                    {option}
                  </option>
                ))}
              </select>
            </div>

            <div style={fieldStyle}>
              <label style={labelStyle} htmlFor="cl-contact-message">
                Message
              </label>
              <textarea
                id="cl-contact-message"
                style={{ ...inputBaseStyle, resize: 'vertical', height: 180 }}
                placeholder="Describe your issue..."
                value={form.message}
                onChange={(e) => setForm({ ...form, message: e.target.value })}
                onFocus={handleFocus}
                onBlur={handleBlur}
                required
              />
            </div>

            <button type="submit" style={buttonStyle} disabled={sending}>
              {sending ? 'Sending…' : 'Send'}
            </button>
          </form>
        )}
      </div>
    </div>
  )
}
