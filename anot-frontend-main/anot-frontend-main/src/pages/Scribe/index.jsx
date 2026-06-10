import { useState, useEffect, useRef, useCallback, useMemo } from 'react'
import { useNavigate } from 'react-router-dom'
import { useSidebar, Overlay, PortalTopbar, usePortalDrawerMode, useSidebarOffCanvasMode, portalSidebarAriaHidden, ConfirmDialog, PortalSidebarBrand } from '../shared'
import { authAPI, usersAPI, visitsAPI, notesAPI, isAbortError } from '../../services/api'
import { useBranding } from '../../services/branding'
import SystemProfileManager from '../../components/SystemProfileManager'
import PortalAudioPlayer from '../../components/PortalAudioPlayer'
import ScribeFinalNoteEditor from '../../components/ScribeFinalNoteEditor'
import NoteWorkspacePanel from '../../components/NoteWorkspacePanel'
import { cleanAiDraftForDisplay } from '../../utils/aiDraftFormat'
import { useRenderRateWarning } from '../../utils/useRenderRateWarning'
import PortalSidebarFooter from '../../components/PortalSidebarFooter'
import ErrorBoundary, { PortalCrashFallback } from '../../components/ErrorBoundary'
import PortalCalendarDayPreview, { scribeDayPreviewRows } from '../../components/PortalCalendarDayPreview'
import { fmtAppointmentTime } from '../../utils/timeFormat'
import { getCurrentUser } from '../../utils/getCurrentUser'
import { useSessionTimeout } from '../../utils/useSessionTimeout'
import './scribe.css'
import '../portal-sidebar-indigo.css'
import '../portalErrorBoundary.css'

/** Day offsets in the recordings calendar strip (relative to today). */
const DAYS = [-2, -1, 0, 1, 2]

// ─── HELPERS ──────────────────────────────────────────────────────────────────

function localDate(off = 0, fmt = 'input') {
  const d = new Date()
  d.setDate(d.getDate() + off)
  const y = d.getFullYear()
  const m = String(d.getMonth() + 1).padStart(2, '0')
  const day = String(d.getDate()).padStart(2, '0')
  if (fmt === 'input') return `${y}-${m}-${day}`
  if (fmt === 'day') return d.toLocaleDateString('en-US', { weekday: 'short' }).toUpperCase()
  if (fmt === 'date') return String(d.getDate())
  return `${y}-${m}-${day}`
}

function scribeEffectiveStatus(v) {
  return ['submitted', 'uploaded'].includes(v?.note_status) ? v.note_status : v?.status
}

function summarizeVisitsForDay(visits) {
  const counts = { total: 0, pending: 0, submitted: 0, completed: 0, overdue: 0 }
  const list = (visits || []).filter((v) => !['upcoming', 'scheduled', 'in-progress'].includes(v.status))
  for (const v of list) {
    counts.total += 1
    const st = scribeEffectiveStatus(v)
    if (st === 'uploaded') counts.completed += 1
    else if (st === 'submitted') counts.submitted += 1
    else counts.pending += 1
  }
  return counts
}

function scheduleDayPreviewHeading(dayOff, stats) {
  const total = stats && typeof stats.total === 'number' ? stats.total : null
  const countLabel = total == null ? '…' : String(total)
  const suffix = total === 1 ? '' : 's'
  return `${localDate(dayOff, 'day')} ${localDate(dayOff, 'date')} · ${countLabel} visit${suffix}`
}

function ScheduleDayPreview({ dayOff, stats, providerName }) {
  const safeStats = stats && typeof stats === 'object' ? stats : null
  const rows = scribeDayPreviewRows(safeStats) ?? []
  return (
    <ErrorBoundary portalName="Day preview">
      <PortalCalendarDayPreview
        showToday={dayOff === 0}
        heading={scheduleDayPreviewHeading(dayOff, safeStats)}
        providerName={providerName ? `Provider: ${providerName}` : null}
        rows={rows}
        emptyMessage={safeStats ? 'No visits for this provider' : undefined}
        loading={safeStats == null}
        classPrefix="portal-cal-strip"
      />
    </ErrorBoundary>
  )
}

