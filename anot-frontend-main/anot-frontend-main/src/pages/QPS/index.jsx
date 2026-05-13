import { useState, useEffect, useRef } from 'react'
import { useNavigate } from 'react-router-dom'
import { authAPI, usersAPI, notesAPI, API_BASE } from '../../services/api'
import { useBranding } from '../../services/branding'
import SystemProfileManager from '../../components/SystemProfileManager'
import { parseTranscriptionBlocks, useSidebar, Overlay, PortalTopbar, usePortalDrawerMode, ConfirmDialog, PortalSidebarBrand } from '../shared'
import './qps.css'

// ─── HELPERS ──────────────────────────────────────────────────────────────────

function fmtTime(t) {
  if (!t) return ''
  const [h, m] = t.split(':')
  const hour = parseInt(h)
  return `${hour > 12 ? hour - 12 : hour === 0 ? 12 : hour}:${m} ${hour >= 12 ? 'PM' : 'AM'}`
}

function fmtSecs(s) {
  if (!s || isNaN(s) || !isFinite(s) || s < 0) return '00:00'
  return `${String(Math.floor(s / 60)).padStart(2,'0')}:${String(Math.floor(s % 60)).padStart(2,'0')}`
}

function fmtDuration(secs) {
  if (!secs) return '—'
  return `${Math.floor(secs / 60)}:${String(secs % 60).padStart(2,'0')}`
}

// ─── AUDIO PLAYER ─────────────────────────────────────────────────────────────

