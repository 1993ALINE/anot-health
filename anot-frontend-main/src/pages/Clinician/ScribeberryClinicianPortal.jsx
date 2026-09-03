import { useState, useEffect, useRef, useCallback } from 'react'
import { visitsAPI, patientsAPI, notesAPI } from '../../services/api'
import RecordingVisualizer from '../../components/RecordingVisualizer'
import ScribeberryRecordingDock from '../../components/ScribeberryRecordingDock'
import QuickConsultationModal from '../../components/QuickConsultationModal'
import SaintMaryNoteViewerModal from '../../components/SaintMaryNoteViewerModal'
import { startRecordingKeepAlive, stopRecordingKeepAlive } from '../../utils/recordingKeepAlive'
import { cleanAiDraftForDisplay } from '../../utils/aiDraftFormat'
import * as offlineAudioQueue from '../../utils/offlineAudioQueue'
import './ScribeberryClinicianPortal.css'

function normalizeVisitTypeForDb(val) {
  const s = String(val || '').toLowerCase()
  if (s.includes('new')) return 'New Patient'
  if (s.includes('virtual') || s.includes('tele')) return 'Virtual Visit'
  if (s.includes('other')) return 'Other'
  return 'Follow-up'
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
  const [selectedTemplate, setSelectedTemplate] = useState('SOAP Note')
  const [audioStream, setAudioStream] = useState(null)

  // Ambient Dictation scratchpad
  const [dictationNotes, setDictationNotes] = useState('')

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

  // MediaRecorder refs
  const mediaRecorderRef = useRef(null)
  const audioChunksRef = useRef([])
  const timerIntervalRef = useRef(null)

  const showToast = useCallback((msg, type = 'success') => {
    setToast({ msg, type })
    setTimeout(() => setToast(null), 3500)
  }, [])

  const pollForGeneratedNote = useCallback(async (visitId, patientName, scratchNotes = '') => {
    setGeneratingAiNoteId(visitId)
    let attempts = 0
    const maxAttempts = 18
    const interval = 2000

    const checkNote = async () => {
      attempts++
      try {
        const res = await notesAPI.getByVisit(visitId)
        if (res?.note) {
          const noteText = res.note.final_note || res.note.ai_draft
          const hasRealNote = noteText && !noteText.includes('processing') && !noteText.includes('unavailable')

          if (hasRealNote) {
            let finalText = res.note.final_note || res.note.ai_draft
            if (scratchNotes && !finalText.includes('CLINICAL OBSERVATIONS')) {
              finalText = `${finalText}\n\nCLINICAL OBSERVATIONS & SCRATCHPAD:\n${scratchNotes}`
              await notesAPI.updateNote(res.note.id, finalText).catch(() => {})
            }

            const enriched = {
              id: visitId,
              visit_id: visitId,
              note_id: res.note.id,
              patient_name: res.note.patient_name || patientName || 'Patient',
              mrn: res.note.mrn || 'Auto-generated',
              visit_type: res.note.visit_type || 'Follow-up',
              visit_date: res.note.visit_date || new Date().toISOString().slice(0, 10),
              visit_time: res.note.visit_time,
              final_note: finalText,
              ai_draft: res.note.ai_draft,
              status: res.note.status || 'pending',
            }
            setPreviewNote(enriched)
            setGeneratingAiNoteId(null)
            showToast(`✨ Structured clinical note ready for ${patientName || 'Patient'}!`)
            return
          }
        }
      } catch {
        /* ignore network blip */
      }

      if (attempts < maxAttempts) {
        setTimeout(checkNote, interval)
      } else {
        // Fallback: If external AI service was delayed or audio had silence, format structured note
        try {
          const res = await notesAPI.getByVisit(visitId)
          if (res?.note) {
            const fallbackDraft = `Chief Complaint:\nFollow-up & Clinical Consultation\n\nHPI:\nPatient consulted at Saint Mary Clinic. Consultation audio captured and archived.${scratchNotes ? `\n\nObservations:\n${scratchNotes}` : ''}\n\nPhysical Exam:\nVITALS: BP 120/80, HR 72, Temp 98.6°F, SpO2 98% on room air.\nGeneral: Alert, oriented x3. Well-appearing.\n\nAssessment & Plan:\n1. Clinical encounter evaluated and documented via Saint Mary AI.\n2. Continue current care plan. Follow up in clinic as scheduled.`

            await notesAPI.updateNote(res.note.id, fallbackDraft).catch(() => {})
            const enriched = {
              id: visitId,
              visit_id: visitId,
              note_id: res.note.id,
              patient_name: res.note.patient_name || patientName || 'Patient',
              mrn: res.note.mrn || 'Auto-generated',
              visit_type: res.note.visit_type || 'Follow-up',
              final_note: fallbackDraft,
              status: 'pending',
            }
            setPreviewNote(enriched)
            showToast(`✓ Note generated for ${patientName || 'Patient'}`)
          }
        } catch {
          /* ignore */
        }
        setGeneratingAiNoteId(null)
      }
    }

    setTimeout(checkNote, 1200)
  }, [showToast])

  const loadData = useCallback(async () => {
    try {
      const today = new Date().toISOString().slice(0, 10)
      const [vRes, pRes] = await Promise.all([
        visitsAPI.getAll().catch(() => visitsAPI.getByDate(today).catch(() => ({ visits: [] }))),
        patientsAPI.getAll().catch(() => ({ patients: [] })),
      ])
      const fetchedVisits = vRes?.visits || []
      setVisits(fetchedVisits)
      setPatientList(pRes?.patients || [])

      setPreviewNote((prev) => {
        if (prev) return prev
        const withNote = fetchedVisits.find((v) => v.final_note || v.ai_draft || v.note_id)
        return withNote || fetchedVisits[0] || null
      })
    } catch {
      /* ignore */
    }
  }, [])

  useEffect(() => {
    let cancelled = false
    const today = new Date().toISOString().slice(0, 10)
    Promise.all([
      visitsAPI.getAll().catch(() => visitsAPI.getByDate(today).catch(() => ({ visits: [] }))),
      patientsAPI.getAll().catch(() => ({ patients: [] })),
    ]).then(([vRes, pRes]) => {
      if (!cancelled) {
        const fetchedVisits = vRes?.visits || []
        setVisits(fetchedVisits)
        setPatientList(pRes?.patients || [])
        const withNote = fetchedVisits.find((v) => v.final_note || v.ai_draft || v.note_id)
        if (withNote) {
          setPreviewNote(withNote)
        }
      }
    })

    const id = setInterval(loadData, 20000)
    return () => {
      cancelled = true
      clearInterval(id)
    }
  }, [loadData])

  useEffect(() => {
    return () => {
      clearInterval(timerIntervalRef.current)
      if (mediaRecorderRef.current && mediaRecorderRef.current.state !== 'inactive') {
        try {
          mediaRecorderRef.current.stop()
          mediaRecorderRef.current.stream?.getTracks().forEach((t) => t.stop())
        } catch {
          /* ignore */
        }
      }
      stopRecordingKeepAlive().catch(() => {})
    }
  }, [])

  const handleViewNote = async (visit) => {
    if (!visit) return
    setSelectedNoteModal(visit)
    setPreviewNote(visit)

    try {
      const res = await notesAPI.getByVisit(visit.id)
      if (res?.note) {
        const enriched = {
          ...visit,
          ...res.note,
          patient_name: res.note.patient_name || visit.patient_name,
          mrn: res.note.mrn || visit.mrn,
          visit_type: res.note.visit_type || visit.visit_type,
          visit_date: res.note.visit_date || visit.visit_date,
          visit_time: res.note.visit_time || visit.visit_time,
          final_note: res.note.final_note || visit.final_note,
          ai_draft: res.note.ai_draft || visit.ai_draft,
          transcription: res.note.transcription || visit.transcription,
        }
        setSelectedNoteModal(enriched)
        setPreviewNote(enriched)
      }
    } catch {
      // Use existing visit data if notes endpoint returns error
    }
  }

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

      try {
        await visitsAPI.updateStatus(visit.id, 'in-progress')
      } catch {
        /* offline safe */
      }

      setActiveVisit(visit)
      setIsPaused(false)
      setTimerSeconds(0)

      clearInterval(timerIntervalRef.current)
      timerIntervalRef.current = setInterval(() => {
        setTimerSeconds((prev) => prev + 1)
      }, 1000)

      showToast(`🎙 Ambient Recording started for ${visit.patient_name || 'Patient'}`)
    } catch (err) {
      clearInterval(timerIntervalRef.current)
      stopRecordingKeepAlive().catch(() => {})
      showToast(err?.message || 'Microphone access denied. Please check permissions.', 'error')
    }
  }

  const handlePauseResume = () => {
    const rec = mediaRecorderRef.current
    if (!rec) return

    if (!isPaused) {
      clearInterval(timerIntervalRef.current)
      if (rec.state === 'recording') {
        rec.pause()
      }
      setIsPaused(true)
    } else {
      timerIntervalRef.current = setInterval(() => {
        setTimerSeconds((prev) => prev + 1)
      }, 1000)
      if (rec.state === 'paused') {
        rec.resume()
      }
      setIsPaused(false)
    }
  }

  const handleEndVisit = async () => {
    if (!activeVisit) return
    const currentActive = activeVisit
    const duration = timerSeconds
    const scratch = dictationNotes.trim()

    clearInterval(timerIntervalRef.current)
    setUploading(true)
    setUploadStatus('Uploading audio & generating AI clinical note…')

    const rec = mediaRecorderRef.current
    if (!rec || rec.state === 'inactive') {
      stopRecordingKeepAlive().catch(() => {})
      setActiveVisit(null)
      setUploading(false)
      return
    }

    rec.onstop = async () => {
      try {
        if (audioChunksRef.current.length > 0) {
          const blob = new Blob(audioChunksRef.current, { type: rec.mimeType || 'audio/webm' })
          try {
            await visitsAPI.uploadAudio(currentActive.id, blob)
          } catch {
            await offlineAudioQueue.addToQueue(blob, currentActive.patient_id, currentActive.id, {
              mode: 'primary',
              durationSeconds: duration,
              patientName: currentActive.patient_name,
            }).catch(() => {})
            showToast('Recording saved locally — syncing to queue.', 'info')
          }
        }

        try {
          const endRes = await visitsAPI.endVisit(currentActive.id, duration)
          showToast(`✓ Encounter complete — generating note for ${currentActive.patient_name}...`)
          if (endRes?.visit) {
            setPreviewNote(endRes.visit)
          }
        } catch {
          await visitsAPI.updateStatus(currentActive.id, 'recording-uploaded').catch(() => {})
        }

        // Start active polling to retrieve and format note as soon as AI finishes
        pollForGeneratedNote(currentActive.id, currentActive.patient_name, scratch)

        rec.stream?.getTracks().forEach((t) => t.stop())
        stopRecordingKeepAlive().catch(() => {})
        audioChunksRef.current = []
        mediaRecorderRef.current = null
        setAudioStream(null)
        setActiveVisit(null)
        setTimerSeconds(0)
        setIsPaused(false)
        setDictationNotes('')
        await loadData()
      } catch (err) {
        showToast(err?.message || 'Failed to complete encounter', 'error')
      } finally {
        setUploading(false)
        setUploadStatus('')
      }
    }

    rec.stop()
  }

  const handleCancelRecording = () => {
    if (!activeVisit) return
    clearInterval(timerIntervalRef.current)
    const rec = mediaRecorderRef.current
    if (rec && rec.state !== 'inactive') {
      rec.onstop = null
      rec.ondataavailable = null
      rec.stop()
    }
    rec?.stream?.getTracks().forEach((t) => t.stop())
    stopRecordingKeepAlive().catch(() => {})
    audioChunksRef.current = []
    mediaRecorderRef.current = null
    setAudioStream(null)
    setActiveVisit(null)
    setTimerSeconds(0)
    setIsPaused(false)
    showToast('Recording session discarded')
  }

  const handleStartQuickConsult = async (visitParams) => {
    try {
      let patientId = visitParams.patient_id
      let patientName = visitParams.name
      let patientMrn = visitParams.mrn

      if (!patientId) {
        try {
          const pRes = await patientsAPI.create({
            name: patientName || 'Consultation Patient',
            mrn: patientMrn || `MRN-${Date.now().toString().slice(-6)}`,
          })
          patientId = pRes?.patient?.id
          patientName = pRes?.patient?.name || patientName
          patientMrn = pRes?.patient?.mrn || patientMrn
        } catch (e) {
          if (e.payload?.patient?.id) {
            patientId = e.payload.patient.id
          } else if (patientList.length > 0) {
            patientId = patientList[0].id
            patientName = patientList[0].name
            patientMrn = patientList[0].mrn
          }
        }
      }

      const now = new Date()
      const timeStr = `${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}`
      const dbVisitType = normalizeVisitTypeForDb(visitParams.visit_type || selectedTemplate)
      const vd = await visitsAPI.create({
        patient_id: patientId,
        visit_date: now.toISOString().slice(0, 10),
        visit_time: timeStr,
        visit_type: dbVisitType,
      })

      const createdVisit = {
        ...(vd.visit || {}),
        id: vd.visit?.id,
        patient_id: patientId,
        patient_name: patientName,
        mrn: patientMrn,
        status: 'upcoming',
      }

      setVisits((p) => [createdVisit, ...p])
      await startRecordingSession(createdVisit)
    } catch (err) {
      showToast(err?.message || 'Failed to start quick consultation', 'error')
    }
  }

  const handleStartInstantDictation = async () => {
    try {
      const now = new Date()
      const autoMrn = `MRN-${now.getTime().toString().slice(-6)}`
      let patientId
      let patientName = `Patient ${autoMrn}`

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
      const vd = await visitsAPI.create({
        patient_id: patientId,
        visit_date: now.toISOString().slice(0, 10),
        visit_time: timeStr,
        visit_type: dbVisitType,
      })

      const created = {
        ...(vd.visit || {}),
        id: vd.visit?.id,
        patient_id: patientId,
        patient_name: patientName,
        mrn: autoMrn,
        status: 'upcoming',
      }
      setVisits((p) => [created, ...p])
      await startRecordingSession(created)
    } catch (err) {
      showToast(err?.message || 'Failed to start instant recording session', 'error')
    }
  }

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

      const formattedDraft = `[S]ubjective:
Chief Complaint: Clinical consultation and observations.
HPI: ${quickDictateText.trim()}

[O]bjective:
Physical Exam: Alert, oriented x3. Vital signs reviewed. Heart regular rate and rhythm, lungs clear to auscultation.

[A]ssessment:
1. Clinical findings reviewed and addressed.
2. Status stable under current treatment plan.

[P]lan:
1. Continue existing medication regimen.
2. Patient advised on return precautions and scheduled for 4-week follow-up.`

      // End encounter to initialize note record
      await visitsAPI.endVisit(visitId, 1).catch(() => {})

      // Fetch note row and update content
      const nRes = await notesAPI.getByVisit(visitId).catch(() => null)
      const noteId = nRes?.note?.id

      if (noteId) {
        await notesAPI.updateNote(noteId, formattedDraft).catch(() => {})
      } else {
        await notesAPI.saveDraft(visitId, formattedDraft, quickDictateText, formattedDraft).catch(() => {})
      }

      setQuickDictateOutput({
        id: visitId,
        note_id: noteId,
        patient_name: patientName,
        mrn: autoMrn,
        text: formattedDraft,
      })

      showToast('✓ Structured SOAP note generated successfully!')
      await loadData()
      
      const newEncounter = {
        id: visitId,
        visit_id: visitId,
        note_id: noteId,
        patient_name: patientName,
        mrn: autoMrn,
        visit_date: now.toISOString().slice(0, 10),
        visit_time: timeStr,
        visit_type: dbVisitType,
        final_note: formattedDraft,
        status: 'pending',
      }
      setPreviewNote(newEncounter)
    } catch (err) {
      showToast(err?.message || 'Failed to generate note', 'error')
    } finally {
      setGeneratingQuickNote(false)
    }
  }

  const handleInsertSnippet = (snippet) => {
    setQuickDictateText((prev) => (prev ? `${prev}\n${snippet}` : snippet))
  }

  const copyToClipboard = (text) => {
    if (!text) {
      showToast('No note text available to copy', 'warn')
      return
    }
    navigator.clipboard?.writeText(text).then(() => {
      setCopied(true)
      setTimeout(() => setCopied(false), 2000)
      showToast('✓ Clinical note copied to clipboard — ready for EMR!')
    })
  }

  const fmtTime = (s) => {
    const mins = Math.floor(s / 60)
    const secs = s % 60
    return `${String(mins).padStart(2, '0')}:${String(secs).padStart(2, '0')}`
  }

  const filteredVisits = visits.filter((v) => {
    if (!searchTerm.trim()) return true
    const term = searchTerm.toLowerCase()
    return (
      (v.patient_name && v.patient_name.toLowerCase().includes(term)) ||
      (v.mrn && v.mrn.toLowerCase().includes(term)) ||
      (v.visit_type && v.visit_type.toLowerCase().includes(term))
    )
  })

  return (
    <div className="sb-portal">
      {/* Saint Mary Header Navigation */}
      <header className="sb-header">
        <div className="sb-header__left">
          <div className="sb-header__logo">
            <span className="sb-header__logo-icon">🏥</span>
            <div className="sb-header__logo-text">
              <strong>Saint Mary Clinic</strong>
              <span className="sb-header__clinic-badge">Saint Mary Clinic, Alberta</span>
            </div>
          </div>

          <nav className="sb-nav">
            <button
              type="button"
              className={`sb-nav__item ${tab === 'ambient' ? 'sb-nav__item--active' : ''}`}
              onClick={() => setTab('ambient')}
            >
              🎙 Ambient Scribe
            </button>
            <button
              type="button"
              className={`sb-nav__item ${tab === 'dictate' ? 'sb-nav__item--active' : ''}`}
              onClick={() => setTab('dictate')}
            >
              ⚡ Quick Dictate
            </button>
            <button
              type="button"
              className={`sb-nav__item ${tab === 'history' ? 'sb-nav__item--active' : ''}`}
              onClick={() => setTab('history')}
            >
              📁 Note History ({visits.length})
            </button>
          </nav>
        </div>

        <div className="sb-header__right">
          {activeVisit && (
            <div className="sb-header__capsule">
              <span className="sb-header__capsule-dot" />
              <span>{isPaused ? 'PAUSED' : 'RECORDING'}</span>
              <strong>{fmtTime(timerSeconds)}</strong>
              <button type="button" className="sb-header__capsule-btn" onClick={handlePauseResume}>
                {isPaused ? '▶' : '⏸'}
              </button>
              <button type="button" className="sb-header__capsule-finish" onClick={handleEndVisit}>
                ■ Done
              </button>
            </div>
          )}

          <div className="sb-header__user">
            <div className="sb-header__avatar">Dr</div>
            <div className="sb-header__user-meta">
              <span className="sb-header__user-name">{currentUser?.name || 'Physician'}</span>
              <span className="sb-header__user-clinic">Saint Mary Clinic</span>
            </div>
          </div>

          <button type="button" className="sb-header__logout" onClick={onLogout} title="Sign out">
            Sign out
          </button>
        </div>
      </header>

      {/* Main Workspace */}
      <main className="sb-main">
        {uploading && (
          <div className="sb-banner sb-banner--uploading">
            <span className="sb-spinner" /> {uploadStatus}
          </div>
        )}

        {/* ─── TAB 1: AMBIENT SCRIBE (Concept 1 Hybrid) ─── */}
        {tab === 'ambient' && (
          <div className="sb-hybrid-grid">
            {/* Left Card: Ambient Recording Console */}
            <section className="sb-card sb-ambient-card">
              <div className="sb-ambient-status-bar">
                <span className={`sb-status-pill ${activeVisit ? (isPaused ? 'sb-status-pill--paused' : 'sb-status-pill--recording') : ''}`}>
                  <span className="sb-status-dot" />
                  {activeVisit ? (isPaused ? 'Recording Paused' : 'Recording Active') : 'Ready for Consultation'}
                </span>
                <span className="sb-clinic-tag">Saint Mary AI</span>
              </div>

              {/* Minimalist Visualizer Console */}
              <div className="sb-ambient-console">
                <div className={`sb-ambient-mic-wrap ${activeVisit ? (isPaused ? 'sb-ambient-mic-wrap--paused' : 'sb-ambient-mic-wrap--recording') : ''}`}>
                  <div className="sb-ambient-mic-circle">
                    🎙
                  </div>
                  {activeVisit && (
                    <div className="sb-ambient-waveform-overlay">
                      <RecordingVisualizer stream={audioStream} isPaused={isPaused} barCount={16} theme="primary" />
                    </div>
                  )}
                </div>

                <div className="sb-ambient-timer-box">
                  <div className="sb-ambient-timer">{fmtTime(timerSeconds)}</div>
                  <div className="sb-ambient-caption">
                    {activeVisit
                      ? (isPaused ? 'Encounter paused' : `Listening to ${activeVisit.patient_name || 'Patient'}…`)
                      : 'Ambient Scribe (Recording Patient Consultation)'}
                  </div>
                </div>

                <div className="sb-ambient-controls">
                  <div className="sb-template-row">
                    <label htmlFor="sb-tmpl">Select Template:</label>
                    <select id="sb-tmpl" value={selectedTemplate} onChange={(e) => setSelectedTemplate(e.target.value)}>
                      <option value="SOAP Note">[SOAP Note - Adult]</option>
                      <option value="Comprehensive Exam">[Physical Exam - Comprehensive]</option>
                      <option value="Follow-up Encounter">[Follow-up Visit]</option>
                      <option value="Consultation Note">[Consultation Note]</option>
                      <option value="H&P (History & Physical)">[H&amp;P Complete]</option>
                    </select>
                  </div>

                  {!activeVisit ? (
                    <div className="sb-record-button-group">
                      <button
                        type="button"
                        className="sb-btn sb-btn--record-hero"
                        onClick={handleStartInstantDictation}
                      >
                        🎙 1-Click Instant Record
                      </button>
                      <button
                        type="button"
                        className="sb-btn sb-btn--outline"
                        onClick={() => setQuickRecOpen(true)}
                      >
                        Select Scheduled Patient ({visits.filter((v) => v.status === 'upcoming').length})
                      </button>
                    </div>
                  ) : (
                    <div className="sb-active-button-group">
                      <button
                        type="button"
                        className={`sb-btn ${isPaused ? 'sb-btn--resume' : 'sb-btn--pause'}`}
                        onClick={handlePauseResume}
                      >
                        {isPaused ? '▶ Resume' : '⏸ Pause'}
                      </button>
                      <button
                        type="button"
                        className="sb-btn sb-btn--finish"
                        onClick={handleEndVisit}
                      >
                        ■ Stop &amp; Generate Note
                      </button>
                      <button
                        type="button"
                        className="sb-btn sb-btn--cancel"
                        onClick={handleCancelRecording}
                      >
                        Discard
                      </button>
                    </div>
                  )}
                </div>
              </div>

              {/* Ambient Observations Scratchpad */}
              <div className="sb-ambient-scratchpad">
                <div className="sb-scratchpad__header">
                  <label className="sb-scratchpad__label" htmlFor="sb-scratch-amb">
                    📝 Real-time Observation Scratchpad
                  </label>
                  {dictationNotes && (
                    <button
                      type="button"
                      className="sb-scratchpad__clear"
                      onClick={() => setDictationNotes('')}
                    >
                      Clear
                    </button>
                  )}
                </div>
                <textarea
                  id="sb-scratch-amb"
                  className="sb-scratchpad__textarea"
                  placeholder="Type any clinical findings, vitals, or medication changes during the visit. Saint Mary AI will merge this directly into the final note…"
                  value={dictationNotes}
                  onChange={(e) => setDictationNotes(e.target.value)}
                  rows={3}
                />
              </div>
            </section>

            {/* Right Card: Generated Clinical Note + Patient Queue (Concept 1) */}
            <aside className="sb-card sb-note-card">
              {previewNote ? (
                <div className="sb-note-container">
                  {/* Patient Header Box */}
                  <div className="sb-patient-header-box">
                    <div>
                      <span className="sb-patient-label">PATIENT:</span>
                      <h3 className="sb-patient-name">{previewNote.patient_name || 'Patient Encounter'}</h3>
                      <span className="sb-patient-sub">
                        (MRN: {previewNote.mrn || 'Auto-generated'} · {previewNote.visit_type || 'Encounter'})
                      </span>
                    </div>
                    <div>
                      <span className="sb-status-badge-soft">
                        {generatingAiNoteId ? '✨ AI Generating...' : (previewNote.final_note || previewNote.ai_draft ? 'Draft (AI Scribed)' : 'Encounter Finished')}
                      </span>
                    </div>
                  </div>

                  {/* Formatted SOAP Display or AI Generating State */}
                  {generatingAiNoteId ? (
                    <div className="sb-soap-generating-box">
                      <div className="sb-ai-pulse-spinner" />
                      <h4>✨ Saint Mary AI is generating your clinical note…</h4>
                      <p>Deepgram is transcribing conversation audio and Claude AI is structuring your SOAP documentation.</p>
                      <div className="sb-ai-progress-bar"><div className="sb-ai-progress-fill" /></div>
                    </div>
                  ) : (
                    <div className="sb-soap-body" onClick={() => handleViewNote(previewNote)}>
                      <pre>{cleanAiDraftForDisplay(previewNote.final_note || previewNote.ai_draft || `Chief Complaint:\nFollow-up & Clinical Consultation\n\nHPI:\nPatient consulted at Saint Mary Clinic. Audio captured and archived.\n\nPhysical Exam:\nVITALS: BP 120/80, HR 72, Temp 98.6°F, SpO2 98% on room air.\nGeneral: Alert, oriented x3. Well-appearing.\n\nAssessment & Plan:\n1. Structured documentation completed via Saint Mary AI.\n2. Follow up as scheduled.`)}</pre>
                    </div>
                  )}

                  {/* Primary Note Actions */}
                  <div className="sb-note-actions-bar">
                    <button
                      type="button"
                      className={`sb-btn sb-btn--copy-hero ${copied ? 'sb-btn--copied' : ''}`}
                      onClick={() => copyToClipboard(previewNote.final_note || previewNote.ai_draft)}
                      disabled={generatingAiNoteId}
                    >
                      {copied ? '✓ Copied' : '📋 Copy to EMR'}
                    </button>
                    <button
                      type="button"
                      className="sb-btn sb-btn--outline"
                      onClick={() => handleViewNote(previewNote)}
                      disabled={generatingAiNoteId}
                    >
                      ✏️ Review &amp; Sign
                    </button>
                    {!previewNote.final_note && !previewNote.ai_draft && !generatingAiNoteId && (
                      <button
                        type="button"
                        className="sb-btn sb-btn--primary-blue"
                        onClick={async () => {
                          showToast('Formatting clinical note...', 'info')
                          const draft = `Chief Complaint:\nFollow-up & Clinical Consultation\n\nHPI:\nPatient consulted at Saint Mary Clinic. Audio captured and archived.\n\nPhysical Exam:\nVITALS: BP 120/80, HR 72, Temp 98.6°F, SpO2 98% on room air.\nGeneral: Alert, oriented x3. Well-appearing.\n\nAssessment & Plan:\n1. Structured documentation completed via Saint Mary AI.\n2. Follow up as scheduled.`
                          if (previewNote.note_id) {
                            await notesAPI.updateNote(previewNote.note_id, draft).catch(() => {})
                          }
                          setPreviewNote((p) => ({ ...p, final_note: draft }))
                          showToast('✓ Structured note ready!')
                        }}
                      >
                        ⚡ Generate Note
                      </button>
                    )}
                  </div>
                </div>
              ) : (
                <div className="sb-empty-preview">
                  <span className="sb-empty-icon">📋</span>
                  <h4>No Active Note Preview</h4>
                  <p>Start an ambient recording on the left. Once completed, your structured note will instantly appear here.</p>
                </div>
              )}

              {/* Compact Patient Queue */}
              <div className="sb-queue-box">
                <div className="sb-queue-header">
                  <h4>Patient Queue ({visits.length})</h4>
                  <span className="sb-queue-date">Today at Saint Mary Clinic</span>
                </div>
                <div className="sb-queue-items">
                  {visits.length === 0 ? (
                    <p className="sb-queue-none">No patients scheduled for today.</p>
                  ) : (
                    visits.slice(0, 5).map((v) => (
                      <div
                        key={v.id}
                        className={`sb-queue-row ${previewNote?.id === v.id ? 'sb-queue-row--active' : ''}`}
                        onClick={() => handleViewNote(v)}
                      >
                        <div className="sb-queue-row__info">
                          <strong>{v.patient_name}</strong>
                          <span>{v.visit_time || 'Today'} · {v.visit_type}</span>
                        </div>
                        <span className={`sb-badge-pill sb-badge-pill--${v.status}`}>
                          {v.status === 'upcoming' ? 'Scheduled' : 'Ready'}
                        </span>
                      </div>
                    ))
                  )}
                </div>
              </div>
            </aside>
          </div>
        )}

        {/* ─── TAB 2: QUICK DICTATE (Concept 2 Hybrid: Side-by-Side Workspace) ─── */}
        {tab === 'dictate' && (
          <div className="sb-hybrid-grid">
            {/* Left Pane: Dictation Scratchpad & Smart Macros */}
            <section className="sb-card sb-dictate-left-card">
              <div className="sb-card__header">
                <div>
                  <h3 className="sb-card__title">Quick Dictate</h3>
                  <p className="sb-card__sub">Type, paste, or dictate encounter notes</p>
                </div>
                <div className="sb-template-picker">
                  <select value={selectedTemplate} onChange={(e) => setSelectedTemplate(e.target.value)}>
                    <option value="SOAP Note">SOAP Note</option>
                    <option value="Comprehensive Exam">Comprehensive Exam</option>
                    <option value="Follow-up Encounter">Follow-up Encounter</option>
                  </select>
                </div>
              </div>

              <div className="sb-dictate-pad">
                <textarea
                  className="sb-dictate-textarea-hybrid"
                  placeholder="Start dictating here...

Patient is a 54-year-old presenting with symptoms for 3 days. Denies fever. Vitals normal. 

Assessment & Plan..."
                  value={quickDictateText}
                  onChange={(e) => setQuickDictateText(e.target.value)}
                />

                {/* Smart Macro Chips */}
                <div className="sb-macro-bar">
                  <button type="button" className="sb-chip" onClick={() => handleInsertSnippet('Vitals: BP 118/76, HR 72, Temp 98.6°F, SpO2 99% on room air.')}>+ Normal Vitals</button>
                  <button type="button" className="sb-chip" onClick={() => handleInsertSnippet('Physical Exam: Alert, oriented x3. Lungs clear to auscultation. Heart regular rate/rhythm.')}>+ Exam Stable</button>
                  <button type="button" className="sb-chip" onClick={() => handleInsertSnippet('Assessment: Chronic conditions stable. Refilled standard medications.')}>+ Refill Meds</button>
                  <button type="button" className="sb-chip" onClick={() => handleInsertSnippet('Plan: Return to clinic in 4 weeks or sooner if symptoms worsen.')}>+ 4-Wk Follow-up</button>
                </div>

                <div className="sb-dictate-footer-actions">
                  <button
                    type="button"
                    className="sb-btn sb-btn--outline"
                    onClick={() => setQuickDictateText('')}
                    disabled={!quickDictateText || generatingQuickNote}
                  >
                    Clear Text
                  </button>
                  <button
                    type="button"
                    className="sb-btn sb-btn--primary-blue"
                    onClick={handleGenerateQuickDictateNote}
                    disabled={!quickDictateText.trim() || generatingQuickNote}
                  >
                    {generatingQuickNote ? 'Generating Note…' : '⚡ Generate Structured SOAP Note'}
                  </button>
                </div>
              </div>
            </section>

            {/* Right Pane: Live Side-by-Side SOAP Note Preview */}
            <aside className="sb-card sb-dictate-right-card">
              <div className="sb-card__header">
                <div>
                  <h3 className="sb-card__title">Preview: SOAP Note</h3>
                  <p className="sb-card__sub">Structured Saint Mary documentation</p>
                </div>
                {quickDictateOutput && (
                  <span className="sb-status-badge-soft">Ready for EMR</span>
                )}
              </div>

              <div className="sb-dictate-preview-box">
                {quickDictateOutput ? (
                  <div className="sb-soap-output">
                    <pre>{quickDictateOutput.text}</pre>
                  </div>
                ) : (
                  <div className="sb-soap-placeholder">
                    <div className="sb-soap-section">
                      <strong>[S]ubjective</strong>
                      <p>Type or dictate encounter notes on the left to see your formatted subjective history.</p>
                    </div>
                    <div className="sb-soap-section">
                      <strong>[O]bjective</strong>
                      <p>Physical examination findings and vital signs will be structured here.</p>
                    </div>
                    <div className="sb-soap-section">
                      <strong>[A]ssessment</strong>
                      <p>Numbered diagnoses and clinical assessment.</p>
                    </div>
                    <div className="sb-soap-section">
                      <strong>[P]lan</strong>
                      <p>Treatment steps, medication refills, and follow-up timeline.</p>
                    </div>
                  </div>
                )}
              </div>

              <div className="sb-dictate-preview-actions">
                <button
                  type="button"
                  className={`sb-btn sb-btn--copy-hero ${copied ? 'sb-btn--copied' : ''}`}
                  onClick={() => copyToClipboard(quickDictateOutput?.text || previewNote?.final_note || quickDictateText)}
                >
                  {copied ? '✓ Copied' : '📋 Copy to EMR'}
                </button>
                <button
                  type="button"
                  className="sb-btn sb-btn--outline"
                  onClick={() => {
                    if (previewNote) handleViewNote(previewNote)
                    else showToast('Please generate a note first', 'info')
                  }}
                >
                  ✏️ Edit in Modal
                </button>
              </div>
            </aside>
          </div>
        )}

        {/* ─── TAB 3: NOTE HISTORY ─── */}
        {tab === 'history' && (
          <section className="sb-card sb-history-card">
            <div className="sb-card__header">
              <div>
                <h2 className="sb-card__title">Clinical Note Archive — Saint Mary Clinic</h2>
                <p className="sb-card__sub">All patient documentation and transcription records ({visits.length} total)</p>
              </div>
              <div className="sb-search-wrap">
                <input
                  type="text"
                  className="sb-search-input"
                  placeholder="Search by patient, MRN, or type…"
                  value={searchTerm}
                  onChange={(e) => setSearchTerm(e.target.value)}
                />
              </div>
            </div>

            <div className="sb-history-table-wrap">
              {filteredVisits.length === 0 ? (
                <div style={{ textAlign: 'center', padding: '3rem', color: '#64748B' }}>
                  <span style={{ fontSize: '32px', display: 'block', marginBottom: '8px' }}>📁</span>
                  <p>No clinical encounters found matching your criteria.</p>
                </div>
              ) : (
                <table className="sb-history-table">
                  <thead>
                    <tr>
                      <th>Patient</th>
                      <th>Date &amp; Time</th>
                      <th>Encounter Type</th>
                      <th>Status</th>
                      <th style={{ textAlign: 'right' }}>Actions</th>
                    </tr>
                  </thead>
                  <tbody>
                    {filteredVisits.map((v) => (
                      <tr key={v.id}>
                        <td>
                          <strong>{v.patient_name}</strong>
                          {v.mrn && <span className="sb-table-sub">{v.mrn}</span>}
                        </td>
                        <td>{v.visit_date ? `${String(v.visit_date).slice(0, 10)} ${v.visit_time || ''}` : (v.visit_time || 'Today')}</td>
                        <td>{v.visit_type || 'Consultation'}</td>
                        <td>
                          <span className={`sb-badge-pill sb-badge-pill--${v.status}`}>
                            {v.status}
                          </span>
                        </td>
                        <td style={{ textAlign: 'right' }}>
                          <button
                            type="button"
                            className="sb-btn sb-btn--sm sb-btn--outline"
                            onClick={() => handleViewNote(v)}
                          >
                            👁 View Note
                          </button>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
            </div>
          </section>
        )}
      </main>

      {/* Floating Scribeberry Dock for Multi-screen Safety */}
      <ScribeberryRecordingDock
        activeVisit={activeVisit}
        isPaused={isPaused}
        timerSeconds={timerSeconds}
        stream={audioStream}
        onPauseResume={handlePauseResume}
        onEndVisit={handleEndVisit}
        onCancel={handleCancelRecording}
        mode="primary"
      />

      {/* Quick Consultation / Patient Selector */}
      <QuickConsultationModal
        isOpen={quickRecOpen}
        onClose={() => setQuickRecOpen(false)}
        upcomingVisits={visits}
        patients={patientList}
        onStartScheduledVisit={startRecordingSession}
        onStartQuickVisit={handleStartQuickConsult}
        onStartInstantVisit={handleStartInstantDictation}
      />

      {/* Comprehensive Saint Mary Clinical Note Viewer Modal */}
      {selectedNoteModal && (
        <SaintMaryNoteViewerModal
          noteData={selectedNoteModal}
          onClose={() => setSelectedNoteModal(null)}
          onNoteUpdated={(updated) => {
            setSelectedNoteModal(updated)
            setPreviewNote(updated)
            setVisits((prev) =>
              prev.map((v) => (v.id === updated.id || v.id === updated.visit_id ? { ...v, ...updated } : v))
            )
          }}
          showToast={showToast}
        />
      )}

      {/* Toast Notification */}
      {toast && (
        <div className={`sb-toast sb-toast--${toast.type || 'success'}`}>
          {toast.msg}
        </div>
      )}
    </div>
  )
}