function localDateStr(offsetDays = 0) {
  const d = new Date()
  d.setDate(d.getDate() + offsetDays)
  return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`
}

function addDaysToDateStr(dateStr, delta) {
  if (!dateStr) return localDateStr(delta)
  const [y, m, d] = dateStr.split('-').map(Number)
  const dt = new Date(y, m - 1, d)
  dt.setDate(dt.getDate() + delta)
  return `${dt.getFullYear()}-${String(dt.getMonth() + 1).padStart(2, '0')}-${String(dt.getDate()).padStart(2, '0')}`
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

function fmtDisplayDate(dateStr) {
  if (!dateStr) return ''
  const d = new Date(dateStr)
  if (!Number.isNaN(d.getTime())) {
    return d.toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric' })
  }
  return fmtShortDate(dateStr)
}

function fmtDisplayDateTime(value) {
  if (!value) return ''
  const d = new Date(value)
  if (Number.isNaN(d.getTime())) return fmtDisplayDate(value)
  return d.toLocaleString('en-US', {
    year: 'numeric', month: 'long', day: 'numeric',
    hour: 'numeric', minute: '2-digit',
  })
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

// ─── COMPONENT ────────────────────────────────────────────────────────────────

function Scribe() {
  useRenderRateWarning('Scribe')

  const navigate    = useNavigate()
  const sidebar     = useSidebar()
  const currentUser = useMemo(() => getCurrentUser(), [])
  const sessionTimeoutModal = useSessionTimeout(!!currentUser && Object.keys(currentUser).length > 0)

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
  const [viewingMyNote, setViewingMyNote]         = useState(null)
  const [loadingProviders, setLoadingProviders]   = useState(true)
  const [loadingRecordings, setLoadingRecordings] = useState(false)
  const [loadingNote, setLoadingNote]             = useState(false)
  const [loadingNotes, setLoadingNotes]           = useState(false)
  const [loadingGrades, setLoadingGrades]         = useState(false)
  const [savingDraft, setSavingDraft]             = useState(false)
  const [uploadingToEMR, setUploadingToEMR]       = useState(false)
  const [notif, setNotif]                         = useState(null)
  const [activeRecIdx, setActiveRecIdx]           = useState(0)
  const [txSegments, setTxSegments]               = useState([])
  const [generatingDraft, setGeneratingDraft] = useState(false)
  const [confirmDialog, setConfirmDialog]         = useState(null)
  const [confirmLoading, setConfirmLoading]         = useState(false)
  const [noteRefreshing, setNoteRefreshing]         = useState(false)
  const [dayStats, setDayStats]                   = useState({})

  const [baseline, setBaseline] = useState({ visitId: null, final: '', tx: '' })
  const [recordingsError, setRecordingsError] = useState(null)
  const dayStatsLoadingRef = useRef(new Set())
  const recordingsAbortRef = useRef(null)
  const noteAbortRef = useRef(null)

  const drawerMode = usePortalDrawerMode()
  const offCanvasSidebar = useSidebarOffCanvasMode()
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

  const requestLogout = useCallback(() => {
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
  }, [screen, isDirty, navigate])

  const runConfirm = useCallback(async () => {
    const onConfirm = confirmDialog?.onConfirm
    if (!onConfirm) return
    setConfirmLoading(true)
    try {
      await onConfirm()
    } finally {
      setConfirmLoading(false)
      setConfirmDialog(null)
    }
  }, [confirmDialog])

  const loadDayStats = useCallback(async (dayOff) => {
    if (!selectedProvider?.id) return
    if (dayStatsLoadingRef.current.has(dayOff)) return
    let alreadyLoaded = false
    setDayStats((prev) => {
      if (prev[dayOff] !== undefined && prev[dayOff] !== null) {
        alreadyLoaded = true
        return prev
      }
      return { ...prev, [dayOff]: null }
    })
    if (alreadyLoaded) return
    dayStatsLoadingRef.current.add(dayOff)
    try {
      const data = await visitsAPI.getAll(selectedProvider.id, localDate(dayOff))
      const visits = data.visits || []
      setDayStats((prev) => ({ ...prev, [dayOff]: summarizeVisitsForDay(visits) }))
    } catch {
      setDayStats((prev) => ({
        ...prev,
        [dayOff]: { total: 0, pending: 0, submitted: 0, completed: 0, overdue: 0 },
      }))
    } finally {
      dayStatsLoadingRef.current.delete(dayOff)
    }
  }, [selectedProvider?.id])

  const showNotif = useCallback((msg, type = 'green') => {
    setNotif({ msg, type })
    setTimeout(() => setNotif(null), 3000)
  }, [])

  const loadProviders = async () => {
    try { setLoadingProviders(true); const data = await usersAPI.getMyClinicians(); setProviders(data.clinicians || []) }
    catch { showNotif('Failed to load providers.', 'red') }
    finally { setLoadingProviders(false) }
  }

  const loadRecordings = useCallback(async (providerId, date) => {
    // Cancel any in-flight load so a slow response for a previous
    // provider/date can never overwrite the latest selection.
    recordingsAbortRef.current?.abort()
    const controller = new AbortController()
    recordingsAbortRef.current = controller
    try {
      setLoadingRecordings(true)
      setRecordingsError(null)
      const data = await visitsAPI.getAll(providerId, date, controller.signal)
      if (controller.signal.aborted) return
      const all  = data.visits || []
      setRecordings(all.filter(v => !['upcoming', 'scheduled', 'in-progress'].includes(v.status)))
    } catch (err) {
      if (isAbortError(err) || controller.signal.aborted) return
      setRecordings([])
      setRecordingsError('Could not load recordings. Check your connection and try again later.')
      showNotif('Failed to load recordings.', 'red')
    } finally {
      if (recordingsAbortRef.current === controller) {
        recordingsAbortRef.current = null
        setLoadingRecordings(false)
      }
    }
  }, [showNotif])

  const loadNote = useCallback(
    async (visitId, opts = {}) => {
      const mergeOnly = !!opts.mergeOnly
      // Cancel any in-flight note load so quickly switching recordings can't
      // resolve out of order and show the wrong note in the editor.
      noteAbortRef.current?.abort()
      const controller = new AbortController()
      noteAbortRef.current = controller
      try {
        if (!mergeOnly) setLoadingNote(true)
        const data = await notesAPI.getByVisit(visitId, controller.signal)
        if (controller.signal.aborted) return false
        const n = data.note
        if (mergeOnly) {
          if (n) {
            setNote(n)
            setSelectedRec((prev) =>
              prev && String(prev.id) === String(visitId)
                ? { ...prev, transcription_status: n.transcription_status }
                : prev,
            )
            if (n.transcription) {
              const segs = parseTranscriptions(n.transcription)
              setTxSegments(segs)
            }
          }
          return true
        }
        if (!n) {
          setNote(null)
          setFinalNote('')
          setTxSegments([])
          setBaseline({ visitId: null, final: '', tx: '' })
          return true
        }
        setNote(n)
        setSelectedRec((prev) =>
          prev && String(prev.id) === String(visitId)
            ? { ...prev, transcription_status: n.transcription_status }
            : prev,
        )
        const fn = n.final_note || ''
        setFinalNote(fn)
        const segs = parseTranscriptions(n.transcription)
        setTxSegments(segs)
        markBaseline(visitId, fn, segs)
        return true
      } catch (err) {
        if (isAbortError(err) || controller.signal.aborted) return false
        if (!mergeOnly) {
          setNote(null)
          setFinalNote('')
          setTxSegments([])
          setBaseline({ visitId: null, final: '', tx: '' })
          showNotif('Failed to load note. Please try again.', 'red')
        }
        return false
      } finally {
        if (noteAbortRef.current === controller) {
          noteAbortRef.current = null
          if (!mergeOnly) setLoadingNote(false)
        }
      }
    },
    [markBaseline, showNotif],
  )

  const performNoteRefresh = useCallback(
    async (mode) => {
      if (!selectedRec?.id || noteRefreshing) return
      setNoteRefreshing(true)
      try {
        const ok =
          mode === 'merge'
            ? await loadNote(selectedRec.id, { mergeOnly: true })
            : await loadNote(selectedRec.id, {})
        if (ok) {
          showNotif(mode === 'merge' ? 'Note data updated from server.' : 'Note reloaded from server.')
        }
      } catch (err) {
        showNotif(err.message || 'Refresh failed.', 'red')
      } finally {
        setNoteRefreshing(false)
      }
    },
    [selectedRec?.id, noteRefreshing, loadNote, showNotif],
  )

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
    return () => {
      recordingsAbortRef.current?.abort()
      noteAbortRef.current?.abort()
    }
  }, [])

  useEffect(() => {
    if (activeTab === 'notes')  loadMyNotes()
    if (activeTab === 'grades') loadGrades()
  }, [activeTab]) // eslint-disable-line react-hooks/exhaustive-deps -- tab switch only; loaders intentionally omitted

  useEffect(() => {
    setDayStats({})
    dayStatsLoadingRef.current.clear()
  }, [selectedProvider?.id])

  useEffect(() => {
    if (screen !== 'recordings' || !selectedProvider?.id || !selectedDate) return
    void loadRecordings(selectedProvider.id, selectedDate)
  }, [screen, selectedProvider?.id, selectedDate, loadRecordings])

  const saveDraft = async () => {
    if (!selectedRec?.id) return
    if (!finalNote.trim()) { showNotif('Please write the note before saving.', 'amber'); return }
    try {
      setSavingDraft(true)
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
    finally { setSavingDraft(false) }
  }

  const uploadToEMR = async () => {
    if (!selectedRec?.id) return
    if (!finalNote.trim()) { showNotif('Please write the note before uploading.', 'amber'); return }
    try {
      setUploadingToEMR(true)
      const trans = txSegments.length > 0 ? JSON.stringify(txSegments) : undefined
      const saved = await notesAPI.saveDraft(selectedRec.id, finalNote, trans, note?.ai_draft)
      await notesAPI.submitNote(note?.id || saved.note.id)
      setRecordings(prev => prev.map(r => r.id === selectedRec.id ? { ...r, status: 'submitted' } : r))
      setSelectedRec(prev => ({ ...prev, status: 'submitted' }))
      markBaseline(selectedRec.id, finalNote, txSegments)
      showNotif('Note submitted to clinician.')
    } catch (err) { showNotif(`Upload failed: ${err.message}`, 'red') }
    finally { setUploadingToEMR(false) }
  }

  const runGenerateDraft = async () => {
    const noteDone = ['submitted', 'uploaded'].includes(selectedRec?.note_status ?? selectedRec?.status)
    if (!selectedRec?.id || generatingDraft || noteDone) return
    setGeneratingDraft(true)
    try {
      const data = await visitsAPI.generateDraft(selectedRec.id)
      const draft = data.ai_draft || ''
      setNote((prev) => (prev ? { ...prev, ai_draft: draft } : { ai_draft: draft, visit_id: selectedRec.id }))
    } catch {
      showNotif('Failed to generate. Check API key in Admin settings.', 'red')
    } finally {
      setGeneratingDraft(false)
    }
  }

  useEffect(() => {
    if (screen !== 'note' || !selectedRec?.id) return undefined
    const st = note?.transcription_status || selectedRec?.transcription_status
    if (st !== 'processing') return undefined
    const timer = setInterval(() => {
      void loadNote(selectedRec.id, { mergeOnly: true })
    }, 30000)
    return () => clearInterval(timer)
  }, [screen, selectedRec?.id, selectedRec?.transcription_status, note?.transcription_status, loadNote])

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

  const myNoteToRec = (n) => {
    const visitId = n.visit_id ?? n.id
    const visitDate = n.visit_date ? String(n.visit_date).slice(0, 10) : selectedDate
    return {
      id: visitId,
      patient_name: n.patient_name,
      mrn: n.mrn,
      visit_type: n.visit_type,
      visit_time: n.visit_time,
      visit_date: visitDate,
      duration_seconds: n.duration_seconds,
      note_status: n.status,
      status: n.status,
    }
  }

  const closeNoteView = () => {
    setScreen('notes')
    setViewingMyNote(null)
    setSelectedRec(null)
    setNote(null)
  }

  const openMyNote = (n) => {
    const visitId = n.visit_id ?? n.id
    const isReadOnly = ['submitted', 'uploaded'].includes(n.status)
    const go = () => {
      if (n.clinician_id && n.clinician_name) {
        setSelectedProvider({ id: n.clinician_id, name: n.clinician_name, specialty: '' })
      }
      const visitDate = n.visit_date ? String(n.visit_date).slice(0, 10) : selectedDate
      setSelectedDate(visitDate)
      setSelectedRec(myNoteToRec(n))
      setViewingMyNote(isReadOnly ? n : null)
      void loadNote(visitId)
      setActiveRecIdx(0)
      setScreen(isReadOnly ? 'note-view' : 'note')
    }
    if (screen === 'note' && isDirty && String(selectedRec?.id) !== String(visitId)) {
      leaveNoteScreen(go)
      return
    }
    go()
  }

  const applyEhrUpload = useCallback((updatedNote) => {
    if (!updatedNote) return
    const noteId = updatedNote.id
    const visitId = updatedNote.visit_id
    setNote((prev) => (prev && String(prev.id) === String(noteId)
      ? { ...prev, ehr_uploaded_at: updatedNote.ehr_uploaded_at, ehr_uploaded_by: updatedNote.ehr_uploaded_by }
      : prev))
    setViewingMyNote((prev) => (prev && String(prev.id) === String(noteId)
      ? { ...prev, ehr_uploaded_at: updatedNote.ehr_uploaded_at, ehr_uploaded_by: updatedNote.ehr_uploaded_by }
      : prev))
    setMyNotes((prev) => prev.map((n) =>
      String(n.id) === String(noteId) || String(n.visit_id) === String(visitId)
        ? { ...n, ehr_uploaded_at: updatedNote.ehr_uploaded_at, ehr_uploaded_by: updatedNote.ehr_uploaded_by }
        : n))
  }, [])

  const requestUploadToEHR = useCallback((noteId) => {
    if (!noteId) return
    setConfirmDialog({
      tone: 'primary',
      title: 'Upload to EHR',
      message: 'Are you sure you want to mark this note as uploaded to EHR?',
      confirmText: 'Upload to EHR',
      cancelText: 'Cancel',
      onConfirm: async () => {
        try {
          const data = await notesAPI.uploadToEHR(noteId)
          applyEhrUpload(data.note)
          showNotif('Note marked as uploaded to EHR.')
        } catch (err) {
          showNotif(err.message || 'Failed to upload to EHR.', 'red')
        }
      },
    })
  }, [applyEhrUpload, showNotif])

  const handleNav = useCallback((tab) => {
    leaveNoteScreen(() => {
      setActiveTab(tab)
      if (tab === 'recordings') {
        if (selectedProvider) setScreen('date')
        else setScreen('providers')
      } else setScreen(tab)
      sidebar.close()
    })
  }, [leaveNoteScreen, selectedProvider, sidebar])

  const handleAudioTabChange = useCallback((idx) => {
    setActiveRecIdx(idx)
  }, [])

  const sidebarMarkup = useMemo(() => (
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
        aria-hidden={portalSidebarAriaHidden(offCanvasSidebar, sidebar.open)}
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
        <PortalSidebarBrand branding={branding} subtitle="Scribe Portal" />
      </div>
      <p className="sf-sidebar-rich__nav-label">Workspace</p>
      <nav className="sf-nav sf-sidebar-rich__nav" aria-label="Main">
        {[['recordings','🎙','Recordings'],['notes','📋','My Notes'],['grades','⭐','My Grades']].map(([k, icon, label]) => (
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
            {k === 'grades' && grades.length > 0 ? <span className="sf-sidebar-rich__nav-badge sf-sidebar-rich__nav-badge--subtle">{grades.length}</span> : null}
          </div>
        ))}
      </nav>
      <div className="scribe-sidebar__fill" aria-hidden="true" />
      <div className="scribe-sidebar__bottom">
        {selectedProvider && (
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
        <PortalSidebarFooter
          userName={currentUser.name || 'Scribe'}
          role="scribe"
          onLogout={requestLogout}
        />
      </div>
    </aside>
    </>
  ), [
    sidebar.open,
    offCanvasSidebar,
    branding,
    activeTab,
    grades.length,
    selectedProvider,
    selectedDate,
    screen,
    currentUser.name,
    confirmDialog,
    confirmLoading,
    leaveNoteScreen,
    requestLogout,
    handleNav,
    runConfirm,
  ])

  const portalToast = notif ? <Notif notif={notif} /> : null

  // ─── MY NOTES ─────────────────────────────────────

  if (screen === 'notes') {
    const byProvider = myNotes.reduce((acc, n) => { const key = n.clinician_name || 'Unknown'; if (!acc[key]) acc[key] = []; acc[key].push(n); return acc }, {})
    return (
      <div className="sf-page sf-portal adm-shell scribe-portal">
        {sidebarMarkup}
        <div className="sf-main sf-portal__main">
          <Overlay open={sidebar.open} onClick={sidebar.close} className="adm-shell-overlay" />
          <PortalTopbar
            drawerMode={drawerMode}
            sidebarOpen={sidebar.open}
            onMenuClick={sidebar.toggle}
            navControlsId="scribe-sidebar"
            moduleTitle="My Notes"
            brandName=""
            user={currentUser}
            avatarFallback="S"
            onViewProfile={() => handleNav('profile')}
            onLogout={requestLogout}
            menuId="scribe-account-menu"
          />
          <div className="sf-body">
            <div className="sf-stats scribe-stats scribe-stats--notes">
              <div className="sf-stat scribe-stat scribe-stat--total"><div className="sf-stat-val">{myNotes.length}</div><div className="sf-stat-lbl">Total</div></div>
              <div className="sf-stat scribe-stat scribe-stat--submitted"><div className="sf-stat-val">{myNotes.filter(n => ['submitted','uploaded'].includes(n.status)).length}</div><div className="sf-stat-lbl">Submitted</div></div>
              <div className="sf-stat scribe-stat scribe-stat--drafts"><div className="sf-stat-val">{myNotes.filter(n => n.status === 'draft').length}</div><div className="sf-stat-lbl">Drafts</div></div>
              <div className="sf-stat scribe-stat scribe-stat--graded"><div className="sf-stat-val">{myNotes.filter(n => n.status === 'uploaded').length}</div><div className="sf-stat-lbl">Graded</div></div>
            </div>
            {loadingNotes ? <Empty icon="⏳" title="Loading..." /> : myNotes.length === 0 ? <Empty icon="📋" title="No notes yet" sub="Notes you write will appear here." /> :
             Object.entries(byProvider).map(([provName, provNotes]) => (
              <div key={provName} className="scribe-notes-group">
                <div className="scribe-notes-group__divider">{provName}</div>
                {provNotes.map(n => {
                  const isPending = ['draft', 'recording-uploaded', 'note-ready'].includes(n.status)
                  const badgeType = n.status === 'uploaded' ? 'graded' : n.status === 'submitted' ? 'submitted' : 'pending'
                  const badgeLabel = n.status === 'uploaded' ? 'Graded' : n.status === 'submitted' ? 'Submitted' : n.status === 'draft' ? 'Draft' : 'Pending'
                  const accentClass = isPending ? 'scribe-note-card--pending' : 'scribe-note-card--done'
                  return (
                    <div
                      key={n.id}
                      role="button"
                      tabIndex={0}
                      className={`scribe-note-card ${accentClass}`}
                      onClick={() => openMyNote(n)}
                      onKeyDown={(e) => {
                        if (e.key === 'Enter' || e.key === ' ') {
                          e.preventDefault()
                          openMyNote(n)
                        }
                      }}
                    >
                      <div className="scribe-note-card__left">
                        <span className="scribe-note-card__icon" aria-hidden>📄</span>
                        <div className="scribe-note-card__info">
                          <div className="scribe-note-card__name">{n.patient_name}</div>
                          <div className="scribe-note-card__meta">
                            {n.mrn} · {fmtDisplayDate(n.visit_date)} · {n.visit_type}
                          </div>
                          <span className={`scribe-status-badge scribe-status-badge--${badgeType}`}>{badgeLabel}</span>
                        </div>
                      </div>
                      <div className="scribe-note-card__actions">
                        <button
                          type="button"
                          className={isPending ? 'scribe-note-btn scribe-note-btn--open' : 'scribe-note-btn scribe-note-btn--view'}
                          onClick={(e) => {
                            e.stopPropagation()
                            openMyNote(n)
                          }}
                        >
                          {isPending ? 'Open Note' : 'View Note'}
                        </button>
                      </div>
                    </div>
                  )
                })}
              </div>
            ))}
          </div>
        </div>
        {portalToast}
      </div>
    )
  }

  // ─── GRADES ───────────────────────────────────────

  if (screen === 'grades') {
    const avgScore = grades.length > 0 ? Math.round(grades.reduce((a, g) => a + (g.overall_score || 0), 0) / grades.length) : 0
    return (
      <div className="sf-page sf-portal adm-shell scribe-portal">
        {sidebarMarkup}
        <div className="sf-main sf-portal__main">
          <Overlay open={sidebar.open} onClick={sidebar.close} className="adm-shell-overlay" />
          <PortalTopbar
            drawerMode={drawerMode}
            sidebarOpen={sidebar.open}
            onMenuClick={sidebar.toggle}
            navControlsId="scribe-sidebar"
            moduleTitle="My Grades"
            brandName=""
            user={currentUser}
            avatarFallback="S"
            onViewProfile={() => handleNav('profile')}
            onLogout={requestLogout}
            menuId="scribe-account-menu"
          />
          <div className="sf-body">
            <div className="sf-stats scribe-stats scribe-stats--grades">
              <div className="sf-stat scribe-stat scribe-stat--notes-graded"><div className="sf-stat-val">{grades.length}</div><div className="sf-stat-lbl">Notes Graded</div></div>
              <div className="sf-stat scribe-stat scribe-stat--avg-score"><div className="sf-stat-val">{avgScore || '—'}</div><div className="sf-stat-lbl">Average Score</div></div>
              <div className="sf-stat scribe-stat scribe-stat--top-score"><div className="sf-stat-val">{grades.length > 0 ? Math.max(...grades.map(g => g.overall_score || 0)) : '—'}</div><div className="sf-stat-lbl">Top Score</div></div>
            </div>
            <p className="scribe-grades-scale">Notes are graded out of 100 by the QPS team based on accuracy, completeness, and clinical language.</p>
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
                      <div className="sf-grade-detail__meta">{selectedGrade.mrn} · {selectedGrade.visit_type} · {fmtDisplayDate(selectedGrade.visit_date)} · {selectedGrade.clinician_name}</div>
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
                  <div><div className="sf-row-name">{g.patient_name}</div><div className="sf-row-meta">{g.mrn} · {g.visit_type} · {fmtDisplayDate(g.visit_date)} · {g.clinician_name}</div>{g.comment && <div style={{ fontSize: 12, color: '#64748B', marginTop: 4, fontStyle: 'italic' }}>"{g.comment.length > 60 ? g.comment.slice(0, 60) + '...' : g.comment}"</div>}</div>
                </div>
                <div className="sf-row-right"><span style={{ fontSize: 12, color: '#4260E9', fontWeight: 500 }}>View →</span></div>
              </div>
            ))}
          </div>
        </div>
        {portalToast}
      </div>
    )
  }

  // ─── PROFILE ──────────────────────────────────────

  if (screen === 'profile') {
    return (
      <div className="sf-page sf-portal adm-shell scribe-portal">
        {sidebarMarkup}
        <div className="sf-main sf-portal__main">
          <Overlay open={sidebar.open} onClick={sidebar.close} className="adm-shell-overlay" />
          <PortalTopbar
            drawerMode={drawerMode}
            sidebarOpen={sidebar.open}
            onMenuClick={sidebar.toggle}
            navControlsId="scribe-sidebar"
            moduleTitle="My Profile"
            brandName=""
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
            <div className="scribe-profile-section" style={{ marginTop: 16 }}>
              <SystemProfileManager
                showToast={showNotif}
                roleLabel="Scribe"
                compact
                className="scribe-profile-card"
                subtitleText="Your name and email are managed by your administrator. You can update your phone number and personal details below."
                fieldPlaceholders={{
                  email: 'your@email.com',
                  phone: '+1 (555) 000-0000',
                  personal_info: 'Add your background, specializations, or preferences...',
                }}
                maskDevEmail
                lockedFields={['name', 'email']}
                saveButtonLabel="Save Changes"
              />
            </div>
          </div>
          {portalToast}
        </div>
      </div>
    )
  }

  // ─── PROVIDER SELECTION ───────────────────────────

  if (screen === 'providers') {
    return (
      <div className="sf-page sf-portal adm-shell scribe-portal">
        {sidebarMarkup}
        <div className="sf-main sf-portal__main">
          <Overlay open={sidebar.open} onClick={sidebar.close} className="adm-shell-overlay" />
          <PortalTopbar
            drawerMode={drawerMode}
            sidebarOpen={sidebar.open}
            onMenuClick={sidebar.toggle}
            navControlsId="scribe-sidebar"
            moduleTitle="Select Provider"
            brandName="Step 1 of 2 — Choose your assigned clinician"
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
        {portalToast}
      </div>
    )
  }

  // ─── DATE SELECTION ───────────────────────────────

  if (screen === 'date') {
    const QUICK = [{ label: 'Today', date: localDateStr(0) },{ label: 'Yesterday', date: localDateStr(-1) },{ label: '2 days ago', date: localDateStr(-2) },{ label: '3 days ago', date: localDateStr(-3) }]
    return (
      <div className="sf-page sf-portal adm-shell scribe-portal">
        {sidebarMarkup}
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
              <div className="scribe-topbar-row">
                <span className="sf-back" onClick={() => { setScreen('providers'); setSelectedProvider(null) }}>
                  ← Back
                </span>
                <div className="adm-topbar__titles">
                  <div className="adm-topbar__module">{selectedProvider?.name}</div>
                  <div className="adm-topbar__brand">Step 2 of 2 — Select a date</div>
                </div>
              </div>
            }
          />
          <div className="sf-body">
            <div className="scribe-date-panel">
              <div className="sf-section-label">Quick Select</div>
              <div className="scribe-date-quick">
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
              <button type="button" className="scribe-date-cta"
                onClick={() => { loadRecordings(selectedProvider.id, selectedDate); setScreen('recordings') }}>
                View Recordings for {fmtShortDate(selectedDate)} →
              </button>
            </div>
          </div>
        </div>
        {portalToast}
      </div>
    )
  }

  // ─── RECORDINGS LIST ──────────────────────────────

  if (screen === 'recordings') {
    const pending   = recordings.filter(r => ['recording-uploaded','note-ready'].includes(r.status)).length
    const submitted = recordings.filter(r => ['submitted','uploaded'].includes(r.status)).length
    return (
      <div className="sf-page sf-portal adm-shell scribe-portal">
        {sidebarMarkup}
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
              <div className="scribe-topbar-row">
                <span className="sf-back" onClick={() => setScreen('date')}>
                  ← Back
                </span>
                <div className="adm-topbar__titles">
                  <div className="adm-topbar__module">{selectedProvider?.name}</div>
                  <div className="adm-topbar__brand">
                    {fmtDateLabel(selectedDate)} · {recordings.length} recording{recordings.length !== 1 ? 's' : ''}
                  </div>
                </div>
              </div>
            }
            endBeforeAccount={
              <button type="button" className="scribe-change-date-btn" onClick={() => setScreen('date')}>
                📅 Change Date
              </button>
            }
          />
          <div className="sf-body">
            <div className="sf-date-nav scribe-date-nav portal-cal-strip">
              <button type="button" className="btn btn-sm scribe-date-nav__arrow portal-cal-strip__arrow portal-cal-strip__arrow--week" onClick={() => setSelectedDate((d) => addDaysToDateStr(d, -7))} aria-label="Previous week">
                ‹‹
              </button>
              <button type="button" className="btn btn-sm scribe-date-nav__arrow portal-cal-strip__arrow" onClick={() => setSelectedDate((d) => addDaysToDateStr(d, -1))} aria-label="Previous day">
                ‹
              </button>
              <div className="sf-date-nav-days scribe-date-nav__days portal-cal-strip__days">
                {DAYS.map((o) => {
                  const stats = dayStats[o]
                  const providerLabel = selectedProvider?.name || null
                  return (
                    <div key={o} className="scribe-date-nav__day-wrap portal-cal-strip__day-wrap">
                      <ScheduleDayPreview dayOff={o} stats={stats} providerName={providerLabel} />
                      <div
                        role="button"
                        tabIndex={0}
                        onMouseEnter={() => void loadDayStats(o)}
                        onFocus={() => void loadDayStats(o)}
                        onClick={() => setSelectedDate(localDate(o, 'input'))}
                        onKeyDown={(e) => (e.key === 'Enter' || e.key === ' ') && setSelectedDate(localDate(o, 'input'))}
                        className={`sf-date-nav-day scribe-date-nav__day portal-cal-strip__day${localDate(o, 'input') === selectedDate ? ' active' : ''}${o === 0 ? ' scribe-date-nav__day--today portal-cal-strip__day--today' : ''}`}
                      >
                        <div className="sf-date-nav-day-name portal-cal-strip__day-name">{localDate(o, 'day')}</div>
                        <div className="sf-date-nav-day-date portal-cal-strip__day-num">{localDate(o, 'date')}</div>
                        {o === 0 ? <div className="scribe-date-nav__today-label portal-cal-strip__today-label">Today</div> : null}
                      </div>
                    </div>
                  )
                })}
              </div>
              <button type="button" className="btn btn-sm scribe-date-nav__arrow portal-cal-strip__arrow" onClick={() => setSelectedDate((d) => addDaysToDateStr(d, 1))} disabled={selectedDate >= localDateStr(0)} aria-label="Next day">
                ›
              </button>
              <button type="button" className="btn btn-sm scribe-date-nav__arrow portal-cal-strip__arrow portal-cal-strip__arrow--week" onClick={() => setSelectedDate((d) => addDaysToDateStr(d, 7))} disabled={selectedDate >= localDateStr(0)} aria-label="Next week">
                ››
              </button>
            </div>
            <div className="sf-stats scribe-stats scribe-stats--recordings">
              <div className="sf-stat scribe-stat scribe-stat--total"><div className="sf-stat-val">{recordings.length}</div><div className="sf-stat-lbl">Total</div></div>
              <div className="sf-stat scribe-stat scribe-stat--pending"><div className="sf-stat-val">{pending}</div><div className="sf-stat-lbl">Pending</div></div>
              <div className="sf-stat scribe-stat scribe-stat--submitted"><div className="sf-stat-val">{submitted}</div><div className="sf-stat-lbl">Submitted</div></div>
            </div>
            <div className="sf-section-label">Patient Recordings — {fmtShortDate(selectedDate)}</div>
            {loadingRecordings ? <Empty icon="⏳" title="Loading..." /> :
             recordingsError ? <Empty icon="⚠️" title="Could not load recordings" sub={recordingsError} /> :
             recordings.length === 0 ? <Empty icon="📭" title="No recordings for this date" sub={`No visits found for ${selectedProvider?.name} on ${fmtDateLabel(selectedDate)}`} /> :
             recordings.map(rec => {
              const effectiveStatus = ['submitted','uploaded'].includes(rec.note_status) ? rec.note_status : rec.status
              const s    = STATUS_CFG[effectiveStatus] || { label: effectiveStatus, cls: 'badge-gray' }
              const isDone = ['submitted','uploaded'].includes(effectiveStatus)
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
        {portalToast}
      </div>
    )
  }

  // ─── READ-ONLY NOTE VIEW (My Notes — submitted / graded) ──

  if (screen === 'note-view' && viewingMyNote) {
    const noteId = viewingMyNote.id ?? note?.id
    const grade =
      viewingMyNote.status === 'uploaded'
        ? grades.find((g) => String(g.note_id) === String(noteId))
        : null
    const finalNoteText = note?.final_note || viewingMyNote.final_note || ''
    const submittedRaw = note?.updated_at || viewingMyNote.updated_at
    const submittedLabel = submittedRaw ? fmtDisplayDate(submittedRaw) : '—'
    const statusLabel = viewingMyNote.status === 'uploaded' ? 'Graded' : 'Submitted'
    const ehrUploadedAt = note?.ehr_uploaded_at || viewingMyNote.ehr_uploaded_at || null
    const ehrUploaded = !!ehrUploadedAt

    return (
      <div className="sf-page sf-portal adm-shell scribe-portal">
        {sidebarMarkup}
        <div className="sf-main sf-portal__main">
          <Overlay open={sidebar.open} onClick={sidebar.close} className="adm-shell-overlay" />
          <PortalTopbar
            drawerMode={drawerMode}
            sidebarOpen={sidebar.open}
            onMenuClick={sidebar.toggle}
            navControlsId="scribe-sidebar"
            moduleTitle="View Note"
            brandName=""
            user={currentUser}
            avatarFallback="S"
            onViewProfile={() => handleNav('profile')}
            onLogout={requestLogout}
            menuId="scribe-account-menu"
          />
          <div className="sf-body scribe-note-readonly-page">
            <button type="button" className="sf-back scribe-note-readonly__back" onClick={closeNoteView}>
              ← Back to My Notes
            </button>
            <article className="scribe-note-readonly">
              <header className="scribe-note-readonly__head">
                <div className="scribe-note-readonly__patient">{viewingMyNote.patient_name}</div>
                <div className="scribe-note-readonly__meta">
                  {viewingMyNote.mrn} · {fmtDisplayDate(viewingMyNote.visit_date)} · {viewingMyNote.visit_type}
                  {viewingMyNote.clinician_name ? ` · ${viewingMyNote.clinician_name}` : ''}
                </div>
                <div className="scribe-note-readonly__submitted">
                  <span className={`scribe-status-badge scribe-status-badge--${viewingMyNote.status === 'uploaded' ? 'graded' : 'submitted'}`}>
                    {statusLabel}
                  </span>
                  <span className="scribe-note-readonly__submitted-date">Submitted {submittedLabel}</span>
                  {ehrUploaded ? (
                    <span className="scribe-status-badge scribe-status-badge--ehr">✓ Uploaded to EHR</span>
                  ) : null}
                </div>
                <div className="scribe-note-readonly__ehr">
                  {ehrUploaded ? (
                    <>
                      <button type="button" className="btn btn-navy" disabled>
                        ✓ Uploaded to EHR
                      </button>
                      <span className="scribe-note-readonly__ehr-date">
                        Uploaded {fmtDisplayDateTime(ehrUploadedAt)}
                      </span>
                    </>
                  ) : (
                    <button
                      type="button"
                      className="btn btn-navy"
                      onClick={() => requestUploadToEHR(noteId)}
                      disabled={loadingNote || !noteId}
                    >
                      Upload to EHR
                    </button>
                  )}
                </div>
              </header>
              {loadingNote ? (
                <div className="scribe-note-readonly__loading">Loading note…</div>
              ) : finalNoteText ? (
                <ScribeFinalNoteEditor value={finalNoteText} onChange={() => {}} readOnly className="scribe-note-readonly__sections" />
              ) : (
                <div className="scribe-note-readonly__empty">No final note content available.</div>
              )}
              {grade ? (
                <footer className="scribe-note-readonly__grade">
                  <div className="scribe-note-readonly__grade-title">Grade Summary</div>
                  <div className="scribe-note-readonly__score">
                    Overall score: <strong>{grade.overall_score}</strong>/100
                  </div>
                  {grade.comment ? (
                    <div className="scribe-note-readonly__feedback">
                      <div className="scribe-note-readonly__feedback-label">
                        Feedback from QPS{grade.qps_name ? ` (${grade.qps_name})` : ''}
                      </div>
                      <p className="scribe-note-readonly__feedback-text">{grade.comment}</p>
                    </div>
                  ) : null}
                </footer>
              ) : null}
            </article>
          </div>
        </div>
        {portalToast}
      </div>
    )
  }

  // ─── NOTE EDITOR ──────────────────────────────────

  if (screen !== 'note') return null

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
    <div className="sf-page-fixed sf-portal adm-shell scribe-portal">
      {sessionTimeoutModal}
      {sidebarMarkup}
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
              <div className="scribe-topbar-row">
                <span className="sf-back" onClick={() => leaveNoteScreen(() => setScreen('recordings'))}>
                  ← Back
                </span>
                <div className="adm-topbar__titles">
                <div className="adm-topbar__module">
                  {selectedRec?.patient_name} — {selectedRec?.visit_type}
                </div>
                <div className="adm-topbar__brand">
                  {selectedRec?.mrn} · {selectedProvider?.name}
                  {selectedRec?.visit_time ? ` · Appt. ${fmtAppointmentTime(selectedRec.visit_time)}` : ''} · {fmtDisplayDate(selectedDate)}
                </div>
              </div>
            </div>
          }
        />

        <div className="sf-note-workspace">
          <div className="sf-note-workspace__top">
            <PortalAudioPlayer
              visitId={selectedRec?.id}
              durationSecs={selectedRec?.duration_seconds || 0}
              onTabChange={handleAudioTabChange}
              compact
            />
          </div>
          <div className="sf-note-workspace__panels">
          <NoteWorkspacePanel
            title="Transcription"
            className="sf-note-panel--transcription"
            allowExpand={false}
          >
            <div className="scribe-note-panel-content">
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
                />
              )}
              {!loadingNote && !currentSeg && txSt === 'failed' && (
                <div className="sf-notif sf-notif-amber" style={{ borderRadius: 10, fontSize: 12, lineHeight: 1.6 }}>
                  Transcription could not be completed. Ask an admin to verify the Deepgram API key in Settings, or have the clinician re-record the visit.
                </div>
              )}
              {!loadingNote && !currentSeg && txSt !== 'processing' && txSt !== 'failed' && (
                <div style={{ color: '#64748B', fontSize: 12, lineHeight: 1.6 }}>
                  No transcript yet. Transcription runs automatically once the clinician finishes the visit — this updates on its own.
                </div>
              )}
            </div>
          </NoteWorkspacePanel>

          <NoteWorkspacePanel
            title="AI Draft"
            allowExpand={false}
            badges={
              !isDone ? (
                <button
                  type="button"
                  className="scribe-generate-draft-btn"
                  onClick={runGenerateDraft}
                  disabled={generatingDraft || loadingNote || !selectedRec?.id}
                >
                  {generatingDraft ? (
                    <>
                      <span className="scribe-generate-draft-spin" aria-hidden />
                      Generating...
                    </>
                  ) : (
                    'Generate AI Draft'
                  )}
                </button>
              ) : null
            }
          >
            {loadingNote ? <div style={{ padding: 12, color: '#64748B', fontSize: 13 }}>Loading...</div> :
             note?.ai_draft ? (
              note.ai_draft.startsWith('[AI draft unavailable') ? (
                <div className="scribe-ai-draft-unavailable">{note.ai_draft}</div>
              ) : (
                <ScribeFinalNoteEditor
                  value={cleanAiDraftForDisplay(note.ai_draft)}
                  onChange={() => {}}
                  readOnly
                  className="scribe-ai-draft-readonly"
                />
              )
            ) : (
              <div style={{ padding: 16, color: '#64748B', fontSize: 13, lineHeight: 1.7 }}>
                <div style={{ fontSize: 24, marginBottom: 8 }}>🤖</div>
                <div style={{ fontWeight: 500, color: '#1E293B', marginBottom: 4 }}>AI draft pending</div>
                <div>Will appear after transcription is processed.</div>
              </div>
            )}
          </NoteWorkspacePanel>

          <NoteWorkspacePanel
            title="Final Note"
            className="sf-note-panel--final-note"
            allowExpand={false}
            badges={<span className={`badge ${isDone ? 'badge-green' : 'badge-amber'}`}>{isDone ? 'Submitted' : 'Editing'}</span>}
          >
            {loadingNote ? <div style={{ padding: 12, color: '#64748B', fontSize: 13 }}>Loading...</div> : (
              <textarea
                className="scribe-final-note-textarea"
                value={finalNote}
                onChange={(e) => setFinalNote(e.target.value)}
                readOnly={isDone}
                placeholder="Write the final clinical note here..."
                spellCheck
              />
            )}
            {!isDone && (
              <div className="sf-bottom-bar">
                <button type="button" className="btn scribe-save-draft-btn" onClick={saveDraft} disabled={savingDraft}>{savingDraft ? 'Saving...' : 'Save Draft'}</button>
                <button className="btn btn-teal" style={{ marginLeft: 'auto' }} onClick={uploadToEMR} disabled={uploadingToEMR}>{uploadingToEMR ? 'Uploading...' : 'Upload to EMR'}</button>
              </div>
            )}
            {isDone && (
              <div className="sf-bottom-bar" style={{ justifyContent: 'center' }}>
                <span style={{ fontSize: 13, color: '#047857', fontWeight: 500 }}>✓ Note submitted — clinician has been notified</span>
              </div>
            )}
          </NoteWorkspacePanel>
        </div>
        </div>

        {portalToast}
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

export default function ScribeWithErrorBoundary() {
  return (
    <ErrorBoundary portalName="Scribe portal" fallback={<PortalCrashFallback />}>
      <Scribe />
    </ErrorBoundary>
  )
}
