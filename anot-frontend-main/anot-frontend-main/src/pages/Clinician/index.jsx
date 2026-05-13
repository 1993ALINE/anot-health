import { useState, useEffect, useRef, useCallback } from 'react'
import { useNavigate } from 'react-router-dom'
import { authAPI, visitsAPI, patientsAPI, notesAPI, API_BASE } from '../../services/api'
import { useBranding } from '../../services/branding'
import SystemProfileManager from '../../components/SystemProfileManager'
import { useSidebar, Overlay, PortalTopbar, usePortalDrawerMode, ConfirmDialog, PortalSidebarBrand } from '../shared'
import './clinician.css'

// ─── HELPERS ──────────────────────────────────────────────────────────────────

function getGreeting() {
  const h = new Date().getHours()
  if (h < 12) return 'Good morning'
  if (h < 17) return 'Good afternoon'
  return 'Good evening'
}

function localDate(off = 0, fmt = 'input') {
  const d = new Date(); d.setDate(d.getDate() + off)
  const y = d.getFullYear(), m = String(d.getMonth()+1).padStart(2,'0'), day = String(d.getDate()).padStart(2,'0')
  if (fmt === 'input') return `${y}-${m}-${day}`
  if (fmt === 'long')  return d.toLocaleDateString('en-US',{weekday:'long',year:'numeric',month:'long',day:'numeric'})
  if (fmt === 'day')   return d.toLocaleDateString('en-US',{weekday:'short'}).toUpperCase()
  if (fmt === 'date')  return d.getDate()
  return `${y}-${m}-${day}`
}

function fmtTime(t) {
  if (!t) return ''
  const [h, m] = t.split(':'); const hour = parseInt(h)
  return `${hour > 12 ? hour-12 : hour === 0 ? 12 : hour}:${m} ${hour >= 12 ? 'PM' : 'AM'}`
}

function fmtSecs(s) {
  if (!s || s <= 0) return '0:00'
  return `${Math.floor(s/60)}:${String(s%60).padStart(2,'0')}`
}

function fmtDate(d) {
  if (!d) return ''
  try { return new Date(d).toLocaleDateString('en-US',{year:'numeric',month:'long',day:'numeric'}) }
  catch { return String(d).slice(0,10) }
}

function audiofmt(s) {
  if (!s || isNaN(s)) return '0:00'
  return `${String(Math.floor(s/60)).padStart(2,'0')}:${String(Math.floor(s%60)).padStart(2,'0')}`
}

function initials(n) {
  if (!n) return '?'
  return n.split(' ').map(x=>x[0]).join('').slice(0,2).toUpperCase()
}

async function copyToClipboard(text) {
  try {
    await navigator.clipboard.writeText(text)
    return true
  } catch {
    return false
  }
}

const CLINICIAN_TIPS = [
  'Start recording as soon as you enter the room — you can pause anytime.',
  'Pending notes appear under Pending Notes when audio is still processing.',
  'Use Templates to match your preferred note structure for each visit type.',
  'Additional recordings append to the same visit when you need more audio.',
]

function formatSyncedLabel(iso) {
  if (!iso) return ''
  try {
    return new Date(iso).toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' })
  } catch {
    return ''
  }
}

const AV_COLORS = ['#E0F2FE','#DCF8E8','#FEF9C3','#FCE7F3','#EDE9FE','#CCFBF1','#FFF3E0','#E8EAF6']
function avatarBg(n) { return AV_COLORS[(n||'A').charCodeAt(0) % AV_COLORS.length] }

// Status definitions — bigger, higher-contrast chips with borders.
// Labels rewritten to remove technical/EMR jargon and feel automatic.
const ST = {
  'upcoming':           { label:'Upcoming',          bg:'#FFF8E1', color:'#92400E', border:'#FCD34D', dot:'#F59E0B' },
  'in-progress':        { label:'Recording',         bg:'#FEE2E2', color:'#991B1B', border:'#FCA5A5', dot:'#DC2626' },
  'recording-uploaded': { label:'Processing',        bg:'#FFEDD5', color:'#9A3412', border:'#FDBA74', dot:'#EA580C' },
  'note-ready':         { label:'Ready for Review',  bg:'#DCFCE7', color:'#15803D', border:'#86EFAC', dot:'#16A34A' },
  'uploaded':           { label:'Completed',         bg:'#DBEAFE', color:'#1E40AF', border:'#93C5FD', dot:'#2563EB' },
  'done':               { label:'Completed',         bg:'#DCFCE7', color:'#15803D', border:'#86EFAC', dot:'#16A34A' },
  /** Note row: scribe submitted final note; visit may still be `note-ready` until clinician files to chart */
  submitted:            { label:'Scribe submitted',  bg:'#EEF2FF', color:'#3730A3', border:'#A5B4FC', dot:'#4F46E5' },
}

/** True when the scribe has returned a final note (or QPS graded upload) — visit may still be `note-ready`. */
function clinicianNoteReturned(h) {
  const ns = h?.note_status
  return ns === 'submitted' || ns === 'uploaded'
}

/** Chip / display key for history rows (visit + note workflow). */
function historyRowDisplayStatus(h) {
  if (h.status === 'done') return 'done'
  if (h.status === 'uploaded') return 'uploaded'
  if (h.note_status === 'uploaded') return 'uploaded'
  if (h.note_status === 'submitted') return 'submitted'
  return h.status
}

// ─── TEMPLATES ────────────────────────────────────────────────────────────────

const DEFAULT_TEMPLATES = [
  { id:'new-patient', name:'New Patient', icon:'👤', color:'#E3F2FD', accent:'#1565C0',
    content:'CHIEF COMPLAINT:\n\n\nHISTORY OF PRESENT ILLNESS (HPI):\n\n\nPAST MEDICAL HISTORY:\n\n\nFAMILY HISTORY:\n\n\nSOCIAL HISTORY:\n\n\nREVIEW OF SYSTEMS:\n\n\nPHYSICAL EXAMINATION:\n\n\nIMAGING:\n\n\nASSESSMENT & PLAN (A&P):\n' },
  { id:'follow-up', name:'Follow-Up Visit', icon:'🔄', color:'#E8F5E9', accent:'#2E7D32',
    content:'REASON FOR VISIT:\n\n\nINTERVAL HISTORY:\n\n\nCURRENT MEDICATIONS:\n\n\nPHYSICAL EXAMINATION:\n\n\nIMAGING:\n\n\nASSESSMENT & PLAN:\n' },
  { id:'virtual-visit', name:'Virtual Visit', icon:'💻', color:'#EDE9FE', accent:'#4527A0',
    content:'CHIEF COMPLAINT:\n\n\nHISTORY OF PRESENT ILLNESS (HPI):\n\n\nREVIEW OF SYSTEMS:\n\n\nCURRENT MEDICATIONS:\n\n\nIMAGING / LAB RESULTS:\n\n\nASSESSMENT & PLAN (A&P):\n\nNOTE: This visit was conducted via telemedicine. Physical examination was not performed.\n' },
  { id:'other', name:'Other / General', icon:'📋', color:'#FFF8E1', accent:'#F57F17',
    content:'VISIT TYPE:\n\n\nCHIEF COMPLAINT:\n\n\nHISTORY:\n\n\nEXAMINATION:\n\n\nASSESSMENT & PLAN:\n' },
]

function loadTemplates() {
  try { const s = localStorage.getItem('anot_cl_tpl'); if (s) return JSON.parse(s) } catch (err) { console.error(err) }
  return DEFAULT_TEMPLATES
}
function saveTemplates(t) {
  try { localStorage.setItem('anot_cl_tpl', JSON.stringify(t)) } catch (err) { console.error(err) }
}

// ─── AUDIO PLAYER ─────────────────────────────────────────────────────────────