function AudioPlayer({ visitId, durationSecs }) {
  const [count, setCount]         = useState(1)
  const [activeIdx, setActiveIdx] = useState(0)
  const [status, setStatus]       = useState('loading')
  const [isPlaying, setPlaying]   = useState(false)
  const [current, setCurrent]     = useState(0)
  const [duration, setDuration]   = useState(durationSecs || 0)
  const audioRef   = useRef(null)
  const blobRef    = useRef(null)
  const maxTimeRef = useRef(durationSecs || 0)

  // Get count
  useEffect(() => {
    if (!visitId) return
    const token = localStorage.getItem('token')
    fetch(`${API_BASE}/audio/${visitId}/count`, {
      headers: { Authorization: `Bearer ${token}` },
    }).then(r => r.json()).then(d => { if (d.count > 0) setCount(d.count) }).catch(() => {})
  }, [visitId])

  // Load audio blob
  useEffect(() => {
    if (!visitId) { setStatus('error'); return }
    setStatus('loading'); setPlaying(false); setCurrent(0)
    const initDur = activeIdx === 0 ? (durationSecs || 0) : 0
    setDuration(initDur); maxTimeRef.current = initDur

    if (blobRef.current) { URL.revokeObjectURL(blobRef.current); blobRef.current = null }

    const token = localStorage.getItem('token')
    fetch(`${API_BASE}/audio/${visitId}?index=${activeIdx}`, {
      headers: { Authorization: `Bearer ${token}` },
    })
      .then(res => { if (!res.ok) throw new Error('no audio'); return res.blob() })
      .then(blob => {
        if (!blob || blob.size === 0) throw new Error('empty')
        blobRef.current = URL.createObjectURL(blob)
        if (audioRef.current) { audioRef.current.src = blobRef.current; audioRef.current.load() }
        setStatus('ready')
      })
      .catch(() => setStatus('error'))

    return () => {
      if (audioRef.current) { audioRef.current.pause(); audioRef.current.src = '' }
      if (blobRef.current)  { URL.revokeObjectURL(blobRef.current); blobRef.current = null }
    }
  }, [visitId, activeIdx])

  // Audio events
  useEffect(() => {
    const audio = audioRef.current
    if (!audio) return
    const onMeta = () => {
      const dur = audio.duration
      if (dur && isFinite(dur) && dur > 0) { setDuration(Math.floor(dur)); maxTimeRef.current = Math.floor(dur) }
    }
    const onTime = () => {
      const cur = Math.floor(audio.currentTime)
      setCurrent(cur)
      if (cur > maxTimeRef.current) { maxTimeRef.current = cur; setDuration(cur) }
    }
    const onEnded = () => { setPlaying(false); setCurrent(0); if (maxTimeRef.current > 0) setDuration(maxTimeRef.current) }
    audio.addEventListener('loadedmetadata', onMeta)
    audio.addEventListener('durationchange', onMeta)
    audio.addEventListener('timeupdate',     onTime)
    audio.addEventListener('ended',          onEnded)
    return () => {
      audio.removeEventListener('loadedmetadata', onMeta)
      audio.removeEventListener('durationchange', onMeta)
      audio.removeEventListener('timeupdate',     onTime)
      audio.removeEventListener('ended',          onEnded)
    }
  }, [])

  const toggle = () => {
    const audio = audioRef.current
    if (!audio || status !== 'ready') return
    if (isPlaying) { audio.pause(); setPlaying(false) }
    else           { audio.play().then(() => setPlaying(true)).catch(() => {}) }
  }

  const skip = (secs) => {
    const audio = audioRef.current
    if (!audio || status !== 'ready') return
    const max = maxTimeRef.current || duration || 0
    const t = Math.max(0, Math.min(max, audio.currentTime + secs))
    audio.currentTime = t; setCurrent(Math.floor(t))
  }

  const seek = (e) => {
    const audio = audioRef.current
    if (!audio || status !== 'ready' || !duration) return
    const rect = e.currentTarget.getBoundingClientRect()
    const t = Math.round(((e.clientX - rect.left) / rect.width) * duration)
    audio.currentTime = t; setCurrent(t)
  }

  const canPlay  = status === 'ready'
  const progress = duration > 0 ? Math.min(100, (current / duration) * 100) : 0
  const totalStr = duration > 0 ? fmtSecs(duration) : '--:--'

  return (
    <div className="sf-audio-bar qps-audio-bar">
      <audio ref={audioRef} preload="metadata" style={{ display: 'none' }} />

      {/* Row 1 — Tabs + label + time */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 10 }}>
        {count > 1 && (
          <div style={{ display: 'flex', gap: 6 }}>
            {Array.from({ length: count }, (_, i) => (
              <button key={i} onClick={() => setActiveIdx(i)} style={{
                padding: '3px 12px', borderRadius: 6, fontSize: 11, fontWeight: 600,
                cursor: 'pointer', border: '1px solid',
                background:  activeIdx === i ? 'linear-gradient(135deg,#4260E9,#7B61FF)' : '#EEF2FF',
                color:       activeIdx === i ? '#fff'    : '#64748B',
                borderColor: activeIdx === i ? '#4260E9' : '#E2E8F0',
              }}>Rec {i + 1}</button>
            ))}
          </div>
        )}
        <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
          <span style={{ fontSize: 12, fontWeight: 600, color: '#1E293B' }}>
            🎙 Recording {activeIdx + 1}{count > 1 ? ` of ${count}` : ''}
          </span>
          {status === 'loading' && <span style={{ fontSize: 10, color: '#64748B', background: '#EEF2FF', padding: '2px 7px', borderRadius: 10 }}>Loading...</span>}
          {status === 'ready'   && <span style={{ fontSize: 10, color: '#047857', background: '#DDFBF3', padding: '2px 7px', borderRadius: 10 }}>● Ready</span>}
          {status === 'error'   && <span style={{ fontSize: 10, color: '#64748B', background: '#EEF2FF', padding: '2px 7px', borderRadius: 10 }}>No audio</span>}
        </div>
        <span style={{ marginLeft: 'auto', fontSize: 12, color: '#64748B', fontWeight: 500 }}>
          {fmtSecs(current)} / {totalStr}
        </span>
      </div>

      {/* Row 2 — Controls + progress bar */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 6, flexShrink: 0 }}>
          <button onClick={() => skip(-5)} disabled={!canPlay} style={{ padding: '5px 10px', borderRadius: 6, background: '#EEF2FF', color: '#64748B', border: '1px solid #E2E8F0', fontSize: 11, fontWeight: 600, cursor: canPlay ? 'pointer' : 'not-allowed', opacity: canPlay ? 1 : 0.4, fontFamily: 'inherit' }}>−5s</button>
          <button onClick={toggle} disabled={!canPlay} style={{ width: 38, height: 38, borderRadius: '50%', background: canPlay ? 'linear-gradient(135deg,#4260E9,#7B61FF)' : '#CBD5E1', color: '#fff', border: 'none', fontSize: 14, cursor: canPlay ? 'pointer' : 'not-allowed', display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0 }}>
            {status === 'loading' ? '⏳' : isPlaying ? '⏸' : '▶'}
          </button>
          <button onClick={() => skip(5)} disabled={!canPlay} style={{ padding: '5px 10px', borderRadius: 6, background: '#EEF2FF', color: '#64748B', border: '1px solid #E2E8F0', fontSize: 11, fontWeight: 600, cursor: canPlay ? 'pointer' : 'not-allowed', opacity: canPlay ? 1 : 0.4, fontFamily: 'inherit' }}>+5s</button>
        </div>
        <div style={{ flex: 1, minWidth: 0 }}>
          <div onClick={canPlay ? seek : undefined} style={{ height: 6, background: '#E2E8F0', borderRadius: 3, overflow: 'hidden', cursor: canPlay ? 'pointer' : 'default', marginBottom: 4 }}>
            <div style={{ height: '100%', background: 'linear-gradient(90deg,#4260E9,#7B61FF)', borderRadius: 3, width: `${progress}%`, transition: 'width 0.3s linear' }} />
          </div>
          <div style={{ display: 'flex', justifyContent: 'space-between' }}>
            <span style={{ fontSize: 10, color: '#64748B' }}>{fmtSecs(current)}</span>
            <span style={{ fontSize: 10, color: '#64748B', fontWeight: 500 }}>{totalStr}</span>
          </div>
        </div>
      </div>
    </div>
  )
}

