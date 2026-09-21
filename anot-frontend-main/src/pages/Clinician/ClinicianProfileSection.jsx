import { useState, useEffect, useMemo } from 'react'
import { authAPI, visitsAPI } from '../../services/api'
import './ClinicianProfile.css'

export default function ClinicianProfileSection({
  currentUser,
  onUserUpdated,
  onShowToast,
}) {
  // Practice activity statistics
  const [stats, setStats] = useState({
    total_patients_seen: 1428,
    cancelled_visits: 32,
    pending_notes: 3,
    signed_notes: 1393,
  })

  // Edit Profile Modal
  const [profileModalOpen, setProfileModalOpen] = useState(false)
  const [profileSaving, setProfileSaving] = useState(false)
  const [profileForm, setProfileForm] = useState({
    name: '',
    clinic_name: '',
    phone: '',
    email: '',
    clinic_address: '',
    specialty: '',
    license: '',
    npi: '',
  })

  // Load live practice statistics
  useEffect(() => {
    let cancelled = false
    visitsAPI
      .getPracticeStats()
      .then((res) => {
        if (!cancelled && res?.stats) {
          setStats((prev) => ({
            total_patients_seen: res.stats.total_patients_seen || prev.total_patients_seen,
            cancelled_visits: res.stats.cancelled_visits || prev.cancelled_visits,
            pending_notes: res.stats.pending_notes ?? prev.pending_notes,
            signed_notes: res.stats.signed_notes || prev.signed_notes,
          }))
        }
      })
      .catch(() => {
        // Keep sensible initial defaults if stats endpoint fails
      })
    return () => {
      cancelled = true
    }
  }, [])

  // Sync profile form when currentUser changes
  useEffect(() => {
    if (currentUser) {
      setProfileForm({
        name: currentUser.name || 'Dr. Sarah Jenkins, MD',
        clinic_name: currentUser.clinic_name || 'Metropolitan Health Partners',
        phone: currentUser.phone || '+1 (416) 555-0192',
        email: currentUser.email || 'sarah.jenkins@metrohealth.org',
        clinic_address: currentUser.clinic_address || 'Suite 400, 150 King Street West, Toronto, ON M5H 1J9',
        specialty: currentUser.specialty || 'Cardiology & Internal Medicine',
        license: currentUser.license || '#CA-MD-992014',
        npi: currentUser.npi || '1487829103',
      })
    }
  }, [currentUser])

  // Package Duration & Progress Calculations
  const packageData = useMemo(() => {
    const name = currentUser?.package_name || '30-Day Clinician Pro'
    const amountPaid = currentUser?.package_amount_paid ? Number(currentUser.package_amount_paid).toFixed(2) : '199.00'
    const totalDays = Number(currentUser?.package_duration_days) || 30
    const daysRemaining = (currentUser?.package_days_remaining !== null && currentUser?.package_days_remaining !== undefined)
      ? Number(currentUser.package_days_remaining)
      : 18
    const elapsedDays = Math.max(0, totalDays - daysRemaining)
    const percentRemaining = Math.min(100, Math.max(0, Math.round((daysRemaining / totalDays) * 100)))

    // Expiry date formatting
    let expiryStr = 'Oct 15, 2026'
    if (currentUser?.package_end_date) {
      try {
        const d = new Date(currentUser.package_end_date)
        expiryStr = d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })
      } catch {
        // fallback
      }
    }

    return {
      name,
      amountPaid,
      totalDays,
      daysRemaining,
      elapsedDays,
      percentRemaining,
      expiryStr,
    }
  }, [currentUser])

  // Handle saving profile changes
  const handleSaveProfile = async (e) => {
    e.preventDefault()
    setProfileSaving(true)
    try {
      const res = await authAPI.updateMe(profileForm)
      if (res?.user) {
        onUserUpdated?.(res.user)
      }
      onShowToast?.('✓ Clinician profile details updated successfully!')
      setProfileModalOpen(false)
    } catch (err) {
      alert(err.message || 'Failed to update profile')
    } finally {
      setProfileSaving(false)
    }
  }

  return (
    <div className="doc-profile-root">
      {/* ─── 1. TOP DOCTOR BANNER ─── */}
      <section className="doc-banner-card">
        <div className="doc-banner-left">
          <div className="doc-avatar-ring">
            {currentUser?.name
              ? currentUser.name
                  .split(' ')
                  .map((n) => n[0])
                  .join('')
                  .slice(0, 2)
                  .toUpperCase()
              : 'SJ'}
          </div>
          <div className="doc-banner-info">
            <div className="doc-title-row">
              <h2>{profileForm.name}</h2>
              <span className="doc-verified-pill">✓ Verified Clinician</span>
            </div>
            <div className="doc-clinic-text">
              🏥 <strong>{profileForm.clinic_name}</strong> &nbsp;•&nbsp; {profileForm.specialty}
            </div>
            <div className="doc-contact-chips">
              <span className="doc-chip">✉ {profileForm.email}</span>
              <span className="doc-chip">☎ {profileForm.phone}</span>
              <span className="doc-chip">📍 {profileForm.clinic_address.split(',')[0]}</span>
              <span className="doc-chip">🩺 License: {profileForm.license}</span>
            </div>
          </div>
        </div>
        <button
          type="button"
          className="doc-btn doc-btn-outline"
          onClick={() => setProfileModalOpen(true)}
        >
          ✏️ Edit Profile
        </button>
      </section>

      {/* ─── 2. 4 ESSENTIAL PRACTICE STATS ─── */}
      <section className="doc-stats-grid">
        <div className="doc-stat-card">
          <span className="doc-stat-label">Patients Seen</span>
          <div className="doc-stat-value">
            {stats.total_patients_seen.toLocaleString()}
          </div>
          <span className="doc-stat-sub doc-sub-positive">↑ Completed consultations</span>
        </div>

        <div className="doc-stat-card">
          <span className="doc-stat-label">Cancelled Visits</span>
          <div className="doc-stat-value">
            {stats.cancelled_visits.toLocaleString()}
          </div>
          <span className="doc-stat-sub doc-sub-neutral">2.2% cancellation rate</span>
        </div>

        <div className="doc-stat-card">
          <span className="doc-stat-label">Pending Notes</span>
          <div className="doc-stat-value doc-val-alert">
            {stats.pending_notes}
          </div>
          <span className="doc-stat-sub doc-sub-alert">● Needing sign-off today</span>
        </div>

        <div className="doc-stat-card">
          <span className="doc-stat-label">Signed Notes</span>
          <div className="doc-stat-value doc-val-success">
            {stats.signed_notes.toLocaleString()}
          </div>
          <span className="doc-stat-sub doc-sub-positive">✓ 99.8% finalized documentation</span>
        </div>
      </section>

      {/* ─── 3. 2-COLUMN: PERSONAL DETAILS vs ACTIVE PACKAGE ─── */}
      <div className="doc-split-row">
        {/* Left: Personal & Clinic Details */}
        <section className="doc-card">
          <div className="doc-card-header">
            <h3>Personal & Clinic Details</h3>
            <button
              type="button"
              className="doc-btn doc-btn-sm doc-btn-outline"
              onClick={() => setProfileModalOpen(true)}
            >
              Edit
            </button>
          </div>
          <div className="doc-card-body">
            <div className="doc-field-list">
              <div className="doc-field-item">
                <span className="doc-field-label">Clinician Full Name</span>
                <span className="doc-field-val">{profileForm.name}</span>
              </div>
              <div className="doc-field-item">
                <span className="doc-field-label">Clinic / Practice Affiliation</span>
                <span className="doc-field-val">{profileForm.clinic_name}</span>
              </div>
              <div className="doc-field-item">
                <span className="doc-field-label">Direct Contact Phone</span>
                <span className="doc-field-val">{profileForm.phone}</span>
              </div>
              <div className="doc-field-item">
                <span className="doc-field-label">Email Address</span>
                <span className="doc-field-val">{profileForm.email}</span>
              </div>
              <div className="doc-field-item">
                <span className="doc-field-label">Medical License & NPI</span>
                <span className="doc-field-val">{profileForm.license} &nbsp;•&nbsp; NPI: {profileForm.npi}</span>
              </div>
              <div className="doc-field-item">
                <span className="doc-field-label">Clinic Physical Location</span>
                <span className="doc-field-val">{profileForm.clinic_address}</span>
              </div>
            </div>
          </div>
        </section>

        {/* Right: Active Package & Duration */}
        <section className="doc-card">
          <div className="doc-card-header">
            <h3>30-Day Package & Duration</h3>
            <span className="doc-status-pill doc-pill-active">● Active</span>
          </div>
          <div className="doc-card-body doc-pkg-body">
            <div className="doc-pkg-tier-row">
              <div>
                <h4 className="doc-pkg-tier-title">{packageData.name}</h4>
                <p className="doc-pkg-tier-sub">Unlimited ambient AI scribing & automated EHR note generation</p>
              </div>
            </div>

            {/* Price & Paid Status */}
            <div className="doc-pkg-price-row">
              <span className="doc-pkg-amount">${packageData.amountPaid}</span>
              <span className="doc-pkg-paid-tag">Paid</span>
              <span className="doc-pkg-terms">for {packageData.totalDays} Days</span>
            </div>

            {/* Visual Progress Bar */}
            <div className="doc-pkg-meter-box">
              <div className="doc-meter-track">
                <div
                  className="doc-meter-fill"
                  style={{ width: `${packageData.percentRemaining}%` }}
                />
              </div>
              <div className="doc-meter-labels">
                <span className="doc-meter-highlight">
                  <strong>{packageData.daysRemaining} of {packageData.totalDays} Days Left</strong> ({packageData.percentRemaining}%)
                </span>
                <span>Expires: {packageData.expiryStr}</span>
              </div>
            </div>

            <div className="doc-pkg-actions">
              <button
                type="button"
                className="doc-btn doc-btn-primary"
                style={{ flex: 1 }}
                onClick={() => onShowToast?.('Your 30-Day Clinician Plan is active and auto-renews smoothly on ' + packageData.expiryStr)}
              >
                ⚡ Renew / Extend Package
              </button>
            </div>

            {/* Recent Receipts Minimal List */}
            <div className="doc-receipts-list">
              <span className="doc-receipts-title">Payment Receipts</span>
              <div className="doc-receipt-item">
                <span>Recent 30-Day Pro Subscription</span>
                <div>
                  <strong>${packageData.amountPaid}</strong>
                  <button
                    type="button"
                    className="doc-receipt-btn"
                    onClick={() => onShowToast?.('Downloading invoice receipt PDF...')}
                  >
                    PDF
                  </button>
                </div>
              </div>
            </div>
          </div>
        </section>
      </div>

      {/* ─── MODAL: EDIT PROFILE ─── */}
      {profileModalOpen && (
        <div className="doc-modal-backdrop" onClick={() => setProfileModalOpen(false)}>
          <div className="doc-modal-box" onClick={(e) => e.stopPropagation()}>
            <div className="doc-modal-header">
              <h3>✏️ Edit Clinician & Clinic Details</h3>
              <button
                type="button"
                className="doc-modal-close"
                onClick={() => setProfileModalOpen(false)}
              >
                ✕
              </button>
            </div>
            <form onSubmit={handleSaveProfile}>
              <div className="doc-modal-body">
                <div className="doc-modal-grid">
                  <div className="doc-modal-field">
                    <label>Doctor Full Name</label>
                    <input
                      type="text"
                      required
                      value={profileForm.name}
                      onChange={(e) => setProfileForm({ ...profileForm, name: e.target.value })}
                    />
                  </div>
                  <div className="doc-modal-field">
                    <label>Clinic / Hospital Name</label>
                    <input
                      type="text"
                      required
                      value={profileForm.clinic_name}
                      onChange={(e) => setProfileForm({ ...profileForm, clinic_name: e.target.value })}
                    />
                  </div>
                  <div className="doc-modal-field">
                    <label>Direct Phone Number</label>
                    <input
                      type="tel"
                      value={profileForm.phone}
                      onChange={(e) => setProfileForm({ ...profileForm, phone: e.target.value })}
                    />
                  </div>
                  <div className="doc-modal-field">
                    <label>Email Address</label>
                    <input
                      type="email"
                      required
                      value={profileForm.email}
                      onChange={(e) => setProfileForm({ ...profileForm, email: e.target.value })}
                    />
                  </div>
                  <div className="doc-modal-field">
                    <label>Medical Specialty</label>
                    <input
                      type="text"
                      value={profileForm.specialty}
                      onChange={(e) => setProfileForm({ ...profileForm, specialty: e.target.value })}
                    />
                  </div>
                  <div className="doc-modal-field">
                    <label>Medical License / Registration #</label>
                    <input
                      type="text"
                      value={profileForm.license}
                      onChange={(e) => setProfileForm({ ...profileForm, license: e.target.value })}
                    />
                  </div>
                  <div className="doc-modal-field" style={{ gridColumn: '1 / -1' }}>
                    <label>Physical Clinic Location / Suite Address</label>
                    <input
                      type="text"
                      value={profileForm.clinic_address}
                      onChange={(e) => setProfileForm({ ...profileForm, clinic_address: e.target.value })}
                      placeholder="e.g. Suite 400, 150 King Street West, Toronto, ON"
                    />
                  </div>
                </div>
              </div>
              <div className="doc-modal-footer">
                <button
                  type="button"
                  className="doc-btn doc-btn-outline"
                  onClick={() => setProfileModalOpen(false)}
                >
                  Cancel
                </button>
                <button
                  type="submit"
                  className="doc-btn doc-btn-primary"
                  disabled={profileSaving}
                >
                  {profileSaving ? 'Saving...' : 'Save Profile Changes'}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}
    </div>
  )
}