function AudioModal({ visitId, visit, onClose, showToast }) {
  const [count, setCount]   = useState(1)
  const [idx, setIdx]       = useState(0)
  const [status, setStatus] = useState('loading')
  const [playing, setPlay]  = useState(false)
  const [cur, setCur]       = useState(0)
  const [dur, setDur]       = useState(0)
  const aRef = useRef(null)
  const blobUrl = useRef(null)
  const durSet = useRef(false)

  useEffect(() => {
    const token = localStorage.getItem('token')
    fetch(`${API_BASE}/audio/${visitId}/count`, {
      headers: { Authorization: `Bearer ${token}` }
    }).then(r => r.json()).then(d => { if (d.count > 0) setCount(d.count) }).catch(() => {})
  }, [visitId])

  useEffect(() => {
    setStatus('loading'); setPlay(false); setCur(0); setDur(0)
    durSet.current = false
    if (blobUrl.current) { URL.revokeObjectURL(blobUrl.current); blobUrl.current = null }
    const a = aRef.current; if (!a) return
    const token = localStorage.getItem('token')
    fetch(`${API_BASE}/audio/${visitId}?index=${idx}`, {
      headers: { Authorization: `Bearer ${token}` }
    }).then(r => r.blob()).then(blob => {
      blobUrl.current = URL.createObjectURL(blob)
      a.src = blobUrl.current
      a.onloadedmetadata = () => {
        if (a.duration && isFinite(a.duration)) {
          setDur(Math.ceil(a.duration))
          durSet.current = true
        } else {
          a.currentTime = 1e101
        }
      }
      a.onseeked = () => {
        if (!durSet.current && a.duration && isFinite(a.duration)) {
          durSet.current = true
          setDur(Math.ceil(a.duration))
          a.currentTime = 0
        }
      }
      a.ontimeupdate = () => setCur(Math.floor(a.currentTime))
      a.onended = () => { setPlay(false); setCur(0) }
      a.load()
      setStatus('ready')
    }).catch(() => setStatus('error'))
    return () => {
      if (a) { a.pause(); a.src = '' }
      if (blobUrl.current) { URL.revokeObjectURL(blobUrl.current); blobUrl.current = null }
    }
  }, [visitId, idx])

  const toggle = () => {
    const a = aRef.current; if (!a || status !== 'ready') return
    if (playing) { a.pause(); setPlay(false) }
    else a.play().then(() => setPlay(true)).catch(() => {})
  }

  const skip = (s) => {
    const a = aRef.current; if (!a || status !== 'ready') return
    a.currentTime = Math.max(0, Math.min(dur, a.currentTime + s))
  }

  const seek = (e) => {
    const a = aRef.current; if (!a || status !== 'ready' || !dur) return
    const rect = e.currentTarget.getBoundingClientRect()
    a.currentTime = Math.round(((e.clientX - rect.left) / rect.width) * dur)
  }

  const prog = dur > 0 ? Math.min(100, (cur / dur) * 100) : 0

  const [txBusy, setTxBusy] = useState(false)
  const runTx = async () => {
    try {
      setTxBusy(true)
      await visitsAPI.runTranscription(visitId)
      showToast?.('Transcription started.', 'success')
    } catch (e) {
      showToast?.(e.message || 'Could not start transcription', 'error')
    } finally {
      setTxBusy(false)
    }
  }
  const txSt = visit?.transcription_status
  const txLabel =
    txSt === 'processing' ? 'Status: processing'
      : txSt === 'completed' ? 'Status: transcribed'
        : txSt === 'failed' ? 'Status: failed'
          : null

  return (
    <div style={{ position:'fixed', inset:0, background:'rgba(0,0,0,0.6)', zIndex:900, display:'flex', alignItems:'flex-end', justifyContent:'center', padding:'0 0 32px' }}>
      <div style={{ background:'#fff', borderRadius:24, padding:28, width:'100%', maxWidth:500, margin:'0 16px', boxShadow:'0 24px 64px rgba(0,0,0,0.25)' }}>
        <audio ref={aRef} preload="metadata" style={{ display:'none' }} />
        <div style={{ display:'flex', justifyContent:'space-between', alignItems:'flex-start', marginBottom:20 }}>
          <div>
            <div style={{ fontSize:17, fontWeight:700, color:'#1E293B' }}>🎙 Encounter Recording</div>
            <div style={{ fontSize:13, color:'#94A3B8', marginTop:3 }}>{count} recording{count > 1 ? 's' : ''}</div>
          </div>
          <button onClick={onClose} style={{ background:'#E2E8F0', border:'none', borderRadius:10, padding:'8px 16px', cursor:'pointer', fontSize:13, fontWeight:600, color:'#64748B' }}>✕ Close</button>
        </div>
        {count > 1 && (
          <div style={{ display:'flex', gap:8, marginBottom:20 }}>
            {Array.from({ length: count }, (_, i) => (
              <button key={i} onClick={() => setIdx(i)} style={{ padding:'6px 16px', borderRadius:10, fontSize:13, fontWeight:600, cursor:'pointer', border:'2px solid', background: idx===i ? 'linear-gradient(135deg,#4260E9,#7B61FF)' : '#fff', color: idx===i ? '#fff' : '#64748B', borderColor: idx===i ? '#4260E9' : '#E2E8F0' }}>
                Rec {i+1}
              </button>
            ))}
          </div>
        )}
        <div style={{ display:'flex', alignItems:'center', gap:12 }}>
          <button onClick={() => skip(-10)} style={{ padding:'8px 14px', borderRadius:10, background:'#E2E8F0', border:'none', fontSize:13, fontWeight:700, cursor:'pointer', color:'#475569' }}>−10s</button>
          <button onClick={toggle} style={{ width:52, height:52, borderRadius:'50%', background:'linear-gradient(135deg,#4260E9,#7B61FF)', color:'#fff', border:'none', fontSize:20, cursor:'pointer', display:'flex', alignItems:'center', justifyContent:'center', flexShrink:0 }}>
            {status === 'loading' ? '⏳' : playing ? '⏸' : '▶'}
          </button>
          <button onClick={() => skip(10)} style={{ padding:'8px 14px', borderRadius:10, background:'#E2E8F0', border:'none', fontSize:13, fontWeight:700, cursor:'pointer', color:'#475569' }}>+10s</button>
          <div style={{ flex:1 }}>
            <div onClick={seek} style={{ height:6, background:'#E2E8F0', borderRadius:4, cursor:'pointer', overflow:'hidden' }}>
              <div style={{ height:'100%', background:'linear-gradient(90deg,#4260E9,#7B61FF)', width:`${prog}%`, transition:'width 0.3s linear', borderRadius:4 }} />
            </div>
            <div style={{ display:'flex', justifyContent:'space-between', marginTop:4, fontSize:11, color:'#94A3B8', fontWeight:500 }}>
              <span>{audiofmt(cur)}</span>
              <span>{dur > 0 ? audiofmt(dur) : '--:--'}</span>
            </div>
          </div>
        </div>
        <div style={{ marginTop: 20, paddingTop: 16, borderTop: '1px solid #E2E8F0', display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 12, justifyContent: 'space-between' }}>
          {txLabel ? <span style={{ fontSize: 12, color: '#64748B', fontWeight: 600 }}>{txLabel}</span> : <span />}
          <button type="button" disabled={txBusy} onClick={runTx} style={{ marginLeft: 'auto', padding: '10px 16px', borderRadius: 10, border: 'none', background: 'linear-gradient(135deg,#4260E9,#7B61FF)', color: '#fff', fontSize: 13, fontWeight: 600, cursor: txBusy ? 'wait' : 'pointer', opacity: txBusy ? 0.7 : 1, fontFamily: 'inherit' }}>
            {txBusy ? 'Starting…' : 'Transcribe audio'}
          </button>
        </div>
      </div>
    </div>
  )
}

// ─── NOTE PREVIEW MODAL ───────────────────────────────────────────────────────
// (Renamed from "AI Modal" — clinicians don't need to know the source.)

function AIModal({ visit, onClose, showToast }) {
  const [note, setNote] = useState(null)
  const [loading, setLoad] = useState(true)
  const [tab, setTab] = useState('ai')
  const [recIdx, setRecIdx] = useState(0)
  const [txBusy, setTxBusy] = useState(false)

  const loadNoteData = useCallback(async (opts = {}) => {
    const silent = !!opts.silent
    const token = localStorage.getItem('token')
    if (!silent) setLoad(true)
    try {
      const r = await fetch(`${API_BASE}/notes/visit/${visit.id}`, {
        headers: { Authorization: `Bearer ${token}` },
      })
      const d = await r.json().catch(() => ({}))
      if (r.ok) setNote(d.note)
      else if (!silent) setNote(null)
    } catch {
      if (!silent) setNote(null)
    } finally {
      if (!silent) setLoad(false)
    }
  }, [visit.id])

  useEffect(() => {
    loadNoteData()
  }, [loadNoteData])

  useEffect(() => {
    if (note?.transcription_status !== 'processing') return
    const t = setInterval(() => {
      void loadNoteData({ silent: true })
    }, 4000)
    return () => clearInterval(t)
  }, [note?.transcription_status, loadNoteData])

  const runTx = async () => {
    try {
      setTxBusy(true)
      await visitsAPI.runTranscription(visit.id)
      showToast?.('Transcription started.', 'success')
      await loadNoteData()
    } catch (e) {
      showToast?.(e.message || 'Could not start transcription', 'error')
    } finally {
      setTxBusy(false)
    }
  }

  const txSt = note?.transcription_status || visit?.transcription_status
  const txBadge =
    txSt === 'processing' ? 'Transcription: processing'
      : txSt === 'completed' ? 'Transcription: ready'
        : txSt === 'failed' ? 'Transcription: failed'
          : null

  const txts = (() => {
    if (!note?.transcription) return []
    try { const p = JSON.parse(note.transcription); return Array.isArray(p) ? p : [p] }
    catch { return [note.transcription] }
  })()

  const parseNote = (txt) => {
    if (!txt) return null
    const m = (r) => { const x = txt.match(r); return x ? x[1].trim() : '' }
    return {
      cc:      m(/CHIEF COMPLAINT[:\s]*([\s\S]*?)(?=HISTORY|HPI|$)/i),
      hpi:     m(/(?:HISTORY OF PRESENT ILLNESS|HPI)[:\s]*([\s\S]*?)(?=PHYSICAL|PE[:\s]|$)/i),
      pe:      m(/PHYSICAL EXAMINATION[:\s]*([\s\S]*?)(?=IMAGING|$)/i),
      imaging: m(/IMAGING[:\s]*([\s\S]*?)(?=ASSESSMENT|A&P|$)/i),
      ap:      m(/(?:ASSESSMENT & PLAN|A&P)[:\s]*([\s\S]*?)$/i),
    }
  }

  const secs = parseNote(note?.ai_draft)
  const SECS = [
    { k:'cc',      l:'Chief Complaint',            icon:'🩺' },
    { k:'hpi',     l:'History of Present Illness', icon:'📋' },
    { k:'pe',      l:'Physical Examination',       icon:'🔬' },
    { k:'imaging', l:'Imaging & Labs',             icon:'🖥'  },
    { k:'ap',      l:'Assessment & Plan',          icon:'📝' },
  ]

  return (
    <div style={{ position:'fixed', inset:0, background:'rgba(0,0,0,0.6)', zIndex:800, display:'flex', alignItems:'center', justifyContent:'center', padding:16 }}>
      <div style={{ background:'#fff', borderRadius:20, width:'100%', maxWidth:700, maxHeight:'92vh', display:'flex', flexDirection:'column', boxShadow:'0 24px 64px rgba(0,0,0,0.25)' }}>
        <div style={{ padding:'20px 24px', borderBottom:'1px solid #E2E8F0', display:'flex', justifyContent:'space-between', alignItems:'flex-start', gap: 12 }}>
          <div>
            <div style={{ fontSize:17, fontWeight:700, color:'#1E293B' }}>📋 Note Preview</div>
            <div style={{ fontSize:13, color:'#94A3B8', marginTop:3 }}>{visit.patient_name} · {visit.visit_type}</div>
          </div>
          <div style={{ display:'flex', flexDirection:'column', alignItems:'flex-end', gap: 10 }}>
            <div style={{ display:'flex', flexWrap:'wrap', alignItems:'center', gap: 8, justifyContent:'flex-end' }}>
              {txBadge ? (
                <span style={{ fontSize: 12, fontWeight: 600, color: '#475569', background: '#EEF2FF', padding: '4px 10px', borderRadius: 8 }}>{txBadge}</span>
              ) : null}
              {visit.audio_file ? (
                <button type="button" disabled={txBusy || loading} onClick={runTx} style={{ padding: '8px 14px', borderRadius: 10, border: 'none', background: 'linear-gradient(135deg,#4260E9,#7B61FF)', color: '#fff', fontSize: 12, fontWeight: 600, cursor: txBusy ? 'wait' : 'pointer', opacity: txBusy ? 0.75 : 1, fontFamily: 'inherit' }}>
                  {txBusy ? 'Starting…' : 'Transcribe audio'}
                </button>
              ) : null}
              <button type="button" onClick={onClose} style={{ background:'#E2E8F0', border:'none', borderRadius:10, padding:'8px 16px', cursor:'pointer', fontSize:13, fontWeight:600, color:'#64748B', fontFamily: 'inherit' }}>✕</button>
            </div>
          </div>
        </div>
        <div style={{ display:'flex', borderBottom:'1px solid #E2E8F0', padding:'0 24px' }}>
          {[['ai','Draft'],['transcription','Transcript']].map(([k,l]) => (
            <button key={k} onClick={() => setTab(k)} style={{ padding:'12px 0', marginRight:24, fontSize:14, fontWeight: tab===k ? 700 : 400, color: tab===k ? '#4260E9' : '#94A3B8', background:'none', border:'none', borderBottom: tab===k ? '2px solid #4260E9' : '2px solid transparent', cursor:'pointer', fontFamily:'inherit' }}>{l}</button>
          ))}
        </div>
        <div style={{ flex:1, overflowY:'auto', padding:'20px 24px' }}>
          {loading ? (
            <div style={{ textAlign:'center', padding:60, color:'#94A3B8' }}>Loading note...</div>
          ) : tab === 'ai' ? (
            secs ? SECS.map(({ k, l, icon }) => (
              <div key={k} style={{ marginBottom:12, border:'1px solid #E2E8F0', borderRadius:14, overflow:'hidden' }}>
                <div style={{ padding:'10px 16px', background:'#F4F7FF', display:'flex', alignItems:'center', gap:10 }}>
                  <span style={{ fontSize:18 }}>{icon}</span>
                  <span style={{ fontSize:12, fontWeight:700, color:'#475569', textTransform:'uppercase', letterSpacing:'.06em' }}>{l}</span>
                </div>
                <div style={{ padding:'12px 16px', fontSize:14, color: secs[k] ? '#1E293B' : '#CBD5E1', lineHeight:1.8 }}>{secs[k] || 'Not mentioned'}</div>
              </div>
            )) : (
              <div style={{ textAlign:'center', padding:60, color:'#94A3B8' }}>
                <div style={{ fontSize:48, marginBottom:16 }}>⏳</div>
                <div style={{ fontSize:16, fontWeight:600, color:'#475569', marginBottom:8 }}>Note still being prepared</div>
                <div style={{ fontSize:14 }}>Usually ready within a few minutes.</div>
              </div>
            )
          ) : (
            txts.length === 0 ? (
              <div style={{ textAlign:'center', padding:60, color:'#94A3B8' }}>Transcript not available yet.</div>
            ) : (
              <>
                {txts.length > 1 && (
                  <div style={{ display:'flex', gap:8, marginBottom:16 }}>
                    {txts.map((_, i) => (
                      <button key={i} onClick={() => setRecIdx(i)} style={{ padding:'6px 16px', borderRadius:10, fontSize:13, fontWeight:600, cursor:'pointer', border:'2px solid', background: recIdx===i ? 'linear-gradient(135deg,#4260E9,#7B61FF)' : '#fff', color: recIdx===i ? '#fff' : '#64748B', borderColor: recIdx===i ? '#4260E9' : '#E2E8F0' }}>Rec {i+1}</button>
                    ))}
                  </div>
                )}
                <div style={{ background:'#F4F7FF', borderRadius:14, padding:20, fontSize:14, color:'#334155', lineHeight:1.9, whiteSpace:'pre-wrap', border:'1px solid #E2E8F0' }}>{txts[recIdx]}</div>
              </>
            )
          )}
        </div>
      </div>
    </div>
  )
}

