import { useEffect, useState, useMemo, useCallback } from 'react'
import { saintMaryClinicAPI, usersAPI } from '../services/api'
import './SaintMaryClinicModule.css'

function initials(name) {
  if (!name) {return 'DR'}
  const parts = name.trim().split(/\s+/)
  if (parts.length === 1) {return parts[0].slice(0, 2).toUpperCase()}
  return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase()
}

export default function SaintMaryClinicModule({ showToast }) {
  const [doctors, setDoctors] = useState([])
  const [allClinicians, setAllClinicians] = useState([])
  const [loading, setLoading] = useState(true)
  const [search, setSearch] = useState('')
  const [uiFilter, setUiFilter] = useState('all')

  // Add doctor modal state
  const [showAddModal, setShowAddModal] = useState(false)
  const [selectedDoctorId, setSelectedDoctorId] = useState('')
  const [selectedUiMode, setSelectedUiMode] = useState('saint_mary')
  const [savingAdd, setSavingAdd] = useState(false)

  // Remove confirmation modal
  const [removeDoctorTarget, setRemoveDoctorTarget] = useState(null)
  const [removing, setRemoving] = useState(false)

  const loadData = useCallback(async () => {
    setLoading(true)
    try {
      const [clinicRes, allCliniciansRes] = await Promise.all([
        saintMaryClinicAPI.getDoctors(),
        usersAPI.getByRole('clinician'),
      ])
      setDoctors(clinicRes?.doctors || [])
      setAllClinicians(allCliniciansRes?.users || [])
    } catch (err) {
      showToast?.(err?.message || 'Failed to load Saint Mary Clinic roster', 'error')
    } finally {
      setLoading(false)
    }
  }, [showToast])

  useEffect(() => {
    let cancelled = false
    Promise.all([
      saintMaryClinicAPI.getDoctors().catch(() => ({ doctors: [] })),
      usersAPI.getByRole('clinician').catch(() => ({ users: [] })),
    ])
      .then(([clinicRes, allCliniciansRes]) => {
        if (!cancelled) {
          setDoctors(clinicRes?.doctors || [])
          setAllClinicians(allCliniciansRes?.users || [])
        }
      })
      .finally(() => {
        if (!cancelled) {
          setLoading(false)
        }
      })

    return () => {
      cancelled = true
    }
  }, [])

  const enrolledIds = useMemo(() => new Set(doctors.map((d) => String(d.id))), [doctors])

  const availableClinicians = useMemo(
    () => allClinicians.filter((c) => !enrolledIds.has(String(c.id))),
    [allClinicians, enrolledIds]
  )

  const filteredDoctors = useMemo(() => {
    const q = search.trim().toLowerCase()
    return doctors.filter((d) => {
      const matchesQuery =
        !q ||
        (d.name || '').toLowerCase().includes(q) ||
        (d.email || '').toLowerCase().includes(q) ||
        (d.specialty || '').toLowerCase().includes(q)
      const matchesUi =
        uiFilter === 'all' ||
        (uiFilter === 'saint_mary' && d.ui_mode === 'saint_mary') ||
        (uiFilter === 'standard' && (d.ui_mode === 'standard' || !d.ui_mode))
      return matchesQuery && matchesUi
    })
  }, [doctors, search, uiFilter])

  const handleOpenAddModal = () => {
    const firstAvailable = availableClinicians[0]?.id || ''
    setSelectedDoctorId(firstAvailable)
    setSelectedUiMode('saint_mary')
    setShowAddModal(true)
  }

  const handleAddDoctor = async (e) => {
    e.preventDefault()
    if (!selectedDoctorId) {
      showToast?.('Please select a doctor to enroll', 'warn')
      return
    }
    setSavingAdd(true)
    try {
      await saintMaryClinicAPI.addDoctor(selectedDoctorId, selectedUiMode)
      showToast?.('✓ Doctor successfully enrolled in Saint Mary Clinic, Alberta')
      setShowAddModal(false)
      setSelectedDoctorId('')
      setSelectedUiMode('saint_mary')
      await loadData()
    } catch (err) {
      showToast?.(err?.message || 'Failed to add doctor to clinic', 'error')
    } finally {
      setSavingAdd(false)
    }
  }

  const handleToggleUiMode = async (doc) => {
    const newMode = doc.ui_mode === 'saint_mary' ? 'standard' : 'saint_mary'
    try {
      await saintMaryClinicAPI.toggleUiMode(doc.id, newMode)
      setDoctors((prev) =>
        prev.map((d) => (d.id === doc.id ? { ...d, ui_mode: newMode } : d))
      )
      showToast?.(
        `✓ UI mode updated for Dr. ${doc.name}: ${newMode === 'saint_mary' ? 'Saint Mary Clinic UI' : 'Standard Anot UI'}`
      )
    } catch (err) {
      showToast?.(err?.message || 'Failed to update UI mode', 'error')
    }
  }

  const handleRemoveDoctor = async () => {
    if (!removeDoctorTarget) {return}
    setRemoving(true)
    try {
      await saintMaryClinicAPI.removeDoctor(removeDoctorTarget.id)
      showToast?.(`✓ Dr. ${removeDoctorTarget.name} removed from Saint Mary Clinic`)
      setRemoveDoctorTarget(null)
      await loadData()
    } catch (err) {
      showToast?.(err?.message || 'Failed to remove doctor from clinic', 'error')
    } finally {
      setRemoving(false)
    }
  }

  const saintMaryUiCount = doctors.filter((d) => d.ui_mode === 'saint_mary').length

  return (
    <div className="sm-clinic">
      {/* Clinic Header Banner */}
      <div className="sm-clinic__banner">
        <div className="sm-clinic__banner-left">
          <div className="sm-clinic__icon-box">🏥</div>
          <div>
            <div className="sm-clinic__badge-row">
              <span className="sm-clinic__badge sm-clinic__badge--location">Alberta, Canada</span>
              <span className="sm-clinic__badge sm-clinic__badge--tag">Saint Mary Module</span>
            </div>
            <h1 className="sm-clinic__title">Saint Mary Clinic, Alberta</h1>
            <p className="sm-clinic__subtitle">
              Physicians enrolled in this clinic receive the custom <strong>Saint Mary Clinic Interface</strong> with ambient documentation workflow.
            </p>
          </div>
        </div>

        <div className="sm-clinic__banner-actions">
          <button
            type="button"
            className="sm-clinic__btn sm-clinic__btn--primary"
            onClick={handleOpenAddModal}
          >
            + Add Doctor to Clinic
          </button>
        </div>
      </div>

      {/* Stats row */}
      <div className="sm-clinic__stats-grid">
        <div className="sm-clinic__stat-card">
          <span className="sm-clinic__stat-label">Total Clinic Doctors</span>
          <strong className="sm-clinic__stat-val">{doctors.length}</strong>
        </div>
        <div className="sm-clinic__stat-card sm-clinic__stat-card--highlight">
          <span className="sm-clinic__stat-label">Saint Mary UI Active</span>
          <strong className="sm-clinic__stat-val">{saintMaryUiCount}</strong>
        </div>
        <div className="sm-clinic__stat-card">
          <span className="sm-clinic__stat-label">Standard UI Doctors</span>
          <strong className="sm-clinic__stat-val">{doctors.length - saintMaryUiCount}</strong>
        </div>
      </div>

      {/* Filter & Search Bar */}
      <div className="sm-clinic__toolbar">
        <div className="sm-clinic__search-wrap">
          <input
            type="search"
            className="sm-clinic__search"
            placeholder="Search doctors in Saint Mary Clinic by name, email, specialty…"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
          />
        </div>

        <div className="sm-clinic__filter-wrap">
          <select
            className="sm-clinic__select"
            value={uiFilter}
            onChange={(e) => setUiFilter(e.target.value)}
          >
            <option value="all">All Interface Modes</option>
            <option value="saint_mary">Saint Mary UI Only</option>
            <option value="standard">Standard Anot UI Only</option>
          </select>

          <button
            type="button"
            className="sm-clinic__btn sm-clinic__btn--refresh"
            onClick={loadData}
            disabled={loading}
            title="Refresh clinic roster"
          >
            {loading ? '⟳ Syncing…' : '⟳ Refresh'}
          </button>
        </div>
      </div>

      {/* Doctor Roster Table */}
      <div className="sm-clinic__table-card">
        {filteredDoctors.length === 0 ? (
          <div className="sm-clinic__empty">
            <span className="sm-clinic__empty-icon">🩺</span>
            <h3>No doctors enrolled in Saint Mary Clinic</h3>
            <p>
              {search
                ? 'No matching doctors found for your search criteria.'
                : 'Click "+ Add Doctor to Clinic" above to assign physicians to Saint Mary Clinic, Alberta.'}
            </p>
          </div>
        ) : (
          <table className="sm-clinic__table">
            <thead>
              <tr>
                <th>Doctor</th>
                <th>Specialty</th>
                <th>Status</th>
                <th>Assigned Interface</th>
                <th style={{ textAlign: 'right' }}>Actions</th>
              </tr>
            </thead>
            <tbody>
              {filteredDoctors.map((doc) => {
                const isSaintMaryUi = doc.ui_mode === 'saint_mary'
                return (
                  <tr key={doc.id}>
                    <td>
                      <div className="sm-clinic__usercell">
                        <div className="sm-clinic__avatar">{initials(doc.name)}</div>
                        <div>
                          <div className="sm-clinic__doc-name">{doc.name}</div>
                          <div className="sm-clinic__doc-email">{doc.email}</div>
                        </div>
                      </div>
                    </td>
                    <td>
                      <span className="sm-clinic__specialty-tag">{doc.specialty || 'General Practice'}</span>
                    </td>
                    <td>
                      <span
                        className={`sm-clinic__status-pill ${doc.status === 'active' ? 'sm-clinic__status-pill--active' : 'sm-clinic__status-pill--inactive'}`}
                      >
                        {doc.status || 'active'}
                      </span>
                    </td>
                    <td>
                      <div className="sm-clinic__ui-control">
                        <span
                          className={`sm-clinic__ui-badge ${isSaintMaryUi ? 'sm-clinic__ui-badge--saint-mary' : 'sm-clinic__ui-badge--standard'}`}
                        >
                          {isSaintMaryUi ? '⚡ Saint Mary Clinic UI' : 'Standard Anot UI'}
                        </span>
                        <button
                          type="button"
                          className="sm-clinic__btn-toggle"
                          onClick={() => handleToggleUiMode(doc)}
                          title={`Switch to ${isSaintMaryUi ? 'Standard Anot UI' : 'Saint Mary Clinic UI'}`}
                        >
                          Switch
                        </button>
                      </div>
                    </td>
                    <td style={{ textAlign: 'right' }}>
                      <button
                        type="button"
                        className="sm-clinic__btn-remove"
                        onClick={() => setRemoveDoctorTarget(doc)}
                        title="Remove doctor from Saint Mary Clinic"
                      >
                        Remove
                      </button>
                    </td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        )}
      </div>

      {/* Add Doctor Modal */}
      {showAddModal && (
        <div className="sm-modal-overlay" role="dialog" aria-modal="true" aria-labelledby="sm-add-title">
          <div className="sm-modal">
            <div className="sm-modal__header">
              <div>
                <h2 id="sm-add-title" className="sm-modal__title">Add Doctor to Saint Mary Clinic</h2>
                <p className="sm-modal__sub">Saint Mary Clinic, Alberta</p>
              </div>
              <button
                type="button"
                className="sm-modal__close"
                onClick={() => setShowAddModal(false)}
                aria-label="Close"
              >
                ×
              </button>
            </div>

            {availableClinicians.length === 0 ? (
              <div className="sm-modal__body">
                <p className="sm-modal__empty-text">
                  All active clinicians in the system are currently enrolled in Saint Mary Clinic. To add a new doctor, first create their account in the <strong>Clinicians</strong> tab.
                </p>
                <div className="sm-modal__actions">
                  <button type="button" className="sm-clinic__btn" onClick={() => setShowAddModal(false)}>
                    Close
                  </button>
                </div>
              </div>
            ) : (
              <form onSubmit={handleAddDoctor} className="sm-modal__form">
                <div className="sm-modal__field">
                  <label className="sm-modal__label" htmlFor="sm-doc-select">
                    Select Doctor *
                  </label>
                  <select
                    id="sm-doc-select"
                    className="sm-modal__select"
                    value={selectedDoctorId}
                    onChange={(e) => setSelectedDoctorId(e.target.value)}
                    required
                  >
                    <option value="">-- Choose a Clinician --</option>
                    {availableClinicians.map((c) => (
                      <option key={c.id} value={c.id}>
                        {c.name} ({c.email}) {c.specialty ? `— ${c.specialty}` : ''}
                      </option>
                    ))}
                  </select>
                </div>

                <div className="sm-modal__field">
                  <label className="sm-modal__label">Assigned Interface *</label>
                  <div className="sm-modal__ui-options">
                    <label className={`sm-modal__ui-option ${selectedUiMode === 'saint_mary' ? 'sm-modal__ui-option--active' : ''}`}>
                      <input
                        type="radio"
                        name="ui_mode"
                        value="saint_mary"
                        checked={selectedUiMode === 'saint_mary'}
                        onChange={(e) => setSelectedUiMode(e.target.value)}
                      />
                      <div>
                        <strong>⚡ Saint Mary Clinic Interface (Recommended)</strong>
                        <p>Doctor gets the Saint Mary ambient consultation workflow, live waveform visualizer, and custom top navigation.</p>
                      </div>
                    </label>

                    <label className={`sm-modal__ui-option ${selectedUiMode === 'standard' ? 'sm-modal__ui-option--active' : ''}`}>
                      <input
                        type="radio"
                        name="ui_mode"
                        value="standard"
                        checked={selectedUiMode === 'standard'}
                        onChange={(e) => setSelectedUiMode(e.target.value)}
                      />
                      <div>
                        <strong>Standard Anot UI</strong>
                        <p>Doctor uses the standard Anot Health calendar and encounter schedule.</p>
                      </div>
                    </label>
                  </div>
                </div>

                <div className="sm-modal__actions">
                  <button
                    type="submit"
                    className="sm-clinic__btn sm-clinic__btn--primary"
                    disabled={savingAdd || !selectedDoctorId}
                  >
                    {savingAdd ? 'Enrolling…' : 'Enroll Doctor in Clinic'}
                  </button>
                  <button
                    type="button"
                    className="sm-clinic__btn"
                    onClick={() => setShowAddModal(false)}
                    disabled={savingAdd}
                  >
                    Cancel
                  </button>
                </div>
              </form>
            )}
          </div>
        </div>
      )}

      {/* Remove Confirmation Modal */}
      {removeDoctorTarget && (
        <div className="sm-modal-overlay" role="dialog" aria-modal="true" aria-labelledby="sm-remove-title">
          <div className="sm-modal sm-modal--confirm">
            <div className="sm-modal__header">
              <h2 id="sm-remove-title" className="sm-modal__title">Remove Doctor from Clinic?</h2>
              <button
                type="button"
                className="sm-modal__close"
                onClick={() => setRemoveDoctorTarget(null)}
                aria-label="Close"
              >
                ×
              </button>
            </div>
            <div className="sm-modal__body">
              <p>
                Are you sure you want to remove <strong>Dr. {removeDoctorTarget.name}</strong> from <strong>Saint Mary Clinic, Alberta</strong>?
              </p>
              <p className="sm-modal__confirm-note">
                Their account will remain active and revert back to Anot's standard interface.
              </p>
              <div className="sm-modal__actions">
                <button
                  type="button"
                  className="sm-clinic__btn sm-clinic__btn--danger"
                  onClick={handleRemoveDoctor}
                  disabled={removing}
                >
                  {removing ? 'Removing…' : 'Remove from Clinic'}
                </button>
                <button
                  type="button"
                  className="sm-clinic__btn"
                  onClick={() => setRemoveDoctorTarget(null)}
                  disabled={removing}
                >
                  Cancel
                </button>
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
