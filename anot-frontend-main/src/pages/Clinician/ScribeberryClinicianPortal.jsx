import { useState, useEffect, useRef, useCallback } from 'react'
import { visitsAPI, patientsAPI, notesAPI, consentAPI } from '../../services/api'
import RecordingVisualizer from '../../components/RecordingVisualizer'
import QuickConsultationModal from '../../components/QuickConsultationModal'
import SaintMaryNoteViewerModal from '../../components/SaintMaryNoteViewerModal'
import { startRecordingKeepAlive, stopRecordingKeepAlive } from '../../utils/recordingKeepAlive'
import { cleanAiDraftForDisplay } from '../../utils/aiDraftFormat'
import { formatClinicalDictationToSOAP, deriveIcd10Codes, deriveCptCodes } from '../../utils/clinicalSoapSynthesizer'
import * as offlineAudioQueue from '../../utils/offlineAudioQueue'
import './ScribeberryClinicianPortal.css'

function normalizeVisitTypeForDb(val) {
  const s = String(val || '').toLowerCase()
  if (s.includes('new')) return 'New Patient'
  if (s.includes('virtual') || s.includes('tele')) return 'Virtual Visit'
  if (s.includes('other')) return 'Other'
  return 'Follow-up'
}

function parseNoteSections(noteText) {
  if (!noteText) return []
  const text = cleanAiDraftForDisplay(noteText)

  const sectionRegex = /^(?:\[?[A-Z0-9\s/&()\-–—]+\]?|[A-Z\s/&()\-–—]+):\s*$/gm
  const matches = []
  let match
  while ((match = sectionRegex.exec(text)) !== null) {
    const rawHeader = match[0].replace(/:$/, '').trim()
    const cleanHeader = rawHeader.replace(/^\[|\]$/g, '').trim()
    if (cleanHeader.length >= 2 && !/^(NOTE|DATE|TIME|MRN|PATIENT|STATUS)/i.test(cleanHeader)) {
      matches.push({ header: cleanHeader, index: match.index, length: match[0].length })
    }
  }

  if (matches.length === 0) {
    return [
      { header: 'CLINICAL NOTE', content: text }
    ]
  }

  const sections = []
  for (let i = 0; i < matches.length; i++) {
    const current = matches[i]
    const next = matches[i + 1]
    const contentStart = current.index + current.length
    const contentEnd = next ? next.index : text.length
    const content = text.slice(contentStart, contentEnd).trim()
    if (content) {
      sections.push({
        header: current.header,
        content: content
      })
    }
  }
  return sections
}

