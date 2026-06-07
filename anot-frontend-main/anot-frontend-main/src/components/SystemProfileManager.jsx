import { useEffect, useState } from 'react'
import { authAPI } from '../services/api'
import { useBranding } from '../services/branding'
import PasswordStrengthMeter from './PasswordStrengthMeter'
import { validatePassword } from '../utils/passwordPolicy'
import './systemProfileManager.css'

export default function SystemProfileManager({
  showToast,
  roleLabel = 'User',
  compact = false,
  readOnly = false,
  className = '',
  subtitleText,
  fieldPlaceholders = {},
  maskDevEmail = false,
  lockedFields = [],
  saveButtonLabel = 'Update profile',
}) {
  const branding = useBranding()
  const [form, setForm] = useState({
    name: '',
    email: '',
    phone: '',
    currentPassword: '',
    newPassword: '',
    confirmPassword: '',
    avatar_data_url: '',
    personal_info: '',
  })
  const [saving, setSaving] = useState(false)
  const [loading, setLoading] = useState(false)
  const [avatarBusy, setAvatarBusy] = useState(false)
  const [meta, setMeta] = useState({ role: roleLabel, status: 'active' })
  const [passVisible, setPassVisible] = useState({ current: false, next: false, confirm: false })

  useEffect(() => {
    let mounted = true
    const cached = authAPI.getCurrentUser() || {}
    queueMicrotask(() => {
      if (!mounted) return
      setForm((prev) => ({ ...prev, name: cached.name || '', email: cached.email || '', phone: cached.phone || '' }))
      setLoading(true)
    })
    authAPI
      .getMe()
      .then((data) => {
        if (!mounted) return
        const u = data.user || {}
        setMeta({ role: u.role || roleLabel, status: u.status || 'active' })
        setForm((prev) => ({
          ...prev,
          name: u.name || '',
          email: u.email || '',
          phone: u.phone || '',
          avatar_data_url: u.avatar_data_url || '',
          personal_info: u.personal_info || '',
        }))
      })
      .catch(() => {})
      .finally(() => {
        if (!mounted) return
        setLoading(false)
      })
    return () => {
      mounted = false
    }
  }, [roleLabel])

  const setField = (k, v) => setForm((prev) => ({ ...prev, [k]: v }))

  const isFieldLocked = (field) => readOnly || lockedFields.includes(field)
  const displayEmail = maskDevEmail && form.email === 'scribe@dev.anot.local' ? '' : form.email
  const resolvedSubtitle =
    subtitleText ||
    (readOnly
      ? 'Your account details are managed by your organization administrator.'
      : 'Update your name, contact details, and password. Only you can change this profile while signed in.')

  const fileToObjectUrl = (file) => URL.createObjectURL(file)

  const optimizeAvatarImage = async (file) => {
    if (!file) return ''
    const blobUrl = fileToObjectUrl(file)
    try {
      const image = await new Promise((resolve, reject) => {
        const img = new Image()
        img.onload = () => resolve(img)
        img.onerror = () => reject(new Error('Failed to load image.'))
        img.src = blobUrl
      })

      const size = 512
      const canvas = document.createElement('canvas')
      canvas.width = size
      canvas.height = size
      const ctx = canvas.getContext('2d')
      if (!ctx) throw new Error('Image processing is unavailable.')

      const srcW = image.naturalWidth || image.width
      const srcH = image.naturalHeight || image.height
      const crop = Math.min(srcW, srcH)
      const sx = Math.max(0, Math.floor((srcW - crop) / 2))
      const sy = Math.max(0, Math.floor((srcH - crop) / 2))

      ctx.clearRect(0, 0, size, size)
      ctx.imageSmoothingEnabled = true
      ctx.imageSmoothingQuality = 'high'
      ctx.drawImage(image, sx, sy, crop, crop, 0, 0, size, size)

      const toJpeg = (quality) =>
        canvas.toDataURL('image/jpeg', quality)

      let dataUrl = toJpeg(0.9)
      if (dataUrl.length > 700_000) dataUrl = toJpeg(0.8)
      if (dataUrl.length > 700_000) dataUrl = toJpeg(0.7)
      if (dataUrl.length > 1_600_000) throw new Error('Image is still too large after optimization.')
      return dataUrl
    } finally {
      URL.revokeObjectURL(blobUrl)
    }
  }

  const onAvatarPick = async (event) => {
    try {
      const file = event.target.files?.[0]
      if (!file) return
      if (!file.type.startsWith('image/')) {
        showToast('Please choose an image file.', 'error')
        return
      }
      setAvatarBusy(true)
      const dataUrl = await optimizeAvatarImage(file)
      setField('avatar_data_url', dataUrl)
      showToast('Avatar optimized and ready to save.')
    } catch (err) {
      showToast(err.message || 'Failed to process image.', 'error')
    } finally {
      setAvatarBusy(false)
      event.target.value = ''
    }
  }

  const save = async () => {
    const name = form.name.trim()
    const email = form.email.trim()
    const phone = form.phone.trim()
    const wantsPassword = !!form.currentPassword || !!form.newPassword || !!form.confirmPassword

    if (!name) return showToast('Name is required.', 'error')
    if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return showToast('Enter a valid email.', 'error')
    if (wantsPassword) {
      if (!form.currentPassword || !form.newPassword) return showToast('Enter current and new password.', 'error')
      const pwCheck = validatePassword(form.newPassword)
      if (!pwCheck.valid) return showToast(pwCheck.message, 'error')
      if (form.newPassword !== form.confirmPassword) return showToast('Passwords do not match.', 'error')
    }

    try {
      setSaving(true)
      await authAPI.updateMe({
        name,
        email,
        phone,
        avatar_data_url: form.avatar_data_url || '',
        personal_info: form.personal_info.trim(),
      })
      const me = await authAPI.getMe()
      const u = me.user || {}
      setMeta({ role: u.role || roleLabel, status: u.status || 'active' })
      if (wantsPassword) {
        await authAPI.changePassword(form.currentPassword, form.newPassword)
      }
      setForm((prev) => ({ ...prev, currentPassword: '', newPassword: '', confirmPassword: '' }))
      showToast('Profile updated successfully')
    } catch (err) {
      showToast(err.message || 'Failed to update profile.', 'error')
    } finally {
      setSaving(false)
    }
  }

  return (
    <div className={`pm-card${className ? ` ${className}` : ''}`}>
      <header className="pm-header" aria-labelledby="pm-heading">
        <div className="pm-header-visual">
          <div className="pm-avatar-wrap">
            {form.avatar_data_url ? (
              <img src={form.avatar_data_url} alt="" className="pm-avatar" />
            ) : (
              <div className="pm-avatar pm-avatar--placeholder" aria-hidden>
                {(form.name || 'U').slice(0, 1).toUpperCase()}
              </div>
            )}
            {!readOnly ? (
              <label className="pm-avatar-upload">
                {avatarBusy ? '…' : 'Photo'}
                <input type="file" accept="image/*" onChange={onAvatarPick} hidden disabled={avatarBusy} />
              </label>
            ) : null}
          </div>
        </div>
        <div className="pm-header-body">
          <p className="pm-eyebrow">Your account</p>
          <h3 id="pm-heading" className="pm-title">
            Profile Management
          </h3>
          <p className="pm-subtitle">{resolvedSubtitle}</p>
          <div className="pm-badges" role="list">
            <span className="pm-badge" role="listitem">
              Role: {meta.role || roleLabel}
            </span>
            <span className="pm-badge" role="listitem">
              Status: {meta.status || 'active'}
            </span>
            <span className="pm-badge pm-badge--muted" role="listitem">
              {branding.system_name || 'Anot'}
            </span>
          </div>
        </div>
      </header>
      {loading ? <div className="pm-loading">Loading profile…</div> : null}
      {avatarBusy ? <div className="pm-loading">Optimizing avatar for faster upload…</div> : null}

      <div className="pm-grid">
        <div className="pm-group">
          <label className="pm-label">Full name *</label>
          <input className="pm-input" value={form.name} onChange={(e) => setField('name', e.target.value)} readOnly={isFieldLocked('name')} disabled={isFieldLocked('name')} />
        </div>
        <div className="pm-group">
          <label className="pm-label">Email address *</label>
          <input className="pm-input" value={displayEmail} onChange={(e) => setField('email', e.target.value)} readOnly={isFieldLocked('email')} disabled={isFieldLocked('email')} placeholder={fieldPlaceholders.email || undefined} />
        </div>
        <div className="pm-group">
          <label className="pm-label">Phone number</label>
          <input className="pm-input" value={form.phone} onChange={(e) => setField('phone', e.target.value)} readOnly={isFieldLocked('phone')} disabled={isFieldLocked('phone')} placeholder={fieldPlaceholders.phone || undefined} />
        </div>
        {!compact && (
          <div className="pm-group">
            <label className="pm-label">Personal information / details</label>
            <textarea className="pm-input pm-textarea" value={form.personal_info} onChange={(e) => setField('personal_info', e.target.value)} readOnly={isFieldLocked('personal_info')} disabled={isFieldLocked('personal_info')} placeholder={fieldPlaceholders.personal_info || undefined} />
          </div>
        )}
        {compact && (
          <div className="pm-group pm-group--full">
            <label className="pm-label">Personal information / details</label>
            <textarea className="pm-input pm-textarea" value={form.personal_info} onChange={(e) => setField('personal_info', e.target.value)} readOnly={isFieldLocked('personal_info')} disabled={isFieldLocked('personal_info')} placeholder={fieldPlaceholders.personal_info || undefined} />
          </div>
        )}

        {!readOnly ? (
        <>
        <div className="pm-group">
          <label className="pm-label">Current password</label>
          <div className="pm-pass-wrap">
            <input className="pm-input pm-input--has-toggle" type={passVisible.current ? 'text' : 'password'} value={form.currentPassword} onChange={(e) => setField('currentPassword', e.target.value)} />
            <button type="button" className="pm-pass-toggle" onClick={() => setPassVisible((p) => ({ ...p, current: !p.current }))}>
              {passVisible.current ? '🙈' : '👁️'}
            </button>
          </div>
        </div>
        <div className="pm-group">
          <label className="pm-label">New password</label>
          <div className="pm-pass-wrap">
            <input className="pm-input pm-input--has-toggle" type={passVisible.next ? 'text' : 'password'} value={form.newPassword} onChange={(e) => setField('newPassword', e.target.value)} />
            <button type="button" className="pm-pass-toggle" onClick={() => setPassVisible((p) => ({ ...p, next: !p.next }))}>
              {passVisible.next ? '🙈' : '👁️'}
            </button>
          </div>
          <PasswordStrengthMeter password={form.newPassword} />
        </div>
        <div className="pm-group">
          <label className="pm-label">Confirm new password</label>
          <div className="pm-pass-wrap">
            <input className="pm-input pm-input--has-toggle" type={passVisible.confirm ? 'text' : 'password'} value={form.confirmPassword} onChange={(e) => setField('confirmPassword', e.target.value)} />
            <button type="button" className="pm-pass-toggle" onClick={() => setPassVisible((p) => ({ ...p, confirm: !p.confirm }))}>
              {passVisible.confirm ? '🙈' : '👁️'}
            </button>
          </div>
        </div>
        </>
        ) : null}
      </div>

      {!readOnly ? (
        <div className="pm-actions">
          <button type="button" className="pm-btn" onClick={save} disabled={saving}>
            {saving ? 'Saving changes…' : saveButtonLabel}
          </button>
        </div>
      ) : null}
    </div>
  )
}

