import { useState, useEffect, useCallback } from 'react'
import { useNavigate } from 'react-router-dom'
import { authAPI, usersAPI, notesAPI, adminAPI } from '../../services/api'
import { useBranding } from '../../services/branding'
import SystemProfileManager from '../../components/SystemProfileManager'
import PortalAudioPlayer from '../../components/PortalAudioPlayer'
import NoteWorkspacePanel from '../../components/NoteWorkspacePanel'
import PortalSidebarFooter from '../../components/PortalSidebarFooter'
import { fmtAppointmentTime } from '../../utils/timeFormat'
import { useSidebar, Overlay, PortalTopbar, usePortalDrawerMode, useSidebarOffCanvasMode, portalSidebarAriaHidden, portalSidebarInert, ConfirmDialog, PortalSidebarBrand } from '../shared'
import ErrorBoundary, { PortalCrashFallback } from '../../components/ErrorBoundary'
import { getCurrentUser } from '../../utils/getCurrentUser'
import { useSessionTimeout } from '../../utils/useSessionTimeout'
import './qps.css'
import '../portal-sidebar-indigo.css'
import '../portalErrorBoundary.css'

// ─── HELPERS ──────────────────────────────────────────────────────────────────

function fmtTime(t) {
  if (!t) {return ''}
  const [h, m] = t.split(':')
  const hour = parseInt(h)
  return `${hour > 12 ? hour - 12 : hour === 0 ? 12 : hour}:${m} ${hour >= 12 ? 'PM' : 'AM'}`
}

function fmtQpsDate(d) {
  if (!d) {return '—'}
  const raw = String(d).trim()
  const date = new Date(/^\d{4}-\d{2}-\d{2}$/.test(raw) ? `${raw}T12:00:00` : raw)
  if (Number.isNaN(date.getTime())) {return raw}
  return date.toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric' })
}

function isGradedNote(note) {
  const status = (note?.status || '').toLowerCase()
  return status === 'uploaded' || status === 'graded' || status === 'completed'
}

function qpsNoteListMeta(note) {
  const parts = [note.mrn, note.visit_type, fmtQpsDate(note.visit_date)]
  if (note.visit_time) {parts.push(fmtTime(note.visit_time))}
  return parts.filter(Boolean).join(' · ')
}

/**
 * Validate grade submission input
 */
function validateGradeSubmission(selectedNote, comment) {
  if (!selectedNote?.id) {return { error: 'No note selected' }}
  if (!comment.trim()) {return { error: 'Please write a comment before submitting.' }}
  return { ok: true }
}

/**
 * Build grade API payload
 */
function buildGradePayload(selectedNote, scores, comment) {
  return {
    note_id: selectedNote.id,
    accuracy: scores.accuracy,
    completeness: scores.completeness,
    terminology: scores.terminology,
    formatting: scores.formatting,
    comment,
  }
}

/**
 * Build local grade state after successful submission
 */
function buildLocalGradePayload(scores, comment) {
  return {
    accuracy: scores.accuracy,
    completeness: scores.completeness,
    terminology: scores.terminology,
    formatting: scores.formatting,
    comment,
  }
}

const DEFAULT_QPS_SCORES = { accuracy: 88, completeness: 92, terminology: 85, formatting: 95 }

const QPS_NAV_ITEMS = [
  { key: 'notes', icon: '📋', label: 'Notes' },
  { key: 'graded', icon: '⭐', label: 'Graded', badgeKey: 'graded' },
  { key: 'performance', icon: '📈', label: 'Performance' },
]

function QPSNavItem({ item, activeTab, badge, onNavigate }) {
  return (
    <div
      role="button"
      tabIndex={0}
      className={`sf-nav-item sf-sidebar-rich__nav-item${activeTab === item.key ? ' active' : ''}`}
      onClick={() => onNavigate(item.key)}
      onKeyDown={(e) => (e.key === 'Enter' || e.key === ' ') && onNavigate(item.key)}
    >
      <span className="sf-sidebar-rich__nav-ico">{item.icon}</span>
      <span className="sf-sidebar-rich__nav-text">{item.label}</span>
      {badge > 0 ? (
        <span className="sf-sidebar-rich__nav-badge sf-sidebar-rich__nav-badge--subtle">{badge}</span>
      ) : null}
    </div>
  )
}