export default function ScribeberryClinicianPortal({ currentUser, onLogout }) {
  const [tab, setTab] = useState('ambient') // 'ambient' | 'dictate' | 'history'
  const [visits, setVisits] = useState([])
  const [patientList, setPatientList] = useState([])
  const [toast, setToast] = useState(null)
  const [searchTerm, setSearchTerm] = useState('')

  // Recording State
  const [activeVisit, setActiveVisit] = useState(null)
  const [isPaused, setIsPaused] = useState(false)
  const [timerSeconds, setTimerSeconds] = useState(0)
  const [uploading, setUploading] = useState(false)
  const [uploadStatus, setUploadStatus] = useState('')
  const [selectedTemplate, setSelectedTemplate] = useState('SOAP Note — Adult')
  const [audioStream, setAudioStream] = useState(null)
  const [liveTranscript, setLiveTranscript] = useState('')

  // Ambient Dictation scratchpad
  const [dictationNotes, setDictationNotes] = useState('')

  // After-recording Review state (1c)
  const [recordedDuration, setRecordedDuration] = useState('00:00')
  const [activeDraftNote, setActiveDraftNote] = useState(null)
  const [selectedAssignPatientId, setSelectedAssignPatientId] = useState('')
  const [isAssigning, setIsAssigning] = useState(false)

  // Quick Dictate tab state
  const [quickDictateText, setQuickDictateText] = useState('')
  const [generatingQuickNote, setGeneratingQuickNote] = useState(false)
  const [quickDictateOutput, setQuickDictateOutput] = useState(null)

  // Note detail modal & workbench preview
  const [previewNote, setPreviewNote] = useState(null)
  const [selectedNoteModal, setSelectedNoteModal] = useState(null)
  const [copied, setCopied] = useState(false)
  const [quickRecOpen, setQuickRecOpen] = useState(false)
  const [generatingAiNoteId, setGeneratingAiNoteId] = useState(null)

  // MediaRecorder & SpeechRecognition refs
  const mediaRecorderRef = useRef(null)
  const speechRecRef = useRef(null)
  const liveTranscriptRef = useRef('')
  const audioChunksRef = useRef([])
  const timerIntervalRef = useRef(null)

  const showToast = useCallback((msg, type = 'success') => {
    setToast({ msg, type })
    setTimeout(() => setToast(null), 3500)
  }, [])

  const fmtTime = (secs) => {
    const m = Math.floor(secs / 60)
    const s = secs % 60
    return `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`
  }

  const loadData = useCallback(async () => {
    try {
      const today = new Date().toISOString().slice(0, 10)
      const [vRes, pRes] = await Promise.all([
        visitsAPI.getByDate(today).catch(() => ({ visits: [] })),
        patientsAPI.getAll().catch(() => ({ patients: [] })),
      ])

      const fetchedVisits = vRes?.visits || []
      const fetchedPatients = pRes?.patients || []

      setVisits(fetchedVisits)
      setPatientList(fetchedPatients)

      // If activeDraftNote is set, make sure it stays synchronized
      if (activeDraftNote) {
        const found = fetchedVisits.find((v) => v.id === activeDraftNote.id)
        if (found && (found.final_note || found.ai_draft)) {
          setActiveDraftNote((prev) => ({
            ...prev,
            final_note: found.final_note || found.ai_draft || prev.final_note,
            ai_draft: found.ai_draft || prev.ai_draft,
            status: found.status || prev.status,
          }))
        }
      }
    } catch {
      /* ignore */
    }
  }, [activeDraftNote])

  useEffect(() => {
    let cancelled = false
    loadData().then(() => {
      if (!cancelled && visits.length > 0 && !activeDraftNote) {
        const withNote = visits.find((v) => v.final_note || v.ai_draft)
        if (withNote) {
          setActiveDraftNote(withNote)
        }
      }
    })

    const id = setInterval(loadData, 15000)
    return () => {
      cancelled = true
      clearInterval(id)
    }
  }, [loadData])

  useEffect(() => {
    return () => {
      clearInterval(timerIntervalRef.current)
      if (speechRecRef.current) {
        try { speechRecRef.current.stop() } catch {}
      }
      if (mediaRecorderRef.current && mediaRecorderRef.current.state !== 'inactive') {
        try {
          mediaRecorderRef.current.stop()
          mediaRecorderRef.current.stream?.getTracks().forEach((t) => t.stop())
        } catch {}
      }
      stopRecordingKeepAlive().catch(() => {})
    }
  }, [])

  const startRecordingSession = async (visit) => {
    if (activeVisit) {
      showToast('A recording is already active.', 'warn')
      return
    }

    try {
      if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
        showToast('Audio recording is not supported on this browser or connection.', 'error')
        return
      }

      if (visit?.id) {
        await consentAPI.recordPatientConsent(visit.id).catch(() => {})
      }

      const stream = await navigator.mediaDevices.getUserMedia({ audio: true })
      const mime = ['audio/ogg;codecs=opus', 'audio/webm;codecs=opus', 'audio/webm'].find(
        (x) => window.MediaRecorder && window.MediaRecorder.isTypeSupported(x)
      ) || ''
      const rec = new window.MediaRecorder(stream, mime ? { mimeType: mime } : {})

      audioChunksRef.current = []
      mediaRecorderRef.current = rec
      setAudioStream(stream)

      rec.ondataavailable = (e) => {
        if (e.data?.size > 0) {
          audioChunksRef.current.push(e.data)
        }
      }

      rec.start(1000)
      startRecordingKeepAlive(stream).catch(() => {})

      // Speech Recognition
      setLiveTranscript('')
      liveTranscriptRef.current = ''
      const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition
      if (SpeechRecognition) {
        try {
          const sr = new SpeechRecognition()
          sr.continuous = true
          sr.interimResults = true
          sr.lang = 'en-US'

          sr.onresult = (event) => {
            let current = ''
            for (let i = 0; i < event.results.length; i++) {
              current += event.results[i][0].transcript + ' '
            }
            const trimmed = current.trim()
            if (trimmed) {
              setLiveTranscript(trimmed)
              liveTranscriptRef.current = trimmed
            }
          }

          sr.onerror = () => {}
          sr.onend = () => {
            if (mediaRecorderRef.current && mediaRecorderRef.current.state === 'recording') {
              try { sr.start() } catch {}
            }
          }

          sr.start()
          speechRecRef.current = sr
        } catch {}
      }

      setActiveVisit(visit)
      setIsPaused(false)
      setTimerSeconds(0)
      setActiveDraftNote(null)

      clearInterval(timerIntervalRef.current)
      timerIntervalRef.current = setInterval(() => {
        setTimerSeconds((prev) => prev + 1)
      }, 1000)

      showToast(`🎙 Live recording started! Speak naturally.`)
    } catch (err) {
      showToast(err?.message || 'Could not access microphone.', 'error')
    }
  }

  const handleStartInstantDictation = async () => {
    try {
      const now = new Date()
      const timeStr = `${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}`
      const autoMrn = `MRN-${now.getTime().toString().slice(-6)}`
      const autoName = `Patient ${autoMrn}`

      let patientId
      try {
        const pRes = await patientsAPI.create({
          name: autoName,
          mrn: autoMrn,
        })
        patientId = pRes?.patient?.id
      } catch (e) {
        if (e.payload?.patient?.id) {
          patientId = e.payload.patient.id
        } else if (patientList.length > 0) {
          patientId = patientList[0].id
        }
      }

      const dbVisitType = normalizeVisitTypeForDb(selectedTemplate)
      const vRes = await visitsAPI.create({
        patient_id: patientId,
        visit_date: now.toISOString().slice(0, 10),
        visit_time: timeStr,
        visit_type: dbVisitType,
      })

      const newVisit = {
        id: vRes?.visit?.id,
        patient_id: patientId,
        patient_name: autoName,
        mrn: autoMrn,
        visit_date: now.toISOString().slice(0, 10),
        visit_time: timeStr,
        visit_type: dbVisitType,
        status: 'in-progress',
      }

      await startRecordingSession(newVisit)
      await loadData()
    } catch (err) {
      showToast(err?.message || 'Failed to initialize instant consultation.', 'error')
    }
  }

  const handlePauseResume = () => {
    const rec = mediaRecorderRef.current
    if (!rec) return

    if (isPaused) {
      rec.resume()
      setIsPaused(false)
      clearInterval(timerIntervalRef.current)
      timerIntervalRef.current = setInterval(() => {
        setTimerSeconds((prev) => prev + 1)
      }, 1000)
      try { speechRecRef.current?.start() } catch {}
      showToast('Recording resumed')
    } else {
      rec.pause()
      setIsPaused(true)
      clearInterval(timerIntervalRef.current)
      try { speechRecRef.current?.stop() } catch {}
      showToast('Recording paused')
    }
  }

  const handleEndVisit = async () => {
    const rec = mediaRecorderRef.current
    if (!rec || !activeVisit) return

    const duration = timerSeconds
    const durationFormatted = fmtTime(duration)
    setRecordedDuration(durationFormatted)

    clearInterval(timerIntervalRef.current)
    if (speechRecRef.current) {
      try { speechRecRef.current.stop() } catch {}
      speechRecRef.current = null
    }

    setUploading(true)
    setUploadStatus('Processing audio & formulating SOAP note...')

    const currentActive = { ...activeVisit }
    const capturedSpeech = (liveTranscriptRef.current || liveTranscript || '').trim()
    const scratch = dictationNotes.trim()
    const combinedClinicalText = [capturedSpeech, scratch].filter(Boolean).join('\n\n')

    rec.onstop = async () => {
      try {
        const audioBlob = new Blob(audioChunksRef.current, { type: rec.mimeType || 'audio/webm' })

        if (audioBlob.size > 0) {
          try {
            await visitsAPI.uploadAudio(currentActive.id, audioBlob)
          } catch (uploadErr) {
            offlineAudioQueue.addToQueue(audioBlob, currentActive.patient_id, currentActive.id, {
              patientName: currentActive.patient_name,
              durationSeconds: duration,
            }).catch(() => {})
          }
        }

        try {
          await visitsAPI.endVisit(currentActive.id, duration)
        } catch {
          await visitsAPI.updateStatus(currentActive.id, 'recording-uploaded').catch(() => {})
        }

        // Formulate and persist note from clinician's actual dictation
        const generatedSOAP = formatClinicalDictationToSOAP(combinedClinicalText, scratch, currentActive.visit_type)
        try {
          await notesAPI.saveDraft(
            currentActive.id,
            generatedSOAP,
            capturedSpeech || combinedClinicalText,
            generatedSOAP
          )
          const nRes = await notesAPI.getByVisit(currentActive.id)
          if (nRes?.note?.id) {
            await notesAPI.updateNote(nRes.note.id, generatedSOAP)
          }

          const enriched = {
            id: currentActive.id,
            visit_id: currentActive.id,
            note_id: nRes?.note?.id,
            patient_name: currentActive.patient_name,
            mrn: currentActive.mrn || 'Auto-generated',
            visit_type: currentActive.visit_type,
            visit_date: currentActive.visit_date,
            visit_time: currentActive.visit_time,
            final_note: generatedSOAP,
            ai_draft: generatedSOAP,
            transcription: capturedSpeech || combinedClinicalText,
            status: 'draft',
            duration: durationFormatted,
          }

          setActiveDraftNote(enriched)
          setSelectedAssignPatientId(currentActive.patient_id ? String(currentActive.patient_id) : '')
          setPreviewNote(enriched)
          showToast(`✓ Clinical note generated from your dictation!`)

          // In background, trigger server-side Anthropic Claude model to further refine with deep ICD/CPT codes
          visitsAPI.generateDraft(currentActive.id).then(async (dRes) => {
            if (dRes?.ai_draft && !dRes.ai_draft.includes('unavailable')) {
              const refreshedNote = dRes.ai_draft
              if (nRes?.note?.id) {
                await notesAPI.updateNote(nRes.note.id, refreshedNote).catch(() => {})
              }
              setActiveDraftNote((prev) => (prev && prev.id === currentActive.id ? { ...prev, final_note: refreshedNote, ai_draft: refreshedNote } : prev))
              setPreviewNote((p) => (p && p.id === currentActive.id ? { ...p, final_note: refreshedNote, ai_draft: refreshedNote } : p))
            }
          }).catch(() => {})
        } catch (noteErr) {
          console.error('Note saving error:', noteErr)
        }

        rec.stream?.getTracks().forEach((t) => t.stop())
        stopRecordingKeepAlive().catch(() => {})
        audioChunksRef.current = []
        mediaRecorderRef.current = null
        setAudioStream(null)
        setActiveVisit(null)
        setTimerSeconds(0)
        setIsPaused(false)
        setLiveTranscript('')
        liveTranscriptRef.current = ''
        await loadData()
      } catch (err) {
        showToast(err?.message || 'Failed to complete encounter', 'error')
      } finally {
        setUploading(false)
      }
    }

    if (rec.state !== 'inactive') {
      rec.stop()
    }
  }

  const handleAssignPatient = async () => {
    if (!activeDraftNote || !selectedAssignPatientId) {
      showToast('Please select a patient to assign this recording.', 'warn')
      return
    }

    setIsAssigning(true)
    try {
      const selectedPatient = patientList.find((p) => String(p.id) === String(selectedAssignPatientId))
      const targetName = selectedPatient ? selectedPatient.name : 'Patient'
      const targetMrn = selectedPatient ? selectedPatient.mrn : ''

      await visitsAPI.updateVisit(activeDraftNote.id, {
        patient_id: parseInt(selectedAssignPatientId, 10),
      })

      const updated = {
        ...activeDraftNote,
        patient_id: parseInt(selectedAssignPatientId, 10),
        patient_name: targetName,
        mrn: targetMrn,
      }
      setActiveDraftNote(updated)
      setPreviewNote(updated)
      showToast(`✓ Assigned note to ${targetName} (${targetMrn})`)
      await loadData()
    } catch (err) {
      showToast(err?.message || 'Failed to assign patient.', 'error')
    } finally {
      setIsAssigning(false)
    }
  }

  const handleCopyToClipboard = (text) => {
    if (!text) return
    navigator.clipboard.writeText(cleanAiDraftForDisplay(text)).then(() => {
      setCopied(true)
      showToast('✓ Note copied to clipboard for EMR paste!')
      setTimeout(() => setCopied(false), 2500)
    })
  }

  const handleReviewAndSign = async (visit) => {
    if (!visit?.note_id) {
      showToast('Note record not found to sign.', 'warn')
      return
    }
    try {
      await notesAPI.submitNote(visit.note_id)
      await visitsAPI.updateStatus(visit.id, 'completed').catch(() => {})
      showToast('✓ Note reviewed & signed successfully!')
      if (activeDraftNote && activeDraftNote.id === visit.id) {
        setActiveDraftNote((prev) => ({ ...prev, status: 'completed' }))
      }
      await loadData()
    } catch (err) {
      showToast(err?.message || 'Failed to sign note.', 'error')
    }
  }

  const handleViewVisitNote = (visit) => {
    setActiveDraftNote(visit)
    setSelectedAssignPatientId(visit.patient_id ? String(visit.patient_id) : '')
    setRecordedDuration(visit.duration_seconds ? fmtTime(visit.duration_seconds) : '04:12')
  }

  // Generate Quick Dictate Note
  const handleGenerateQuickDictateNote = async () => {
    if (!quickDictateText.trim()) {
      showToast('Please enter clinical observations or dictation first.', 'warn')
      return
    }
    setGeneratingQuickNote(true)
    try {
      const now = new Date()
      const autoMrn = `MRN-${now.getTime().toString().slice(-6)}`
      let patientId
      let patientName = `Quick Patient (${autoMrn})`

      try {
        const pRes = await patientsAPI.create({
          name: patientName,
          mrn: autoMrn,
        })
        patientId = pRes?.patient?.id
      } catch (e) {
        if (e.payload?.patient?.id) {
          patientId = e.payload.patient.id
        } else if (patientList.length > 0) {
          patientId = patientList[0].id
          patientName = patientList[0].name
        }
      }

      const timeStr = `${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}`
      const dbVisitType = normalizeVisitTypeForDb(selectedTemplate)
      const vRes = await visitsAPI.create({
        patient_id: patientId,
        visit_date: now.toISOString().slice(0, 10),
        visit_time: timeStr,
        visit_type: dbVisitType,
      })
      const visitId = vRes?.visit?.id

      const formattedDraft = formatClinicalDictationToSOAP(quickDictateText.trim(), dictationNotes, dbVisitType)

      await visitsAPI.endVisit(visitId, 1).catch(() => {})

      const nRes = await notesAPI.getByVisit(visitId).catch(() => null)
      const noteId = nRes?.note?.id

      if (noteId) {
        await notesAPI.updateNote(noteId, formattedDraft).catch(() => {})
      } else {
        await notesAPI.saveDraft(visitId, formattedDraft, quickDictateText, formattedDraft).catch(() => {})
      }

      const quickEncounter = {
        id: visitId,
        visit_id: visitId,
        note_id: noteId,
        patient_name: patientName,
        mrn: autoMrn,
        visit_date: now.toISOString().slice(0, 10),
        visit_time: timeStr,
        visit_type: dbVisitType,
        final_note: formattedDraft,
        status: 'draft',
      }

      setActiveDraftNote(quickEncounter)
      setTab('ambient')
      showToast('✓ Structured SOAP note generated successfully!')

      visitsAPI.generateDraft(visitId).then(async (dRes) => {
        if (dRes?.ai_draft && !dRes.ai_draft.includes('unavailable')) {
          const refreshedNote = dRes.ai_draft
          if (noteId) {
            await notesAPI.updateNote(noteId, refreshedNote).catch(() => {})
          }
          setActiveDraftNote((p) => (p && p.id === visitId ? { ...p, final_note: refreshedNote, ai_draft: refreshedNote } : p))
        }
      }).catch(() => {})
      await loadData()
    } catch (err) {
      showToast(err?.message || 'Failed to generate note.', 'error')
    } finally {
      setGeneratingQuickNote(false)
    }
  }

  // Determine current active display state: 1a (idle), 1b (recording), 1c (after stop / review)
  const isRecordingState = Boolean(activeVisit)
  const isReviewState = Boolean(!activeVisit && activeDraftNote && (activeDraftNote.final_note || activeDraftNote.ai_draft))
  const isIdleState = !isRecordingState && !isReviewState

  const activeNoteSections = isReviewState
    ? parseNoteSections(activeDraftNote.final_note || activeDraftNote.ai_draft)
    : []

  return (
    <div className="sm-app">
      {/* Toast Notification */}
      {toast && (
        <div className={`sm-toast sm-toast--${toast.type}`}>
          {toast.msg}
        </div>
      )}

      {/* Global Saint Mary Header */}
      <header className="sm-topbar">
        <div className="sm-topbar__left">
          <div className="sm-logo-box">
            <span className="sm-logo-icon" />
            <span className="sm-logo-title">Saint Mary</span>
          </div>

          <div className="sm-topbar__divider" />

          <nav className="sm-nav-tabs">
            <button
              type="button"
              className={`sm-tab-btn ${tab === 'ambient' ? 'sm-tab-btn--active' : ''}`}
              onClick={() => setTab('ambient')}
            >
              Ambient Scribe
            </button>
            <button
              type="button"
              className={`sm-tab-btn ${tab === 'dictate' ? 'sm-tab-btn--active' : ''}`}
              onClick={() => setTab('dictate')}
            >
              Quick Dictate
            </button>
            <button
              type="button"
              className={`sm-tab-btn ${tab === 'history' ? 'sm-tab-btn--active' : ''}`}
              onClick={() => setTab('history')}
            >
              Note History
            </button>
          </nav>
        </div>

        <div className="sm-topbar__right">
          {isRecordingState && (
            <div className="sm-rec-badge">
              <span className="sm-rec-dot" />
              <span>REC</span>
            </div>
          )}

          <span className="sm-user-name">{currentUser?.name || 'Dr Celina Provencio'}</span>
          <div className="sm-user-avatar">
            {currentUser?.name ? currentUser.name.split(' ').map((n) => n[0]).join('').slice(0, 2).toUpperCase() : 'CP'}
          </div>

          <button type="button" className="sm-logout-btn" onClick={onLogout} title="Sign Out">
            Sign out
          </button>
        </div>
      </header>

      {/* Main 2-Column Workspace */}
      <main className="sm-main-layout">
        {/* ─── LEFT COLUMN: WORKSPACE (1a, 1b, 1c) ─── */}
        <section className="sm-left-canvas">
          {/* TAB 1: AMBIENT SCRIBE */}
          {tab === 'ambient' && (
            <>
              {/* STATE 1a: Idle — ready to record */}
              {isIdleState && (
                <div className="sm-idle-panel">
                  <div className="sm-idle-center">
                    <button
                      type="button"
                      className="sm-mic-circle sm-mic-circle--idle"
                      onClick={handleStartInstantDictation}
                      title="Click to start consultation"
                    >
                      <svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="#1D68CD" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
                        <path d="M12 2a3 3 0 0 0-3 3v7a3 3 0 0 0 6 0V5a3 3 0 0 0-3-3Z" />
                        <path d="M19 10v2a7 7 0 0 1-14 0v-2" />
                        <line x1="12" y1="19" x2="12" y2="22" />
                      </svg>
                    </button>

                    <div className="sm-timer-display">00:00</div>
                    <div className="sm-status-caption">Ready for consultation</div>

                    <button
                      type="button"
                      className="sm-btn sm-btn--primary-record"
                      onClick={handleStartInstantDictation}
                    >
                      <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round">
                        <path d="M12 2a3 3 0 0 0-3 3v7a3 3 0 0 0 6 0V5a3 3 0 0 0-3-3Z" />
                        <path d="M19 10v2a7 7 0 0 1-14 0v-2" />
                        <line x1="12" y1="19" x2="12" y2="22" />
                      </svg>
                      Start recording
                    </button>

                    <div className="sm-helper-text">No patient needed — assign after</div>

                    <div className="sm-template-bar">
                      <span className="sm-template-label">Template</span>
                      <select
                        className="sm-template-select"
                        value={selectedTemplate}
                        onChange={(e) => setSelectedTemplate(e.target.value)}
                      >
                        <option value="SOAP Note — Adult">SOAP Note — Adult ▾</option>
                        <option value="SOAP Note — Pediatric">SOAP Note — Pediatric ▾</option>
                        <option value="Comprehensive Exam">Comprehensive Exam ▾</option>
                        <option value="Follow-up Visit">Follow-up Visit ▾</option>
                        <option value="Consultation Note">Consultation Note ▾</option>
                      </select>
                    </div>
                  </div>
                </div>
              )}

              {/* STATE 1b: Recording — mic is live */}
              {isRecordingState && (
                <div className="sm-recording-panel">
                  <div className="sm-recording-center">
                    <div className={`sm-mic-circle sm-mic-circle--recording ${isPaused ? 'sm-mic-circle--paused' : ''}`}>
                      <svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="#EF4444" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
                        <path d="M12 2a3 3 0 0 0-3 3v7a3 3 0 0 0 6 0V5a3 3 0 0 0-3-3Z" />
                        <path d="M19 10v2a7 7 0 0 1-14 0v-2" />
                        <line x1="12" y1="19" x2="12" y2="22" />
                      </svg>
                    </div>

                    <div className="sm-timer-display">{fmtTime(timerSeconds)}</div>
                    <div className="sm-status-caption">
                      {isPaused ? 'Recording paused' : 'Listening — ambient scribe active'}
                    </div>

                    {/* Animated audio waveform */}
                    <div className="sm-waveform-container">
                      <RecordingVisualizer stream={audioStream} isPaused={isPaused} barCount={20} theme="danger" />
                    </div>

                    {/* Live speech preview if available */}
                    {liveTranscript && (
                      <div className="sm-live-speech-pill">
                        <span className="sm-live-speech-text">“{liveTranscript}”</span>
                      </div>
                    )}

                    <div className="sm-recording-btn-row">
                      <button
                        type="button"
                        className="sm-btn sm-btn--pause"
                        onClick={handlePauseResume}
                      >
                        {isPaused ? '▶ Resume' : '⏸ Pause'}
                      </button>

                      <button
                        type="button"
                        className="sm-btn sm-btn--stop-generate"
                        onClick={handleEndVisit}
                      >
                        <span className="sm-btn-square-icon" />
                        Stop & generate
                      </button>
                    </div>

                    <div className="sm-template-bar">
                      <span className="sm-template-label">Template</span>
                      <select
                        className="sm-template-select"
                        value={selectedTemplate}
                        onChange={(e) => setSelectedTemplate(e.target.value)}
                      >
                        <option value="SOAP Note — Adult">SOAP Note — Adult ▾</option>
                        <option value="SOAP Note — Pediatric">SOAP Note — Pediatric ▾</option>
                        <option value="Comprehensive Exam">Comprehensive Exam ▾</option>
                        <option value="Follow-up Visit">Follow-up Visit ▾</option>
                        <option value="Consultation Note">Consultation Note ▾</option>
                      </select>
                    </div>
                  </div>
                </div>
              )}

              {/* STATE 1c: After stop — assign & review the note */}
              {isReviewState && (
                <div className="sm-review-panel">
                  {/* Top Amber Assign Banner */}
                  <div className="sm-assign-banner">
                    <div className="sm-assign-banner__left">
                      <div className="sm-assign-icon">
                        <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="#9A3412" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                          <path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2" />
                          <circle cx="9" cy="7" r="4" />
                          <line x1="19" y1="8" x2="19" y2="14" />
                          <line x1="22" y1="11" x2="16" y2="11" />
                        </svg>
                      </div>
                      <div className="sm-assign-meta">
                        <strong>Assign this recording</strong>
                        <span>
                          {recordedDuration || '04:12'} recording · {selectedTemplate || 'SOAP Note — Adult'}
                        </span>
                      </div>
                    </div>

                    <div className="sm-assign-banner__right">
                      <select
                        className="sm-assign-select"
                        value={selectedAssignPatientId}
                        onChange={(e) => setSelectedAssignPatientId(e.target.value)}
                      >
                        <option value="">{activeDraftNote?.mrn ? `${activeDraftNote.mrn} likely ▾` : 'Select Patient ▾'}</option>
                        {patientList.map((p) => (
                          <option key={p.id} value={p.id}>
                            {p.name} ({p.mrn})
                          </option>
                        ))}
                      </select>

                      <button
                        type="button"
                        className="sm-btn sm-btn--assign"
                        onClick={handleAssignPatient}
                        disabled={isAssigning}
                      >
                        {isAssigning ? 'Assigning...' : 'Assign'}
                      </button>
                    </div>
                  </div>

                  {/* Draft Note Header */}
                  <div className="sm-note-header">
                    <div className="sm-note-header__left">
                      <h2>Draft note</h2>
                      <span className="sm-badge sm-badge--ai-scribed">AI SCRIBED</span>
                    </div>

                    <div className="sm-note-header__right">
                      <button
                        type="button"
                        className="sm-btn sm-btn--copy"
                        onClick={() => handleCopyToClipboard(activeDraftNote.final_note || activeDraftNote.ai_draft)}
                      >
                        {copied ? '✓ Copied!' : 'Copy to EMR'}
                      </button>

                      <button
                        type="button"
                        className="sm-btn sm-btn--sign"
                        onClick={() => handleReviewAndSign(activeDraftNote)}
                      >
                        Review & sign
                      </button>

                      <button
                        type="button"
                        className="sm-btn sm-btn--new-rec"
                        onClick={handleStartInstantDictation}
                        title="Start another consultation"
                      >
                        + New
                      </button>
                    </div>
                  </div>

                  {/* Structured Clinical Note Document */}
                  <div className="sm-note-body">
                    {activeNoteSections.map((sec, idx) => (
                      <div key={idx} className="sm-note-section">
                        <div className="sm-note-section__header">{sec.header}</div>
                        <div className="sm-note-section__content">{sec.content}</div>
                      </div>
                    ))}
                  </div>
                </div>
              )}
            </>
          )}

          {/* TAB 2: QUICK DICTATE */}
          {tab === 'dictate' && (
            <div className="sm-quick-dictate-canvas">
              <div className="sm-quick-header">
                <h2>⚡ Quick Clinical Dictation</h2>
                <p>Dictate or type clinical notes directly for instant AI SOAP note structuring with ICD-10 & CPT codes.</p>
              </div>

              <textarea
                className="sm-quick-textarea"
                placeholder="Dictate or type clinical observations (e.g. 36yo male presenting with right knee pain after bike fall, tender MCL, mild OA on X-ray, start Ibuprofen BID...)"
                value={quickDictateText}
                onChange={(e) => setQuickDictateText(e.target.value)}
                rows={8}
              />

              <div className="sm-quick-actions">
                <button
                  type="button"
                  className="sm-btn sm-btn--primary-record"
                  onClick={handleGenerateQuickDictateNote}
                  disabled={generatingQuickNote || !quickDictateText.trim()}
                >
                  {generatingQuickNote ? 'Generating Note...' : '⚡ Generate Structured SOAP Note'}
                </button>
              </div>
            </div>
          )}

          {/* TAB 3: NOTE HISTORY */}
          {tab === 'history' && (
            <div className="sm-history-canvas">
              <div className="sm-history-header">
                <h2>📁 Consultation & Note History</h2>
                <input
                  type="text"
                  className="sm-search-input"
                  placeholder="Search by patient name, MRN, date..."
                  value={searchTerm}
                  onChange={(e) => setSearchTerm(e.target.value)}
                />
              </div>

              <div className="sm-history-list">
                {visits
                  .filter((v) => !searchTerm || (v.patient_name || '').toLowerCase().includes(searchTerm.toLowerCase()) || (v.mrn || '').toLowerCase().includes(searchTerm.toLowerCase()))
                  .map((v) => (
                    <div key={v.id} className="sm-history-item" onClick={() => handleViewVisitNote(v)}>
                      <div className="sm-history-item__left">
                        <strong>{v.patient_name || 'Patient'}</strong>
                        <span>{v.visit_date} · {v.visit_time || '10:00'} · {v.visit_type} ({v.mrn || 'No MRN'})</span>
                      </div>
                      <div className="sm-history-item__right">
                        <span className={`sm-badge ${v.status === 'completed' ? 'sm-badge--ready' : 'sm-badge--draft'}`}>
                          {v.status === 'completed' ? 'SIGNED' : (v.final_note || v.ai_draft ? 'DRAFT' : 'RECORDED')}
                        </span>
                        <button type="button" className="sm-btn sm-btn--view" onClick={(e) => { e.stopPropagation(); setSelectedNoteModal(v) }}>
                          View
                        </button>
                      </div>
                    </div>
                  ))}
              </div>
            </div>
          )}
        </section>

        {/* ─── RIGHT COLUMN: SIDEBAR ─── */}
        <aside className="sm-right-sidebar">
          {/* Today's Visits Card */}
          <div className="sm-side-card">
            <div className="sm-side-card__header">
              <span className="sm-side-card__title">Today's visits</span>
              <span className="sm-side-card__count">{visits.length}</span>
            </div>

            <div className="sm-visit-list">
              {visits.length === 0 ? (
                <div className="sm-empty-visits">No visits scheduled today</div>
              ) : (
                visits.map((v) => {
                  const hasNote = Boolean(v.final_note || v.ai_draft)
                  const isCompleted = v.status === 'completed'
                  const isCurrent = activeDraftNote?.id === v.id
                  let dotColor = '#CBD5E1'
                  let badgeText = v.visit_time || '10:00'
                  let badgeType = 'time'

                  if (isCompleted || (hasNote && v.status === 'ready')) {
                    dotColor = '#10B981'
                    badgeText = 'READY'
                    badgeType = 'ready'
                  } else if (hasNote) {
                    dotColor = '#3B82F6'
                    badgeText = 'DRAFT'
                    badgeType = 'draft'
                  }

                  return (
                    <div
                      key={v.id}
                      className={`sm-visit-row ${isCurrent ? 'sm-visit-row--active' : ''}`}
                      onClick={() => handleViewVisitNote(v)}
                    >
                      <div className="sm-visit-row__left">
                        <span className="sm-visit-dot" style={{ background: dotColor }} />
                        <div className="sm-visit-info">
                          <span className="sm-visit-patient">{v.patient_name || `Patient ${v.mrn || ''}`}</span>
                          <span className="sm-visit-meta">
                            {v.visit_time || '08:25'} · {v.visit_type || 'Follow-up'}
                          </span>
                        </div>
                      </div>

                      <div className="sm-visit-row__right">
                        {badgeType === 'ready' && <span className="sm-status-tag sm-status-tag--ready">READY</span>}
                        {badgeType === 'draft' && <span className="sm-status-tag sm-status-tag--draft">DRAFT</span>}
                        {badgeType === 'time' && <span className="sm-status-tag sm-status-tag--time">{badgeText}</span>}
                      </div>
                    </div>
                  )
                })
              )}
            </div>
          </div>

          {/* Scratchpad Card */}
          <div className="sm-side-card sm-side-card--scratchpad">
            <div className="sm-side-card__header">
              <span className="sm-side-card__title">Scratchpad</span>
            </div>

            <textarea
              className="sm-scratchpad-input"
              placeholder="Type vitals, meds, findings..."
              value={dictationNotes}
              onChange={(e) => setDictationNotes(e.target.value)}
              rows={4}
            />
          </div>
        </aside>
      </main>

      {/* Note Viewer Modal */}
      {selectedNoteModal && (
        <SaintMaryNoteViewerModal
          note={selectedNoteModal}
          currentUser={currentUser}
          onClose={() => setSelectedNoteModal(null)}
          onNoteUpdated={loadData}
        />
      )}
    </div>
  )
}
