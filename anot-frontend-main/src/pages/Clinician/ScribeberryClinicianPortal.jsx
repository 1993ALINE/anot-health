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

const DEFAULT_MACROS = [
  {
    id: 'm_vitals',
    name: 'Normal Vitals',
    shortcut: '.vitals',
    content: 'VITALS: BP 120/80 mmHg, HR 72 bpm regular, Temp 98.6°F, RR 16/min, SpO2 99% on room air.',
  },
  {
    id: 'm_normexam',
    name: 'Normal Physical Exam',
    shortcut: '.normexam',
    content: 'PHYSICAL EXAM:\nGENERAL: Alert and oriented x3, well-nourished, in no acute distress.\nCARDIOVASCULAR: Regular rate and rhythm, normal S1/S2, no murmurs.\nPULMONARY: Clear to auscultation bilaterally, no wheezes, rales, or rhonchi.\nABDOMEN: Soft, non-tender, non-distended, normoactive bowel sounds.',
  },
  {
    id: 'm_kneemsk',
    name: 'Right Knee MSK Exam',
    shortcut: '.kneemsk',
    content: 'RIGHT KNEE EXAM:\nInspection: Mild joint effusion, no erythema or local warmth.\nPalpation: Tenderness to palpation along medial joint line and MCL.\nSpecial Tests: McMurray positive for medial joint discomfort. Lachman negative, stable to varus/valgus stress.\nROM: Active flexion to 115 degrees limited by pain; full extension (0 degrees).',
  },
  {
    id: 'm_rx_nsaid',
    name: 'Rx NSAID Plan',
    shortcut: '.rx_nsaid',
    content: 'PLAN:\n1. Ibuprofen 600 mg PO TID with meals as needed for pain and inflammation.\n2. Advised patient on gastrointestinal precautions and adequate hydration.\n3. Ice application for 15-20 minutes 3-4 times daily.',
  },
  {
    id: 'm_ortho',
    name: 'Ortho Referral & MRI',
    shortcut: '.ortho',
    content: 'PLAN:\n1. Outpatient orthopedic surgery referral ordered for advanced subspecialty evaluation.\n2. Right knee MRI without contrast ordered to assess meniscal and ligamentous status.\n3. Activity modification and avoid high-impact pivoting activities.',
  },
  {
    id: 'm_followup',
    name: '2-Week Follow-up',
    shortcut: '.followup',
    content: 'FOLLOW-UP:\n1. Return to clinic in 2 weeks or sooner if symptoms, swelling, or pain worsen.\n2. Red flag return precautions discussed including severe pain, calf swelling, or inability to bear weight.',
  },
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

function calculateAge(dateOfBirth) {
  if (!dateOfBirth) return ''
  try {
    const dob = new Date(dateOfBirth)
    if (isNaN(dob.getTime())) return ''
    const diffMs = Date.now() - dob.getTime()
    const ageDt = new Date(diffMs)
    const age = Math.abs(ageDt.getUTCFullYear() - 1970)
    return `${age} yrs`
  } catch {
    return ''
  }
}

function getPatientDisplayAge(visitOrPatient, patientList = []) {
  if (!visitOrPatient) return '36 yrs'
  if (visitOrPatient.age) {
    const num = String(visitOrPatient.age).replace(/[^0-9]/g, '')
    return num ? `${num} yrs` : visitOrPatient.age
  }
  if (visitOrPatient.date_of_birth) {
    const a = calculateAge(visitOrPatient.date_of_birth)
    if (a) return a
  }
  if (visitOrPatient.dob) {
    const a = calculateAge(visitOrPatient.dob)
    if (a) return a
  }
  if (visitOrPatient.patient_id && Array.isArray(patientList)) {
    const p = patientList.find((x) => String(x.id) === String(visitOrPatient.patient_id))
    if (p?.date_of_birth) {
      const a = calculateAge(p.date_of_birth)
      if (a) return a
    }
    if (p?.dob) {
      const a = calculateAge(p.dob)
      if (a) return a
    }
    if (p?.age) return `${p.age} yrs`
  }
  return '36 yrs'
}

export default function ScribeberryClinicianPortal({ currentUser, onLogout }) {
  const [tab, setTab] = useState('ambient') // 'ambient' | 'history'
  const [visits, setVisits] = useState([])
  const [patientList, setPatientList] = useState([])
  const [toast, setToast] = useState(null)
  const [searchTerm, setSearchTerm] = useState('')
  const [scheduleFilter, setScheduleFilter] = useState('all') // 'all' | 'ready' | 'draft' | 'upcoming'

  // Selected Patient for next/active encounter
  const [selectedPatientIdForEncounter, setSelectedPatientIdForEncounter] = useState('')
  const [patientNameInput, setPatientNameInput] = useState('')
  const [patientAgeInput, setPatientAgeInput] = useState('')
  const [patientMrnInput, setPatientMrnInput] = useState('')

  // Custom Free-Text Macros / SmartPhrases
  const [macros, setMacros] = useState(() => {
    try {
      const saved = localStorage.getItem('anot_clinician_macros_v2')
      if (saved) {
        const parsed = JSON.parse(saved)
        if (Array.isArray(parsed) && parsed.length > 0) return parsed
      }
    } catch {}
    return DEFAULT_MACROS
  })
  const [macroModalOpen, setMacroModalOpen] = useState(false)
  const [editingMacro, setEditingMacro] = useState(null)
  const [macroForm, setMacroForm] = useState({ name: '', shortcut: '', content: '' })

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
    loadData()
    const id = setInterval(loadData, 15000)
    return () => {
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

  const handleSelectScheduledPatient = (pId) => {
    setSelectedPatientIdForEncounter(pId)
    if (pId) {
      const p = patientList.find((x) => String(x.id) === String(pId))
      if (p) {
        setPatientNameInput(p.name || '')
        setPatientMrnInput(p.mrn || '')
        setPatientAgeInput(getPatientDisplayAge(p, patientList) || '')
      }
    } else {
      setPatientNameInput('')
      setPatientMrnInput('')
      setPatientAgeInput('')
    }
  }

  const handleStartInstantDictation = async (customPatientId = null) => {
    try {
      const now = new Date()
      const timeStr = `${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}`
      
      let patientId = customPatientId || selectedPatientIdForEncounter
      let patientName = patientNameInput.trim()
      let patientMrn = patientMrnInput.trim()
      let patientAge = patientAgeInput.trim()

      if (patientId && !patientName) {
        const found = patientList.find((p) => String(p.id) === String(patientId))
        if (found) {
          patientName = found.name
          patientMrn = found.mrn
          patientAge = getPatientDisplayAge(found, patientList)
        }
      }

      if (!patientName) {
        patientName = 'Patient Encounter'
      }

      if (!patientMrn) {
        patientMrn = `MRN-${now.getTime().toString().slice(-6)}`
      }

      if (!patientAge) {
        patientAge = '36 yrs'
      }

      // Create or ensure patient record in DB if new name is provided
      if (!patientId || (patientNameInput && patientName !== 'Patient Encounter')) {
        try {
          const pRes = await patientsAPI.create({
            name: patientName,
            mrn: patientMrn,
          })
          if (pRes?.patient?.id) {
            patientId = pRes.patient.id
          }
        } catch (e) {
          if (e.payload?.patient?.id) {
            patientId = e.payload.patient.id
          }
        }
      }

      const dbVisitType = normalizeVisitTypeForDb(selectedTemplate)
      const vRes = await visitsAPI.create({
        patient_id: patientId || undefined,
        visit_date: now.toISOString().slice(0, 10),
        visit_time: timeStr,
        visit_type: dbVisitType,
      })

      const newVisit = {
        id: vRes?.visit?.id,
        patient_id: patientId,
        patient_name: patientName,
        mrn: patientMrn,
        age: patientAge,
        visit_date: now.toISOString().slice(0, 10),
        visit_time: timeStr,
        visit_type: dbVisitType,
        status: 'in-progress',
      }

      await startRecordingSession(newVisit)
      await loadData()
    } catch (err) {
      showToast(err?.message || 'Failed to initialize consultation.', 'error')
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

  const saveMacrosToStorage = (newList) => {
    setMacros(newList)
    try {
      localStorage.setItem('anot_clinician_macros_v2', JSON.stringify(newList))
    } catch {}
  }

  const handleOpenAddMacro = () => {
    setEditingMacro(null)
    setMacroForm({ name: '', shortcut: '.', content: '' })
    setMacroModalOpen(true)
  }

  const handleOpenEditMacro = (macro) => {
    setEditingMacro(macro)
    setMacroForm({ name: macro.name, shortcut: macro.shortcut, content: macro.content })
    setMacroModalOpen(true)
  }

  const handleDeleteMacro = (id) => {
    const updated = macros.filter((m) => m.id !== id)
    saveMacrosToStorage(updated)
    showToast('Macro removed.', 'info')
  }

  const handleResetMacros = () => {
    saveMacrosToStorage(DEFAULT_MACROS)
    showToast('Reset macros to standard presets.')
  }

  const handleSaveMacroForm = (e) => {
    if (e && e.preventDefault) e.preventDefault()
    if (!macroForm.name.trim() || !macroForm.content.trim()) {
      showToast('Macro Name and Free Text Content are required.', 'warn')
      return
    }

    let shortcut = macroForm.shortcut.trim()
    if (shortcut && !shortcut.startsWith('.')) {
      shortcut = `.${shortcut}`
    }

    if (editingMacro) {
      const updated = macros.map((m) =>
        m.id === editingMacro.id
          ? { ...m, name: macroForm.name.trim(), shortcut: shortcut || `.${macroForm.name.toLowerCase().replace(/\s+/g, '')}`, content: macroForm.content.trim() }
          : m
      )
      saveMacrosToStorage(updated)
      showToast('✓ Macro updated successfully!')
    } else {
      const newMacro = {
        id: `m_${Date.now()}`,
        name: macroForm.name.trim(),
        shortcut: shortcut || `.${macroForm.name.toLowerCase().replace(/\s+/g, '')}`,
        content: macroForm.content.trim(),
      }
      saveMacrosToStorage([...macros, newMacro])
      showToast('✓ New Macro added successfully!')
    }

    setMacroModalOpen(false)
    setEditingMacro(null)
  }

  const handleInsertMacro = (macro) => {
    const textToInsert = macro.content || macro.text || ''
    if (!textToInsert) return
    setDictationNotes((prev) => {
      const trimmed = prev.trim()
      return trimmed ? `${trimmed}\n\n${textToInsert}` : textToInsert
    })
    showToast(`✓ Added macro: ${macro.name || macro.shortcut}`)
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
                    {/* Active Patient Demographic & Intake Bar */}
                    <div className="sm-patient-intake-card">
                      <div className="sm-patient-intake-header">
                        <div className="sm-patient-intake-badge">
                          <span className="sm-intake-icon">👤</span>
                          <span className="sm-intake-title">Patient Encounter Details</span>
                        </div>

                        {patientList.length > 0 && (
                          <div className="sm-patient-quick-select">
                            <select
                              className="sm-patient-quick-dropdown"
                              value={selectedPatientIdForEncounter}
                              onChange={(e) => handleSelectScheduledPatient(e.target.value)}
                            >
                              <option value="">⚡ Or select from Today's Scheduled Patients ({patientList.length}) ▾</option>
                              {patientList.map((p) => (
                                <option key={p.id} value={p.id}>
                                  {p.name} — Age: {getPatientDisplayAge(p, patientList)} ({p.mrn})
                                </option>
                              ))}
                            </select>
                          </div>
                        )}
                      </div>

                      <div className="sm-patient-intake-inputs-row">
                        <div className="sm-intake-field sm-intake-field--name">
                          <label className="sm-intake-label">Patient Name *</label>
                          <input
                            type="text"
                            className="sm-intake-input sm-intake-input--name"
                            placeholder="Enter patient name (e.g. John Doe, Sarah Miller)..."
                            value={patientNameInput}
                            onChange={(e) => {
                              setPatientNameInput(e.target.value)
                              if (selectedPatientIdForEncounter) setSelectedPatientIdForEncounter('')
                            }}
                          />
                        </div>

                        <div className="sm-intake-field sm-intake-field--age">
                          <label className="sm-intake-label">Age / DOB</label>
                          <input
                            type="text"
                            className="sm-intake-input"
                            placeholder="e.g. 45 yrs"
                            value={patientAgeInput}
                            onChange={(e) => setPatientAgeInput(e.target.value)}
                          />
                        </div>

                        <div className="sm-intake-field sm-intake-field--mrn">
                          <label className="sm-intake-label">MRN / ID</label>
                          <input
                            type="text"
                            className="sm-intake-input"
                            placeholder="e.g. MRN-849201"
                            value={patientMrnInput}
                            onChange={(e) => setPatientMrnInput(e.target.value)}
                          />
                        </div>
                      </div>
                    </div>

                    {/* Glowing Mic Hero */}
                    <div className="sm-idle-mic-wrap">
                      <button
                        type="button"
                        className="sm-idle-mic-btn"
                        onClick={() => handleStartInstantDictation()}
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
                      onClick={() => handleStartInstantDictation()}
                    >
                      <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                        <path d="M12 2a3 3 0 0 0-3 3v7a3 3 0 0 0 6 0V5a3 3 0 0 0-3-3Z" />
                        <path d="M19 10v2a7 7 0 0 1-14 0v-2" />
                        <line x1="12" y1="19" x2="12" y2="22" />
                      </svg>
                      <span>Start recording</span>
                    </button>

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

                    {/* Free-Text Clinical Macros Bar */}
                    <div className="sm-smart-chips-box">
                      <div className="sm-macros-header-row">
                        <span className="sm-smart-chips-title">⚡ Clinical Macros & DotPhrases</span>
                        <button
                          type="button"
                          className="sm-btn-manage-macros"
                          onClick={() => setMacroModalOpen(true)}
                          title="Add or Edit Custom Macros"
                        >
                          ⚙️ Manage / Add Macros
                        </button>
                      </div>
                      <div className="sm-smart-chips-row">
                        {macros.map((m) => (
                          <button
                            key={m.id}
                            type="button"
                            className="sm-smart-chip"
                            onClick={() => handleInsertMacro(m)}
                            title={`Insert: ${m.content}`}
                          >
                            + {m.shortcut || m.name}
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
                    {/* Active Patient Demographic Strip */}
                    <div className="sm-recording-patient-badge">
                      <span className="sm-patient-avatar-mini">👤</span>
                      <span className="sm-rec-patient-name">{activeVisit?.patient_name || 'Patient'}</span>
                      <span className="sm-meta-divider">•</span>
                      <span className="sm-rec-patient-age">Age: <strong>{getPatientDisplayAge(activeVisit, patientList)}</strong></span>
                      <span className="sm-meta-divider">•</span>
                      <span className="sm-rec-patient-mrn">MRN: <strong>{activeVisit?.mrn || 'Auto-MRN'}</strong></span>
                    </div>

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

              {/* STATE 1c: AFTER STOP — Review & Complete SOAP Note */}
              {isReviewState && (
                <div className="sm-state-review">
                  {/* Top Back Navigation Bar */}
                  <div className="sm-review-top-bar">
                    <button
                      type="button"
                      className="sm-btn-back-recording"
                      onClick={() => {
                        setActiveDraftNote(null)
                        setIsEditingNote(false)
                      }}
                      title="Return to Ready to Record"
                    >
                      <span className="sm-back-arrow">←</span>
                      <span>Back to Recording</span>
                    </button>

                    <div className="sm-review-top-meta">
                      <span className="sm-badge-ai">AI SCRIBED</span>
                      <span className="sm-review-duration">{recordedDuration || '04:12'} recording</span>
                      <span className="sm-review-template">{selectedTemplate || 'SOAP Note — Adult'}</span>
                    </div>
                  </div>

                  {/* Clinical Patient Demographic Header */}
                  <div className="sm-patient-clinical-header">
                    <div className="sm-patient-card-main">
                      <div className="sm-patient-avatar-badge">
                        <span className="sm-patient-avatar-icon">👤</span>
                      </div>
                      <div className="sm-patient-identifiers">
                        <div className="sm-patient-name-row">
                          <h2 className="sm-patient-name-title">{activeDraftNote?.patient_name || 'Patient'}</h2>
                          <span className={`sm-patient-status-chip ${activeDraftNote?.status === 'completed' ? 'sm-patient-status-chip--signed' : 'sm-patient-status-chip--draft'}`}>
                            {activeDraftNote?.status === 'completed' ? 'Signed' : 'Draft Note'}
                          </span>
                        </div>
                        <div className="sm-patient-meta-row">
                          <span className="sm-meta-item"><strong>Age:</strong> {getPatientDisplayAge(activeDraftNote, patientList)}</span>
                          <span className="sm-meta-divider">•</span>
                          <span className="sm-meta-item"><strong>MRN:</strong> {activeDraftNote?.mrn || 'N/A'}</span>
                          <span className="sm-meta-divider">•</span>
                          <span className="sm-meta-item"><strong>Encounter:</strong> {activeDraftNote?.visit_type || selectedTemplate}</span>
                          <span className="sm-meta-divider">•</span>
                          <span className="sm-meta-item"><strong>Date:</strong> {activeDraftNote?.visit_date || new Date().toISOString().slice(0, 10)}</span>
                        </div>
                      </div>
                    </div>

                    <div className="sm-patient-actions-group">
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
                        {isEditingNote ? '💾 Save Changes' : '✏️ Edit Note'}
                      </button>

                      <button
                        type="button"
                        className="sm-btn-doc sm-btn-doc--sign"
                        onClick={() => handleReviewAndSign(activeDraftNote)}
                      >
                        ✍️ Review & Sign
                      </button>

                      <button
                        type="button"
                        className="sm-btn-doc sm-btn-doc--new"
                        onClick={() => {
                          setActiveDraftNote(null)
                          setIsEditingNote(false)
                          handleStartInstantDictation()
                        }}
                        title="Start another patient consultation"
                      >
                        + New Encounter
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
                            Age: <strong>{getPatientDisplayAge(v, patientList)}</strong> · {v.mrn || 'No MRN'}
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
              {macros.slice(0, 4).map((m) => (
                <button
                  key={m.id}
                  type="button"
                  className="sm-btn-mini-chip"
                  onClick={() => handleInsertMacro(m)}
                  title={`Insert: ${m.content}`}
                >
                  + {m.shortcut || m.name}
                </button>
              ))}
              <button
                type="button"
                className="sm-btn-mini-chip sm-btn-mini-chip--manage"
                onClick={() => setMacroModalOpen(true)}
                title="Manage Macros"
              >
                ⚙️ Macros
              </button>
            </div>
          </div>
        </aside>
      </main>

      {/* Note Viewer Modal */}
      {selectedNoteModal && (
        <SaintMaryNoteViewerModal
          note={selectedNoteModal}
          noteData={selectedNoteModal}
          currentUser={currentUser}
          onClose={() => setSelectedNoteModal(null)}
          onNoteUpdated={loadData}
          showToast={showToast}
        />
      )}

      {/* Clinical Macros Manager Modal */}
      {macroModalOpen && (
        <ManageMacrosModal
          macros={macros}
          editingMacro={editingMacro}
          macroForm={macroForm}
          setMacroForm={setMacroForm}
          onClose={() => {
            setMacroModalOpen(false)
            setEditingMacro(null)
          }}
          onSave={handleSaveMacroForm}
          onStartAdd={handleOpenAddMacro}
          onStartEdit={handleOpenEditMacro}
          onDelete={handleDeleteMacro}
          onReset={handleResetMacros}
          onInsert={handleInsertMacro}
        />
      )}
    </div>
  )
}

/**
 * ManageMacrosModal
 * Dedicated modal for creating, editing, and deleting clinician DotPhrases / Free-Text Macros
 */
function ManageMacrosModal({
  macros,
  editingMacro,
  macroForm,
  setMacroForm,
  onClose,
  onSave,
  onStartAdd,
  onStartEdit,
  onDelete,
  onReset,
  onInsert,
}) {
  const [activeTab, setActiveTab] = useState(editingMacro ? 'form' : 'list') // 'list' | 'form'

  const handleEditClick = (m) => {
    onStartEdit(m)
    setActiveTab('form')
  }

  const handleNewClick = () => {
    onStartAdd()
    setActiveTab('form')
  }

  return (
    <div className="sm-modal-overlay" onClick={onClose}>
      <div className="sm-modal sm-macro-modal" onClick={(e) => e.stopPropagation()}>
        <div className="sm-modal__header">
          <div className="sm-modal__title-group">
            <h3>⚡ Clinical Macros & DotPhrases</h3>
            <p>Create and customize reusable free-text clinical templates for ambient dictation and notes.</p>
          </div>
          <button type="button" className="sm-btn-close-modal" onClick={onClose}>
            ✕
          </button>
        </div>

        {/* Modal Subnav */}
        <div className="sm-macro-tabs">
          <button
            type="button"
            className={`sm-macro-tab ${activeTab === 'list' ? 'sm-macro-tab--active' : ''}`}
            onClick={() => setActiveTab('list')}
          >
            📋 All Macros ({macros.length})
          </button>
          <button
            type="button"
            className={`sm-macro-tab ${activeTab === 'form' ? 'sm-macro-tab--active' : ''}`}
            onClick={handleNewClick}
          >
            {editingMacro ? `✏️ Edit: ${editingMacro.name}` : '➕ Add New Macro'}
          </button>
        </div>

        <div className="sm-modal__body sm-macro-modal-body">
          {/* TAB 1: MACRO LIST */}
          {activeTab === 'list' && (
            <div className="sm-macro-list-view">
              <div className="sm-macro-list-header">
                <span>Click <strong>Insert</strong> to add to notes, or <strong>Edit</strong> to modify free text.</span>
                <button type="button" className="sm-btn-reset-macros" onClick={onReset}>
                  ↺ Reset Presets
                </button>
              </div>

              <div className="sm-macro-cards-grid">
                {macros.map((m) => (
                  <div key={m.id} className="sm-macro-card">
                    <div className="sm-macro-card__top">
                      <div className="sm-macro-card__title-row">
                        <span className="sm-macro-card__shortcut">{m.shortcut || '.macro'}</span>
                        <strong className="sm-macro-card__name">{m.name}</strong>
                      </div>
                      <div className="sm-macro-card__actions">
                        <button
                          type="button"
                          className="sm-btn-macro-action sm-btn-macro-action--insert"
                          onClick={() => {
                            onInsert(m)
                            onClose()
                          }}
                          title="Insert into active scratchpad"
                        >
                          Insert ↵
                        </button>
                        <button
                          type="button"
                          className="sm-btn-macro-action sm-btn-macro-action--edit"
                          onClick={() => handleEditClick(m)}
                          title="Edit this macro"
                        >
                          ✏️ Edit
                        </button>
                        <button
                          type="button"
                          className="sm-btn-macro-action sm-btn-macro-action--delete"
                          onClick={() => onDelete(m.id)}
                          title="Delete macro"
                        >
                          🗑️
                        </button>
                      </div>
                    </div>
                    <pre className="sm-macro-card__content-preview">{m.content}</pre>
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* TAB 2: ADD / EDIT FORM */}
          {activeTab === 'form' && (
            <form onSubmit={onSave} className="sm-macro-form">
              <div className="sm-macro-form__row">
                <div className="sm-macro-field">
                  <label className="sm-macro-label">Macro Name *</label>
                  <input
                    type="text"
                    className="sm-macro-input"
                    placeholder="e.g. Right Knee MSK Exam, Shoulder Findings, Diabetes Plan..."
                    value={macroForm.name}
                    onChange={(e) => setMacroForm((p) => ({ ...p, name: e.target.value }))}
                    required
                  />
                </div>

                <div className="sm-macro-field sm-macro-field--short">
                  <label className="sm-macro-label">Shortcut / DotPhrase</label>
                  <input
                    type="text"
                    className="sm-macro-input"
                    placeholder=".kneemsk"
                    value={macroForm.shortcut}
                    onChange={(e) => setMacroForm((p) => ({ ...p, shortcut: e.target.value }))}
                  />
                </div>
              </div>

              <div className="sm-macro-field">
                <div className="sm-macro-label-row">
                  <label className="sm-macro-label">Free-Text Template Content *</label>
                  <span className="sm-macro-hint">Type or paste your complete clinical documentation text below</span>
                </div>
                <textarea
                  className="sm-macro-textarea"
                  placeholder="Type your clinical template text here... e.g.&#10;PHYSICAL EXAM:&#10;Alert and oriented x3. Lungs clear bilaterally. Heart regular rate and rhythm.&#10;PLAN:&#10;1. Start anti-inflammatory therapy..."
                  value={macroForm.content}
                  onChange={(e) => setMacroForm((p) => ({ ...p, content: e.target.value }))}
                  rows={9}
                  required
                />
              </div>

              <div className="sm-macro-form-footer">
                <button
                  type="button"
                  className="sm-btn-macro-cancel"
                  onClick={() => {
                    setActiveTab('list')
                  }}
                >
                  Cancel
                </button>
                <button type="submit" className="sm-btn-macro-save">
                  💾 {editingMacro ? 'Save Macro Changes' : 'Create & Save Macro'}
                </button>
              </div>
            </form>
          )}
        </div>
      </div>
    </div>
  )
}