// ─── TEMPLATES SCREEN ─────────────────────────────────────────────────────────

function TemplatesScreen({ showToast }) {
  const [templates, setTemplates] = useState(loadTemplates)
  const [selected, setSelected]   = useState(null)
  const [editing, setEditing]     = useState(false)
  const [draft, setDraft]         = useState('')

  const open = (t) => { setSelected(t); setDraft(t.content); setEditing(false) }

  const save = () => {
    const updated = templates.map(t => t.id === selected.id ? { ...t, content: draft } : t)
    setTemplates(updated); saveTemplates(updated)
    setSelected(prev => ({ ...prev, content: draft }))
    setEditing(false); showToast('Template saved')
  }

  const reset = () => {
    const def = DEFAULT_TEMPLATES.find(t => t.id === selected.id)
    if (!def) return
    const updated = templates.map(t => t.id === selected.id ? { ...t, content: def.content } : t)
    setTemplates(updated); saveTemplates(updated)
    setSelected(prev => ({ ...prev, content: def.content }))
    setDraft(def.content); setEditing(false)
    showToast('Template reset to default')
  }

  const sectionCount = (content) =>
    content.split('\n').filter((l) => l.trim().endsWith(':')).length

  if (selected) {
    return (
      <div className="cl-template-detail">
        <div className="cl-template-detail__toolbar">
          <button type="button" onClick={() => setSelected(null)} className="btn btn-sm">
            ← Back
          </button>
          <div className="cl-template-detail__titles">
            <div className="cl-template-detail__title">
              <span className="cl-template-detail__emoji" aria-hidden>{selected.icon}</span>
              {selected.name}
            </div>
            <div className="cl-template-detail__subtitle">
              {editing ? 'Edit the outline below, then save.' : 'Preview only — use Edit to customise this device’s copy.'}
            </div>
          </div>
          <div className="cl-template-detail__actions">
            {!editing ? (
              <>
                <button type="button" onClick={() => { navigator.clipboard?.writeText(selected.content); showToast('Copied!') }} className="btn btn-sm">
                  📋 Copy
                </button>
                <button type="button" onClick={() => setEditing(true)} className="btn btn-sm btn-navy">
                  ✏️ Edit
                </button>
              </>
            ) : (
              <>
                <button type="button" onClick={reset} className="btn btn-sm cl-template-btn--danger">
                  ↺ Reset
                </button>
                <button type="button" onClick={() => { setEditing(false); setDraft(selected.content) }} className="btn btn-sm">
                  Cancel
                </button>
                <button type="button" onClick={save} className="btn btn-sm btn-teal">
                  ✓ Save
                </button>
              </>
            )}
          </div>
        </div>
        <div className="cl-template-detail__body">
          {editing ? (
            <textarea
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              className="sf-input cl-template-editor"
              aria-label="Template body"
            />
          ) : (
            <div className="sf-note-card cl-template-preview">
              {selected.content}
            </div>
          )}
        </div>
      </div>
    )
  }

  return (
    <div className="sf-body cl-templates-page">
      <header className="cl-templates-intro">
        <span className="cl-templates-intro__badge">{templates.length} templates</span>
        <p className="cl-templates-intro__text">
          Structured starters for common visit types. Choose one to preview, copy to clipboard, or edit — saved locally in this browser.
        </p>
      </header>
      <div className="cl-templates-grid">
        {templates.map((t) => (
          <article
            key={t.id}
            role="button"
            tabIndex={0}
            className="cl-template-card"
            onClick={() => open(t)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' || e.key === ' ') {
                e.preventDefault()
                open(t)
              }
            }}
          >
            <div className="cl-template-card__accent" style={{ background: t.accent }} aria-hidden />
            <div className="cl-template-card__icon" style={{ background: t.color }} aria-hidden>
              {t.icon}
            </div>
            <div className="cl-template-card__main">
              <h3 className="cl-template-card__name">{t.name}</h3>
              <p className="cl-template-card__meta">
                {sectionCount(t.content)} section labels · Customisable
              </p>
              <span className="cl-template-card__cta">
                Open <span aria-hidden>→</span>
              </span>
            </div>
          </article>
        ))}
      </div>
    </div>
  )
}

// ─── SIDEBAR ──────────────────────────────────────────────────────────────────

function Sidebar({ screen, setScreen, sidebar, currentUser, visits, tip, drawerMode, onRequestLogout, confirmDialog, confirmLoading, onDismissConfirm, onConfirmAction, branding }) {
  const badge = visits.filter(v => v.status === 'recording-uploaded').length
  const NAV = [
    { key:'schedule',  label:'Schedule',        icon:'📅', badge },
    { key:'pending',   label:'Pending Notes',   icon:'⏳' },
    { key:'completed', label:'Completed Notes', icon:'✅' },
    { key:'history',   label:'All History',     icon:'🕐' },
    { key:'templates', label:'Templates',       icon:'📄' },
    { key:'profile',   label:'Profile',         icon:'👤' },
  ]
  const go = (key) => {
    setScreen(key)
    sidebar.close()
  }
  return (
    <>
      <ConfirmDialog
        dialog={confirmDialog}
        loading={confirmLoading}
        onDismiss={onDismissConfirm}
        onConfirm={onConfirmAction}
      />
      <aside
        id="clinician-sidebar"
        className={`sf-sidebar sf-sidebar--rich adm-sidebar${sidebar.open ? ' open' : ''}`}
        aria-hidden={drawerMode ? !sidebar.open : undefined}
      >
      <div className="sf-sidebar-top sf-sidebar-rich__top">
        <PortalSidebarBrand branding={branding} subtitle="Clinician Portal" />
      </div>
      <p className="sf-sidebar-rich__nav-label">Workspace</p>
      <nav className="sf-nav sf-sidebar-rich__nav" aria-label="Main">
        {NAV.map(({ key, label, icon, badge: navBadge }) => (
          <div
            key={key}
            role="button"
            tabIndex={0}
            className={`sf-nav-item sf-sidebar-rich__nav-item${screen === key ? ' active' : ''}`}
            onClick={() => go(key)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' || e.key === ' ') {
                e.preventDefault()
                go(key)
              }
            }}
          >
            <span className="sf-sidebar-rich__nav-ico">{icon}</span>
            <span className="sf-sidebar-rich__nav-text">{label}</span>
            {navBadge > 0 ? <span className="sf-sidebar-rich__nav-badge">{navBadge}</span> : null}
          </div>
        ))}
      </nav>
      <div className="sf-sidebar-rich__tip">
        <div className="sf-sidebar-rich__tip-label">Tip</div>
        <p className="sf-sidebar-rich__tip-text">{tip}</p>
      </div>
      <div className="sf-sidebar-footer sf-sidebar-rich__footer adm-sidebar-footer">
        <div className="adm-sidebar-footer__card">
          <p className="adm-sidebar-footer__eyebrow">Account</p>
          <p className="adm-sidebar-footer__who">{currentUser.name || 'Clinician'}</p>
          <button
            type="button"
            className="adm-sidebar-footer__btn"
            onClick={onRequestLogout}
          >
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
}

// ─── PROFILE SCREEN ───────────────────────────────────────────────────────────

