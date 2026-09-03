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

const CLINICAL_TEMPLATES = [
  { id: 'soap-adult', label: 'SOAP Note — Adult (Standard)', type: 'Follow-up' },
  { id: 'soap-pediatric', label: 'SOAP Note — Pediatric', type: 'Follow-up' },
  { id: 'comprehensive', label: 'Comprehensive Physical Exam (H&P)', type: 'New Patient' },
  { id: 'ortho-msk', label: 'Musculoskeletal / Orthopedic Exam', type: 'Follow-up' },
  { id: 'cardio', label: 'Cardiology / Chest Pain Consult', type: 'Follow-up' },
  { id: 'wellness', label: 'Annual Wellness / Preventive Visit', type: 'Follow-up' },
  { id: 'telehealth', label: 'Telehealth / Virtual Encounter', type: 'Virtual Visit' },
]

const QUICK_SMART_CHIPS = [
  { label: '+ Vitals (120/80, 72bpm)', text: 'VITALS: BP 120/80 mmHg, HR 72 bpm, SpO2 99% on room air, Temp 98.6°F.' },
  { label: '+ Alert & Oriented x3', text: 'GENERAL: Alert, oriented x3, well-appearing, in no acute distress.' },
  { label: '+ Normal Heart & Lungs', text: 'CARDIO/RESP: Heart regular rate and rhythm, no murmurs. Lungs clear to auscultation bilaterally.' },
  { label: '+ Right Knee MSK Exam', text: 'RIGHT KNEE EXAM: Tenderness to palpation over MCL, positive McMurray test, mild joint effusion, limited flexion due to pain.' },
  { label: '+ Start Ibuprofen 600mg', text: 'PLAN MEDS: Start Ibuprofen 600 mg PO TID with meals as needed for pain and inflammation.' },
  { label: '+ Ortho Referral & MRI', text: 'PLAN ORDERS: Outpatient orthopedic referral for evaluation and MRI imaging of the affected joint.' },
  { label: '+ 2-Week Follow-up', text: 'FOLLOW-UP: Return to clinic in 2 weeks or sooner if symptoms, swelling, or pain worsen.' },
]

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
    return [{ header: 'CLINICAL NOTE', content: text }]
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
        content: content,
      })
    }
  }
  return sections
}