// ─── MAIN COMPONENT ───────────────────────────────────────────────────────────

export default function QPS() {
  const navigate    = useNavigate()
  const sidebar     = useSidebar()
  const currentUser = JSON.parse(localStorage.getItem('user') || '{}')

  const [screen, setScreen]                     = useState('provider')
  const [activeTab, setActiveTab]               = useState('notes')
  const [providers, setProviders]               = useState([])
  const [selectedProvider, setSelectedProvider] = useState(null)
  const [notes, setNotes]                       = useState([])
  const [gradedNotes, setGradedNotes]           = useState([])
  const [selectedNote, setSelectedNote]         = useState(null)
  const [loadingProviders, setLoadingProviders] = useState(true)
  const [loadingNotes, setLoadingNotes]         = useState(false)
  const [loadingGraded, setLoadingGraded]       = useState(false)
  const [submitting, setSubmitting]             = useState(false)
  const [notif, setNotif]                       = useState(null)
  const [scores, setScores]                     = useState({ accuracy: 88, completeness: 92, terminology: 85, formatting: 95 })
  const [comment, setComment]                   = useState('')
  const [confirmDialog, setConfirmDialog]       = useState(null)
  const [confirmLoading, setConfirmLoading]     = useState(false)

  const drawerMode = usePortalDrawerMode()
  const branding = useBranding()
  const requestLogout = () => {
    setConfirmDialog({
      tone: 'primary',
      title: 'Sign out?',
      message: 'You will need to sign in again to use Anot.',
      confirmText: 'Log out',
      onConfirm: () => {
        authAPI.logout()
        navigate('/login', { replace: true })
      },
    })
  }

  const runConfirm = async () => {
    if (!confirmDialog?.onConfirm) return
    setConfirmLoading(true)
    try {
      await Promise.resolve(confirmDialog.onConfirm())
    } finally {
      setConfirmLoading(false)
      setConfirmDialog(null)
    }
  }

  const overallScore = Math.round(Object.values(scores).reduce((a, b) => a + b, 0) / 4)
  const isGraded     = selectedNote?.status === 'uploaded'

  // ── API ───────────────────────────────────────────

  const showNotif = (msg, type = 'success') => {
    setNotif({ msg, type })
    setTimeout(() => setNotif(null), 3000)
  }

  const loadProviders = async () => {
    try {
      setLoadingProviders(true)
      const data = await usersAPI.getByRole('clinician')
      setProviders(data.users || [])
    } catch (err) { showNotif(`Failed to load providers: ${err.message}`, 'error') }
    finally { setLoadingProviders(false) }
  }

  const loadNotes = async (providerId) => {
    try {
      setLoadingNotes(true)
      const data = await notesAPI.getAllNotes(providerId, null)
      setNotes((data.notes || []).filter(n => ['submitted','uploaded'].includes(n.status)))
    } catch (err) { showNotif(`Failed to load notes: ${err.message}`, 'error') }
    finally { setLoadingNotes(false) }
  }

  const loadGradedNotes = async () => {
    try {
      setLoadingGraded(true)
      const data = await notesAPI.getAllNotes(null, 'uploaded')
      setGradedNotes(data.notes || [])
    } catch (err) { showNotif(`Failed to load graded notes: ${err.message}`, 'error') }
    finally { setLoadingGraded(false) }
  }

  useEffect(() => { loadProviders() }, [])
  useEffect(() => { if (activeTab === 'graded') loadGradedNotes() }, [activeTab])

  const openNote = (note) => {
    setSelectedNote(note)
    // Load existing grade if already graded
    if (note.status === 'uploaded' && note.grade) {
      setScores({ accuracy: note.grade.accuracy || 88, completeness: note.grade.completeness || 92, terminology: note.grade.terminology || 85, formatting: note.grade.formatting || 95 })
      setComment(note.grade.comment || '')
    } else {
      setScores({ accuracy: 88, completeness: 92, terminology: 85, formatting: 95 })
      setComment('')
    }
    setScreen('review')
  }

  const handleSubmit = async () => {
    if (!comment.trim()) { showNotif('Please write a comment before submitting.', 'error'); return }
    try {
      setSubmitting(true)
      await notesAPI.submitGrade({
        note_id:      selectedNote.id,
        accuracy:     scores.accuracy,
        completeness: scores.completeness,
        terminology:  scores.terminology,
        formatting:   scores.formatting,
        comment,
      })
      setNotes(prev => prev.map(n => n.id === selectedNote.id ? { ...n, status: 'uploaded' } : n))
      showNotif('Grade submitted successfully')
      setTimeout(() => {
        setScreen('recordings')
        setComment('')
        setScores({ accuracy: 88, completeness: 92, terminology: 85, formatting: 95 })
      }, 1500)
    } catch (err) { showNotif(`Failed to submit: ${err.message}`, 'error') }
    finally { setSubmitting(false) }
  }

  const handleNav = (tab) => {
    sidebar.close()
    setActiveTab(tab)
    if (tab === 'notes') selectedProvider ? setScreen('recordings') : setScreen('provider')
    else setScreen(tab)
  }

  // ─── SIDEBAR ──────────────────────────────────────

  const Sidebar = () => (
    <>
      <ConfirmDialog
        dialog={confirmDialog}
        loading={confirmLoading}
        onDismiss={() => !confirmLoading && setConfirmDialog(null)}
        onConfirm={runConfirm}
      />
      <aside
        id="qps-sidebar"
        className={`sf-sidebar sf-sidebar--rich adm-sidebar${sidebar.open ? ' open' : ''}`}
        aria-hidden={drawerMode ? !sidebar.open : undefined}
      >
      <div className="sf-sidebar-top sf-sidebar-rich__top">
        <PortalSidebarBrand branding={branding} subtitle="QPS Portal" />
      </div>
      <p className="sf-sidebar-rich__nav-label">Workspace</p>
      <nav className="sf-nav sf-sidebar-rich__nav" aria-label="Main">
        {[['notes','📋','Notes'],['graded','⭐','Graded'],['profile','👤','Profile']].map(([k, icon, label]) => (
          <div
            key={k}
            role="button"
            tabIndex={0}
            className={`sf-nav-item sf-sidebar-rich__nav-item${activeTab === k ? ' active' : ''}`}
            onClick={() => handleNav(k)}
            onKeyDown={(e) => (e.key === 'Enter' || e.key === ' ') && handleNav(k)}
          >
            <span className="sf-sidebar-rich__nav-ico">{icon}</span>
            <span className="sf-sidebar-rich__nav-text">{label}</span>
            {k === 'graded' && gradedNotes.length > 0 ? (
              <span className="sf-sidebar-rich__nav-badge sf-sidebar-rich__nav-badge--subtle">{gradedNotes.length}</span>
            ) : null}
          </div>
        ))}
      </nav>
      {selectedProvider && activeTab === 'notes' && (
        <div className="sf-provider-chip">
          <div className="sf-chip-label">Current Provider</div>
          <div className="sf-chip-name">{selectedProvider.name}</div>
          <div className="sf-chip-spec">{selectedProvider.specialty || 'Clinician'}</div>
          <div
            className="sf-chip-change"
            onClick={() => {
              setScreen('provider')
              setSelectedProvider(null)
              setSelectedNote(null)
              setNotes([])
              sidebar.close()
            }}
          >
            Change provider
          </div>
        </div>
      )}
      <div className="sf-sidebar-footer sf-sidebar-rich__footer adm-sidebar-footer">
        <div className="adm-sidebar-footer__card">
          <p className="adm-sidebar-footer__eyebrow">Account</p>
          <p className="adm-sidebar-footer__who">{currentUser.name || 'QPS'}</p>
          <button type="button" className="adm-sidebar-footer__btn" onClick={requestLogout}>
            <span className="adm-sidebar-footer__btn-ico" aria-hidden>
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                <path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4" />
                <polyline points="16 17 21 12 16 7" />
                <line x1="21" y1="12" x2="9" y2="12" />
              </svg>
            </span>
            Sign out
          </button>
        </div>
      </div>
    </aside>
    </>
  )

  // ─── GRADED NOTES ─────────────────────────────────

  if (screen === 'graded') {
    return (
      <div className="sf-page sf-portal adm-shell qps-portal">
        <Sidebar />
        <div className="sf-main sf-portal__main">
          <Overlay open={sidebar.open} onClick={sidebar.close} className="adm-shell-overlay" />
          <PortalTopbar
            drawerMode={drawerMode}
            sidebarOpen={sidebar.open}
            onMenuClick={sidebar.toggle}
            navControlsId="qps-sidebar"
            moduleTitle="Graded Notes"
            brandName={branding.system_name || 'Anot'}
            user={currentUser}
            avatarFallback="Q"
            onViewProfile={() => handleNav('profile')}
            onLogout={requestLogout}
            menuId="qps-account-menu"
          />
          <div className="sf-body">
            <p className="qps-page-intro">
              Your grading archive in one place — reopen any note to review scores, comments, and context.
            </p>
            <div className="qps-graded-banner">
              Tip: Use <strong>View Grade</strong> to reopen rubric scores, your comment, and the full note.
            </div>
            <div className="qps-stats-wrap">
              <div className="sf-stats" style={{ gridTemplateColumns: 'repeat(3, 1fr)' }}>
                <StatCard label="Total Graded"      value={gradedNotes.length} color="#1E293B" />
                <StatCard label="Providers Covered" value={[...new Set(gradedNotes.map(n => n.clinician_id))].length} color="#00C896" />
                <StatCard label="This Month"        value={gradedNotes.filter(n => {
                  const d = new Date(n.updated_at), now = new Date()
                  return d.getMonth() === now.getMonth() && d.getFullYear() === now.getFullYear()
                }).length} color="#4FACFE" />
              </div>
            </div>
            <div className="qps-notes-list-block">
              <div className="sf-section-label">All Graded Notes</div>
              {!loadingGraded && gradedNotes.length > 0 ? (
                <div className="qps-notes-list-thead" aria-hidden>
                  <span>Patient &amp; visit</span>
                  <div className="qps-notes-list-thead__right">
                    <span>Status</span>
                    <span>Action</span>
                  </div>
                </div>
              ) : null}
              {loadingGraded ? <Loading /> : gradedNotes.length === 0 ? (
                <Empty icon="⭐" title="No graded notes yet" sub="Notes you grade will appear here." />
              ) : gradedNotes.map(note => {
              // Use submitted_by name first, fallback to scribe_name
              const scribeName = note.scribe_name || '—'
              return (
                <div key={note.id} className="sf-row">
                  <div className="sf-row-left">
                    <span className="qps-row-icon" aria-hidden>📋</span>
                    <div>
                      <div className="sf-row-name">{note.patient_name}</div>
                      <div className="sf-row-meta">
                        {note.mrn} · {note.visit_type} · {note.visit_date} · {fmtTime(note.visit_time)}
                        {note.duration_seconds ? ` · ${fmtDuration(note.duration_seconds)}` : ''}
                      </div>
                      <div className="qps-row-byline">
                        👨‍⚕️ {note.clinician_name} · 📝 Scribe: <strong>{scribeName}</strong>
                      </div>
                    </div>
                  </div>
                  <div className="sf-row-right">
                    <span className="badge badge-green">Graded</span>
                    <button type="button" className="btn btn-ghost btn-sm" onClick={() => openNote(note)}>View Grade</button>
                  </div>
                </div>
              )
              })}
            </div>
          </div>
        </div>
      </div>
    )
  }

  // ─── PROFILE ──────────────────────────────────────

  if (screen === 'profile') {
    return (
      <div className="sf-page sf-portal adm-shell qps-portal">
        <Sidebar />
        <div className="sf-main sf-portal__main">
          <Overlay open={sidebar.open} onClick={sidebar.close} className="adm-shell-overlay" />
          <PortalTopbar
            drawerMode={drawerMode}
            sidebarOpen={sidebar.open}
            onMenuClick={sidebar.toggle}
            navControlsId="qps-sidebar"
            moduleTitle="My Profile"
            brandName={branding.system_name || 'Anot'}
            user={currentUser}
            avatarFallback="Q"
            onViewProfile={() => handleNav('profile')}
            onLogout={requestLogout}
            menuId="qps-account-menu"
          />
          <div className="sf-body">
            <div className="sf-card sf-card-lg">
              <div className="sf-card__title">My Activity</div>
              <div className="sf-metric-grid">
                {[['Notes Graded', gradedNotes.length, '#4260E9'], ['Providers Reviewed', [...new Set(gradedNotes.map(n => n.clinician_id))].length, '#00C896'], ['Pending Review', notes.filter(n => n.status !== 'uploaded').length, '#FFB547']].map(([l, v, c]) => (
                  <div key={l} className="sf-metric-tile">
                    <div className="sf-metric-tile__val" style={{ color: c }}>{v}</div>
                    <div className="sf-metric-tile__lbl">{l}</div>
                  </div>
                ))}
              </div>
            </div>
            <div style={{ marginTop: 16 }}>
              <SystemProfileManager showToast={showNotif} roleLabel="QPS" compact />
            </div>
          </div>
          {notif && <Notif notif={notif} />}
        </div>
      </div>
    )
  }

  // ─── PROVIDER SELECTION ───────────────────────────

  if (screen === 'provider') {
    return (
      <div className="sf-page sf-portal adm-shell qps-portal">
        <Sidebar />
        <div className="sf-main sf-portal__main">
          <Overlay open={sidebar.open} onClick={sidebar.close} className="adm-shell-overlay" />
          <PortalTopbar
            drawerMode={drawerMode}
            sidebarOpen={sidebar.open}
            onMenuClick={sidebar.toggle}
            navControlsId="qps-sidebar"
            moduleTitle="Select Provider"
            brandName={branding.system_name || 'Anot'}
            user={currentUser}
            avatarFallback="Q"
            onViewProfile={() => handleNav('profile')}
            onLogout={requestLogout}
            menuId="qps-account-menu"
          />
          <div className="sf-body">
            <p className="qps-page-intro">
              Pick a clinician to load their submitted notes. You&apos;ll review what&apos;s pending QA and what&apos;s already been graded for that provider.
            </p>
            <div className="qps-provider-select-block">
              <div className="sf-section-label">Providers</div>
              {loadingProviders ? <Loading /> : providers.length === 0 ? (
                <Empty icon="🏥" title="No providers found" sub="Clinicians need to be registered first." />
              ) : (
                <div className="sf-provider-grid">
                  {providers.map(p => (
                    <div
                      key={p.id}
                      className="sf-provider-card"
                      onClick={() => { setSelectedProvider(p); loadNotes(p.id); setScreen('recordings'); setActiveTab('notes') }}
                      onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); setSelectedProvider(p); loadNotes(p.id); setScreen('recordings'); setActiveTab('notes') } }}
                      role="button"
                      tabIndex={0}
                    >
                      <div className="sf-provider-avatar">{p.name.charAt(0).toUpperCase()}</div>
                      <div className="qps-provider-card__body">
                        <div className="sf-provider-name">{p.name}</div>
                        <div className="sf-provider-spec">{p.specialty || 'Clinician'}</div>
                      </div>
                      <span className="qps-provider-card__chevron" aria-hidden>→</span>
                    </div>
                  ))}
                </div>
              )}
            </div>
          </div>
        </div>
      </div>
    )
  }

  // ─── NOTES LIST ───────────────────────────────────

  if (screen === 'recordings') {
    const pending = notes.filter(n => n.status === 'submitted').length
    const graded  = notes.filter(n => n.status === 'uploaded').length
    return (
      <div className="sf-page sf-portal adm-shell qps-portal">
        <Sidebar />
        <div className="sf-main sf-portal__main">
          <Overlay open={sidebar.open} onClick={sidebar.close} className="adm-shell-overlay" />
          <PortalTopbar
            drawerMode={drawerMode}
            sidebarOpen={sidebar.open}
            onMenuClick={sidebar.toggle}
            navControlsId="qps-sidebar"
            moduleTitle=""
            brandName=""
            user={currentUser}
            avatarFallback="Q"
            onViewProfile={() => handleNav('profile')}
            onLogout={requestLogout}
            menuId="qps-account-menu"
            titleRow={
              <div style={{ display: 'flex', alignItems: 'center', gap: 12, minWidth: 0, flex: 1 }}>
                <span className="sf-back" role="button" tabIndex={0} onClick={() => { setScreen('provider'); setActiveTab('notes') }} onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); setScreen('provider'); setActiveTab('notes') } }}>
                  ← Back
                </span>
                <div className="adm-topbar__titles" style={{ minWidth: 0 }}>
                  <div className="adm-topbar__module">{selectedProvider.name}</div>
                  <div className="adm-topbar__brand">{notes.length} submitted notes</div>
                </div>
              </div>
            }
          />
          <div className="sf-body">
            <p className="qps-page-intro">
              Work the queue for <strong style={{ color: 'var(--text-main)' }}>{selectedProvider.name}</strong> — prioritize notes that still need a grade, or reopen completed reviews.
            </p>
            <div className="qps-stats-wrap">
              <div className="sf-stats" style={{ gridTemplateColumns: 'repeat(3, 1fr)' }}>
                <StatCard label="Total"        value={notes.length} color="#1E293B" />
                <StatCard label="Needs Review" value={pending}      color="#FFB547" />
                <StatCard label="Graded"       value={graded}       color="#00C896" />
              </div>
            </div>
            <div className="qps-notes-list-block">
              <div className="sf-section-label">Submitted Notes</div>
              {!loadingNotes && notes.length > 0 ? (
                <div className="qps-notes-list-thead" aria-hidden>
                  <span>Patient &amp; visit</span>
                  <div className="qps-notes-list-thead__right">
                    <span>Status</span>
                    <span>Action</span>
                  </div>
                </div>
              ) : null}
              {loadingNotes ? <Loading /> : notes.length === 0 ? (
                <Empty icon="📭" title="No notes submitted yet" sub="Notes will appear here after scribes submit them." />
              ) : notes.map(note => {
              const isGr = note.status === 'uploaded'
              const scribeName = note.scribe_name || '—'
              return (
                <div key={note.id} className="sf-row">
                  <div className="sf-row-left">
                    <span className="qps-row-icon" aria-hidden>📄</span>
                    <div>
                      <div className="sf-row-name">{note.patient_name}</div>
                      <div className="sf-row-meta">
                        {note.mrn} · {note.visit_type} · {note.visit_date} · {fmtTime(note.visit_time)}
                        {note.duration_seconds ? ` · ⏱ ${fmtDuration(note.duration_seconds)}` : ''}
                      </div>
                      <div className="qps-row-byline">
                        📝 Scribe: <strong>{scribeName}</strong>
                      </div>
                    </div>
                  </div>
                  <div className="sf-row-right">
                    <span className={`badge ${isGr ? 'badge-green' : 'badge-amber'}`}>
                      {isGr ? 'Graded' : 'Needs Review'}
                    </span>
                    <button type="button" className={`btn btn-sm ${isGr ? 'btn-ghost' : 'btn-navy'}`} onClick={() => openNote(note)}>
                      {isGr ? 'View Grade' : 'Review Note'}
                    </button>
                  </div>
                </div>
              )
              })}
            </div>
          </div>
        </div>
      </div>
    )
  }

  // ─── REVIEW / GRADING ─────────────────────────────

  const scribeName = selectedNote?.scribe_name || 'Unknown Scribe'

  return (
    <div className="sf-page-fixed sf-portal adm-shell qps-portal">
      <Sidebar />
      <div className="sf-main-fixed sf-portal__main">
        <Overlay open={sidebar.open} onClick={sidebar.close} className="adm-shell-overlay" />
        <PortalTopbar
          drawerMode={drawerMode}
          sidebarOpen={sidebar.open}
          onMenuClick={sidebar.toggle}
          navControlsId="qps-sidebar"
          moduleTitle=""
          brandName=""
          user={currentUser}
          avatarFallback="Q"
          onViewProfile={() => handleNav('profile')}
          onLogout={requestLogout}
          menuId="qps-account-menu"
          titleRow={
            <div style={{ display: 'flex', alignItems: 'center', gap: 12, minWidth: 0, flex: 1 }}>
              <span
                className="sf-back"
                role="button"
                tabIndex={0}
                onClick={() => setScreen(activeTab === 'graded' ? 'graded' : 'recordings')}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' || e.key === ' ') {
                    e.preventDefault()
                    setScreen(activeTab === 'graded' ? 'graded' : 'recordings')
                  }
                }}
              >
                ← Back
              </span>
              <div className="adm-topbar__titles" style={{ minWidth: 0 }}>
                <div className="adm-topbar__module">
                  {selectedNote?.patient_name} — {selectedNote?.visit_type}
                </div>
                <div className="adm-topbar__brand">
                  {selectedNote?.mrn} · {selectedNote?.visit_date} · {fmtTime(selectedNote?.visit_time)}
                  {selectedNote?.duration_seconds ? ` · ⏱ ${fmtDuration(selectedNote.duration_seconds)}` : ''}
                  {' · '}📝 <strong>{scribeName}</strong>
                </div>
              </div>
            </div>
          }
        />

        {/* Audio player — uses visit_id, shows duration */}
        <AudioPlayer visitId={selectedNote?.visit_id} durationSecs={selectedNote?.duration_seconds} />

        {notif && (
          <div className={`sf-notif ${notif.type === 'error' ? 'sf-notif-error' : 'sf-notif-green'}`}>
            {notif.type === 'error' ? '⚠ ' : '✓ '}{notif.msg}
          </div>
        )}

        <div className="sf-panels">

          <div className="sf-panel">
            <div className="sf-panel-head">
              <span className="sf-panel-title">Transcription</span>
              <span className="badge badge-gray">Read-only</span>
            </div>
            <div className="sf-panel-body">
              {selectedNote?.transcription ? (
                parseTranscriptionBlocks(selectedNote.transcription).map((block, i) => (
                  <div key={i} className="sf-transcript-block">{block}</div>
                ))
              ) : (
                <div className="qps-panel-empty" role="status">
                  <div className="qps-panel-empty__icon" aria-hidden>🎙</div>
                  <div className="qps-panel-empty__title">Transcription pending</div>
                  <div>Will appear after AI processing.</div>
                </div>
              )}
            </div>
          </div>

          <div className="sf-panel">
            <div className="sf-panel-head">
              <span className="sf-panel-title">Final Note</span>
              <span className="badge badge-blue">by {scribeName}</span>
            </div>
            {selectedNote?.final_note ? (
              <textarea className="sf-textarea sf-textarea-readonly" value={selectedNote.final_note} readOnly />
            ) : (
              <div className="sf-panel-body qps-panel-empty" role="status">
                <div className="qps-panel-empty__icon" aria-hidden>📄</div>
                <div className="qps-panel-empty__title">Note not available</div>
                <div>The scribe has not submitted the final note yet.</div>
              </div>
            )}
          </div>

          <div className="sf-panel">
            <div className="sf-panel-head">
              <span className="sf-panel-title">Grade & Comment</span>
              <span className={`badge ${overallScore >= 90 ? 'badge-green' : overallScore >= 75 ? 'badge-amber' : 'badge-red'}`}>
                Score: {overallScore}
              </span>
            </div>
            <div className="sf-panel-body">
              <div className="sf-callout sf-callout--compact">
                📝 Grading note by <strong style={{ color: '#1E293B' }}>{scribeName}</strong>
              </div>

              {[
                { key: 'accuracy',     label: 'Accuracy' },
                { key: 'completeness', label: 'Completeness' },
                { key: 'terminology',  label: 'Medical Terminology' },
                { key: 'formatting',   label: 'Formatting' },
              ].map(({ key, label }) => (
                <div key={key} className="sf-score-row">
                  <div className="sf-score-label" style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 6 }}>
                    <span>{label}</span>
                    <span style={{ fontSize: 13, fontWeight: 700, color: scores[key] >= 90 ? '#00C896' : scores[key] >= 75 ? '#FFB547' : '#FF5A7A' }}>{scores[key]}</span>
                  </div>
                  <input
                    type="range"
                    min="0"
                    max="100"
                    value={scores[key]}
                    className="sf-slider"
                    onChange={e => !isGraded && setScores({ ...scores, [key]: Number(e.target.value) })}
                    style={{ cursor: isGraded ? 'default' : 'pointer' }}
                    disabled={isGraded}
                  />
                </div>
              ))}

              <div className="sf-overall-box">
                <span className="sf-overall-label">Overall Score</span>
                <span className="sf-overall-val" style={{ color: overallScore >= 90 ? '#00C896' : overallScore >= 75 ? '#FFB547' : '#FF5A7A' }}>{overallScore} / 100</span>
              </div>

              <div className="sf-form-label" style={{ marginBottom: 6 }}>Comment to Scribe *</div>
              <textarea
                className="sf-textarea-field"
                value={comment}
                onChange={e => setComment(e.target.value)}
                placeholder="Write feedback or comments for the scribe..."
                rows={5}
                readOnly={isGraded}
              />
            </div>

            <div className="sf-bottom-bar">
              <button type="button" className="btn btn-sm btn-ghost" onClick={() => setScreen(activeTab === 'graded' ? 'graded' : 'recordings')}>Cancel</button>
              {!isGraded && (
                <button type="button" className="btn btn-sm btn-navy" style={{ marginLeft: 'auto' }} onClick={handleSubmit} disabled={submitting}>
                  {submitting ? 'Submitting...' : 'Submit Grade'}
                </button>
              )}
              {isGraded && <span style={{ fontSize: 12, color: '#047857', fontWeight: 500, marginLeft: 'auto' }}>✓ Already graded</span>}
            </div>
          </div>
        </div>
      </div>
    </div>
  )
}