/**
 * QPS portal sidebar — navigation, provider chip, logout footer.
 */
function QPSSidebar({
  sidebar,
  offCanvasSidebar,
  branding,
  activeTab,
  gradedCount,
  selectedProvider,
  currentUser,
  confirmDialog,
  confirmLoading,
  onDismissConfirm,
  onConfirm,
  onNavigate,
  onChangeProvider,
  onLogout,
}) {
  return (
    <>
      <ConfirmDialog
        dialog={confirmDialog}
        loading={confirmLoading}
        onDismiss={onDismissConfirm}
        onConfirm={onConfirm}
      />
      <aside
        id="qps-sidebar"
        className={`sf-sidebar sf-sidebar--rich adm-sidebar${sidebar.open ? ' open' : ''}`}
        aria-hidden={portalSidebarAriaHidden(offCanvasSidebar, sidebar.open)}
        inert={portalSidebarInert(offCanvasSidebar, sidebar.open) || undefined}
      >
        <div className="sf-sidebar-top sf-sidebar-rich__top">
          <button
            type="button"
            className="adm-sidebar__close"
            onClick={sidebar.close}
            aria-label="Close navigation menu"
          >
            ✕
          </button>
          <PortalSidebarBrand branding={branding} subtitle="QPS Portal" />
        </div>
        <p className="sf-sidebar-rich__nav-label">Workspace</p>
        <nav className="sf-nav sf-sidebar-rich__nav" aria-label="Main">
          {QPS_NAV_ITEMS.map((item) => (
            <QPSNavItem
              key={item.key}
              item={item}
              activeTab={activeTab}
              badge={item.badgeKey === 'graded' ? gradedCount : 0}
              onNavigate={onNavigate}
            />
          ))}
        </nav>
        <div className="qps-sidebar__fill" aria-hidden="true" />
        <div className="qps-sidebar__bottom">
          {selectedProvider && (
            <div className="sf-provider-chip">
              <div className="sf-chip-label">Current Provider</div>
              <div className="sf-chip-name">{selectedProvider?.name ?? 'Unknown'}</div>
              <div className="sf-chip-spec">{selectedProvider.specialty || 'Clinician'}</div>
              <div className="sf-chip-change" onClick={onChangeProvider}>
                Change provider
              </div>
            </div>
          )}
          <PortalSidebarFooter
            userName={currentUser.name || 'QPS'}
            role="qps"
            onLogout={onLogout}
          />
        </div>
      </aside>
    </>
  )
}

// ─── MAIN COMPONENT ───────────────────────────────────────────────────────────

export default function QPSWithErrorBoundary() {
  return (
    <ErrorBoundary portalName="QPS portal" fallback={<PortalCrashFallback />}>
      <QPS />
    </ErrorBoundary>
  )
}