function ProfileScreen({ currentUser, showToast }) {
  const contactRows = [
    ['Email', currentUser.email || '—', '✉️'],
    ['Phone', currentUser.phone || '—', '📞'],
    ['Specialty', currentUser.specialty || '—', '🩺'],
  ]

  return (
    <>
      <div className="sf-card sf-card-lg">
        <div className="sf-card__title">Account overview</div>
        <p style={{ margin: '0 0 16px', fontSize: 13, color: '#64748b', lineHeight: 1.55 }}>
          Details tied to your Anot clinician account. For name or access changes, reach out to your organization admin.
        </p>
        <ul className="cl-profile-field-list" aria-label="Contact and practice">
          {contactRows.map(([label, val, icon]) => (
            <li key={label} className="cl-profile-field">
              <span className="cl-profile-field__icon" aria-hidden>
                {icon}
              </span>
              <div className="cl-profile-field__body">
                <span className="cl-profile-field__label">{label}</span>
                <span className="cl-profile-field__val">{val}</span>
              </div>
            </li>
          ))}
        </ul>
      </div>
      <div style={{ marginTop: 16 }}>
        <SystemProfileManager showToast={showToast} roleLabel="Clinician" compact />
      </div>
    </>
  )
}

// ─── BUTTON STYLES ────────────────────────────────────────────────────────────

const B = {
  primary: { display:'inline-flex', alignItems:'center', gap:8, padding:'10px 20px', borderRadius:12, background:'linear-gradient(135deg,#4260E9,#7B61FF)', color:'#fff', border:'none', fontSize:14, fontWeight:700, cursor:'pointer', fontFamily:'inherit', boxShadow:'0 4px 14px rgba(66,96,233,.35)' },
  outline: { display:'inline-flex', alignItems:'center', gap:8, padding:'10px 20px', borderRadius:12, background:'#fff', color:'#475569', border:'1.5px solid #E2E8F0', fontSize:14, fontWeight:600, cursor:'pointer', fontFamily:'inherit' },
  action:  { display:'inline-flex', alignItems:'center', gap:6, padding:'9px 16px', borderRadius:10, fontSize:13, fontWeight:700, cursor:'pointer', border:'none', fontFamily:'inherit', whiteSpace:'nowrap' },
  small:   { padding:'7px 14px', borderRadius:10, fontSize:13, fontWeight:700, cursor:'pointer', fontFamily:'inherit' },
}

// Reusable status chip — bigger, bolder, with border for high contrast.
function StatusChip({ st }) {
  return (
    <span
      className="cl-status-chip"
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        gap: 7,
        padding: '6px 14px',
        borderRadius: 10,
        fontSize: 13,
        fontWeight: 700,
        background: st.bg,
        color: st.color,
        border: `1px solid ${st.border}`,
        whiteSpace: 'nowrap',
      }}
    >
      <span style={{ width: 7, height: 7, borderRadius: '50%', background: st.dot, display: 'inline-block' }} />
      {st.label}
    </span>
  )
}

// ─── MAIN COMPONENT ───────────────────────────────────────────────────────────

