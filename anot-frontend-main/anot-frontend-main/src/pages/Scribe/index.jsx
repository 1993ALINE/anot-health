import { useState, useEffect, useRef, useCallback, useMemo } from 'react'
import { useNavigate } from 'react-router-dom'
import { useSidebar, Overlay, PortalTopbar, usePortalDrawerMode, ConfirmDialog, PortalSidebarBrand } from '../shared'
import { authAPI, usersAPI, visitsAPI, notesAPI, API_BASE } from '../../services/api'
import { useBranding } from '../../services/branding'
import SystemProfileManager from '../../components/SystemProfileManager'

// ─── HELPERS ──────────────────────────────────────────────────────────────────

function localDateStr(offsetDays = 0) {
  const d = new Date()
  d.setDate(d.getDate() + offsetDays)
  return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`
}

function fmtDateLabel(dateStr) {
  if (!dateStr) return ''
  const [y, m, day] = dateStr.split('-').map(Number)
  return new Date(y, m - 1, day).toLocaleDateString('en-US', { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' })
}

function fmtShortDate(dateStr) {
  if (!dateStr) return ''
  const [y, m, day] = dateStr.split('-').map(Number)
  return new Date(y, m - 1, day).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })
}

function fmtDuration(secs) {
  if (!secs) return '—'
  return `${Math.floor(secs / 60)}:${String(secs % 60).padStart(2, '0')}`
}

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

// Parse transcription stored as JSON array or plain string
function parseTranscriptions(raw) {
  if (!raw) return []
  try {
    const parsed = JSON.parse(raw)
    if (Array.isArray(parsed)) return parsed
    return [parsed]
  } catch {
    return [raw]
  }
}

const STATUS_CFG = {
  'recording-uploaded': { label: 'Pending',   cls: 'badge-amber' },
  'note-ready':         { label: 'Pending',   cls: 'badge-amber' },
  draft:                { label: 'Draft',     cls: 'badge-blue'  },
  submitted:            { label: 'Submitted', cls: 'badge-green' },
  uploaded:             { label: 'Graded',    cls: 'badge-green' },
}

function ScoreBar({ value }) {
  if (!value) return <span style={{ color: '#B4B2A9', fontSize: 12 }}>—</span>
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
      <div style={{ flex: 1, height: 6, background: '#E2E8F0', borderRadius: 3, overflow: 'hidden' }}>
        <div style={{ width: `${value}%`, height: '100%', borderRadius: 3, background: value >= 90 ? '#00C896' : value >= 75 ? '#FFB547' : '#FF5A7A' }} />
      </div>
      <span style={{ fontSize: 12, fontWeight: 600, color: '#1E293B', minWidth: 28 }}>{value}</span>
    </div>
  )
}

// ─── AUDIO PLAYER ─────────────────────────────────────────────────────────────

function AudioPlayer({ visitId, durationSecs, onTabChange }) {
  const [count, setCount]         = useState(1)
  const [activeIdx, setActiveIdx] = useState(0)
  const [status, setStatus]       = useState('loading')
  const [isPlaying, setPlaying]   = useState(false)
  const [current, setCurrent]     = useState(0)
  const [duration, setDuration]   = useState(durationSecs || 0)
  const audioRef   = useRef(null)
  const blobRef    = useRef(null)
  const maxTimeRef = useRef(durationSecs || 0)

  useEffect(() => {
    if (!visitId) return
    const token = localStorage.getItem('token')
    fetch(`${API_BASE}/audio/${visitId}/count`, {
      headers: { Authorization: `Bearer ${token}` },
    }).then(r => r.json()).then(d => { if (d.count > 0) setCount(d.count) }).catch(() => {})
  }, [visitId])

  useEffect(() => {
    if (!visitId) { setStatus('error'); return }
    const audioEl = audioRef.current
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
        if (audioEl) { audioEl.src = blobRef.current; audioEl.load() }
        setStatus('ready')
      })
      .catch(() => setStatus('error'))
    return () => {
      if (audioEl) { audioEl.pause(); audioEl.src = '' }
      if (blobRef.current) { URL.revokeObjectURL(blobRef.current); blobRef.current = null }
    }
  }, [visitId, activeIdx, durationSecs])

  useEffect(() => {
    const audio = audioRef.current
    if (!audio) return
    const onMeta = () => { const dur = audio.duration; if (dur && isFinite(dur) && dur > 0) { setDuration(Math.floor(dur)); maxTimeRef.current = Math.floor(dur) } }
    const onTime = () => { const cur = Math.floor(audio.currentTime); setCurrent(cur); if (cur > maxTimeRef.current) { maxTimeRef.current = cur; setDuration(cur) } }
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

  const handleTabChange = (i) => {
    setActiveIdx(i)
    if (onTabChange) onTabChange(i)
  }

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
    <div className="sf-audio-bar">
      <audio ref={audioRef} preload="metadata" style={{ display: 'none' }} />
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 10 }}>
        {count > 1 && (
          <div style={{ display: 'flex', gap: 6 }}>
            {Array.from({ length: count }, (_, i) => (
              <button key={i} onClick={() => handleTabChange(i)} style={{ padding: '3px 12px', borderRadius: 6, fontSize: 11, fontWeight: 600, cursor: 'pointer', border: '1px solid', background: activeIdx === i ? 'linear-gradient(135deg,#4260E9,#7B61FF)' : '#EEF2FF', color: activeIdx === i ? '#fff' : '#64748B', borderColor: activeIdx === i ? '#4260E9' : '#E2E8F0' }}>Rec {i + 1}</button>
            ))}
          </div>
        )}
        <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
          <span style={{ fontSize: 12, fontWeight: 600, color: '#1E293B' }}>🎙 Recording {activeIdx + 1}{count > 1 ? ` of ${count}` : ''}</span>
          {status === 'loading' && <span style={{ fontSize: 10, color: '#64748B', background: '#EEF2FF', padding: '2px 7px', borderRadius: 10 }}>Loading...</span>}
          {status === 'ready'   && <span style={{ fontSize: 10, color: '#085041', background: '#E1F5EE', padding: '2px 7px', borderRadius: 10 }}>● Ready</span>}
          {status === 'error'   && <span style={{ fontSize: 10, color: '#64748B', background: '#EEF2FF', padding: '2px 7px', borderRadius: 10 }}>No audio</span>}
        </div>
        <span style={{ marginLeft: 'auto', fontSize: 12, color: '#64748B', fontWeight: 500 }}>{fmtSecs(current)} / {totalStr}</span>
      </div>
      <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 6, flexShrink: 0 }}>
          <button onClick={() => skip(-5)} disabled={!canPlay} style={{ padding: '5px 10px', borderRadius: 6, background: '#EEF2FF', color: '#64748B', border: '1px solid #E2E8F0', fontSize: 11, fontWeight: 600, cursor: canPlay ? 'pointer' : 'not-allowed', opacity: canPlay ? 1 : 0.4, fontFamily: 'inherit' }}>−5s</button>
          <button onClick={toggle} disabled={!canPlay} style={{ width: 38, height: 38, borderRadius: '50%', background: canPlay ? 'linear-gradient(135deg,#4260E9,#7B61FF)' : '#CBD5E1', color: '#fff', border: 'none', fontSize: 14, cursor: canPlay ? 'pointer' : 'not-allowed', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
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

// ─── COMPONENT ────────────────────────────────────────────────────────────────

export default function Scribe() {
  const navigate    = useNavigate()
  const sidebar     = useSidebar()
  const currentUser = JSON.parse(localStorage.getItem('user') || '{}')

  const [screen, setScreen]                       = useState('providers')
  const [activeTab, setActiveTab]                 = useState('recordings')
  const [providers, setProviders]                 = useState([])
  const [selectedProvider, setSelectedProvider]   = useState(null)
  const [selectedDate, setSelectedDate]           = useState(localDateStr(0))
  const [recordings, setRecordings]               = useState([])
  const [selectedRec, setSelectedRec]             = useState(null)
  const [note, setNote]                           = useState(null)
  const [finalNote, setFinalNote]                 = useState('')
  const [myNotes, setMyNotes]                     = useState([])
  const [grades, setGrades]                       = useState([])
  const [selectedGrade, setSelectedGrade]         = useState(null)
  const [loadingProviders, setLoadingProviders]   = useState(true)
  const [loadingRecordings, setLoadingRecordings] = useState(false)
  const [loadingNote, setLoadingNote]             = useState(false)
  const [loadingNotes, setLoadingNotes]           = useState(false)
  const [loadingGrades, setLoadingGrades]         = useState(false)
  const [saving, setSaving]                       = useState(false)
  const [notif, setNotif]                         = useState(null)
  const [activeRecIdx, setActiveRecIdx]           = useState(0)
  const [txSegments, setTxSegments]               = useState([])
  const [transcribeSubmitting, setTranscribeSubmitting] = useState(false)
  const [confirmDialog, setConfirmDialog]         = useState(null)
  const [confirmLoading, setConfirmLoading]         = useState(false)
  const [noteRefreshing, setNoteRefreshing]         = useState(false)

  const [baseline, setBaseline] = useState({ visitId: null, final: '', tx: '' })

  const drawerMode = usePortalDrawerMode()
  const branding = useBranding()

  const markBaseline = useCallback((visitId, final, segments) => {
    const tx = JSON.stringify(Array.isArray(segments) ? segments : [])
    setBaseline({ visitId, final: final ?? '', tx })
  }, [])

  const isDirty = useMemo(() => {
    if (!selectedRec?.id || baseline.visitId !== selectedRec.id) return false
    return finalNote !== baseline.final || JSON.stringify(txSegments) !== baseline.tx
  }, [selectedRec?.id, finalNote, txSegments, baseline])

  const leaveNoteScreen = useCallback(
    (proceed) => {
      if (screen !== 'note' || !isDirty) {
        proceed()
        return
      }
      setConfirmDialog({
        tone: 'danger',
        title: 'Leave without saving?',
        message:
          'You have unsaved edits to this encounter’s note or transcript. Save a draft first, or continue to leave — your changes will be lost.',
        confirmText: 'Leave without saving',
        cancelText: 'Stay',
        onConfirm: proceed,
      })
    },
    [screen, isDirty],
  )

  const requestLogout = () => {
    const dirtyNote = screen === 'note' && isDirty
    setConfirmDialog({
      tone: 'primary',
      title: 'Sign out?',
      message: dirtyNote
        ? 'You have unsaved edits to a note. Signing out will lose those changes unless you saved a draft. You will need to sign in again to use Anot.'
        : 'You will need to sign in again to use Anot.',
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

  const showNotif = (msg, type = 'green') => { setNotif({ msg, type }); setTimeout(() => setNotif(null), 3000) }

  const loadProviders = async () => {
    try { setLoadingProviders(true); const data = await usersAPI.getMyClinicians(); setProviders(data.clinicians || []) }
    catch { showNotif('Failed to load providers.', 'red') }
    finally { setLoadingProviders(false) }
  }

  const loadRecordings = async (providerId, date) => {
    try {
      setLoadingRecordings(true)
      const data = await visitsAPI.getAll(providerId, date)
      const all  = data.visits || []
      setRecordings(all.filter(v => !['upcoming', 'scheduled', 'in-progress'].includes(v.status)))
    } catch { showNotif('Failed to load recordings.', 'red') }
    finally  { setLoadingRecordings(false) }
  }

  const loadNote = useCallback(
    async (visitId, opts = {}) => {
      const mergeOnly = !!opts.mergeOnly
      try {
        if (!mergeOnly) setLoadingNote(true)
        const data = await notesAPI.getByVisit(visitId)
        const n = data.note
        if (mergeOnly) {
          if (n) setNote(n)
          return
        }
        if (!n) {
          setNote(null)
          setFinalNote('')
          setTxSegments([])
          setBaseline({ visitId: null, final: '', tx: '' })
          return
        }
        setNote(n)
        const fn = n.final_note || ''
        setFinalNote(fn)
        const segs = parseTranscriptions(n.transcription)
        setTxSegments(segs)
        markBaseline(visitId, fn, segs)
      } catch {
        if (!mergeOnly) {
          setNote(null)
          setFinalNote('')
          setTxSegments([])
          setBaseline({ visitId: null, final: '', tx: '' })
        }
      } finally {
        if (!mergeOnly) setLoadingNote(false)
      }
    },
    [markBaseline],
  )

  const performNoteRefresh = useCallback(
    async (mode) => {
      if (!selectedRec?.id || noteRefreshing) return
      setNoteRefreshing(true)
      try {
        if (mode === 'merge') await loadNote(selectedRec.id, { mergeOnly: true })
        else await loadNote(selectedRec.id, {})
        showNotif(mode === 'merge' ? 'Note data updated from server.' : 'Note reloaded from server.')
      } catch (err) {
        showNotif(err.message || 'Refresh failed.', 'red')
      } finally {
        setNoteRefreshing(false)
      }
    },
    [selectedRec?.id, noteRefreshing, loadNote],
  )

  const onToolbarRefresh = useCallback(() => {
    if (!selectedRec?.id || noteRefreshing || loadingNote) return
    if (isDirty) {
      setConfirmDialog({
        tone: 'primary',
        title: 'Refresh with unsaved edits?',
        message:
          'We will update transcription status and the AI draft from the server. Your note text and transcript fields will not be overwritten.',
        confirmText: 'Refresh safely',
        cancelText: 'Cancel',
        onConfirm: () => performNoteRefresh('merge'),
      })
      return
    }
    void performNoteRefresh('full')
  }, [selectedRec?.id, noteRefreshing, loadingNote, isDirty, performNoteRefresh])

  const onDiscardReloadFromServer = useCallback(() => {
    if (!selectedRec?.id || noteRefreshing || loadingNote) return
    setConfirmDialog({
      tone: 'danger',
      title: 'Discard local edits and reload?',
      message:
        'Your unsaved note and transcript changes will be replaced by the latest data from the server. This cannot be undone.',
      confirmText: 'Discard and reload',
      cancelText: 'Cancel',
      onConfirm: () => performNoteRefresh('full'),
    })
  }, [selectedRec?.id, noteRefreshing, loadingNote, performNoteRefresh])

  const loadMyNotes = async () => {
    try { setLoadingNotes(true); const data = await notesAPI.getMyNotes(); setMyNotes(data.notes || []) }
    catch { showNotif('Failed to load notes.', 'red') }
    finally { setLoadingNotes(false) }
  }

  const loadGrades = async () => {
    try { setLoadingGrades(true); const data = await notesAPI.getMyGrades(); setGrades(data.grades || []) }
    catch { showNotif('Failed to load grades.', 'red') }
    finally { setLoadingGrades(false) }
  }

  useEffect(() => {
    if (!isDirty) return
    const onBeforeUnload = (e) => {
      e.preventDefault()
      e.returnValue = ''
    }
    window.addEventListener('beforeunload', onBeforeUnload)
    return () => window.removeEventListener('beforeunload', onBeforeUnload)
  }, [isDirty])

  useEffect(() => {
    loadProviders()
  }, []) // eslint-disable-line react-hooks/exhaustive-deps -- initial load only

  useEffect(() => {
    if (activeTab === 'notes')  loadMyNotes()
    if (activeTab === 'grades') loadGrades()
  }, [activeTab]) // eslint-disable-line react-hooks/exhaustive-deps -- tab switch only; loaders intentionally omitted

  const saveDraft = async () => {
    if (!finalNote.trim()) { showNotif('Please write the note before saving.', 'amber'); return }
    try {
      setSaving(true)
      const trans = txSegments.length > 0 ? JSON.stringify(txSegments) : undefined
      const saved = await notesAPI.saveDraft(selectedRec.id, finalNote, trans, note?.ai_draft)
      if (saved.note) {
        setNote(saved.note)
        const fn = saved.note.final_note || ''
        setFinalNote(fn)
        let segs = txSegments
        if (saved.note.transcription != null && String(saved.note.transcription).length > 0) {
          segs = parseTranscriptions(saved.note.transcription)
          setTxSegments(segs)
        }
        markBaseline(selectedRec.id, fn, segs)
      }
      showNotif('Draft saved successfully')
    } catch (err) { showNotif(`Save failed: ${err.message}`, 'red') }
    finally { setSaving(false) }
  }

  const uploadToEMR = async () => {
    if (!finalNote.trim()) { showNotif('Please write the note before uploading.', 'amber'); return }
    try {
      setSaving(true)
      const trans = txSegments.length > 0 ? JSON.stringify(txSegments) : undefined
      const saved = await notesAPI.saveDraft(selectedRec.id, finalNote, trans, note?.ai_draft)
      await notesAPI.submitNote(note?.id || saved.note.id)
      setRecordings(prev => prev.map(r => r.id === selectedRec.id ? { ...r, status: 'submitted' } : r))
      setSelectedRec(prev => ({ ...prev, status: 'submitted' }))
      markBaseline(selectedRec.id, finalNote, txSegments)
      showNotif('Note submitted to clinician.')
    } catch (err) { showNotif(`Upload failed: ${err.message}`, 'red') }
    finally { setSaving(false) }
  }

  const runTranscribe = async () => {
    if (!selectedRec?.id) return
    try {
      setTranscribeSubmitting(true)
      await visitsAPI.runTranscription(selectedRec.id)
      showNotif('Transcription started. Use Refresh when it finishes — your work stays on screen until then.')
      await loadNote(selectedRec.id)
    } catch (err) {
      showNotif(err.message || 'Could not start transcription.', 'red')
    } finally {
      setTranscribeSubmitting(false)
    }
  }

  const openRecording = (rec) => {
    const go = () => {
      setSelectedRec(rec)
      void loadNote(rec.id)
      setActiveRecIdx(0)
      setScreen('note')
    }
    if (screen === 'note' && isDirty && selectedRec?.id !== rec.id) {
      leaveNoteScreen(go)
      return
    }
    go()
  }

  const handleNav = (tab) => {
    leaveNoteScreen(() => {
      setActiveTab(tab)
      if (tab === 'recordings') {
        if (selectedProvider) setScreen('date')
        else setScreen('providers')
      } else setScreen(tab)
      sidebar.close()
    })
  }

  const SidebarEl = () => (
    <>
      <ConfirmDialog
        dialog={confirmDialog}
        loading={confirmLoading}
        onDismiss={() => !confirmLoading && setConfirmDialog(null)}
        onConfirm={runConfirm}
      />
      <aside
        id="scribe-sidebar"
        className={`sf-sidebar sf-sidebar--rich adm-sidebar${sidebar.open ? ' open' : ''}`}
        aria-hidden={drawerMode ? !sidebar.open : undefined}
      >
      <div className="sf-sidebar-top sf-sidebar-rich__top">
        <PortalSidebarBrand branding={branding} subtitle="Scribe Portal" />
      </div>
      <p className="sf-sidebar-rich__nav-label">Workspace</p>
      <nav className="sf-nav sf-sidebar-rich__nav" aria-label="Main">
        {[['recordings','🎙','Recordings'],['notes','📋','My Notes'],['grades','⭐','My Grades'],['profile','👤','Profile']].map(([k, icon, label]) => (
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
            {k === 'grades' && grades.length > 0 ? <span className="sf-sidebar-rich__nav-badge">{grades.length}</span> : null}
          </div>
        ))}
      </nav>
      {selectedProvider && activeTab === 'recordings' && (
        <div className="sf-provider-chip">
          <div className="sf-chip-label">Current Provider</div>
          <div className="sf-chip-name">{selectedProvider.name}</div>
          <div className="sf-chip-spec">{selectedProvider.specialty || 'Clinician'}</div>
          {selectedDate && screen !== 'providers' && (
            <div className="sf-chip-date">📅 {fmtShortDate(selectedDate)}</div>
          )}
          <div
            className="sf-chip-change"
            onClick={() =>
              leaveNoteScreen(() => {
                setScreen('providers')
                setSelectedProvider(null)
                setSelectedRec(null)
                setRecordings([])
                sidebar.close()
              })
            }
          >
            Change provider
          </div>
        </div>
      )}
      <div className="sf-sidebar-footer sf-sidebar-rich__footer adm-sidebar-footer">
        <div className="adm-sidebar-footer__card">
          <p className="adm-sidebar-footer__eyebrow">Account</p>
          <p className="adm-sidebar-footer__who">{currentUser.name || 'Scribe'}</p>
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

  // ─── MY NOTES ─────────────────────────────────────

  if (screen === 'notes') {
    const byProvider = myNotes.reduce((acc, n) => { const key = n.clinician_name || 'Unknown'; if (!acc[key]) acc[key] = []; acc[key].push(n); return acc }, {})
    return (
      <div className="sf-page sf-portal adm-shell">
        <SidebarEl />
        <div className="sf-main sf-portal__main">
          <Overlay open={sidebar.open} onClick={sidebar.close} className="adm-shell-overlay" />
          <PortalTopbar
            drawerMode={drawerMode}
            sidebarOpen={sidebar.open}
            onMenuClick={sidebar.toggle}
            navControlsId="scribe-sidebar"
            moduleTitle="My Notes"
            brandName={branding.system_name || 'Anot'}
            user={currentUser}
            avatarFallback="S"
            onViewProfile={() => handleNav('profile')}
            onLogout={requestLogout}
            menuId="scribe-account-menu"
          />
          <div className="sf-body">
            <div className="sf-stats" style={{ gridTemplateColumns: 'repeat(4,1fr)' }}>
              {[['Total', myNotes.length, '#4260E9'],['Submitted', myNotes.filter(n => ['submitted','uploaded'].includes(n.status)).length, '#00C896'],['Drafts', myNotes.filter(n => n.status === 'draft').length, '#4FACFE'],['Graded', myNotes.filter(n => n.status === 'uploaded').length, '#FFB547']].map(([l, v, c]) => (
                <div key={l} className="sf-stat"><div className="sf-stat-val" style={{ color: c }}>{v}</div><div className="sf-stat-lbl">{l}</div></div>
              ))}
            </div>
            {loadingNotes ? <Empty icon="⏳" title="Loading..." /> : myNotes.length === 0 ? <Empty icon="📋" title="No notes yet" sub="Notes you write will appear here." /> :
             Object.entries(byProvider).map(([provName, provNotes]) => (
              <div key={provName} className="sf-prov-bundle">
                <div className="sf-prov-bundle__head">
                  <div className="sf-prov-bundle__mark">
                    <div className="sf-prov-bundle__dot" aria-hidden />
                    <div>
                      <div className="sf-prov-bundle__name">{provName}</div>
                      <div className="sf-prov-bundle__meta">{provNotes.length} note{provNotes.length !== 1 ? 's' : ''}</div>
                    </div>
                  </div>
                </div>
                {provNotes.map(n => {
                  const s = STATUS_CFG[n.status] || { label: n.status, cls: 'badge-gray' }
                  return (
                    <div key={n.id} className="sf-row">
                      <div className="sf-row-left"><span style={{ fontSize: 20 }}>📄</span><div><div className="sf-row-name">{n.patient_name}</div><div className="sf-row-meta">{n.mrn} · {n.visit_type} · {n.visit_date}</div></div></div>
                      <div className="sf-row-right"><span className={`badge ${s.cls}`}>{s.label}</span></div>
                    </div>
                  )
                })}
              </div>
            ))}
          </div>
        </div>
      </div>
    )
  }

  // ─── GRADES ───────────────────────────────────────

  if (screen === 'grades') {
    const avgScore = grades.length > 0 ? Math.round(grades.reduce((a, g) => a + (g.overall_score || 0), 0) / grades.length) : 0
    return (
      <div className="sf-page sf-portal adm-shell">
        <SidebarEl />
        <div className="sf-main sf-portal__main">
          <Overlay open={sidebar.open} onClick={sidebar.close} className="adm-shell-overlay" />
          <PortalTopbar
            drawerMode={drawerMode}
            sidebarOpen={sidebar.open}
            onMenuClick={sidebar.toggle}
            navControlsId="scribe-sidebar"
            moduleTitle="My Grades"
            brandName={branding.system_name || 'Anot'}
            user={currentUser}
            avatarFallback="S"
            onViewProfile={() => handleNav('profile')}
            onLogout={requestLogout}
            menuId="scribe-account-menu"
          />
          <div className="sf-body">
            <div className="sf-stats" style={{ gridTemplateColumns: 'repeat(3,1fr)' }}>
              {[['Notes Graded', grades.length, '#4260E9'],['Average Score', avgScore || '—', avgScore >= 90 ? '#00C896' : avgScore >= 75 ? '#FFB547' : '#FF5A7A'],['Top Score', grades.length > 0 ? Math.max(...grades.map(g => g.overall_score || 0)) : '—', '#00C896']].map(([l, v, c]) => (
                <div key={l} className="sf-stat"><div className="sf-stat-val" style={{ color: c }}>{v}</div><div className="sf-stat-lbl">{l}</div></div>
              ))}
            </div>
            <div className="sf-section-label">Grade History</div>
            {loadingGrades ? <Empty icon="⏳" title="Loading grades..." /> :
             grades.length === 0 ? <Empty icon="⭐" title="No grades yet" sub="Grades from QPS will appear here once your notes are reviewed." /> :
             selectedGrade ? (
              <div>
                <button type="button" className="sf-back" onClick={() => setSelectedGrade(null)}>← Back to grades</button>
                <div className="sf-card sf-card-lg">
                  <div className="sf-grade-detail__head">
                    <div>
                      <div className="sf-grade-detail__name">{selectedGrade.patient_name}</div>
                      <div className="sf-grade-detail__meta">{selectedGrade.mrn} · {selectedGrade.visit_type} · {selectedGrade.visit_date} · {selectedGrade.clinician_name}</div>
                    </div>
                    <div style={{ fontSize: 36, fontWeight: 700, color: selectedGrade.overall_score >= 90 ? '#4260E9' : selectedGrade.overall_score >= 75 ? '#FFB547' : '#FF5A7A', lineHeight: 1 }}>{selectedGrade.overall_score}<span style={{ fontSize: 14, color: '#64748B', fontWeight: 400 }}>/100</span></div>
                  </div>
                  <div style={{ display: 'flex', flexDirection: 'column', gap: 16, marginBottom: 20 }}>
                    {[['Accuracy', selectedGrade.accuracy],['Completeness', selectedGrade.completeness],['Medical Terminology', selectedGrade.terminology],['Formatting', selectedGrade.formatting]].map(([l, v]) => (
                      <div key={l}>
                        <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 6 }}>
                          <span style={{ fontSize: 13, color: '#1E293B', fontWeight: 500 }}>{l}</span>
                          <span style={{ fontSize: 13, fontWeight: 700, color: v >= 90 ? '#4260E9' : v >= 75 ? '#FFB547' : '#FF5A7A' }}>{v}/100</span>
                        </div>
                        <ScoreBar value={v} />
                      </div>
                    ))}
                  </div>
                  {selectedGrade.comment && (
                    <div className="sf-callout">
                      <div className="sf-callout__label">💬 Feedback from QPS ({selectedGrade.qps_name})</div>
                      <div className="sf-callout__text">{selectedGrade.comment}</div>
                    </div>
                  )}
                  {selectedGrade.final_note && (
                    <div style={{ marginTop: 16 }}>
                      <div className="sf-callout__label">📄 Your Note</div>
                      <pre className="sf-note-preview">{selectedGrade.final_note}</pre>
                    </div>
                  )}
                </div>
              </div>
            ) : grades.map(g => (
              <div key={g.id} className="sf-row" style={{ cursor: 'pointer' }} onClick={() => setSelectedGrade(g)}>
                <div className="sf-row-left">
                  <div style={{ width: 48, height: 48, borderRadius: '50%', flexShrink: 0, display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 16, fontWeight: 700, background: g.overall_score >= 90 ? '#E1F5EE' : g.overall_score >= 75 ? '#FAEEDA' : '#FCEBEB', color: g.overall_score >= 90 ? '#085041' : g.overall_score >= 75 ? '#633806' : '#501313' }}>{g.overall_score}</div>
                  <div><div className="sf-row-name">{g.patient_name}</div><div className="sf-row-meta">{g.mrn} · {g.visit_type} · {g.visit_date} · {g.clinician_name}</div>{g.comment && <div style={{ fontSize: 12, color: '#64748B', marginTop: 4, fontStyle: 'italic' }}>"{g.comment.length > 60 ? g.comment.slice(0, 60) + '...' : g.comment}"</div>}</div>
                </div>
                <div className="sf-row-right"><span style={{ fontSize: 12, color: '#4260E9', fontWeight: 500 }}>View →</span></div>
              </div>
            ))}
          </div>
        </div>
      </div>
    )
  }

  // ─── PROFILE ──────────────────────────────────────

  if (screen === 'profile') {
    return (
      <div className="sf-page sf-portal adm-shell">
        <SidebarEl />
        <div className="sf-main sf-portal__main">
          <Overlay open={sidebar.open} onClick={sidebar.close} className="adm-shell-overlay" />
          <PortalTopbar
            drawerMode={drawerMode}
            sidebarOpen={sidebar.open}
            onMenuClick={sidebar.toggle}
            navControlsId="scribe-sidebar"
            moduleTitle="My Profile"
            brandName={branding.system_name || 'Anot'}
            user={currentUser}
            avatarFallback="S"
            onViewProfile={() => handleNav('profile')}
            onLogout={requestLogout}
            menuId="scribe-account-menu"
          />
          <div className="sf-body">
            <div className="sf-card sf-card-lg">
              <div className="sf-card__title">My Activity</div>
              <div className="sf-metric-grid">
                {[['Notes Written', myNotes.length, '#4260E9'],['Notes Submitted', myNotes.filter(n => ['submitted','uploaded'].includes(n.status)).length, '#00C896'],['Notes Graded', grades.length, '#FFB547']].map(([l, v, c]) => (
                  <div key={l} className="sf-metric-tile">
                    <div className="sf-metric-tile__val" style={{ color: c }}>{v}</div>
                    <div className="sf-metric-tile__lbl">{l}</div>
                  </div>
                ))}
              </div>
            </div>
            <div style={{ marginTop: 16 }}>
              <SystemProfileManager showToast={showNotif} roleLabel="Scribe" compact />
            </div>
          </div>
          {notif && <Notif notif={notif} />}
        </div>
      </div>
    )
  }

  // ─── PROVIDER SELECTION ───────────────────────────

  if (screen === 'providers') {
    return (
      <div className="sf-page sf-portal adm-shell">
        <SidebarEl />
        <div className="sf-main sf-portal__main">
          <Overlay open={sidebar.open} onClick={sidebar.close} className="adm-shell-overlay" />
          <PortalTopbar
            drawerMode={drawerMode}
            sidebarOpen={sidebar.open}
            onMenuClick={sidebar.toggle}
            navControlsId="scribe-sidebar"
            moduleTitle="Select Provider"
            brandName={`Step 1 of 2 — Choose your assigned clinician · ${branding.system_name || 'Anot'}`}
            user={currentUser}
            avatarFallback="S"
            onViewProfile={() => handleNav('profile')}
            onLogout={requestLogout}
            menuId="scribe-account-menu"
          />
          <div className="sf-body">
            {loadingProviders ? <Empty icon="⏳" title="Loading..." /> :
             providers.length === 0 ? <Empty icon="🏥" title="No providers assigned" sub="Ask your admin to assign you to a clinician." /> : (
              <div className="sf-provider-grid">
                {providers.map(p => {
                  const id = p.clinician_id || p.id; const name = p.clinician_name || p.name || 'Unknown'
                  return (
                    <div key={id} className="sf-provider-card" onClick={() => { setSelectedProvider({ id, name, specialty: p.specialty || '' }); setSelectedDate(localDateStr(0)); setScreen('date') }}>
                      <div className="sf-provider-avatar">{(name || 'U').charAt(0).toUpperCase()}</div>
                      <div style={{ flex: 1 }}><div className="sf-provider-name">{name}</div><div className="sf-provider-spec">{p.specialty || 'Clinician'}</div></div>
                      <span style={{ fontSize: 18, color: '#C4C2B9' }}>→</span>
                    </div>
                  )
                })}
              </div>
            )}
          </div>
        </div>
      </div>
    )
  }

  // ─── DATE SELECTION ───────────────────────────────

  if (screen === 'date') {
    const QUICK = [{ label: 'Today', date: localDateStr(0) },{ label: 'Yesterday', date: localDateStr(-1) },{ label: '2 days ago', date: localDateStr(-2) },{ label: '3 days ago', date: localDateStr(-3) }]
    return (
      <div className="sf-page sf-portal adm-shell">
        <SidebarEl />
        <div className="sf-main sf-portal__main">
          <Overlay open={sidebar.open} onClick={sidebar.close} className="adm-shell-overlay" />
          <PortalTopbar
            drawerMode={drawerMode}
            sidebarOpen={sidebar.open}
            onMenuClick={sidebar.toggle}
            navControlsId="scribe-sidebar"
            moduleTitle=""
            brandName=""
            user={currentUser}
            avatarFallback="S"
            onViewProfile={() => handleNav('profile')}
            onLogout={requestLogout}
            menuId="scribe-account-menu"
            titleRow={
              <div style={{ display: 'flex', alignItems: 'center', gap: 12, minWidth: 0, flex: 1 }}>
                <span className="sf-back" onClick={() => { setScreen('providers'); setSelectedProvider(null) }}>
                  ← Back
                </span>
                <div className="adm-topbar__titles" style={{ minWidth: 0 }}>
                  <div className="adm-topbar__module">{selectedProvider?.name}</div>
                  <div className="adm-topbar__brand">Step 2 of 2 — Select a date · {branding.system_name || 'Anot'}</div>
                </div>
              </div>
            }
          />
          <div className="sf-body">
            <div style={{ maxWidth: 480 }}>
              <div className="sf-section-label">Quick Select</div>
              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10, marginBottom: 24 }}>
                {QUICK.map(({ label, date }) => {
                  const isSel = selectedDate === date
                  return (
                    <div key={date} onClick={() => setSelectedDate(date)} style={{ padding: '14px 16px', borderRadius: 12, cursor: 'pointer', border: `2px solid ${isSel ? '#4260E9' : '#E2E8F0'}`, background: isSel ? 'linear-gradient(135deg,#4260E9,#7B61FF)' : '#fff', transition: 'all .15s' }}>
                      <div style={{ fontSize: 14, fontWeight: 600, color: isSel ? '#fff' : '#1E293B' }}>{label}</div>
                      <div style={{ fontSize: 12, color: isSel ? 'rgba(255,255,255,.6)' : '#64748B', marginTop: 3 }}>{fmtShortDate(date)}</div>
                    </div>
                  )
                })}
              </div>
              <div className="sf-section-label">Or Pick a Date</div>
              <input type="date" value={selectedDate} max={localDateStr(0)} onChange={e => setSelectedDate(e.target.value)}
                style={{ width: '100%', padding: '12px 16px', borderRadius: 12, border: '2px solid #E2E8F0', fontSize: 14, color: '#1E293B', outline: 'none', fontFamily: 'inherit', background: '#EEF2FF', boxSizing: 'border-box', marginBottom: 24, cursor: 'pointer' }} />
              {selectedDate && (
                <div style={{ background: '#E1F5EE', border: '1px solid #9FE1CB', borderRadius: 12, padding: '12px 16px', marginBottom: 24 }}>
                  <div style={{ fontSize: 12, color: '#085041', fontWeight: 600, marginBottom: 2 }}>Selected Date</div>
                  <div style={{ fontSize: 14, color: '#1E293B', fontWeight: 500 }}>{fmtDateLabel(selectedDate)}</div>
                </div>
              )}
              <button style={{ width: '100%', padding: '14px', borderRadius: 12, background: 'linear-gradient(135deg,#4260E9,#7B61FF)', color: '#fff', border: 'none', fontSize: 14, fontWeight: 600, cursor: 'pointer', fontFamily: 'inherit', boxShadow: '0 4px 14px rgba(66,96,233,.35)' }}
                onClick={() => { loadRecordings(selectedProvider.id, selectedDate); setScreen('recordings') }}>
                View Recordings for {fmtShortDate(selectedDate)} →
              </button>
            </div>
          </div>
        </div>
      </div>
    )
  }

  // ─── RECORDINGS LIST ──────────────────────────────

  if (screen === 'recordings') {
    const pending   = recordings.filter(r => ['recording-uploaded','note-ready'].includes(r.status)).length
    const submitted = recordings.filter(r => ['submitted','uploaded'].includes(r.status)).length
    return (
      <div className="sf-page sf-portal adm-shell">
        <SidebarEl />
        <div className="sf-main sf-portal__main">
          <Overlay open={sidebar.open} onClick={sidebar.close} className="adm-shell-overlay" />
          <PortalTopbar
            drawerMode={drawerMode}
            sidebarOpen={sidebar.open}
            onMenuClick={sidebar.toggle}
            navControlsId="scribe-sidebar"
            moduleTitle=""
            brandName=""
            user={currentUser}
            avatarFallback="S"
            onViewProfile={() => handleNav('profile')}
            onLogout={requestLogout}
            menuId="scribe-account-menu"
            titleRow={
              <div style={{ display: 'flex', alignItems: 'center', gap: 12, minWidth: 0, flex: 1, flexWrap: 'wrap' }}>
                <span className="sf-back" onClick={() => setScreen('date')}>
                  ← Back
                </span>
                <div className="adm-topbar__titles" style={{ minWidth: 0, flex: '1 1 160px' }}>
                  <div className="adm-topbar__module">{selectedProvider?.name}</div>
                  <div className="adm-topbar__brand">
                    {fmtDateLabel(selectedDate)} · {recordings.length} recording{recordings.length !== 1 ? 's' : ''} ·{' '}
                    {branding.system_name || 'Anot'}
                  </div>
                </div>
              </div>
            }
            endBeforeAccount={
              <button
                type="button"
                onClick={() => setScreen('date')}
                style={{
                  padding: '6px 12px',
                  borderRadius: 8,
                  fontSize: 12,
                  fontWeight: 500,
                  background: '#EEF2FF',
                  color: '#64748B',
                  border: '1px solid #E2E8F0',
                  cursor: 'pointer',
                  fontFamily: 'inherit',
                }}
              >
                📅 Change Date
              </button>
            }
          />
          <div className="sf-body">
            <div className="sf-stats" style={{ gridTemplateColumns: 'repeat(3,1fr)' }}>
              <div className="sf-stat"><div className="sf-stat-val" style={{ color: '#1E293B' }}>{recordings.length}</div><div className="sf-stat-lbl">Total</div></div>
              <div className="sf-stat"><div className="sf-stat-val" style={{ color: '#FFB547' }}>{pending}</div><div className="sf-stat-lbl">Pending</div></div>
              <div className="sf-stat"><div className="sf-stat-val" style={{ color: '#4260E9' }}>{submitted}</div><div className="sf-stat-lbl">Submitted</div></div>
            </div>
            <div className="sf-section-label">Patient Recordings — {fmtShortDate(selectedDate)}</div>
            {loadingRecordings ? <Empty icon="⏳" title="Loading..." /> :
             recordings.length === 0 ? <Empty icon="📭" title="No recordings for this date" sub={`No visits found for ${selectedProvider?.name} on ${fmtDateLabel(selectedDate)}`} /> :
             recordings.map(rec => {
              const effectiveStatus = ['submitted','uploaded'].includes(rec.note_status) ? rec.note_status : rec.status
              const s    = STATUS_CFG[effectiveStatus] || { label: effectiveStatus, cls: 'badge-gray' }
              const isDone = ['submitted','uploaded'].includes(rec.note_status)
              return (
                <div key={rec.id} className="sf-row">
                  <div className="sf-row-left">
                    <span style={{ fontSize: 22 }}>🎙</span>
                    <div>
                      <div className="sf-row-name">{rec.patient_name}</div>
                      <div className="sf-row-meta">{rec.mrn} · {rec.visit_type} · {fmtTime(rec.visit_time)} · {fmtDuration(rec.duration_seconds)}</div>
                    </div>
                  </div>
                  <div className="sf-row-right">
                    <span className={`badge ${s.cls}`}>{s.label}</span>
                    <button className={`btn ${isDone ? 'btn-ghost' : 'btn-navy'}`} onClick={() => openRecording(rec)}>{isDone ? 'View Note' : 'Start Note'}</button>
                  </div>
                </div>
              )
            })}
          </div>
        </div>
      </div>
    )
  }

  // ─── NOTE EDITOR ──────────────────────────────────

  const notePhase = selectedRec?.note_status ?? selectedRec?.status
  const isDone = ['submitted', 'uploaded'].includes(notePhase)
  const currentSeg = txSegments[activeRecIdx] ?? ''
  const txSt = note?.transcription_status || selectedRec?.transcription_status
  const txBadge =
    txSt === 'processing' ? { label: 'Processing', cls: 'badge-blue' }
      : txSt === 'completed' ? { label: 'Completed', cls: 'badge-green' }
        : txSt === 'failed' ? { label: 'Failed', cls: 'badge-gray' }
          : { label: 'Idle', cls: 'badge-amber' }

  return (
    <div className="sf-page-fixed sf-portal adm-shell">
      <SidebarEl />
      <div className="sf-main-fixed sf-portal__main">
        <Overlay open={sidebar.open} onClick={sidebar.close} className="adm-shell-overlay" />
        <PortalTopbar
          drawerMode={drawerMode}
          sidebarOpen={sidebar.open}
          onMenuClick={sidebar.toggle}
          navControlsId="scribe-sidebar"
          moduleTitle=""
          brandName=""
          user={currentUser}
          avatarFallback="S"
          onViewProfile={() => handleNav('profile')}
          onLogout={requestLogout}
          menuId="scribe-account-menu"
          titleRow={
            <div style={{ display: 'flex', alignItems: 'center', gap: 12, minWidth: 0, flex: 1 }}>
              <span className="sf-back" onClick={() => leaveNoteScreen(() => setScreen('recordings'))}>
                ← Back
              </span>
              <div className="adm-topbar__titles" style={{ minWidth: 0 }}>
                <div className="adm-topbar__module">
                  {selectedRec?.patient_name} — {selectedRec?.visit_type}
                </div>
                <div className="adm-topbar__brand">
                  {selectedRec?.mrn} · {selectedProvider?.name} · {fmtTime(selectedRec?.visit_time)} · {selectedDate} ·{' '}
                  {branding.system_name || 'Anot'}
                </div>
              </div>
            </div>
          }
        />

        <div className="sf-note-toolbar" role="toolbar" aria-label="Note data">
          {isDirty ? <span className="sf-note-toolbar__pill">Unsaved changes</span> : null}
          <span className="sf-note-toolbar__hint">
            {txSt === 'processing'
              ? 'Transcription is running on the server. Use Refresh when it completes — your typing is not interrupted.'
              : 'Edits stay in your browser until you save a draft or submit to the clinician.'}
          </span>
          <button
            type="button"
            className="sf-note-toolbar__btn"
            onClick={() => onToolbarRefresh()}
            disabled={noteRefreshing || loadingNote || !selectedRec?.id}
            title={isDirty ? 'Safe refresh: updates status and AI draft from server, keeps your note text' : 'Reload note, transcript, and AI draft from server'}
          >
            {noteRefreshing ? <span className="sf-note-toolbar__spin" aria-hidden /> : (
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" aria-hidden>
                <path d="M21 12a9 9 0 1 1-2.64-6.36" />
                <polyline points="21 3 21 9 15 9" />
              </svg>
            )}
            {noteRefreshing ? 'Refreshing…' : 'Refresh'}
          </button>
          {isDirty ? (
            <button
              type="button"
              className="sf-note-toolbar__btn sf-note-toolbar__btn--danger"
              onClick={onDiscardReloadFromServer}
              disabled={noteRefreshing || loadingNote}
              title="Replace note and transcript with the latest from the server"
            >
              Discard edits and reload
            </button>
          ) : null}
        </div>

        <div className="sf-transcribe-split">
          <div className="sf-transcribe-split__audio">
            <AudioPlayer
              visitId={selectedRec?.id}
              durationSecs={selectedRec?.duration_seconds || 0}
              onTabChange={(idx) => setActiveRecIdx(idx)}
            />
          </div>
          <div className="sf-panel" style={{ borderRadius: 12, border: '1px solid var(--sf-card-edge, #E2E8F0)' }}>
            <div className="sf-panel-head">
              <span className="sf-panel-title">Transcription</span>
              <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap', justifyContent: 'flex-end' }}>
                <span className={`badge ${txBadge.cls}`}>{txBadge.label}</span>
                <span className="badge badge-gray">
                  {txSegments.length > 1 ? `Rec ${activeRecIdx + 1} of ${txSegments.length}` : 'Auto'}
                </span>
              </div>
            </div>
            <div className="sf-panel-body" style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
              {!isDone && (
                <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
                  <button type="button" className="btn btn-navy" disabled={transcribeSubmitting || !selectedRec?.id} onClick={runTranscribe}>
                    {transcribeSubmitting ? 'Starting…' : 'Transcribe audio'}
                  </button>
                </div>
              )}
              {loadingNote ? <div style={{ color: '#64748B', fontSize: 13 }}>Loading...</div> : (
                <textarea
                  className="sf-textarea sf-textarea-transcript"
                  value={currentSeg}
                  onChange={(e) => {
                    const v = e.target.value
                    setTxSegments((prev) => {
                      const next = [...prev]
                      while (next.length <= activeRecIdx) next.push('')
                      next[activeRecIdx] = v
                      return next
                    })
                  }}
                  readOnly={isDone}
                  placeholder="Transcript for this recording appears here after AI processing. You can edit text before saving the draft."
                  spellCheck
                  style={{ minHeight: 200, flex: 1 }}
                />
              )}
              {!loadingNote && !currentSeg && txSt !== 'processing' && (
                <div style={{ color: '#64748B', fontSize: 12, lineHeight: 1.6 }}>
                  No transcript yet. Use &quot;Transcribe audio&quot; or wait for the clinician to finish the visit if auto-transcription is enabled.
                </div>
              )}
            </div>
          </div>
        </div>

        {notif && <div className={`sf-notif sf-notif-${notif.type}`}>✓ {notif.msg}</div>}

        <div className="sf-panels sf-panels--two">
          <div className="sf-panel">
            <div className="sf-panel-head">
              <span className="sf-panel-title">AI Draft</span>
              <span className="badge badge-blue">AI Generated</span>
            </div>
            {loadingNote ? <div style={{ padding: 12, color: '#64748B', fontSize: 13 }}>Loading...</div> :
             note?.ai_draft ? (
              <textarea className="sf-textarea sf-textarea-readonly" value={note.ai_draft} readOnly />
            ) : (
              <div style={{ padding: 16, color: '#64748B', fontSize: 13, lineHeight: 1.7 }}>
                <div style={{ fontSize: 24, marginBottom: 8 }}>🤖</div>
                <div style={{ fontWeight: 500, color: '#1E293B', marginBottom: 4 }}>AI draft pending</div>
                <div>Will appear after transcription is processed.</div>
              </div>
            )}
          </div>

          {/* Final Note */}
          <div className="sf-panel">
            <div className="sf-panel-head">
              <span className="sf-panel-title">Final Note</span>
              <span className={`badge ${isDone ? 'badge-green' : 'badge-amber'}`}>{isDone ? 'Submitted' : 'Editing'}</span>
            </div>
            {loadingNote ? <div style={{ padding: 12, color: '#64748B', fontSize: 13 }}>Loading...</div> : (
              <textarea className="sf-textarea" value={finalNote} onChange={e => setFinalNote(e.target.value)}
                readOnly={isDone} style={isDone ? { background: '#EEF2FF', cursor: 'default' } : {}}
                placeholder={`Write the final clinical note here...\n\nCHIEF COMPLAINT:\n\nHISTORY OF PRESENT ILLNESS (HPI):\n\nPHYSICAL EXAMINATION (PE):\n\nIMAGING:\n\nASSESSMENT & PLAN (A&P):`}
                spellCheck />
            )}
            {!isDone && (
              <div className="sf-bottom-bar">
                <button className="btn btn-amber" onClick={saveDraft} disabled={saving}>{saving ? 'Saving...' : 'Save Draft'}</button>
                <button className="btn btn-teal" style={{ marginLeft: 'auto' }} onClick={uploadToEMR} disabled={saving}>{saving ? 'Uploading...' : 'Upload to EMR'}</button>
              </div>
            )}
            {isDone && (
              <div className="sf-bottom-bar" style={{ justifyContent: 'center' }}>
                <span style={{ fontSize: 13, color: '#047857', fontWeight: 500 }}>✓ Note submitted — clinician has been notified</span>
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  )
}

// ─── HELPERS ──────────────────────────────────────────────────────────────────

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
    <div style={{ position: 'fixed', bottom: 24, right: 24, zIndex: 999, background: notif.type === 'red' ? '#FFE8ED' : 'linear-gradient(135deg,#4260E9,#7B61FF)', color: notif.type === 'red' ? '#be123c' : '#fff', padding: '12px 20px', borderRadius: 10, fontSize: 13, fontWeight: 500, boxShadow: '0 4px 20px rgba(0,0,0,.15)' }}>
      {notif.type === 'red' ? '⚠ ' : '✓ '}{notif.msg}
    </div>
  )
}