function QPS() {
  const _navigate    = useNavigate()
  const sidebar     = useSidebar()
  const currentUser = getCurrentUser()
  const sessionTimeoutModal = useSessionTimeout(!!currentUser && Object.keys(currentUser).length > 0)

  const [screen, setScreen]                     = useState('provider')
  const [activeTab, setActiveTab]               = useState('notes')
  const [providers, setProviders]               = useState([])
  const [selectedProvider, setSelectedProvider] = useState(null)
  const [notes, setNotes]                       = useState([])
  const [gradedNotes, setGradedNotes]           = useState([])
  const [performance, setPerformance]           = useState([])
  const [selectedNote, setSelectedNote]         = useState(null)
  const [loadingProviders, setLoadingProviders] = useState(true)
  const [loadingNotes, setLoadingNotes]         = useState(false)
  const [loadingGraded, setLoadingGraded]       = useState(false)
  const [loadingPerformance, setLoadingPerformance] = useState(false)
  const [submitting, setSubmitting]             = useState(false)
  const [notif, setNotif]                       = useState(null)
  const [scores, setScores]                     = useState({ accuracy: 88, completeness: 92, terminology: 85, formatting: 95 })
  const [comment, setComment]                   = useState('')
  const [confirmDialog, setConfirmDialog]       = useState(null)
  const [confirmLoading, setConfirmLoading]     = useState(false)

  const drawerMode = usePortalDrawerMode()
  const offCanvasSidebar = useSidebarOffCanvasMode()
  const branding = useBranding()
  const requestLogout = () => {
    authAPI.logout({ reload: true }).catch(() => {
      globalThis.location.replace('/login')
    })
  }

  const runConfirm = async () => {
    if (!confirmDialog?.onConfirm) {return}
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

  const showNotif = useCallback((msg, type = 'success') => {
    setNotif({ msg, type })
    setTimeout(() => setNotif(null), 3000)
  }, [])

  const loadProviders = useCallback(async () => {
    try {
      setLoadingProviders(true)
      const data = await usersAPI.getByRole('clinician')
      setProviders(data.users || [])
    } catch (err) { showNotif(`Failed to load providers: ${err.message}`, 'error') }
    finally { setLoadingProviders(false) }
  }, [showNotif])

  const loadNotes = async (providerId) => {
    try {
      setLoadingNotes(true)
      const data = await notesAPI.getAllNotes(providerId, null)
      setNotes((data.notes || []).filter(n => ['submitted','uploaded'].includes(n.status)))
    } catch (err) { showNotif(`Failed to load notes: ${err.message}`, 'error') }
    finally { setLoadingNotes(false) }
  }

  const loadGradedNotes = useCallback(async () => {
    try {
      setLoadingGraded(true)
      const data = await notesAPI.getAllNotes(null, 'uploaded')
      setGradedNotes(data.notes || [])
    } catch (err) { showNotif(`Failed to load graded notes: ${err.message}`, 'error') }
    finally { setLoadingGraded(false) }
  }, [showNotif])

  const loadPerformance = async () => {
    try {
      setLoadingPerformance(true)
      const data = await adminAPI.getPerformance()
      setPerformance((data.performance || []).filter(p => p.role === 'scribe'))
    } catch (err) { showNotif(`Failed to load performance: ${err.message}`, 'error') }
    finally { setLoadingPerformance(false) }
  }

  useEffect(() => { loadProviders() }, [loadProviders])
  useEffect(() => { loadGradedNotes() }, [loadGradedNotes])
  useEffect(() => { if (activeTab === 'graded') {loadGradedNotes()} }, [activeTab, loadGradedNotes])
  useEffect(() => { if (activeTab === 'performance') {loadPerformance()} }, [activeTab]) // eslint-disable-line react-hooks/exhaustive-deps

  const openNote = (note) => {
    setSelectedNote(note)
    if (note.grade) {
      setScores({
        accuracy: note.grade.accuracy ?? 88,
        completeness: note.grade.completeness ?? 92,
        terminology: note.grade.terminology ?? 85,
        formatting: note.grade.formatting ?? 95,
      })
      setComment(note.grade.comment ?? '')
    } else {
      setScores({ accuracy: 88, completeness: 92, terminology: 85, formatting: 95 })
      setComment('')
    }
    setScreen('review')
  }

  const handleSubmit = async () => {
    const validation = validateGradeSubmission(selectedNote, comment)
    if (validation.error) {
      showNotif(validation.error, validation.error.includes('comment') ? 'error' : undefined)
      return
    }
    try {
      setSubmitting(true)
      await notesAPI.submitGrade(buildGradePayload(selectedNote, scores, comment))
      const gradePayload = buildLocalGradePayload(scores, comment)
      setNotes(prev => prev.filter(n => n.id !== selectedNote.id))
      setGradedNotes(prev => {
        const next = prev.filter(n => n.id !== selectedNote.id)
        return [{ ...selectedNote, status: 'uploaded', grade: gradePayload }, ...next]
      })
      showNotif('Grade submitted successfully')
      await loadGradedNotes()
      setTimeout(() => {
        setScreen('recordings')
        setComment('')
        setScores({ ...DEFAULT_QPS_SCORES })
      }, 1500)
    } catch (err) {
      showNotif(`Failed to submit: ${err.message}`, 'error')
    } finally {
      setSubmitting(false)
    }
  }

  const handleNav = (tab) => {
    sidebar.close()
    setActiveTab(tab)
    if (tab === 'notes') {selectedProvider ? setScreen('recordings') : setScreen('provider')}
    else {setScreen(tab)}
  }

  // ─── SIDEBAR ──────────────────────────────────────
  // Plain JSX expression (not an inline component): defining a component type
  // inside the render function makes React unmount/remount the whole sidebar
  // subtree on every state change (every keystroke in the grading comment).

  const sidebarMarkup = (
    <QPSSidebar
      sidebar={sidebar}
      offCanvasSidebar={offCanvasSidebar}
      branding={branding}
      activeTab={activeTab}
      gradedCount={gradedNotes.length}
      selectedProvider={selectedProvider}
      currentUser={currentUser}
      confirmDialog={confirmDialog}
      confirmLoading={confirmLoading}
      onDismissConfirm={() => !confirmLoading && setConfirmDialog(null)}
      onConfirm={runConfirm}
      onNavigate={handleNav}
      onChangeProvider={() => {
        setScreen('provider')
        setSelectedProvider(null)
        setSelectedNote(null)
        setNotes([])
        sidebar.close()
      }}
      onLogout={requestLogout}
    />
  )

  const portalToast = notif ? <Notif notif={notif} /> : null

  // ─── GRADED NOTES ─────────────────────────────────

  if (screen === 'graded') {
    return (
      <div className="sf-page sf-portal adm-shell qps-portal">
        {sessionTimeoutModal}
        {sidebarMarkup}
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
              <div className="sf-stats qps-stats--three">
                <StatCard label="Total Graded"      value={gradedNotes.length} variant="graded" />
                <StatCard label="Providers Covered" value={[...new Set(gradedNotes.map(n => n.clinician_id))].length} variant="total" />
                <StatCard label="This Month"        value={gradedNotes.filter(n => {
                  const d = new Date(n.updated_at), now = new Date()
                  return d.getMonth() === now.getMonth() && d.getFullYear() === now.getFullYear()
                }).length} variant="review" />
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
                <div key={note.id} className="sf-row qps-note-card qps-note-card--graded">
                  <div className="sf-row-left">
                    <span className="qps-row-icon" aria-hidden>📋</span>
                    <div>
                      <div className="sf-row-name">{note.patient_name}</div>
                      <div className="sf-row-meta">{qpsNoteListMeta(note)}</div>
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
        {portalToast}
      </div>
    )
  }

  // ─── PERFORMANCE REPORTS ──────────────────────────

  if (screen === 'performance') {
    const avgScore = performance.length
      ? Math.round(performance.reduce((a, p) => a + parseInt(p.overall_avg || 0, 10), 0) / performance.length)
      : 0
    const totalNotes = performance.reduce((a, p) => a + parseInt(p.notes_completed || 0, 10), 0)
    return (
      <div className="sf-page sf-portal adm-shell qps-portal">
        {sessionTimeoutModal}
        {sidebarMarkup}
        <div className="sf-main sf-portal__main">
          <Overlay open={sidebar.open} onClick={sidebar.close} className="adm-shell-overlay" />
          <PortalTopbar
            drawerMode={drawerMode}
            sidebarOpen={sidebar.open}
            onMenuClick={sidebar.toggle}
            navControlsId="qps-sidebar"
            moduleTitle="Performance Reports"
            brandName={branding.system_name || 'Anot'}
            user={currentUser}
            avatarFallback="Q"
            onViewProfile={() => handleNav('profile')}
            onLogout={requestLogout}
            menuId="qps-account-menu"
          />
          <div className="sf-body">
            <p className="qps-page-intro">
              Scribe quality and productivity, aggregated from the grades you submit.
            </p>
            <div className="qps-stats-wrap">
              <div className="sf-stats qps-stats--three">
                <StatCard label="Scribes Tracked"  value={performance.length} variant="total" />
                <StatCard label="Avg Overall Score" value={`${avgScore}%`}     variant="graded" />
                <StatCard label="Notes Completed"   value={totalNotes}         variant="review" />
              </div>
            </div>
            <div className="qps-notes-list-block">
              <div className="sf-section-label">Scribe Performance</div>
              {loadingPerformance ? <Loading /> : performance.length === 0 ? (
                <Empty icon="📈" title="No graded performance yet" sub="Scores appear here once you grade scribe notes." />
              ) : performance.map(p => (
                <div key={p.id} className="sf-row qps-note-card">
                  <div className="sf-row-left">
                    <span className="qps-row-icon" aria-hidden>📝</span>
                    <div>
                      <div className="sf-row-name">{p.name}</div>
                      <div className="sf-row-meta">
                        {p.notes_completed || 0} notes · Accuracy {p.accuracy_avg || 0}% · Completeness {p.completeness_avg || 0}% · Terminology {p.terminology_avg || 0}% · Formatting {p.formatting_avg || 0}%
                      </div>
                    </div>
                  </div>
                  <div className="sf-row-right">
                    <span className="badge badge-green">{p.overall_avg || 0}%</span>
                  </div>
                </div>
              ))}
            </div>
          </div>
        </div>
        {portalToast}
      </div>
    )
  }

  // ─── PROFILE ──────────────────────────────────────

  if (screen === 'profile') {
    return (
      <div className="sf-page sf-portal adm-shell qps-portal">
        {sessionTimeoutModal}
        {sidebarMarkup}
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
                {[['Notes Graded', gradedNotes.length, '#0A3663'], ['Providers Reviewed', [...new Set(gradedNotes.map(n => n.clinician_id))].length, '#00C896'], ['Pending Review', notes.filter(n => n.status !== 'uploaded').length, '#FFB547']].map(([l, v, c]) => (
                  <div key={l} className="sf-metric-tile">
                    <div className="sf-metric-tile__val" style={{ color: c }}>{v}</div>
                    <div className="sf-metric-tile__lbl">{l}</div>
                  </div>
                ))}
              </div>
            </div>
            <div style={{ marginTop: 16 }}>
              <SystemProfileManager showToast={showNotif} roleLabel="QPS" compact readOnly />
            </div>
          </div>
          {portalToast}
        </div>
      </div>
    )
  }

  // ─── PROVIDER SELECTION ───────────────────────────

  if (screen === 'provider') {
    return (
      <div className="sf-page sf-portal adm-shell qps-portal">
        {sessionTimeoutModal}
        {sidebarMarkup}
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
        {portalToast}
      </div>
    )
  }

  // ─── NOTES LIST ───────────────────────────────────

  if (screen === 'recordings') {
    const pendingNotes = notes.filter(n => !isGradedNote(n))
    const gradedCount  = notes.filter(n => isGradedNote(n)).length
    return (
      <div className="sf-page sf-portal adm-shell qps-portal">
        {sessionTimeoutModal}
        {sidebarMarkup}
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
                <span className="sf-back" role="button" tabIndex={0} onClick={() => { setScreen('provider'); setActiveTab('notes'); setSelectedProvider(null) }} onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); setScreen('provider'); setActiveTab('notes'); setSelectedProvider(null) } }}>
                  ← Back
                </span>
                <div className="adm-topbar__titles" style={{ minWidth: 0 }}>
                  <div className="adm-topbar__module">{selectedProvider?.name ?? 'Unknown'}</div>
                  <div className="adm-topbar__brand">{pendingNotes.length} notes need review</div>
                </div>
              </div>
            }
          />
          <div className="sf-body">
            <p className="qps-page-intro">
              Work the review queue for <strong style={{ color: 'var(--text-main)' }}>{selectedProvider?.name ?? 'Unknown'}</strong> — notes listed here still need your grade. Completed reviews are on the Graded tab.
            </p>
            <div className="qps-stats-wrap">
              <div className="sf-stats qps-stats--three">
                <StatCard label="Total"        value={notes.length}        variant="total" />
                <StatCard label="Needs Review" value={pendingNotes.length} variant="review" />
                <StatCard label="Graded"       value={gradedCount}         variant="graded" />
              </div>
            </div>
            <div className="qps-notes-list-block">
              <div className="sf-section-label">Notes Needing Review</div>
              {!loadingNotes && pendingNotes.length > 0 ? (
                <div className="qps-notes-list-thead" aria-hidden>
                  <span>Patient &amp; visit</span>
                  <div className="qps-notes-list-thead__right">
                    <span>Status</span>
                    <span>Action</span>
                  </div>
                </div>
              ) : null}
              {loadingNotes ? <Loading /> : pendingNotes.length === 0 ? (
                <Empty
                  icon="📭"
                  title={notes.length === 0 ? 'No notes submitted yet' : 'All caught up'}
                  sub={notes.length === 0 ? 'Notes will appear here after scribes submit them.' : 'Every note for this provider has been graded. Open the Graded tab to review completed work.'}
                />
              ) : pendingNotes.map(note => {
              const scribeName = note.scribe_name || '—'
              return (
                <div key={note.id} className="sf-row qps-note-card qps-note-card--review">
                  <div className="sf-row-left">
                    <span className="qps-row-icon" aria-hidden>📄</span>
                    <div>
                      <div className="sf-row-name">{note.patient_name}</div>
                      <div className="sf-row-meta">{qpsNoteListMeta(note)}</div>
                      <div className="qps-row-byline">
                        📝 Scribe: <strong>{scribeName}</strong>
                      </div>
                    </div>
                  </div>
                  <div className="sf-row-right">
                    <span className="badge badge-amber">Needs Review</span>
                    <button type="button" className="btn btn-sm btn-navy" onClick={() => openNote(note)}>
                      Review Note
                    </button>
                  </div>
                </div>
              )
              })}
            </div>
          </div>
        </div>
        {portalToast}
      </div>
    )
  }

  // ─── REVIEW / GRADING ─────────────────────────────

  const scribeName = selectedNote?.scribe_name || 'Unknown Scribe'

  return (
    <div className="sf-page-fixed sf-portal adm-shell qps-portal">
      {sessionTimeoutModal}
      {sidebarMarkup}
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
                  {selectedNote?.mrn} · {fmtQpsDate(selectedNote?.visit_date)}{selectedNote?.visit_time ? ` · Appt. ${fmtAppointmentTime(selectedNote.visit_time)}` : ''}
                  {' · '}📝 <strong>{scribeName}</strong>
                </div>
              </div>
            </div>
          }
        />

        <div className="sf-note-workspace">
          <div className="sf-note-workspace__top">
            <PortalAudioPlayer
              visitId={selectedNote?.visit_id}
              durationSecs={selectedNote?.duration_seconds || 0}
              compact
            />
          </div>

          <div className="qps-note-detail-container">
            <div className="qps-note-detail">
              <NoteWorkspacePanel
                title="Final Note"
                className="final-note-panel"
                badges={<span className="badge badge-blue">by {scribeName}</span>}
              >
              {selectedNote?.final_note ? (
                <textarea className="sf-textarea sf-textarea-readonly" value={selectedNote.final_note} readOnly />
              ) : (
                <div className="qps-panel-empty" role="status">
                  <div className="qps-panel-empty__icon" aria-hidden>📄</div>
                  <div className="qps-panel-empty__title">Note not available</div>
                  <div>The scribe has not submitted the final note yet.</div>
                </div>
              )}
            </NoteWorkspacePanel>

              <NoteWorkspacePanel
                title="Grade & Comment"
                className="grade-panel"
                badges={
                <span className={`badge ${overallScore >= 90 ? 'badge-green' : overallScore >= 75 ? 'badge-amber' : 'badge-red'}`}>
                  Score: {overallScore}
                </span>
              }
            >
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

              <div className="sf-bottom-bar">
                <button type="button" className="btn btn-sm btn-ghost" onClick={() => setScreen(activeTab === 'graded' ? 'graded' : 'recordings')}>Cancel</button>
                {!isGraded && (
                  <button type="button" className="btn btn-sm btn-navy" style={{ marginLeft: 'auto' }} onClick={handleSubmit} disabled={submitting}>
                    {submitting ? 'Submitting...' : 'Submit Grade'}
                  </button>
                )}
                {isGraded && <span style={{ fontSize: 12, color: '#047857', fontWeight: 500, marginLeft: 'auto' }}>✓ Already graded</span>}
              </div>
            </NoteWorkspacePanel>
            </div>
          </div>
        </div>

        {portalToast}
      </div>
    </div>
  )
}

// ─── HELPER COMPONENTS ────────────────────────────────────────────────────────

function StatCard({ label, value, variant = 'total' }) {
  return (
    <div className={`sf-stat qps-stat qps-stat--${variant}`}>
      <div className="sf-stat-val qps-stat__val">{value}</div>
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
    <div style={{ position: 'fixed', bottom: 24, right: 24, zIndex: 999, background: notif.type === 'error' ? '#FFE8ED' : 'linear-gradient(135deg,#0A3663,#008080)', color: notif.type === 'error' ? '#be123c' : '#fff', padding: '12px 20px', borderRadius: 10, fontSize: 13, fontWeight: 500, boxShadow: '0 4px 20px rgba(0,0,0,.15)' }}>
      {notif.type === 'error' ? '⚠ ' : '✓ '}{notif.msg}
    </div>
  )
}