export default function ScribeberryClinicianPortal({ currentUser, onLogout }) {
  const [tab, setTab] = useState('ambient') // 'ambient' | 'dictate' | 'workbench' | 'history'
  const [visits, setVisits] = useState([])
  const [patientList, setPatientList] = useState([])
  const [toast, setToast] = useState(null)
  const [searchTerm, setSearchTerm] = useState('')
  const [scheduleFilter, setScheduleFilter] = useState('all') // 'all' | 'ready' | 'draft' | 'upcoming'

  // Recording State
  const [activeVisit, setActiveVisit] = useState(null)
  const [isPaused, setIsPaused] = useState(false)
  const [timerSeconds, setTimerSeconds] = useState(0)
  const [uploading, setUploading] = useState(false)
  const [uploadStatus, setUploadStatus] = useState('')
  const [selectedTemplate, setSelectedTemplate] = useState('SOAP Note — Adult (Standard)')
  const [audioStream, setAudioStream] = useState(null)
  const [liveTranscript, setLiveTranscript] = useState('')
  const [micLevel, setMicLevel] = useState(0)

  // Ambient Dictation scratchpad
  const [dictationNotes, setDictationNotes] = useState('')

  // After-recording Review state (1c)
  const [recordedDuration, setRecordedDuration] = useState('00:00')
  const [activeDraftNote, setActiveDraftNote] = useState(null)
  const [selectedAssignPatientId, setSelectedAssignPatientId] = useState('')
  const [isAssigning, setIsAssigning] = useState(false)
  const [isEditingNote, setIsEditingNote] = useState(false)
  const [editedNoteText, setEditedNoteText] = useState('')

  // Note detail modal & copy feedback
  const [selectedNoteModal, setSelectedNoteModal] = useState(null)
  const [copiedSectionIndex, setCopiedSectionIndex] = useState(null)
  const [copiedFullNote, setCopiedFullNote] = useState(false)
  const [quickRecOpen, setQuickRecOpen] = useState(false)

  // MediaRecorder & SpeechRecognition refs
  const mediaRecorderRef = useRef(null)
  const speechRecRef = useRef(null)
  const liveTranscriptRef = useRef('')
  const audioChunksRef = useRef([])
  const timerIntervalRef = useRef(null)
  const animFrameRef = useRef(null)
  const audioContextRef = useRef(null)
  const transcriptScrollRef = useRef(null)

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
          setEditedNoteText(withNote.final_note || withNote.ai_draft || '')
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
      if (animFrameRef.current) cancelAnimationFrame(animFrameRef.current)
      if (audioContextRef.current) {
        try { audioContextRef.current.close() } catch {}
      }
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

  // Auto-scroll live transcript
  useEffect(() => {
    if (transcriptScrollRef.current) {
      transcriptScrollRef.current.scrollTop = transcriptScrollRef.current.scrollHeight
    }
  }, [liveTranscript])

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

      const stream = await navigator.mediaDevices.getUserMedia({
        audio: {
          echoCancellation: true,
          noiseSuppression: true,
          autoGainControl: true,
        },
      })

      const mime = ['audio/ogg;codecs=opus', 'audio/webm;codecs=opus', 'audio/webm'].find(
        (x) => window.MediaRecorder && window.MediaRecorder.isTypeSupported(x)
      ) || ''
      const rec = new window.MediaRecorder(stream, mime ? { mimeType: mime } : {})

      audioChunksRef.current = []
      mediaRecorderRef.current = rec
      setAudioStream(stream)

      // Audio meter for mic volume responsiveness
      try {
        const AudioCtx = window.AudioContext || window.webkitAudioContext
        if (AudioCtx) {
          const audioCtx = new AudioCtx()
          audioContextRef.current = audioCtx
          const source = audioCtx.createMediaStreamSource(stream)
          const analyser = audioCtx.createAnalyser()
          analyser.fftSize = 64
          source.connect(analyser)
          const dataArr = new Uint8Array(analyser.frequencyBinCount)

          const updateVolume = () => {
            if (!mediaRecorderRef.current || mediaRecorderRef.current.state === 'inactive') return
            analyser.getByteFrequencyData(dataArr)
            let sum = 0
            for (let i = 0; i < dataArr.length; i++) sum += dataArr[i]
            const avg = sum / dataArr.length
            setMicLevel(Math.min(100, Math.round((avg / 128) * 100)))
            animFrameRef.current = requestAnimationFrame(updateVolume)
          }
          updateVolume()
        }
      } catch {}

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

      showToast(`🎙 Ambient Scribe active! Consulting for ${visit.patient_name || 'Patient'}.`)
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
    setUploadStatus('Synthesizing structured SOAP documentation & medical coding...')

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
          setEditedNoteText(generatedSOAP)
          setSelectedAssignPatientId(currentActive.patient_id ? String(currentActive.patient_id) : '')
          showToast(`✓ Clinical SOAP Note & ICD-10 Codes generated!`)

          // Background Claude enhancement
          visitsAPI.generateDraft(currentActive.id).then(async (dRes) => {
            if (dRes?.ai_draft && !dRes.ai_draft.includes('unavailable')) {
              const refreshedNote = dRes.ai_draft
              if (nRes?.note?.id) {
                await notesAPI.updateNote(nRes.note.id, refreshedNote).catch(() => {})
              }
              setActiveDraftNote((prev) => (prev && prev.id === currentActive.id ? { ...prev, final_note: refreshedNote, ai_draft: refreshedNote } : prev))
              setEditedNoteText(refreshedNote)
            }
          }).catch(() => {})
        } catch (noteErr) {
          console.error('Note formulation error:', noteErr)
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

  const handleCancelRecording = () => {
    if (speechRecRef.current) {
      try { speechRecRef.current.stop() } catch {}
      speechRecRef.current = null
    }
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
    setLiveTranscript('')
    liveTranscriptRef.current = ''
    showToast('Recording cancelled and discarded.', 'info')
  }

  const handleAssignPatient = async () => {
    if (!activeDraftNote || !selectedAssignPatientId) {
      showToast('Please select a patient from the dropdown.', 'warn')
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
      showToast(`✓ Assigned encounter to ${targetName} (${targetMrn})`)
      await loadData()
    } catch (err) {
      showToast(err?.message || 'Failed to assign patient.', 'error')
    } finally {
      setIsAssigning(false)
    }
  }

  const handleCopyFullNote = () => {
    const textToCopy = isEditingNote ? editedNoteText : (activeDraftNote?.final_note || activeDraftNote?.ai_draft || '')
    if (!textToCopy) return

    navigator.clipboard.writeText(cleanAiDraftForDisplay(textToCopy)).then(() => {
      setCopiedFullNote(true)
      showToast('✓ Full Note copied to clipboard! Ready to paste into EMR.')
      setTimeout(() => setCopiedFullNote(false), 2500)
    })
  }

  const handleCopySection = (content, index) => {
    if (!content) return
    navigator.clipboard.writeText(cleanAiDraftForDisplay(content)).then(() => {
      setCopiedSectionIndex(index)
      showToast('✓ Section copied to clipboard!')
      setTimeout(() => setCopiedSectionIndex(null), 2000)
    })
  }

  const handleSaveEditedNote = async () => {
    if (!activeDraftNote?.note_id) {
      showToast('No note record found to save.', 'warn')
      return
    }
    try {
      await notesAPI.updateNote(activeDraftNote.note_id, editedNoteText)
      setActiveDraftNote((prev) => ({ ...prev, final_note: editedNoteText, ai_draft: editedNoteText }))
      setIsEditingNote(false)
      showToast('✓ Clinical note changes saved successfully!')
      await loadData()
    } catch (err) {
      showToast(err?.message || 'Failed to save note edits.', 'error')
    }
  }

  const handleReviewAndSign = async (visit) => {
    const target = visit || activeDraftNote
    if (!target?.note_id) {
      showToast('Note record not found to sign.', 'warn')
      return
    }
    try {
      await notesAPI.submitNote(target.note_id)
      await visitsAPI.updateStatus(target.id, 'completed').catch(() => {})
      showToast('✓ Note officially reviewed & signed!')
      if (activeDraftNote && activeDraftNote.id === target.id) {
        setActiveDraftNote((prev) => ({ ...prev, status: 'completed' }))
      }
      await loadData()
    } catch (err) {
      showToast(err?.message || 'Failed to sign note.', 'error')
    }
  }

  const handleRegenerateNote = async () => {
    if (!activeDraftNote?.id) return
    setUploading(true)
    setUploadStatus('Re-generating note with Anthropic Claude AI...')
    try {
      const res = await visitsAPI.generateDraft(activeDraftNote.id)
      if (res?.ai_draft) {
        setActiveDraftNote((p) => ({ ...p, final_note: res.ai_draft, ai_draft: res.ai_draft }))
        setEditedNoteText(res.ai_draft)
        showToast('✓ AI Note regenerated successfully!')
      }
    } catch {
      showToast('Failed to regenerate AI draft.', 'error')
    } finally {
      setUploading(false)
    }
  }

  const handleInsertSmartChip = (chipText) => {
    setDictationNotes((prev) => {
      const trimmed = prev.trim()
      return trimmed ? `${trimmed}\n${chipText}` : chipText
    })
    showToast(`Added: ${chipText.slice(0, 30)}...`)
  }

  const handleSelectVisitFromSchedule = async (visit) => {
    if (activeVisit) {
      showToast('Please finish or pause the active recording before switching encounters.', 'warn')
      return
    }

    try {
      const res = await notesAPI.getByVisit(visit.id).catch(() => null)
      const noteData = res?.note
      const combined = {
        ...visit,
        note_id: noteData?.id || visit.note_id,
        final_note: noteData?.final_note || visit.final_note,
        ai_draft: noteData?.ai_draft || visit.ai_draft,
        transcription: noteData?.transcription || visit.transcription,
        status: noteData?.status || visit.status,
      }
      setActiveDraftNote(combined)
      setEditedNoteText(combined.final_note || combined.ai_draft || '')
      setSelectedAssignPatientId(visit.patient_id ? String(visit.patient_id) : '')
      setRecordedDuration(visit.duration_seconds ? fmtTime(visit.duration_seconds) : '04:12')
      setTab('ambient')
    } catch {
      setActiveDraftNote(visit)
      setEditedNoteText(visit.final_note || visit.ai_draft || '')
    }
  }

  // Determine current active display state
  const isRecordingState = Boolean(activeVisit)
  const isReviewState = Boolean(!activeVisit && activeDraftNote && (activeDraftNote.final_note || activeDraftNote.ai_draft))
  const isIdleState = !isRecordingState && !isReviewState

  const activeNoteSections = isReviewState
    ? parseNoteSections(activeDraftNote.final_note || activeDraftNote.ai_draft)
    : []

  // Filter today's visits list
  const filteredVisits = visits.filter((v) => {
    const hasNote = Boolean(v.final_note || v.ai_draft)
    const isCompleted = v.status === 'completed'
    if (scheduleFilter === 'ready' && !(isCompleted || (hasNote && v.status === 'ready'))) return false
    if (scheduleFilter === 'draft' && !(hasNote && !isCompleted)) return false
    if (scheduleFilter === 'upcoming' && (hasNote || isCompleted)) return false

    if (searchTerm) {
      const term = searchTerm.toLowerCase()
      const matchName = (v.patient_name || '').toLowerCase().includes(term)
      const matchMrn = (v.mrn || '').toLowerCase().includes(term)
      if (!matchName && !matchMrn) return false
    }
    return true
  })

  return (
    <div className="sm-portal">
      {/* Toast Notification */}
      {toast && (
        <div className={`sm-toast sm-toast--${toast.type}`}>
          <span className="sm-toast-icon">
            {toast.type === 'success' ? '✓' : toast.type === 'error' ? '✕' : 'ℹ'}
          </span>
          <span>{toast.msg}</span>
        </div>
      )}

      {/* Global Clinical Header */}
      <header className="sm-header">
        <div className="sm-header__brand-group">
          <div className="sm-brand">
            <span className="sm-brand__icon">✚</span>
            <div className="sm-brand__info">
              <span className="sm-brand__name">Saint Mary</span>
              <span className="sm-brand__sub">Clinical AI Scribe</span>
            </div>
          </div>

          <div className="sm-header__divider" />

          <nav className="sm-nav">
            <button
              type="button"
              className={`sm-nav__btn ${tab === 'ambient' ? 'sm-nav__btn--active' : ''}`}
              onClick={() => setTab('ambient')}
            >
              <span className="sm-nav__icon">🎙</span>
              <span>Ambient Scribe</span>
            </button>
            <button
              type="button"
              className={`sm-nav__btn ${tab === 'history' ? 'sm-nav__btn--active' : ''}`}
              onClick={() => setTab('history')}
            >
              <span className="sm-nav__icon">📁</span>
              <span>Note History</span>
              <span className="sm-nav__count">{visits.length}</span>
            </button>
          </nav>
        </div>

        <div className="sm-header__user-group">
          {/* Active Recording Badge with Audio Sensitivity Meter */}
          {isRecordingState && (
            <div className="sm-live-badge">
              <span className="sm-live-badge__dot" />
              <span className="sm-live-badge__text">LIVE REC</span>
              <div className="sm-mic-meter" title={`Mic sensitivity: ${micLevel}%`}>
                <span className="sm-mic-meter__bar" style={{ height: `${Math.max(20, micLevel)}%` }} />
                <span className="sm-mic-meter__bar" style={{ height: `${Math.max(10, micLevel * 0.8)}%` }} />
                <span className="sm-mic-meter__bar" style={{ height: `${Math.max(30, micLevel * 1.1)}%` }} />
              </div>
            </div>
          )}

          <div className="sm-clinician-badge">
            <div className="sm-clinician-avatar">
              {currentUser?.name ? currentUser.name.split(' ').map((n) => n[0]).join('').slice(0, 2).toUpperCase() : 'CP'}
            </div>
            <div className="sm-clinician-meta">
              <span className="sm-clinician-name">{currentUser?.name || 'Dr Celina Provencio'}</span>
              <span className="sm-clinician-role">Saint Mary Clinic • Alberta</span>
            </div>
          </div>

          <button type="button" className="sm-logout-link" onClick={onLogout} title="Sign Out">
            Sign out
          </button>
        </div>
      </header>

      {/* Main 2-Column Clinical Layout */}
      <main className="sm-workspace">
        {/* ─── LEFT COLUMN: CLINICAL WORKSPACE ─── */}
        <section className="sm-canvas">
          {/* TAB 1: AMBIENT SCRIBE */}
          {tab === 'ambient' && (
            <>
              {/* STATE 1a: IDLE — Ready to Record */}
              {isIdleState && (
                <div className="sm-state-idle">
                  <div className="sm-idle-card">
                    {/* Glowing Mic Hero */}
                    <div className="sm-idle-mic-wrap">
                      <button
                        type="button"
                        className="sm-idle-mic-btn"
                        onClick={handleStartInstantDictation}
                        title="Click to start ambient consultation"
                      >
                        <svg width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
                          <path d="M12 2a3 3 0 0 0-3 3v7a3 3 0 0 0 6 0V5a3 3 0 0 0-3-3Z" />
                          <path d="M19 10v2a7 7 0 0 1-14 0v-2" />
                          <line x1="12" y1="19" x2="12" y2="22" />
                        </svg>
                      </button>
                    </div>

                    <div className="sm-clock-display">00:00</div>
                    <div className="sm-status-line">
                      <span className="sm-status-dot sm-status-dot--ready" />
                      <span>Ready for consultation</span>
                    </div>

                    <button
                      type="button"
                      className="sm-btn-hero-record"
                      onClick={handleStartInstantDictation}
                    >
                      <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                        <path d="M12 2a3 3 0 0 0-3 3v7a3 3 0 0 0 6 0V5a3 3 0 0 0-3-3Z" />
                        <path d="M19 10v2a7 7 0 0 1-14 0v-2" />
                        <line x1="12" y1="19" x2="12" y2="22" />
                      </svg>
                      <span>Start recording</span>
                    </button>

                    <span className="sm-sub-caption">No patient needed — assign after</span>

                    {/* Template Selection Pill */}
                    <div className="sm-template-pill">
                      <span className="sm-template-pill__tag">Template</span>
                      <select
                        className="sm-template-pill__select"
                        value={selectedTemplate}
                        onChange={(e) => setSelectedTemplate(e.target.value)}
                      >
                        {CLINICAL_TEMPLATES.map((t) => (
                          <option key={t.id} value={t.label}>
                            {t.label} ▾
                          </option>
                        ))}
                      </select>
                    </div>

                    {/* Quick Smart Observation Chips */}
                    <div className="sm-smart-chips-box">
                      <span className="sm-smart-chips-title">Quick Observation Presets</span>
                      <div className="sm-smart-chips-row">
                        {QUICK_SMART_CHIPS.slice(0, 5).map((chip, idx) => (
                          <button
                            key={idx}
                            type="button"
                            className="sm-smart-chip"
                            onClick={() => handleInsertSmartChip(chip.text)}
                          >
                            {chip.label}
                          </button>
                        ))}
                      </div>
                    </div>
                  </div>
                </div>
              )}

              {/* STATE 1b: RECORDING — Mic is Live */}
              {isRecordingState && (
                <div className="sm-state-recording">
                  <div className="sm-recording-card">
                    {/* Live Glowing Mic */}
                    <div className={`sm-rec-mic-halo ${isPaused ? 'sm-rec-mic-halo--paused' : ''}`}>
                      <div className="sm-rec-mic-btn">
                        <svg width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
                          <path d="M12 2a3 3 0 0 0-3 3v7a3 3 0 0 0 6 0V5a3 3 0 0 0-3-3Z" />
                          <path d="M19 10v2a7 7 0 0 1-14 0v-2" />
                          <line x1="12" y1="19" x2="12" y2="22" />
                        </svg>
                      </div>
                    </div>

                    <div className="sm-clock-display sm-clock-display--live">{fmtTime(timerSeconds)}</div>
                    <div className="sm-status-line">
                      <span className={`sm-status-dot ${isPaused ? 'sm-status-dot--paused' : 'sm-status-dot--live'}`} />
                      <span>{isPaused ? 'Consultation paused' : 'Listening — ambient scribe active'}</span>
                    </div>

                    {/* Audio Waveform Reaction */}
                    <div className="sm-waveform-wrap">
                      <RecordingVisualizer stream={audioStream} isPaused={isPaused} barCount={24} theme="danger" />
                    </div>

                    {/* Live Speech Recognition Auto-Scroll Bubble */}
                    <div className="sm-live-transcript-card" ref={transcriptScrollRef}>
                      <div className="sm-live-transcript-header">
                        <span className="sm-live-transcript-badge">LIVE TRANSCRIPT</span>
                        <span className="sm-live-transcript-meta">AI streaming dictation...</span>
                      </div>
                      <div className="sm-live-transcript-text">
                        {liveTranscript ? `“${liveTranscript}”` : 'Start speaking naturally with the patient. The ambient scribe is capturing clinical insights in real-time...'}
                      </div>
                    </div>

                    {/* Action Button Controls */}
                    <div className="sm-rec-actions-row">
                      <button
                        type="button"
                        className="sm-btn-action sm-btn-action--pause"
                        onClick={handlePauseResume}
                      >
                        {isPaused ? '▶ Resume' : '⏸ Pause'}
                      </button>

                      <button
                        type="button"
                        className="sm-btn-action sm-btn-action--stop"
                        onClick={handleEndVisit}
                      >
                        <span className="sm-square-icon" />
                        <span>Stop & generate</span>
                      </button>

                      <button
                        type="button"
                        className="sm-btn-action sm-btn-action--cancel"
                        onClick={handleCancelRecording}
                        title="Cancel recording"
                      >
                        ✕
                      </button>
                    </div>

                    {/* Template Selection Pill */}
                    <div className="sm-template-pill">
                      <span className="sm-template-pill__tag">Template</span>
                      <select
                        className="sm-template-pill__select"
                        value={selectedTemplate}
                        onChange={(e) => setSelectedTemplate(e.target.value)}
                      >
                        {CLINICAL_TEMPLATES.map((t) => (
                          <option key={t.id} value={t.label}>
                            {t.label} ▾
                          </option>
                        ))}
                      </select>
                    </div>
                  </div>
                </div>
              )}

              {/* STATE 1c: AFTER STOP — Review & Assign SOAP Note */}
              {isReviewState && (
                <div className="sm-state-review">
                  {/* Top Amber Patient Linkage Banner */}
                  <div className="sm-assign-banner">
                    <div className="sm-assign-banner__left">
                      <div className="sm-assign-icon">
                        <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="#9A3412" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                          <path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2" />
                          <circle cx="9" cy="7" r="4" />
                          <line x1="19" y1="8" x2="19" y2="14" />
                          <line x1="22" y1="11" x2="16" y2="11" />
                        </svg>
                      </div>
                      <div className="sm-assign-details">
                        <strong>Assign this recording</strong>
                        <span>
                          {recordedDuration || '04:12'} recording · {selectedTemplate || 'SOAP Note — Adult'}
                        </span>
                      </div>
                    </div>

                    <div className="sm-assign-banner__right">
                      <select
                        className="sm-assign-dropdown"
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
                        className="sm-btn-assign"
                        onClick={handleAssignPatient}
                        disabled={isAssigning}
                      >
                        {isAssigning ? 'Assigning...' : 'Assign'}
                      </button>
                    </div>
                  </div>

                  {/* Note Header & Action Controls */}
                  <div className="sm-doc-header">
                    <div className="sm-doc-header__left">
                      <h2>Draft note</h2>
                      <span className="sm-badge-ai">AI SCRIBED</span>
                      <span className="sm-doc-patient-meta">
                        {activeDraftNote?.patient_name || 'Patient'} · {activeDraftNote?.mrn || 'No MRN'}
                      </span>
                    </div>

                    <div className="sm-doc-header__right">
                      <button
                        type="button"
                        className="sm-btn-doc sm-btn-doc--copy"
                        onClick={handleCopyFullNote}
                      >
                        {copiedFullNote ? '✓ Copied to EMR!' : '📋 Copy to EMR'}
                      </button>

                      <button
                        type="button"
                        className={`sm-btn-doc ${isEditingNote ? 'sm-btn-doc--save' : 'sm-btn-doc--edit'}`}
                        onClick={isEditingNote ? handleSaveEditedNote : () => setIsEditingNote(true)}
                      >
                        {isEditingNote ? '💾 Save Changes' : '✏️ Edit'}
                      </button>

                      <button
                        type="button"
                        className="sm-btn-doc sm-btn-doc--sign"
                        onClick={() => handleReviewAndSign(activeDraftNote)}
                      >
                        ✍️ Review & sign
                      </button>

                      <button
                        type="button"
                        className="sm-btn-doc sm-btn-doc--new"
                        onClick={handleStartInstantDictation}
                        title="Start another patient consultation"
                      >
                        + New
                      </button>
                    </div>
                  </div>

                  {/* Note Body: Structured Medical Document View */}
                  {isEditingNote ? (
                    <div className="sm-edit-note-box">
                      <textarea
                        className="sm-edit-note-textarea"
                        value={editedNoteText}
                        onChange={(e) => setEditedNoteText(e.target.value)}
                        rows={18}
                      />
                    </div>
                  ) : (
                    <div className="sm-doc-body">
                      {activeNoteSections.map((sec, idx) => (
                        <div key={idx} className="sm-doc-section">
                          <div className="sm-doc-section__header-row">
                            <span className="sm-doc-section__title">{sec.header}</span>
                            <button
                              type="button"
                              className="sm-btn-copy-sec"
                              onClick={() => handleCopySection(sec.content, idx)}
                              title="Copy this section"
                            >
                              {copiedSectionIndex === idx ? '✓ Copied' : 'Copy'}
                            </button>
                          </div>
                          <div className="sm-doc-section__content">{sec.content}</div>
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              )}
            </>
          )}

          {/* TAB 2: NOTE HISTORY */}
          {tab === 'history' && (
            <div className="sm-history-panel">
              <div className="sm-panel-header sm-panel-header--flex">
                <div>
                  <h2>📁 Consultation & Note History</h2>
                  <p>Review signed and draft clinical documentation for Dr. Provencio's patients.</p>
                </div>
                <input
                  type="text"
                  className="sm-search-control"
                  placeholder="🔍 Search by name or MRN..."
                  value={searchTerm}
                  onChange={(e) => setSearchTerm(e.target.value)}
                />
              </div>

              <div className="sm-history-grid">
                {visits
                  .filter((v) => !searchTerm || (v.patient_name || '').toLowerCase().includes(searchTerm.toLowerCase()) || (v.mrn || '').toLowerCase().includes(searchTerm.toLowerCase()))
                  .map((v) => (
                    <div key={v.id} className="sm-history-card" onClick={() => handleSelectVisitFromSchedule(v)}>
                      <div className="sm-history-card__left">
                        <div className="sm-history-card__name-row">
                          <strong>{v.patient_name || 'Patient'}</strong>
                          <span className="sm-history-card__mrn">{v.mrn || 'Auto-MRN'}</span>
                        </div>
                        <span className="sm-history-card__meta">
                          {v.visit_date} · {v.visit_time || '10:00'} · {v.visit_type}
                        </span>
                      </div>
                      <div className="sm-history-card__right">
                        <span className={`sm-badge ${v.status === 'completed' ? 'sm-badge--ready' : 'sm-badge--draft'}`}>
                          {v.status === 'completed' ? 'SIGNED' : (v.final_note || v.ai_draft ? 'DRAFT' : 'PENDING')}
                        </span>
                        <button type="button" className="sm-btn-sm-view" onClick={(e) => { e.stopPropagation(); setSelectedNoteModal(v) }}>
                          View Note
                        </button>
                      </div>
                    </div>
                  ))}
              </div>
            </div>
          )}
        </section>

        {/* ─── RIGHT COLUMN: CLINICAL SCHEDULE & SCRATCHPAD ─── */}
        <aside className="sm-sidebar">
          {/* Today's Schedule Card */}
          <div className="sm-side-card">
            <div className="sm-side-card__header">
              <div className="sm-side-card__title-group">
                <span className="sm-side-card__title">Today's visits</span>
                <span className="sm-side-card__count">{visits.length}</span>
              </div>

              {/* Schedule Filter Pills */}
              <div className="sm-filter-pills">
                <button
                  type="button"
                  className={`sm-filter-pill ${scheduleFilter === 'all' ? 'sm-filter-pill--active' : ''}`}
                  onClick={() => setScheduleFilter('all')}
                >
                  All
                </button>
                <button
                  type="button"
                  className={`sm-filter-pill ${scheduleFilter === 'ready' ? 'sm-filter-pill--active' : ''}`}
                  onClick={() => setScheduleFilter('ready')}
                >
                  Ready
                </button>
                <button
                  type="button"
                  className={`sm-filter-pill ${scheduleFilter === 'draft' ? 'sm-filter-pill--active' : ''}`}
                  onClick={() => setScheduleFilter('draft')}
                >
                  Draft
                </button>
              </div>
            </div>

            <div className="sm-visits-container">
              {filteredVisits.length === 0 ? (
                <div className="sm-empty-state">No scheduled encounters matching filter</div>
              ) : (
                filteredVisits.map((v) => {
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
                      className={`sm-visit-item ${isCurrent ? 'sm-visit-item--active' : ''}`}
                      onClick={() => handleSelectVisitFromSchedule(v)}
                    >
                      <div className="sm-visit-item__left">
                        <span className="sm-visit-item__dot" style={{ background: dotColor }} />
                        <div className="sm-visit-item__details">
                          <span className="sm-visit-item__patient">{v.patient_name || `Patient ${v.mrn || ''}`}</span>
                          <span className="sm-visit-item__sub">
                            {v.visit_time || '08:25'} · {v.visit_type || 'Follow-up'}
                          </span>
                        </div>
                      </div>

                      <div className="sm-visit-item__right">
                        {badgeType === 'ready' && <span className="sm-tag sm-tag--ready">READY</span>}
                        {badgeType === 'draft' && <span className="sm-tag sm-tag--draft">DRAFT</span>}
                        {badgeType === 'time' && <span className="sm-tag sm-tag--time">{badgeText}</span>}
                      </div>
                    </div>
                  )
                })
              )}
            </div>
          </div>

          {/* Smart Scratchpad Card */}
          <div className="sm-side-card sm-side-card--scratchpad">
            <div className="sm-side-card__header">
              <span className="sm-side-card__title">Scratchpad</span>
              <span className="sm-side-card__sub">Auto-synthesizes with dictation</span>
            </div>

            <textarea
              className="sm-scratchpad-area"
              placeholder="Type vitals, meds, findings... (e.g. BP 130/85, knee swollen, limited ROM)"
              value={dictationNotes}
              onChange={(e) => setDictationNotes(e.target.value)}
              rows={6}
            />

            <div className="sm-scratchpad-quick-bar">
              <button
                type="button"
                className="sm-btn-mini-chip"
                onClick={() => handleInsertSmartChip('BP 120/80, HR 72, Temp 98.6°F')}
              >
                + BP/Vitals
              </button>
              <button
                type="button"
                className="sm-btn-mini-chip"
                onClick={() => handleInsertSmartChip('Normal exam, no distress')}
              >
                + Norm Exam
              </button>
              <button
                type="button"
                className="sm-btn-mini-chip"
                onClick={() => handleInsertSmartChip('Ibuprofen 600mg BID')}
              >
                + Rx NSAID
              </button>
            </div>
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