export default function Clinician() {
  const navigate    = useNavigate()
  const cu          = JSON.parse(localStorage.getItem('user') || '{}')
  const sidebar     = useSidebar()

  const [screen, setScreen]         = useState('schedule')
  const [off, setOff]               = useState(0)
  const [visits, setVisits]         = useState([])
  const [history, setHistory]       = useState([])
  const [loading, setLoading]       = useState(false)
  const [active, setActive]         = useState(null)
  const [paused, setPaused]         = useState(false)
  const [timer, setTimer]           = useState(0)
  const [uploading, setUploading]   = useState(false)
  const [addRec, setAddRec]         = useState(null)
  const [addTimer, setAddTimer]     = useState(0)
  const [addPaused, setAddPaused]   = useState(false)
  const [showAdd, setShowAdd]       = useState(false)
  const [reviewNote, setReview]     = useState(null)
  const [aiVisit, setAiVisit]       = useState(null)
  const [playVisit, setPlayVisit]   = useState(null)
  const [histQ, setHistQ]           = useState('')
  const [toast, setToast]           = useState(null)
  const [editReq, setEditReq]       = useState({})
  const [editV, setEditV]           = useState(null)
  const [editD, setEditD]           = useState({})
  const [editSaving, setEditSaving] = useState(false)
  const [pt, setPt]                 = useState({ name:'', mrn:'', time:'', type:'Follow-up', dob:'' })
  const [ptErr, setPtErr]           = useState('')
  const [scheduleSyncedAt, setScheduleSyncedAt] = useState(null)
  const [historySyncedAt, setHistorySyncedAt]   = useState(null)
  const [liveNow, setLiveNow]       = useState(() => new Date())
  const [histAudioOnly, setHistAudioOnly]       = useState(false)

  const drawerMode = usePortalDrawerMode()
  const branding = useBranding()

  const tRef  = useRef(null), mRef  = useRef(null), cRef  = useRef([])
  const atRef = useRef(null), arRef = useRef(null), acRef = useRef([])
  const DAYS  = [-2, -1, 0, 1, 2]

  const tipOfDay = CLINICIAN_TIPS[(new Date().getDate() + new Date().getMonth() * 7) % CLINICIAN_TIPS.length]

  const showToast = (msg, type = 'success') => { setToast({ msg, type }); setTimeout(() => setToast(null), 3500) }
  const [confirmDialog, setConfirmDialog] = useState(null)
  const [confirmLoading, setConfirmLoading] = useState(false)

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

  const copyMrn = async (mrn) => {
    const ok = await copyToClipboard(mrn || '')
    showToast(ok ? 'MRN copied to clipboard' : 'Could not copy', ok ? 'success' : 'error')
  }

  const loadVisits = async (opts = {}) => {
    try {
      setLoading(true)
      const d = await visitsAPI.getByDate(localDate(off))
      setVisits(d.visits || [])
      setScheduleSyncedAt(new Date().toISOString())
      if (opts.notify) showToast('Schedule updated')
    } catch (e) {
      showToast(e.message, 'error')
    } finally {
      setLoading(false)
    }
  }

  const loadHistory = async (opts = {}) => {
    try {
      setLoading(true)
      const d = await visitsAPI.getHistory()
      setHistory(d.visits || [])
      setHistorySyncedAt(new Date().toISOString())
      if (opts.notify) showToast('History updated')
    } catch (e) {
      showToast(e.message, 'error')
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => {
    const id = setInterval(() => setLiveNow(new Date()), 1000)
    return () => clearInterval(id)
  }, [])

  useEffect(() => {
    const onKey = (e) => {
      const t = e.target
      if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.tagName === 'SELECT' || t.isContentEditable)) return
      if (screen === 'schedule' && e.key === 't' && !e.metaKey && !e.ctrlKey && !e.altKey) {
        e.preventDefault()
        setOff(0)
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [screen])

  useEffect(() => { if (screen === 'schedule') loadVisits() }, [off, screen])
  // History also loads for the Pending and Completed sub-views.
  useEffect(() => {
    if (['history', 'pending', 'completed'].includes(screen)) loadHistory()
  }, [screen])

  useEffect(() => {
    if (screen !== 'profile') return
    let alive = true
    ;(async () => {
      try {
        const [h, v] = await Promise.all([visitsAPI.getHistory(), visitsAPI.getByDate(localDate(off))])
        if (!alive) return
        setHistory(h.visits || [])
        setVisits(v.visits || [])
        setHistorySyncedAt(new Date().toISOString())
        setScheduleSyncedAt(new Date().toISOString())
      } catch {
        /* keep existing lists */
      }
    })()
    return () => {
      alive = false
    }
  }, [screen, off])

  const getMime = () => { const t = ['audio/webm;codecs=opus','audio/webm','audio/ogg;codecs=opus','audio/mp4']; return t.find(x => MediaRecorder.isTypeSupported(x)) || '' }

  const startVisit = async (v) => {
    if (active) return
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true })
      const rec = new MediaRecorder(stream, getMime() ? { mimeType: getMime() } : {})
      cRef.current = []; mRef.current = rec
      rec.ondataavailable = (e) => { if (e.data?.size > 0) cRef.current.push(e.data) }
      rec.start(1000)
      await visitsAPI.updateStatus(v.id, 'in-progress')
      setVisits(p => p.map(x => x.id === v.id ? { ...x, status:'in-progress' } : x))
      setActive(v); setPaused(false); setTimer(0)
      tRef.current = setInterval(() => setTimer(t => t + 1), 1000)
      showToast('🎙 Recording started')
    } catch { showToast('Microphone access denied.', 'error') }
  }

  const pauseResume = () => {
    if (!paused) { clearInterval(tRef.current); if (mRef.current?.state === 'recording') mRef.current.pause(); setPaused(true) }
    else { tRef.current = setInterval(() => setTimer(t => t+1), 1000); if (mRef.current?.state === 'paused') mRef.current.resume(); setPaused(false) }
  }

  const endVisit = async () => {
    try {
      clearInterval(tRef.current); setUploading(true)
      const rec = mRef.current, vid = active.id, pn = active.patient_name
      if (rec && rec.state !== 'inactive') {
        await new Promise(res => {
          rec.onstop = async () => {
            if (cRef.current.length > 0) {
              try { const b = new Blob(cRef.current, { type: rec.mimeType || 'audio/webm' }); await visitsAPI.uploadAudio(vid, b) } catch (err) { console.error(err) }
            }
            rec.stream.getTracks().forEach(t => t.stop()); res()
          }
          rec.stop()
        })
      }
      const endData = await visitsAPI.endVisit(vid, timer)
      const vr = endData.visit
      setVisits((p) =>
        p.map((v) =>
          v.id === vid
            ? { ...v, ...(vr || {}), patient_name: v.patient_name, duration_seconds: vr?.duration_seconds ?? timer }
            : v
        )
      )
      if (['history', 'pending', 'completed'].includes(screen)) loadHistory()
      showToast(`✓ Encounter ended — preparing note for ${pn}`)
      setActive(null); setTimer(0); setPaused(false); cRef.current = []; mRef.current = null
    } catch(e) { showToast(e.message, 'error') } finally { setUploading(false) }
  }

  const startAdd = async (v) => {
    if (active || addRec) return
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true })
      const rec = new MediaRecorder(stream, getMime() ? { mimeType: getMime() } : {})
      acRef.current = []; arRef.current = rec
      rec.ondataavailable = (e) => { if (e.data?.size > 0) acRef.current.push(e.data) }
      rec.start(1000); setAddRec(v); setAddTimer(0); setAddPaused(false)
      atRef.current = setInterval(() => setAddTimer(t => t + 1), 1000)
    } catch { showToast('Microphone access denied.', 'error') }
  }

  const pauseResumeAdd = () => {
    if (!addPaused) { clearInterval(atRef.current); if (arRef.current?.state === 'recording') arRef.current.pause(); setAddPaused(true) }
    else { atRef.current = setInterval(() => setAddTimer(t => t+1), 1000); if (arRef.current?.state === 'paused') arRef.current.resume(); setAddPaused(false) }
  }

  const stopAdd = async () => {
    try {
      clearInterval(atRef.current); setUploading(true)
      const vid = addRec.id, extra = addTimer
      await new Promise(res => {
        arRef.current.onstop = async () => {
          if (acRef.current.length > 0) {
            try { const b = new Blob(acRef.current, { type: arRef.current.mimeType || 'audio/webm' }); await visitsAPI.appendAudio(vid, b); showToast('✓ Additional recording uploaded') }
            catch { showToast('Upload failed', 'error') }
          }
          arRef.current?.stream?.getTracks().forEach(t => t.stop()); res()
        }
        arRef.current.stop()
      })
      setVisits(p => p.map(v => v.id === vid ? { ...v, duration_seconds:(v.duration_seconds||0)+extra, recording_count:(v.recording_count||1)+1 } : v))
      setAddRec(null); setAddTimer(0); acRef.current = []; arRef.current = null
    } catch (err) { console.error(err) } finally { setUploading(false) }
  }

  const addPatient = async () => {
    setPtErr('')
    if (!pt.name.trim()) { setPtErr('Patient name required'); return }
    if (!pt.mrn.trim())  { setPtErr('MRN required'); return }
    if (!pt.time)        { setPtErr('Time required'); return }
    try {
      let patient
      let linkedExistingMrn = false
      try {
        const d = await patientsAPI.create({ name:pt.name.trim(), mrn:pt.mrn.trim().toUpperCase(), date_of_birth:pt.dob||null })
        patient = d.patient
      } catch (e) {
        if (e.payload?.patient) {
          patient = e.payload.patient
          linkedExistingMrn = true
        } else if (e.message.includes('already exists')) {
          const d = await patientsAPI.getAll()
          patient = d.patients.find((p) => p.mrn === pt.mrn.trim().toUpperCase())
          if (!patient) { setPtErr(e.message); return }
          linkedExistingMrn = true
        } else {
          setPtErr(e.message)
          return
        }
      }
      const vd = await visitsAPI.create({ patient_id:patient.id, visit_date:localDate(off), visit_time:pt.time, visit_type:pt.type })
      setVisits(p => [...p, { ...vd.visit, patient_name:patient.name, mrn:patient.mrn }].sort((a,b) => a.visit_time.localeCompare(b.visit_time)))
      setPt({ name:'', mrn:'', time:'', type:'Follow-up', dob:'' }); setShowAdd(false)
      showToast(
        linkedExistingMrn
          ? `✓ Visit scheduled for ${patient.name} (MRN already on file)`
          : `✓ ${patient.name} added`,
      )
    } catch(e) { setPtErr(e.message) }
  }

  const deleteVisit = (v) => {
    setConfirmDialog({
      tone: 'danger',
      title: 'Remove this visit?',
      message: `Remove ${v.patient_name} from the schedule? This cannot be undone.`,
      confirmText: 'Remove visit',
      onConfirm: async () => {
        try {
          await visitsAPI.deleteVisit(v.id)
          setVisits((p) => p.filter((x) => x.id !== v.id))
          showToast(`${v.patient_name} removed`)
        } catch (e) {
          showToast(e.message, 'error')
        }
      },
    })
  }

  const today  = visits.length
  const action = visits.filter(v => v.status === 'recording-uploaded').length
  const ready  = visits.filter(v => v.status === 'note-ready').length
  const synced = visits.filter(v => v.status === 'uploaded').length

  // Filter history for the Pending / Completed sidebar views.
  const historyFiltered = (() => {
    let base =
      screen === 'pending'
        ? history.filter(
            (h) =>
              h.status === 'recording-uploaded' ||
              (h.status === 'note-ready' && !clinicianNoteReturned(h)),
          )
        : screen === 'completed'
          ? history.filter(
              (h) => ['uploaded', 'done'].includes(h.status) || clinicianNoteReturned(h),
            )
          : history
    if (histAudioOnly) {
      base = base.filter((h) => h.audio_file && String(h.audio_file).trim() !== '')
    }
    if (!histQ) return base
    const q = histQ.toLowerCase()
    return base.filter(h => h.patient_name?.toLowerCase().includes(q) || h.mrn?.toLowerCase().includes(q))
  })()

  const historyTitle = screen === 'pending' ? 'Pending Notes' : screen === 'completed' ? 'Completed Notes' : 'All History'
  const historySubtitle =
    screen === 'pending'
      ? `Pipeline status · ${historyFiltered.length} encounter${historyFiltered.length !== 1 ? 's' : ''}${
          historySyncedAt ? ` · Refreshed ${formatSyncedLabel(historySyncedAt)}` : ''
        }`
      : screen === 'completed'
      ? `Finalized in chart · ${historyFiltered.length} encounter${historyFiltered.length !== 1 ? 's' : ''}${
          historySyncedAt ? ` · Refreshed ${formatSyncedLabel(historySyncedAt)}` : ''
        }`
      : screen === 'history'
      ? `Full timeline · ${historyFiltered.length} encounter${historyFiltered.length !== 1 ? 's' : ''}${
          historySyncedAt ? ` · Refreshed ${formatSyncedLabel(historySyncedAt)}` : ''
        }`
      : `${historyFiltered.length} encounter${historyFiltered.length !== 1 ? 's' : ''}${
          historySyncedAt ? ` · Refreshed ${formatSyncedLabel(historySyncedAt)}` : ''
        }`

  const pendingProcessing =
    screen === 'pending' ? historyFiltered.filter((h) => h.status === 'recording-uploaded').length : 0
  const pendingReady =
    screen === 'pending' ? historyFiltered.filter((h) => h.status === 'note-ready').length : 0

  const completedDone =
    screen === 'completed' ? historyFiltered.filter((h) => h.status === 'done').length : 0
  const completedReturned =
    screen === 'completed' ? Math.max(0, historyFiltered.length - completedDone) : 0

  const historyPipeline =
    screen === 'history'
      ? historyFiltered.filter(
          (h) =>
            h.status === 'recording-uploaded' ||
            (h.status === 'note-ready' && !clinicianNoteReturned(h)),
        ).length
      : 0
  const historyFinished =
    screen === 'history'
      ? historyFiltered.filter((h) => ['uploaded', 'done'].includes(h.status) || clinicianNoteReturned(h)).length
      : 0
  const historyScheduled =
    screen === 'history'
      ? historyFiltered.filter((h) => ['upcoming', 'in-progress'].includes(h.status)).length
      : 0

  const historyToolbarLayout = screen === 'pending' || screen === 'completed' || screen === 'history'

  const Topbar = ({ children, title, subtitle }) => (
    <PortalTopbar
      drawerMode={drawerMode}
      sidebarOpen={sidebar.open}
      onMenuClick={sidebar.toggle}
      moduleTitle={title || 'Clinician'}
      brandName={subtitle || branding.system_name || 'Anot'}
      user={cu}
      avatarFallback="C"
      navControlsId="clinician-sidebar"
      onViewProfile={() => {
        setScreen('profile')
        sidebar.close()
      }}
      onLogout={requestLogout}
      menuId="clinician-account-menu"
      endBeforeAccount={
        children ? (
          <div style={{ display: 'inline-flex', alignItems: 'center', gap: 8, flexWrap: 'wrap', justifyContent: 'flex-end' }}>
            {children}
          </div>
        ) : null
      }
    />
  )

  const sidebarProps = {
    screen,
    setScreen,
    sidebar,
    currentUser: cu,
    visits,
    tip: tipOfDay,
    drawerMode,
    branding,
    onRequestLogout: requestLogout,
    confirmDialog,
    confirmLoading,
    onDismissConfirm: () => !confirmLoading && setConfirmDialog(null),
    onConfirmAction: runConfirm,
  }

  if (screen === 'profile') {
    const pendingEnc = history.filter((h) => ['recording-uploaded', 'note-ready'].includes(h.status)).length
    const completedEnc = history.filter(
      (h) => ['uploaded', 'done'].includes(h.status) || clinicianNoteReturned(h),
    ).length
    const todayEnc = visits.length
    const encDayLabel = off === 0 ? 'Encounters today' : `Encounters · ${localDate(off)}`
    return (
      <div className="sf-page sf-portal adm-shell">
        <Sidebar {...sidebarProps} />
        <div className="sf-main sf-portal__main">
          <Overlay open={sidebar.open} onClick={sidebar.close} className="adm-shell-overlay" />
          <PortalTopbar
            drawerMode={drawerMode}
            sidebarOpen={sidebar.open}
            onMenuClick={sidebar.toggle}
            navControlsId="clinician-sidebar"
            moduleTitle="My Profile"
            brandName={branding.system_name || 'Anot'}
            user={cu}
            avatarFallback="C"
            onViewProfile={() => {
              setScreen('profile')
              sidebar.close()
            }}
            onLogout={requestLogout}
            menuId="clinician-account-menu"
          />
          <div className="sf-body">
            <div className="sf-card sf-card-lg">
              <div className="sf-card__title">My activity</div>
              <div className="sf-metric-grid">
                {[
                  [encDayLabel, todayEnc, '#4260E9'],
                  ['In pipeline', pendingEnc, '#FFB547'],
                  ['Completed', completedEnc, '#00C896'],
                ].map(([label, val, color]) => (
                  <div key={label} className="sf-metric-tile">
                    <div className="sf-metric-tile__val" style={{ color }}>
                      {val}
                    </div>
                    <div className="sf-metric-tile__lbl">{label}</div>
                  </div>
                ))}
              </div>
            </div>
            <ProfileScreen currentUser={cu} showToast={showToast} />
          </div>
          {toast && <Toast toast={toast} />}
        </div>
      </div>
    )
  }

  // ── Review Note ────────────────────────────────────────────────────────────

  if (reviewNote) {
    return (
      <div className="sf-page sf-portal adm-shell">
        <Sidebar {...sidebarProps} />
        <div className="sf-main sf-portal__main">
          <Overlay open={sidebar.open} onClick={sidebar.close} className="adm-shell-overlay" />
          <PortalTopbar
            drawerMode={drawerMode}
            sidebarOpen={sidebar.open}
            onMenuClick={sidebar.toggle}
            navControlsId="clinician-sidebar"
            user={cu}
            avatarFallback="C"
            onViewProfile={() => {
              setScreen('profile')
              sidebar.close()
            }}
            onLogout={requestLogout}
            menuId="clinician-account-menu"
            moduleTitle=""
            brandName={branding.system_name || 'Anot'}
            titleRow={
              <div style={{ display: 'flex', alignItems: 'center', gap: 12, minWidth: 0, flex: 1 }}>
                <button type="button" className="btn btn-sm" onClick={() => setReview(null)}>
                  ← Back
                </button>
                <div className="adm-topbar__titles" style={{ minWidth: 0 }}>
                  <div className="adm-topbar__module">{reviewNote.patient_name}</div>
                  <div className="adm-topbar__brand">
                    {reviewNote.visit_type} · {fmtDate(reviewNote.visit_date)}
                  </div>
                </div>
              </div>
            }
          />
          <div className="sf-body">
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 16, flexWrap: 'wrap', gap: 10 }}>
              <div style={{ display: 'inline-flex', alignItems: 'center', gap: 8, padding: '8px 16px', borderRadius: 999, background: 'var(--blue-light)', border: '1px solid rgba(79, 172, 254, 0.35)' }}>
                <span style={{ fontSize: 14 }}>📄</span>
                <span style={{ fontSize: 13, fontWeight: 600, color: 'var(--brand-primary-dark)' }}>Final Note — {reviewNote.scribe_name || 'Scribe'}</span>
              </div>
              {!editReq[reviewNote.note_id] ? (
                <button
                  type="button"
                  className="btn"
                  onClick={async () => {
                    try {
                      await notesAPI.requestEdit(reviewNote.note_id)
                      setEditReq((p) => ({ ...p, [reviewNote.note_id]: true }))
                      showToast('Edit request sent')
                    } catch (e) {
                      showToast(e.message, 'error')
                    }
                  }}
                >
                  ✏️ Request Edit
                </button>
              ) : (
                <span className="badge badge-amber">✓ Edit Requested</span>
              )}
            </div>
            <div className="sf-note-card">
              <pre className="sf-note-pre">{reviewNote.final_note || 'Note not available.'}</pre>
            </div>
          </div>
          {toast && <Toast toast={toast} />}
        </div>
      </div>
    )
  }

  // ── Main layout ────────────────────────────────────────────────────────────

  return (
    <div className="sf-page sf-portal adm-shell">
      <Sidebar {...sidebarProps} />
      <div className="sf-main sf-portal__main">
        <Overlay open={sidebar.open} onClick={sidebar.close} className="adm-shell-overlay" />

        {/* TEMPLATES */}
        {screen === 'templates' && (
          <>
            <Topbar title="Note Templates" subtitle="Structured note starters · Saved in this browser" />
            <div style={{ flex: 1, minHeight: 0, display: 'flex', flexDirection: 'column' }}>
              <TemplatesScreen showToast={showToast} />
            </div>
          </>
        )}

        {/* HISTORY / PENDING / COMPLETED — same UI, different filter */}
        {['history', 'pending', 'completed'].includes(screen) && (
          <>
            <Topbar title={historyTitle} subtitle={historySubtitle}>
              <button type="button" className="btn btn-sm" disabled={loading} onClick={() => loadHistory({ notify: true })} title="Reload list">
                ⟳ Refresh
              </button>
            </Topbar>
            <div className="sf-body">
              {screen === 'pending' && !loading && historyFiltered.length > 0 ? (
                <div className="cl-pending-hero" aria-label="Pending pipeline summary">
                  <div className="cl-pending-stat cl-pending-stat--processing">
                    <span className="cl-pending-stat__val">{pendingProcessing}</span>
                    <span className="cl-pending-stat__lbl">Processing</span>
                    <span className="cl-pending-stat__hint">Audio or AI draft is still finishing — check back shortly.</span>
                  </div>
                  <div className="cl-pending-stat cl-pending-stat--ready">
                    <span className="cl-pending-stat__val">{pendingReady}</span>
                    <span className="cl-pending-stat__lbl">Ready for you</span>
                    <span className="cl-pending-stat__hint">Note is ready to preview, play audio, or open when available.</span>
                  </div>
                </div>
              ) : null}

              {screen === 'completed' && !loading && historyFiltered.length > 0 ? (
                <div className="cl-pending-hero" aria-label="Completed encounters summary">
                  <div className="cl-pending-stat cl-pending-stat--completed-emr">
                    <span className="cl-pending-stat__val">{completedReturned}</span>
                    <span className="cl-pending-stat__lbl">Returned or filed</span>
                    <span className="cl-pending-stat__hint">
                      Scribe-submitted notes, chart uploads, and anything not yet marked visit closed.
                    </span>
                  </div>
                  <div className="cl-pending-stat cl-pending-stat--completed-done">
                    <span className="cl-pending-stat__val">{completedDone}</span>
                    <span className="cl-pending-stat__lbl">Visit closed</span>
                    <span className="cl-pending-stat__hint">Marked complete in your workflow.</span>
                  </div>
                </div>
              ) : null}

              {screen === 'history' && !loading && historyFiltered.length > 0 ? (
                <div className="cl-history-hero" aria-label="All history summary">
                  <div className="cl-pending-stat cl-pending-stat--history-pipeline">
                    <span className="cl-pending-stat__val">{historyPipeline}</span>
                    <span className="cl-pending-stat__lbl">In pipeline</span>
                    <span className="cl-pending-stat__hint">Processing audio or note ready for review.</span>
                  </div>
                  <div className="cl-pending-stat cl-pending-stat--history-finished">
                    <span className="cl-pending-stat__val">{historyFinished}</span>
                    <span className="cl-pending-stat__lbl">Completed</span>
                    <span className="cl-pending-stat__hint">Submitted to chart or visit closed.</span>
                  </div>
                  <div className="cl-pending-stat cl-pending-stat--history-scheduled">
                    <span className="cl-pending-stat__val">{historyScheduled}</span>
                    <span className="cl-pending-stat__lbl">Scheduled / live</span>
                    <span className="cl-pending-stat__hint">Upcoming visits or recording in progress.</span>
                  </div>
                </div>
              ) : null}

              <div className={historyToolbarLayout ? 'cl-pending-toolbar' : ''}>
                <input
                  className="sf-input"
                  placeholder="Search by name or MRN…"
                  value={histQ}
                  onChange={(e) => setHistQ(e.target.value)}
                  aria-label="Search encounters"
                  style={historyToolbarLayout ? undefined : { marginBottom: 12 }}
                />
                <label className="cl-filter-toggle">
                  <input type="checkbox" checked={histAudioOnly} onChange={(e) => setHistAudioOnly(e.target.checked)} />
                  <span>Only encounters with a recording</span>
                </label>
              </div>

              {loading ? (
                <div className="sf-empty">
                  <div className="sf-empty-icon">⏳</div>
                  <div className="sf-empty-title">Loading…</div>
                </div>
              ) : historyFiltered.length === 0 ? (
                <div className="sf-empty">
                  <div className="sf-empty-icon">
                    {screen === 'pending' ? '✨' : screen === 'completed' ? '✅' : screen === 'history' ? '📜' : '📋'}
                  </div>
                  <div className="sf-empty-title">
                    {screen === 'pending' ? 'No pending notes — all caught up.' : screen === 'completed' ? 'No completed notes yet.' : screen === 'history' ? 'No encounters match your filters.' : 'No history found'}
                  </div>
                  {screen === 'pending' ? (
                    <div className="sf-empty-sub">When a visit is still processing or waiting for your review, it will show up here.</div>
                  ) : null}
                  {screen === 'completed' ? (
                    <div className="sf-empty-sub">
                      Includes notes the scribe has submitted and visits filed to the chart. If nothing appears, your
                      scribe may still be drafting, or filters may be hiding visits without audio.
                    </div>
                  ) : null}
                  {screen === 'history' ? (
                    <div className="sf-empty-sub">Try clearing search or include visits without a recording. New activity will show after your next refresh.</div>
                  ) : null}
                </div>
              ) : (
                historyFiltered.map((h) => {
                  const hst = ST[historyRowDisplayStatus(h)] || ST.upcoming
                  const modernCard = screen === 'pending' || screen === 'completed' || screen === 'history'
                  const cardVariant =
                    screen === 'pending'
                      ? h.status === 'note-ready'
                        ? 'ready'
                        : 'processing'
                      : screen === 'completed'
                      ? h.status === 'done'
                        ? 'completed-done'
                        : 'completed-emr'
                      : screen === 'history'
                      ? h.status === 'note-ready'
                        ? 'ready'
                        : h.status === 'recording-uploaded'
                        ? 'processing'
                        : h.status === 'uploaded'
                        ? 'completed-emr'
                        : h.status === 'done'
                        ? 'completed-done'
                        : h.status === 'in-progress'
                        ? 'history-live'
                        : h.status === 'upcoming'
                        ? 'history-upcoming'
                        : 'history-default'
                      : ''
                  const RowWrap = modernCard ? 'article' : 'div'
                  const rowClass = modernCard ? `cl-pending-card cl-pending-card--${cardVariant}` : 'sf-row'
                  const rowProps = modernCard ? { 'aria-label': `${h.patient_name}, ${hst.label}` } : {}
                  return (
                    <RowWrap key={h.id} className={rowClass} style={modernCard ? undefined : { alignItems: 'flex-start', flexWrap: 'wrap', marginBottom: 8, justifyContent: 'flex-start', gap: 14 }} {...rowProps}>
                      <div className={modernCard ? 'cl-pending-card__main' : ''} style={modernCard ? undefined : { display:'flex', alignItems:'center', gap:14, flex:1, minWidth:0 }}>
                        <div
                          className={modernCard ? 'cl-pending-card__avatar' : ''}
                          style={
                            modernCard
                              ? { background: avatarBg(h.patient_name) }
                              : { width:46, height:46, borderRadius:14, background:avatarBg(h.patient_name), display:'flex', alignItems:'center', justifyContent:'center', fontSize:15, fontWeight:800, color:'#1E293B', flexShrink:0 }
                          }
                        >
                          {initials(h.patient_name)}
                        </div>
                        <div style={{ minWidth:0, flex:1 }}>
                          <div className={modernCard ? 'cl-pending-card__title' : ''} style={modernCard ? undefined : { fontSize:15, fontWeight:700, color:'#1E293B' }}>{h.patient_name}</div>
                          <div className={modernCard ? 'cl-pending-card__meta' : ''} style={modernCard ? undefined : { fontSize:13, color:'#64748B', marginTop:3, display:'flex', alignItems:'center', gap:8, flexWrap:'wrap' }}>
                            <span style={{ fontWeight:600, color:'#475569' }}>📋 {h.mrn}</span>
                            <button type="button" className="cl-copy-mrn" onClick={() => copyMrn(h.mrn)} title="Copy MRN">
                              Copy
                            </button>
                            <span style={{ color:'#CBD5E1' }}>·</span>
                            <span style={{ fontWeight:500 }}>{fmtDate(h.visit_date)}</span>
                            <span style={{ color:'#CBD5E1' }}>·</span>
                            <span>{h.visit_type}</span>
                            {h.duration_seconds ? <><span style={{ color:'#CBD5E1' }}>·</span><span>{fmtSecs(h.duration_seconds)}</span></> : null}
                          </div>
                          <div style={{ marginTop:8 }}><StatusChip st={hst} /></div>
                        </div>
                      </div>
                      <div className={modernCard ? 'cl-pending-card__actions' : ''} style={modernCard ? undefined : { display: 'flex', gap: 8, flexWrap: 'wrap', justifyContent: 'flex-end', marginLeft: 'auto' }}>
                        {h.audio_file ? (
                          <button type="button" className="cl-icon-btn" title="Play recording" onClick={() => setPlayVisit(h)}>
                            🔊
                          </button>
                        ) : null}
                        {h.ai_draft ? (
                          <button type="button" className="cl-icon-btn" title="Preview Draft" onClick={() => setAiVisit(h)}>
                            👁
                          </button>
                        ) : null}
                        {h.final_note ? (
                          <button
                            type="button"
                            className="cl-icon-btn"
                            title="Final Note"
                            onClick={async () => {
                              try {
                                const d = await notesAPI.getByVisit(h.id)
                                setReview({ ...h, final_note: d.note?.final_note, note_id: d.note?.id, scribe_name: d.note?.scribe_name || h.scribe_name })
                              } catch {
                                showToast('Failed', 'error')
                              }
                            }}
                          >
                            📋
                          </button>
                        ) : null}
                      </div>
                    </RowWrap>
                  )
                })
              )}
            </div>
          </>
        )}

        {/* SCHEDULE */}
        {screen === 'schedule' && (
          <>
            <Topbar
              title={`${getGreeting()}, Dr. ${cu.name?.split(' ').pop()}`}
              subtitle={`${localDate(off, 'long')} · ${today} patient${today !== 1 ? 's' : ''} on this day${
                scheduleSyncedAt ? ` · Updated ${formatSyncedLabel(scheduleSyncedAt)}` : ''
              }`}
            >
              <time
                dateTime={liveNow.toISOString()}
                title="Local time"
                style={{
                  fontSize: 12,
                  fontWeight: 600,
                  fontVariantNumeric: 'tabular-nums',
                  color: 'var(--text-sub)',
                  padding: '4px 10px',
                  borderRadius: 8,
                  background: 'var(--gray-bg)',
                  border: '1px solid var(--border)',
                }}
              >
                {liveNow.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' })}
              </time>
              <button type="button" className="btn btn-sm" disabled={loading} onClick={() => loadVisits({ notify: true })} title="Reload schedule">
                ⟳ Refresh
              </button>
              <button type="button" className="btn btn-navy btn-sm" onClick={() => { setShowAdd((f) => !f); setPtErr('') }}>
                + Add Patient
              </button>
            </Topbar>

            <div className="sf-body">
              <div className="sf-banner sf-banner-past" style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12, flexWrap: 'wrap' }}>
                <div>
                  <div className="sf-section-label" style={{ marginBottom: 4 }}>
                    {off === 0 ? "Today's visits" : `Visits for ${localDate(off, 'long')}`}
                  </div>
                  <div style={{ fontSize: 13, color: 'var(--text-sub)' }}>
                    Press <kbd className="cl-kbd">T</kbd> to jump to today
                    {off !== 0 ? (
                      <>
                        {' · '}
                        <button type="button" className="sf-back" style={{ display: 'inline', background: 'none', border: 'none', padding: 0, cursor: 'pointer' }} onClick={() => setOff(0)}>
                          Go to today
                        </button>
                      </>
                    ) : null}
                  </div>
                </div>
                <span className="badge badge-blue">Clinical workspace</span>
              </div>

              <div className="sf-stats">
                {[
                  ['Total Visits', today, '#4260E9'],
                  ['Processing', action, '#EA580C'],
                  ['Ready for Review', ready, '#16A34A'],
                  ['Completed', synced, '#2563EB'],
                ].map(([label, val, color]) => (
                  <div key={label} className="sf-stat">
                    <div className="sf-stat-val" style={{ color }}>{val}</div>
                    <div className="sf-stat-lbl">{label}</div>
                  </div>
                ))}
              </div>

              {active && (
                <div className="sf-rec-banner" style={{ marginBottom: 14 }}>
                  <div className="sf-rec-dot" />
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div className="sf-audio-label" style={{ color: '#9F1239' }}>{active.patient_name}</div>
                    <div style={{ fontSize: 12, color: '#E11D48', marginTop: 2 }}>{fmtSecs(timer)} · {paused ? 'Paused' : 'Recording live...'}</div>
                  </div>
                  <div className="sf-audio-controls">
                    <button type="button" className="btn btn-sm btn-amber" onClick={pauseResume}>{paused ? '▶ Resume' : '⏸ Pause'}</button>
                    <button type="button" className="btn btn-sm btn-red" onClick={endVisit}>■ End</button>
                  </div>
                </div>
              )}

              {addRec && (
                <div className="sf-banner sf-banner-future" style={{ display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap', marginBottom: 14 }}>
                  <span style={{ fontSize: 18 }}>🎙</span>
                  <div style={{ flex: 1 }}>
                    <div style={{ fontSize: 14, fontWeight: 700, color: 'var(--brand-primary-dark)' }}>{addRec.patient_name} — Additional Recording</div>
                    <div style={{ fontSize: 12, color: 'var(--text-sub)', marginTop: 2 }}>{fmtSecs(addTimer)} · {addPaused ? 'Paused' : 'Recording...'}</div>
                  </div>
                  <button type="button" className="btn btn-sm btn-amber" onClick={pauseResumeAdd}>{addPaused ? '▶ Resume' : '⏸ Pause'}</button>
                  <button type="button" className="btn btn-sm" onClick={stopAdd}>■ Stop</button>
                </div>
              )}

              {uploading && (
                <div className="sf-notif sf-notif-green" style={{ borderRadius: 10, marginBottom: 14 }}>
                  ⏳ Uploading & preparing note...
                </div>
              )}

              {showAdd && (
                <div className="sf-card sf-card-lg" style={{ marginBottom: 18 }}>
                  <div className="sf-modal-title" style={{ marginBottom: 16 }}>Schedule New Patient</div>
                  <div className="sf-form-grid">
                    {[
                      ['Patient Name *', 'text', 'Full name', 'name'],
                      ['MRN *', 'text', 'e.g. MRN-00421', 'mrn'],
                      ['Date of Birth', 'date', '', 'dob'],
                      ['Appointment Time *', 'time', '', 'time'],
                    ].map(([label, type, ph, key]) => (
                      <div key={key} className="sf-form-group">
                        <label className="sf-form-label" htmlFor={`pt-${key}`}>{label}</label>
                        <input
                          id={`pt-${key}`}
                          className="sf-input"
                          type={type}
                          placeholder={ph}
                          value={pt[key]}
                          onChange={(e) => setPt({ ...pt, [key]: e.target.value })}
                        />
                      </div>
                    ))}
                    <div className="sf-form-group">
                      <label className="sf-form-label" htmlFor="pt-type">Visit Type</label>
                      <select id="pt-type" className="sf-input" value={pt.type} onChange={(e) => setPt({ ...pt, type: e.target.value })}>
                        <option>Follow-up</option>
                        <option>New Patient</option>
                        <option>Virtual Visit</option>
                        <option>Other</option>
                      </select>
                    </div>
                  </div>
                  {ptErr ? (
                    <div className="sf-notif sf-notif-amber" style={{ borderRadius: 10, marginTop: 12 }}>
                      ⚠ {ptErr}
                    </div>
                  ) : null}
                  <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap', marginTop: 16 }}>
                    <button type="button" className="btn btn-navy" onClick={addPatient}>Schedule Patient</button>
                    <button type="button" className="btn" onClick={() => { setShowAdd(false); setPtErr('') }}>Cancel</button>
                  </div>
                </div>
              )}

              <div className="sf-date-nav">
                <button type="button" className="btn btn-sm" onClick={() => setOff((d) => d - 1)} aria-label="Previous day">
                  ‹
                </button>
                <div className="sf-date-nav-days">
                  {DAYS.map((o) => (
                    <div
                      key={o}
                      role="button"
                      tabIndex={0}
                      onClick={() => setOff(o)}
                      onKeyDown={(e) => (e.key === 'Enter' || e.key === ' ') && setOff(o)}
                      className={`sf-date-nav-day${o === off ? ' active' : ''}`}
                    >
                      <div className="sf-date-nav-day-name">{localDate(o, 'day')}</div>
                      <div className="sf-date-nav-day-date" style={{ fontSize: 16, fontWeight: 800, lineHeight: 1.2, color: o === off ? '#fff' : undefined }}>{localDate(o, 'date')}</div>
                      {o === 0 ? (
                        <div
                          className="sf-date-nav-day-date"
                          style={{
                            fontSize: 9,
                            fontWeight: 700,
                            marginTop: 2,
                            textTransform: 'uppercase',
                            letterSpacing: '0.06em',
                            color: o === off ? 'rgba(255,255,255,0.75)' : undefined,
                          }}
                        >
                          Today
                        </div>
                      ) : null}
                    </div>
                  ))}
                </div>
                <button type="button" className="btn btn-sm" onClick={() => setOff((d) => d + 1)} aria-label="Next day">
                  ›
                </button>
              </div>

              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', margin: '18px 0 10px' }}>
                <span className="sf-section-label" style={{ marginBottom: 0 }}>Patient List</span>
                <span style={{ fontSize: 12, color: 'var(--text-muted)' }}>Sort: Time ▾</span>
              </div>

              <div>
                {loading && visits.length === 0 ? (
                  <div className="cl-skeleton-list" aria-busy="true" aria-label="Loading schedule">
                    {[0, 1, 2, 3].map((i) => (
                      <div key={i} className="cl-skeleton-row" />
                    ))}
                  </div>
                ) : loading ? (
                  <div className="sf-empty">
                    <div className="sf-empty-icon">⏳</div>
                    <div className="sf-empty-title">Updating…</div>
                  </div>
                ) : visits.length === 0 ? (
                  <div className="sf-empty">
                    <div className="sf-empty-icon">📭</div>
                    <div className="sf-empty-title">No patients scheduled</div>
                    <div className="sf-empty-sub">{localDate(off, 'long')}</div>
                    <button type="button" className="btn btn-navy" style={{ marginTop: 8 }} onClick={() => setShowAdd(true)}>
                      + Add Patient
                    </button>
                  </div>
                ) : (
                  visits.map((v) => {
                  const st = ST[v.status] || ST.upcoming
                  const isActive = active?.id === v.id
                  const hasAudio = v.audio_file && v.audio_file.trim() !== ''
                  const recCount = v.recording_count || 1
                  return (
                    <div key={v.id} className={`sf-row${isActive ? ' sf-row-active' : ''}`} style={{ alignItems: 'flex-start', flexWrap: 'wrap', marginBottom: 8, justifyContent: 'flex-start', gap: 14 }}>
                      {/* Time */}
                      <div style={{ textAlign:'center', minWidth:44, flexShrink:0, paddingTop:2 }}>
                        <div style={{ fontSize:15, fontWeight:800, color:'#1E293B' }}>{fmtTime(v.visit_time).split(' ')[0]}</div>
                        <div style={{ fontSize:11, fontWeight:600, color:'#94A3B8' }}>{fmtTime(v.visit_time).split(' ')[1]}</div>
                      </div>
                      {/* Avatar */}
                      <div style={{ width:46, height:46, borderRadius:14, background:avatarBg(v.patient_name), display:'flex', alignItems:'center', justifyContent:'center', fontSize:15, fontWeight:800, color:'#1E293B', flexShrink:0 }}>{initials(v.patient_name)}</div>
                      {/* Info — improved hierarchy: bolder MRN, more contrast on metadata */}
                      <div style={{ flex:1, minWidth:0 }}>
                        <div style={{ fontSize:16, fontWeight:700, color:'#1E293B', whiteSpace:'nowrap', overflow:'hidden', textOverflow:'ellipsis' }}>{v.patient_name}</div>
                        <div style={{ fontSize:13, color:'#64748B', marginTop:4, display:'flex', alignItems:'center', gap:8, flexWrap:'wrap' }}>
                          <span style={{ fontWeight:600, color:'#475569' }}>📋 {v.mrn}</span>
                          <button type="button" className="cl-copy-mrn" onClick={() => copyMrn(v.mrn)} title="Copy MRN">
                            Copy
                          </button>
                          <span style={{ color:'#CBD5E1' }}>·</span>
                          <span style={{ fontWeight:500 }}>{v.visit_type}</span>
                          {v.duration_seconds > 0 && (
                            <>
                              <span style={{ color:'#CBD5E1' }}>·</span>
                              <span style={{ color:'#16A34A', fontWeight:600 }}>🎙 {fmtSecs(v.duration_seconds)} total{recCount > 1 ? ` (${recCount} recordings)` : ''}</span>
                            </>
                          )}
                        </div>
                        <div style={{ marginTop:8 }}>
                          <StatusChip st={st} />
                        </div>
                      </div>
                      {/* Actions */}
                      <div style={{ display:'flex', gap:8, alignItems:'flex-start', flexShrink:0, flexWrap:'wrap', justifyContent:'flex-end', paddingTop:2, marginLeft:'auto' }}>
                        {hasAudio && !['upcoming', 'scheduled', 'in-progress'].includes(v.status) && (
                          <button type="button" className="cl-icon-btn" title="Play recording" onClick={() => setPlayVisit(v)}>
                            🔊
                          </button>
                        )}
                        {v.status === 'upcoming' && (
                          <>
                            <button onClick={() => startVisit(v)} disabled={!!active} style={{ display:'inline-flex', alignItems:'center', gap:10, padding:'10px 22px', borderRadius:14, background: active ? '#94A3B8' : 'linear-gradient(135deg,#16A34A,#15803D)', color:'#fff', border:'none', fontSize:15, fontWeight:800, cursor: active ? 'not-allowed' : 'pointer', fontFamily:'inherit', boxShadow: active ? 'none' : '0 4px 16px rgba(22,163,74,0.4)', opacity: active ? 0.6 : 1 }}>
                              <span style={{ width:11, height:11, borderRadius:'50%', background:'#fff', display:'inline-block', flexShrink:0, animation: active ? 'none' : 'pulse 1.4s infinite' }} />
                              Record Encounter
                            </button>
                            <button type="button" className="cl-icon-btn" title="Edit" onClick={() => { setEditV(v); setEditD({ visit_time: v.visit_time, visit_type: v.visit_type }) }}>✏️</button>
                            <button type="button" className="cl-icon-btn" title="Remove" onClick={() => deleteVisit(v)}>🗑</button>
                          </>
                        )}
                        {v.status === 'in-progress' && (
                          <div style={{ display:'inline-flex', alignItems:'center', gap:8, padding:'8px 16px', borderRadius:10, background:'#FFF1F2', border:'1px solid #FECDD3' }}>
                            <div style={{ width:8, height:8, borderRadius:'50%', background:'#EF4444', animation:'pulse 1.2s infinite' }} />
                            <span style={{ fontSize:14, color:'#9F1239', fontWeight:700 }}>Recording...</span>
                          </div>
                        )}
                        {/* recording-uploaded: NO "Generate Note" button.
                            Status chip already says "Processing".
                            Optional Preview Draft + Add to Encounter for additional audio. */}
                        {v.status === 'recording-uploaded' && (
                          <div style={{ display:'flex', gap:8, flexWrap:'wrap', justifyContent:'flex-end', alignItems:'center' }}>
                            <button style={{ ...B.outline, padding:'9px 14px', fontSize:13 }} onClick={() => setAiVisit(v)}>
                              👁 Preview Draft
                            </button>
                            <button onClick={() => startAdd(v)} disabled={!!active || !!addRec} style={{ display:'inline-flex', alignItems:'center', gap:10, padding:'10px 22px', borderRadius:14, background: (active||addRec) ? '#94A3B8' : 'linear-gradient(135deg,#16A34A,#15803D)', color:'#fff', border:'none', fontSize:15, fontWeight:800, cursor: (active||addRec) ? 'not-allowed' : 'pointer', fontFamily:'inherit', boxShadow: (active||addRec) ? 'none' : '0 4px 16px rgba(22,163,74,0.4)', opacity: (active||addRec) ? 0.6 : 1 }}>
                              <span style={{ width:11, height:11, borderRadius:'50%', background:'#fff', display:'inline-block', flexShrink:0 }} />
                              Additional Recording
                            </button>
                          </div>
                        )}
                        {v.status === 'note-ready' && (
                          <>
                            <button style={{ ...B.action, background:'linear-gradient(135deg,#15803D,#16A34A)', color:'#fff', padding:'10px 18px', fontSize:14, boxShadow:'0 4px 14px rgba(21,128,61,0.35)' }}
                              onClick={async () => { try { const d = await notesAPI.getByVisit(v.id); setReview({ ...v, final_note:d.note?.final_note, note_id:d.note?.id, scribe_name:d.note?.scribe_name||v.scribe_name }) } catch { showToast('Failed to load note','error') } }}>
                              📋 Review Final Note
                            </button>
                            <button type="button" className="cl-icon-btn" title="Preview Draft" onClick={() => setAiVisit(v)}>👁</button>
                          </>
                        )}
                        {v.status === 'uploaded' && (
                          <>
                            <button style={{ ...B.action, background:'linear-gradient(135deg,#1565C0,#1E40AF)', color:'#fff', padding:'10px 18px', fontSize:14, boxShadow:'0 4px 14px rgba(30,64,175,0.35)' }}
                              onClick={async () => { try { const d = await notesAPI.getByVisit(v.id); setReview({ ...v, final_note:d.note?.final_note, note_id:d.note?.id, scribe_name:d.note?.scribe_name||v.scribe_name }) } catch { showToast('Failed to load note','error') } }}>
                              📋 View Final Note
                            </button>
                            <button type="button" className="cl-icon-btn" title="Preview Draft" onClick={() => setAiVisit(v)}>👁</button>
                          </>
                        )}
                      </div>
                    </div>
                  )
                })
                )}
              </div>
            </div>
          </>
        )}
      </div>

      {/* Edit visit modal */}
      {editV && (
        <div className="sf-modal-overlay" role="dialog" aria-modal="true" aria-labelledby="cl-edit-title">
          <div className="sf-modal">
            <div id="cl-edit-title" className="sf-modal-title">
              Edit — {editV.patient_name}
            </div>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
              <div className="sf-form-group">
                <label className="sf-form-label" htmlFor="edit-vtype">Visit Type</label>
                <select id="edit-vtype" className="sf-input" value={editD.visit_type} onChange={(e) => setEditD({ ...editD, visit_type: e.target.value })}>
                  <option>Follow-up</option>
                  <option>New Patient</option>
                  <option>Virtual Visit</option>
                  <option>Other</option>
                </select>
              </div>
              <div className="sf-form-group">
                <label className="sf-form-label" htmlFor="edit-vtime">Time</label>
                <input id="edit-vtime" className="sf-input" type="time" value={editD.visit_time} onChange={(e) => setEditD({ ...editD, visit_time: e.target.value })} />
              </div>
            </div>
            <div style={{ display: 'flex', gap: 10, marginTop: 22, flexWrap: 'wrap' }}>
              <button
                type="button"
                className="btn btn-navy"
                onClick={async () => {
                  try {
                    setEditSaving(true)
                    await visitsAPI.updateVisit(editV.id, { visit_time: editD.visit_time, visit_type: editD.visit_type })
                    setVisits((p) => p.map((v) => (v.id === editV.id ? { ...v, ...editD } : v)))
                    setEditV(null)
                    showToast('Updated')
                  } catch (e) {
                    showToast(e.message, 'error')
                  } finally {
                    setEditSaving(false)
                  }
                }}
                disabled={editSaving}
              >
                {editSaving ? 'Saving…' : 'Save Changes'}
              </button>
              <button type="button" className="btn" onClick={() => setEditV(null)}>
                Cancel
              </button>
            </div>
          </div>
        </div>
      )}

      {aiVisit    && <AIModal    visit={aiVisit}    onClose={() => setAiVisit(null)} showToast={showToast} />}
      {playVisit  && <AudioModal visitId={playVisit.id} visit={playVisit} onClose={() => setPlayVisit(null)} showToast={showToast} />}
      {toast      && <Toast toast={toast} />}
    </div>
  )
}

function Toast({ toast }) {
  const err = toast.type === 'error'
  return (
    <div
      role="status"
      style={{
        position: 'fixed',
        bottom: 24,
        right: 24,
        zIndex: 9999,
        padding: '12px 20px',
        borderRadius: 12,
        fontSize: 13,
        fontWeight: 600,
        boxShadow: '0 8px 30px rgba(0,0,0,0.12)',
        background: err ? 'var(--danger-light)' : 'var(--gradient-btn)',
        color: err ? '#be123c' : '#fff',
      }}
    >
      {err ? '⚠ ' : '✓ '}{toast.msg}
    </div>
  )
}