// ─── HELPER COMPONENTS ────────────────────────────────────────────────────────

function StatCard({ label, value, color }) {
  return (
    <div className="sf-stat">
      <div className="sf-stat-val" style={{ color }}>{value}</div>
      <div className="sf-stat-lbl">{label}</div>
    </div>
  )
}

function Loading() {
  return <div className="sf-loading-placeholder">Loading…</div>
}

function Empty({ icon, title, sub }) {
  return (
    <div className="sf-empty" role="status">
      {icon && <div className="sf-empty-icon">{icon}</div>}
      {title && <div className="sf-empty-title">{title}</div>}
      {sub && <div className="sf-empty-sub">{sub}</div>}
    </div>
  )
}

function Notif({ notif }) {
  return (
    <div style={{ position: 'fixed', bottom: 24, right: 24, zIndex: 999, background: notif.type === 'error' ? '#FFE8ED' : 'linear-gradient(135deg,#4260E9,#7B61FF)', color: notif.type === 'error' ? '#be123c' : '#fff', padding: '12px 20px', borderRadius: 10, fontSize: 13, fontWeight: 500, boxShadow: '0 4px 20px rgba(0,0,0,.15)' }}>
      {notif.type === 'error' ? '⚠ ' : '✓ '}{notif.msg}
    </div>
  )
}
