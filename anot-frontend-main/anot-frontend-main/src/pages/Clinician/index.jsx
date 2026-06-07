import { useState, useEffect, useRef, useCallback, useMemo } from 'react'
import { useNavigate } from 'react-router-dom'
import { authAPI, visitsAPI, patientsAPI, notesAPI, API_BASE, isAbortError } from '../../services/api'
import { useBranding } from '../../services/branding'
import SystemProfileManager from '../../components/SystemProfileManager'
import PortalSidebarFooter from '../../components/PortalSidebarFooter'
import { useSidebar, Overlay, PortalTopbar, usePortalDrawerMode, useSidebarOffCanvasMode, portalSidebarAriaHidden, ConfirmDialog, PortalSidebarBrand } from '../shared'
import { queueAudioUpload, flushPendingAudioUploads, installOfflineUploadFlush } from '../../utils/offlineUploadQueue'
import './clinician.css'
import './clinician-redesign.css'
import '../portalErrorBoundary.css'
import PortalCalendarDayPreview from '../../components/PortalCalendarDayPreview'
import ErrorBoundary, { PortalCrashFallback } from '../../components/ErrorBoundary'
import ContactScreen from './ContactScreen'
import { getPatientAvatarColor } from '../../utils/avatarColor'
import { getCurrentUser } from '../../utils/getCurrentUser'
import { useSessionTimeout } from '../../utils/useSessionTimeout'

// ─── HELPERS ──────────────────────────────────────────────────────────────────

/** Display-only badge class for With Scribe (alias of badge-processing styles). */
const BADGE_WITH_SCRIBE_CLASS = 'badge-processing badge-with-scribe'

function getGreeting() {
  const now = new Date()
  const mins = now.getHours() * 60 + now.getMinutes()
  if (mins < 5 * 60) return 'Good evening'
  if (mins < 12 * 60) return 'Good morning'
  if (mins < 18 * 60) return 'Good afternoon'
  return 'Good evening'
}

function isScheduleToday(off = 0) {
  return Number(off) === 0
}

function visitsSectionTitle(off = 0) {
  if (isScheduleToday(off)) return "TODAY'S VISITS"
  const d = new Date()
  d.setDate(d.getDate() + off)
  const day = d.toLocaleDateString('en-US', { weekday: 'long' }).toUpperCase()
  const month = d.toLocaleDateString('en-US', { month: 'short' }).toUpperCase()
  return `VISITS FOR ${day}, ${month} ${d.getDate()}`
}

function isScribePipelineVisit(v) {
  return ['recording-uploaded', 'submitted', 'in-progress'].includes(v?.status)
}

function showScribeTurnaroundOnSchedule(v) {
  if (!isScribePipelineVisit(v)) return false
  return v.status === 'recording-uploaded' || v.status === 'in-progress'
}

/** Duration only (e.g. "19h", "45m") when audio is with the scribe pipeline. */
function scribeTurnaroundDuration(v) {
  if (!isScribePipelineVisit(v)) return null
  const raw = v.note_updated_at || v.updated_at
  if (!raw) return null
  const ms = Date.now() - new Date(raw).getTime()
  if (Number.isNaN(ms) || ms < 0) return null
  const mins = Math.max(1, Math.floor(ms / 60000))
  if (mins < 60) return `${mins}m`
  const hours = Math.floor(mins / 60)
  return `${hours}h`
}

function scribeWaitingTier(v) {
  if (!['recording-uploaded', 'submitted'].includes(v?.status)) return 'fresh'
  const raw = v.note_updated_at || v.updated_at
  if (!raw) return 'fresh'
  const ms = Date.now() - new Date(raw).getTime()
  if (Number.isNaN(ms) || ms < 0) return 'fresh'
  const hours = ms / 3600000
  if (hours < 24) return 'fresh'
  if (hours < 72) return 'warn'
  return 'urgent'
}

function withScribeBadgeClassName(v) {
  const tier = scribeWaitingTier(v)
  if (tier === 'warn') return `${BADGE_WITH_SCRIBE_CLASS} badge-processing--warn`
  if (tier === 'urgent') return `${BADGE_WITH_SCRIBE_CLASS} badge-processing--urgent`
  return BADGE_WITH_SCRIBE_CLASS
}

function withScribeBadgeLabel(item, { schedule = false } = {}) {
  let duration = scribeTurnaroundDuration(item)
  if (schedule && !showScribeTurnaroundOnSchedule(item)) duration = null
  if (!duration) return WITH_SCRIBE_LABEL
  const tier = scribeWaitingTier(item)
  const timeIcon = tier === 'warn' ? '⚠️' : tier === 'urgent' ? '!' : '🕐'
  const iconClass =
    tier === 'urgent'
      ? 'cl-status-badge__urgency cl-status-badge__urgency--critical'
      : tier === 'warn'
        ? 'cl-status-badge__urgency'
        : 'cl-status-badge__clock'
  return (
    <>
      {WITH_SCRIBE_LABEL} · <span className={iconClass} aria-hidden>{timeIcon}</span> {duration}
    </>
  )
}

function notesMatchesDateRange(h, from, to) {
  if (!from && !to) return true
  const visitDate = h?.visit_date ? String(h.visit_date).slice(0, 10) : ''
  if (!visitDate) return false
  if (from && visitDate < from) return false
  if (to && visitDate > to) return false
  return true
}

function visitMinutesFromMidnight(timeStr) {
  if (!timeStr) return 0
  const [h, m] = timeStr.split(':').map((x) => parseInt(x, 10) || 0)
  return h * 60 + m
}

function shouldInsertNowBefore(visits, index, off, now) {
  if (off !== 0 || !visits.length) return false
  const nowMins = now.getHours() * 60 + now.getMinutes()
  const curMins = visitMinutesFromMidnight(visits[index]?.visit_time)
  if (index === 0) return nowMins < curMins
  const prevMins = visitMinutesFromMidnight(visits[index - 1]?.visit_time)
  return prevMins <= nowMins && curMins > nowMins
}

function shouldInsertNowAfterAll(visits, off, now) {
  if (off !== 0 || !visits.length) return false
  const nowMins = now.getHours() * 60 + now.getMinutes()
  const lastMins = visitMinutesFromMidnight(visits[visits.length - 1]?.visit_time)
  return lastMins <= nowMins
}

function isScheduleVisitOverdue(v, off) {
  if (v.status !== 'upcoming') return false
  return isScheduleVisitOverdueForDay(v, off)
}

function schedulePatientCardAccentClass(v, off) {
  if (isScheduleVisitOverdue(v, off)) return 'cl-patient-card--overdue'
  switch (v.status) {
    case 'upcoming':
      return 'cl-patient-card--upcoming'
    case 'note-ready':
      return 'cl-patient-card--review'
    case 'uploaded':
    case 'done':
      return 'cl-patient-card--completed'
    case 'recording-uploaded':
    case 'in-progress':
    case 'submitted':
      return 'cl-patient-card--processing'
    default:
      return 'cl-patient-card--upcoming'
  }
}

function notesWaitingTier(h) {
  const raw = h?.updated_at || h?.created_at || h?.visit_date
  if (!raw) return 'fresh'
  const ms = Date.now() - new Date(raw).getTime()
  if (Number.isNaN(ms) || ms < 0) return 'fresh'
  const hours = ms / 3600000
  if (hours < 24) return 'fresh'
  if (hours < 72) return 'warn'
  return 'urgent'
}

function notesWaitingLabel(h) {
  const raw = h?.updated_at || h?.created_at || h?.visit_date
  if (!raw) return 'Waiting'
  const ms = Date.now() - new Date(raw).getTime()
  if (Number.isNaN(ms) || ms < 0) return 'Waiting'
  const hours = Math.floor(ms / 3600000)
  if (hours < 24) return hours < 1 ? 'Waiting < 1h' : `Waiting ${hours}h`
  const days = Math.floor(hours / 24)
  return `Waiting ${days}d`
}

/** Relative "Xh ago" (same day) / "X days ago" — returns null when the timestamp is missing/invalid. */
function notesRelativeAgo(raw) {
  if (!raw) return null
  const t = new Date(raw).getTime()
  if (Number.isNaN(t)) return null
  const ms = Date.now() - t
  if (ms < 0) return null
  const hours = Math.floor(ms / 3600000)
  if (hours < 24) return hours < 1 ? '<1h ago' : `${hours}h ago`
  const days = Math.floor(hours / 24)
  return days === 1 ? '1 day ago' : `${days} days ago`
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

function initials(n) {
  if (!n) return '?'
  const parts = String(n).trim().split(/\s+/).filter(Boolean)
  if (!parts.length) return '?'
  if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase()
  return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase()
}

function audiofmt(s) {
  if (!s || isNaN(s)) return '0:00'
  return `${String(Math.floor(s/60)).padStart(2,'0')}:${String(Math.floor(s%60)).padStart(2,'0')}`
}

function daysOffsetFromToday(year, month, day) {
  const today = new Date()
  today.setHours(12, 0, 0, 0)
  const target = new Date(year, month, day, 12, 0, 0, 0)
  return Math.round((target - today) / 86400000)
}

function normalizeScheduleDay(date = new Date()) {
  const d = new Date(date)
  d.setHours(12, 0, 0, 0)
  return d
}

function scheduleOffFromDate(date) {
  return daysOffsetFromToday(date.getFullYear(), date.getMonth(), date.getDate())
}

function IconCalendar() {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <rect x="3" y="4" width="18" height="18" rx="2" ry="2" />
      <line x1="16" y1="2" x2="16" y2="6" />
      <line x1="8" y1="2" x2="8" y2="6" />
      <line x1="3" y1="10" x2="21" y2="10" />
    </svg>
  )
}

function IconMic() {
  return (
    <svg className="cl-schedule-cta__icon" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <path d="M12 1a3 3 0 0 0-3 3v8a3 3 0 0 0 6 0V4a3 3 0 0 0-3-3z" />
      <path d="M19 10v2a7 7 0 0 1-14 0v-2" />
      <line x1="12" y1="19" x2="12" y2="23" />
      <line x1="8" y1="23" x2="16" y2="23" />
    </svg>
  )
}

function ClinicianTooltip({ tip, placement = 'above', compact = false, icon = false, filterTip = false, children }) {
  if (!tip) return children
  return (
    <span
      className={`cl-schedule-tooltip-wrap cl-schedule-tooltip-wrap--${placement}${compact ? ' cl-schedule-tooltip-wrap--compact' : ''}${icon ? ' cl-schedule-tooltip-wrap--icon' : ''}${filterTip ? ' cl-schedule-tooltip-wrap--filter' : ''}`}
    >
      {children}
      <span
        className={`cl-schedule-tooltip cl-schedule-tooltip--${placement}${compact ? ' cl-schedule-tooltip--compact' : ''}${icon ? ' cl-schedule-tooltip--icon' : ''}${filterTip ? ' cl-schedule-tooltip--filter' : ''}`}
        role="tooltip"
      >
        {tip}
      </span>
    </span>
  )
}

function isScheduleVisitOverdueForDay(v, dayOff) {
  if (v.status !== 'upcoming') return false
  const timePart = v.visit_time || '23:59:59'
  const normalized = timePart.length === 5 ? `${timePart}:00` : timePart
  const appt = new Date(`${localDate(dayOff)}T${normalized}`)
  return !Number.isNaN(appt.getTime()) && appt < new Date()
}

function scheduleDayStatusBreakdown(visitList, dayOff) {
  const counts = { upcoming: 0, withScribe: 0, overdue: 0, ready: 0, completed: 0 }
  for (const v of visitList) {
    if (v.status === 'upcoming') {
      if (isScheduleVisitOverdueForDay(v, dayOff)) counts.overdue += 1
      else counts.upcoming += 1
    } else if (['recording-uploaded', 'in-progress', 'submitted'].includes(v.status)) {
      counts.withScribe += 1
    } else if (v.status === 'note-ready') {
      counts.ready += 1
    } else if (['uploaded', 'done'].includes(v.status)) {
      counts.completed += 1
    }
  }
  return counts
}

// Always-visible status dots for a day pill (mobile/tablet have no hover).
// Priority + max 3: purple (overdue), red (ready), blue (upcoming), green (completed).
function scheduleDayDots(breakdown) {
  if (!breakdown || typeof breakdown !== 'object') return []
  const dots = []
  if ((breakdown.overdue || 0) > 0) dots.push('#D97706')
  if ((breakdown.ready || 0) > 0) dots.push('#DC2626')
  if ((breakdown.upcoming || 0) > 0) dots.push('#2563EB')
  if ((breakdown.completed || 0) > 0) dots.push('#16A34A')
  return dots.slice(0, 3)
}

function scheduleDayBreakdownFor(dayOff, selectedOff, currentVisits, scheduleDayBreakdown) {
  const key = localDate(dayOff)
  if (dayOff === selectedOff) return scheduleDayStatusBreakdown(currentVisits, dayOff)
  if (scheduleDayBreakdown && Object.prototype.hasOwnProperty.call(scheduleDayBreakdown, key)) {
    return scheduleDayBreakdown[key]
  }
  return null
}

function scheduleDayPatientTotal(dayOff, breakdown, scheduleDayCounts) {
  const hasBreakdownData =
    breakdown && typeof breakdown === 'object' && !Array.isArray(breakdown) &&
    ('upcoming' in breakdown || 'withScribe' in breakdown || 'overdue' in breakdown || 'ready' in breakdown || 'completed' in breakdown)
  if (hasBreakdownData) {
    return (breakdown.upcoming || 0) + (breakdown.withScribe || 0) + (breakdown.overdue || 0) + (breakdown.ready || 0) + (breakdown.completed || 0)
  }
  if (!scheduleDayCounts || typeof scheduleDayCounts !== 'object' || Array.isArray(scheduleDayCounts)) {
    return 0
  }
  const key = localDate(dayOff)
  if (Object.prototype.hasOwnProperty.call(scheduleDayCounts, key)) {
    return scheduleDayCounts[key]
  }
  return 0
}

function scheduleDayPreviewLabel(dayOff, total) {
  if (total === 0) return 'No patients'
  const word = total === 1 ? 'patient' : 'patients'
  if (dayOff === 0) return `${total} ${word} today`
  return `${total} ${word}`
}

function ScheduleDayPreview({ dayOff, breakdown, scheduleDayCounts }) {
  if (dayOff === undefined || dayOff === null) return null
  try {
    const total = scheduleDayPatientTotal(dayOff, breakdown, scheduleDayCounts)
    return (
      <span className="portal-cal-strip__day-preview cl-date-nav__day-preview" role="tooltip">
        {scheduleDayPreviewLabel(dayOff, total)}
      </span>
    )
  } catch (e) {
    return null
  }
}

function ScheduleDatePicker({ off, onSelectDate, onClose, anchorRef }) {
  const selectedDate = useMemo(() => {
    const d = new Date()
    d.setDate(d.getDate() + off)
    d.setHours(12, 0, 0, 0)
    return d
  }, [off])

  const [viewYear, setViewYear] = useState(selectedDate.getFullYear())
  const [viewMonth, setViewMonth] = useState(selectedDate.getMonth())
  const popupRef = useRef(null)

  useEffect(() => {
    setViewYear(selectedDate.getFullYear())
    setViewMonth(selectedDate.getMonth())
  }, [selectedDate])

  useEffect(() => {
    const onDocClick = (e) => {
      if (popupRef.current?.contains(e.target)) return
      if (anchorRef?.current?.contains(e.target)) return
      onClose()
    }
    const t = setTimeout(() => document.addEventListener('mousedown', onDocClick), 0)
    return () => {
      clearTimeout(t)
      document.removeEventListener('mousedown', onDocClick)
    }
  }, [onClose, anchorRef])

  const firstDay = new Date(viewYear, viewMonth, 1)
  const startPad = firstDay.getDay()
  const daysInMonth = new Date(viewYear, viewMonth + 1, 0).getDate()
  const cells = []
  for (let i = 0; i < startPad; i++) cells.push(null)
  for (let d = 1; d <= daysInMonth; d++) cells.push(d)

  const monthLabel = new Date(viewYear, viewMonth, 1).toLocaleDateString('en-US', { month: 'long', year: 'numeric' })

  const prevMonth = () => {
    if (viewMonth === 0) {
      setViewMonth(11)
      setViewYear((y) => y - 1)
    } else {
      setViewMonth((m) => m - 1)
    }
  }

  const nextMonth = () => {
    if (viewMonth === 11) {
      setViewMonth(0)
      setViewYear((y) => y + 1)
    } else {
      setViewMonth((m) => m + 1)
    }
  }

  return (
    <div className="cl-calendar-popup" ref={popupRef} role="dialog" aria-label="Choose date">
      <div className="cl-calendar-popup__head">
        <button type="button" className="cl-calendar-popup__nav" onClick={prevMonth} aria-label="Previous month">
          ‹
        </button>
        <span className="cl-calendar-popup__month">{monthLabel}</span>
        <button type="button" className="cl-calendar-popup__nav" onClick={nextMonth} aria-label="Next month">
          ›
        </button>
      </div>
      <div className="cl-calendar-popup__weekdays" aria-hidden>
        {['Su', 'Mo', 'Tu', 'We', 'Th', 'Fr', 'Sa'].map((d) => (
          <span key={d}>{d}</span>
        ))}
      </div>
      <div className="cl-calendar-popup__grid">
        {cells.map((day, i) => {
          if (day === null) {
            return <span key={`empty-${i}`} className="cl-calendar-popup__cell cl-calendar-popup__cell--empty" aria-hidden />
          }
          const dayOff = daysOffsetFromToday(viewYear, viewMonth, day)
          const isToday = dayOff === 0
          const isSelected = dayOff === off
          return (
            <button
              key={day}
              type="button"
              className={`cl-calendar-popup__day${isToday ? ' cl-calendar-popup__day--today' : ''}${isSelected ? ' cl-calendar-popup__day--selected' : ''}`}
              onClick={() => onSelectDate(dayOff)}
            >
              {day}
            </button>
          )
        })}
      </div>
    </div>
  )
}

const CLINICIAN_TIPS = [
  'Start recording as soon as you enter the room — you can pause anytime.',
  'Pending notes appear under Notes when audio is still with the scribe.',
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

// Status labels — colors live in clinician.css (`.badge-*` classes).
const WITH_SCRIBE_LABEL = 'With Scribe'
const READY_FOR_REVIEW_LABEL = 'Ready for Review'

const ST = {
  'upcoming':           { label:'Upcoming' },
  'in-progress':        { label:'Recording' },
  processing:           { label: WITH_SCRIBE_LABEL },
  'recording-uploaded': { label: WITH_SCRIBE_LABEL },
  'note-ready':         { label: READY_FOR_REVIEW_LABEL },
  'uploaded':           { label:'Completed' },
  'done':               { label:'Completed' },
  submitted:            { label:'Scribe submitted' },
}

/** Schedule/Notes chip text only — never show legacy "Processing" or standalone "Review". */
function scheduleStatusDisplayLabel(status) {
  const label = ST[status]?.label
  if (label === 'Processing') return WITH_SCRIBE_LABEL
  if (label === 'Review') return READY_FOR_REVIEW_LABEL
  return label || ST.upcoming.label
}

function normalizeStatusBadgeLabel(label) {
  if (label === 'Review' || label === 'Ready for review') return READY_FOR_REVIEW_LABEL
  return label
}

function transcriptionStatusBadgeClass(txSt) {
  if (txSt === 'completed') return 'badge-completed'
  if (txSt === 'failed') return 'badge-overdue'
  return BADGE_WITH_SCRIBE_CLASS
}

function scheduleVisitBadgeClass(status) {
  switch (status) {
    case 'upcoming':
      return 'badge-upcoming'
    case 'note-ready':
      return 'badge-review'
    case 'uploaded':
    case 'done':
      return 'badge-completed'
    case 'recording-uploaded':
    case 'in-progress':
    case 'submitted':
      return BADGE_WITH_SCRIBE_CLASS
    default:
      return BADGE_WITH_SCRIBE_CLASS
  }
}

// Status priority for the Schedule "Sort: Status" option (lower = more urgent).
function scheduleStatusSortRank(v, off) {
  if (isScheduleVisitOverdue(v, off)) return 0 // Overdue
  switch (v.status) {
    case 'note-ready':
      return 1 // Ready for Review
    case 'processing':
    case 'recording-uploaded':
    case 'in-progress':
    case 'submitted':
      return 2 // With Scribe
    case 'upcoming':
      return 3 // Upcoming
    case 'uploaded':
    case 'done':
      return 4 // Completed
    default:
      return 3
  }
}

const NOTES_FILTER_TABS = [
  { key: 'all', label: 'All', tip: 'Show all encounters regardless of status' },
  { key: 'with-scribe', label: 'With Scribe', tip: 'Encounters where scribe is actively drafting the note' },
  {
    key: 'ready-for-review',
    label: READY_FOR_REVIEW_LABEL,
    tip: 'Notes completed by scribe and waiting for your review and signature',
  },
]

const NOTES_BADGE_META = {
  processing: { label: WITH_SCRIBE_LABEL, className: BADGE_WITH_SCRIBE_CLASS },
  ready: { label: READY_FOR_REVIEW_LABEL, className: 'badge-review' },
  completed: { label: 'Completed', className: 'badge-completed' },
  overdue: { label: 'Overdue', className: 'badge-overdue' },
  closed: { label: 'Visit Closed', className: 'badge-visit-closed' },
}

function NowDivider({ now }) {
  const label = now.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' })
  return (
    <div className="cl-now-divider" role="separator" aria-label={`Current time ${label}`}>
      <span className="cl-now-divider__line" aria-hidden />
      <span className="cl-now-divider__label">NOW · {label}</span>
      <span className="cl-now-divider__line" aria-hidden />
    </div>
  )
}

function StatusBadge({ label, className }) {
  const text = typeof label === 'string' ? normalizeStatusBadgeLabel(label) : label
  return <span className={`cl-status-badge ${className}`}>{text}</span>
}

/** True when the scribe has returned a final note (or QPS graded upload) — visit may still be `note-ready`. */
function clinicianNoteReturned(h) {
  const ns = h?.note_status
  return ns === 'submitted' || ns === 'uploaded'
}

/** Preview / view note only after scribe has uploaded (final note available). */
function canPreviewUploadedNote(h) {
  return !!(h?.final_note || clinicianNoteReturned(h))
}

/** Chip / display key for history rows (visit + note workflow). */
function historyRowDisplayStatus(h) {
  if (h.status === 'done') return 'done'
  if (h.status === 'uploaded') return 'uploaded'
  if (h.note_status === 'uploaded') return 'uploaded'
  if (h.note_status === 'submitted') return 'submitted'
  return h.status
}

function notesVisitHasRecording(h) {
  return !!(h?.audio_file && String(h.audio_file).trim() !== '')
}

function notesVisitAppointmentPast(h) {
  if (!h?.visit_date) return false
  const timePart = h.visit_time || '23:59:59'
  const normalizedTime = timePart.length === 5 ? `${timePart}:00` : timePart
  const appt = new Date(`${h.visit_date}T${normalizedTime}`)
  return !Number.isNaN(appt.getTime()) && appt < new Date()
}

/** Notes page card badge — rendering only; defaults to With Scribe when status is unknown. */
function notesCardBadgeKey(h) {
  if (!h) return 'processing'
  if (h.status === 'done') return 'closed'
  if (h.status === 'uploaded' || h.note_status === 'uploaded') return 'completed'
  if (h.status === 'note-ready') return 'ready'
  if (notesVisitAppointmentPast(h) && !notesVisitHasRecording(h)) return 'overdue'
  return 'processing'
}

function notesCardActionKind(h) {
  const key = notesCardBadgeKey(h)
  if (key === 'overdue' || h.status === 'upcoming') return null
  if (key === 'ready' || key === 'completed' || key === 'closed' || canPreviewUploadedNote(h)) {
    return 'review'
  }
  if (key === 'processing') return 'awaiting'
  return null
}

function isNoteDetailCompleted(note) {
  // A note is only "completed" (locked) when the clinician has locked it.
  // The "uploaded" status just means uploaded to EHR, not locked by clinician.
  return !!note?.locked_at
}

function isNoteDetailReadyForReview(note) {
  return note?.status === 'note-ready' && !isNoteDetailCompleted(note)
}

function notesWithScribeMatch(h) {
  return notesCardBadgeKey(h) === 'processing'
}

function notesReadyForReviewMatch(h) {
  return notesCardBadgeKey(h) === 'ready'
}

function notesCompletedMatch(h) {
  const key = notesCardBadgeKey(h)
  return key === 'completed' || key === 'closed'
}

function notesTabFilterMatch(h, tabKey) {
  switch (tabKey) {
    case 'with-scribe':
      return notesWithScribeMatch(h)
    case 'ready-for-review':
      return notesReadyForReviewMatch(h)
    default:
      return true
  }
}

function normalizeVisitType(type) {
  return String(type || '').trim().toLowerCase()
}

function notesEncounterTypeMatch(h, filterKey) {
  if (filterKey === 'all') return true
  const t = normalizeVisitType(h.visit_type)
  switch (filterKey) {
    case 'new-patient':
      return t === 'new patient'
    case 'follow-up':
      return t === 'follow-up' || t === 'follow up'
    case 'urgent-care':
      return t === 'urgent care'
    case 'telemedicine':
      return t === 'telemedicine' || t === 'virtual visit' || t === 'virtual'
    default:
      return true
  }
}

function notesScribeStatusMatch(h, filterKey) {
  if (filterKey === 'all') return true
  switch (filterKey) {
    case 'with-scribe':
      return notesWithScribeMatch(h)
    case 'ready-for-review':
      return notesReadyForReviewMatch(h)
    case 'completed':
      return h.status === 'uploaded' || h.status === 'done' || clinicianNoteReturned(h)
    default:
      return true
  }
}

function notesDateSortKey(h) {
  const date = h.visit_date || ''
  const time = h.visit_time || '00:00:00'
  const normalized = time.length === 5 ? `${time}:00` : time
  return `${date}T${normalized}`
}

function notesWaitingMs(h) {
  const raw = h?.note_updated_at || h?.updated_at || h?.created_at || h?.visit_date
  if (!raw) return 0
  const ms = Date.now() - new Date(raw).getTime()
  return Number.isNaN(ms) || ms < 0 ? 0 : ms
}

function sortNotesHistory(list, sortBy) {
  const sorted = [...list]
  switch (sortBy) {
    case 'date-oldest':
      return sorted.sort((a, b) => notesDateSortKey(a).localeCompare(notesDateSortKey(b)))
    case 'name-az':
      return sorted.sort((a, b) =>
        (a.patient_name || '').localeCompare(b.patient_name || '', undefined, { sensitivity: 'base' }),
      )
    case 'waiting-longest':
      return sorted.sort((a, b) => notesWaitingMs(b) - notesWaitingMs(a))
    case 'date-newest':
    default:
      return sorted.sort((a, b) => notesDateSortKey(b).localeCompare(notesDateSortKey(a)))
  }
}

const NOTES_ENCOUNTER_FILTER_OPTS = [
  { value: 'all', label: 'All Types' },
  { value: 'new-patient', label: 'New Patient' },
  { value: 'follow-up', label: 'Follow-up' },
  { value: 'urgent-care', label: 'Urgent Care' },
  { value: 'telemedicine', label: 'Telemedicine' },
]

const NOTES_SCRIBE_FILTER_OPTS = [
  { value: 'all', label: 'All Statuses' },
  { value: 'with-scribe', label: 'With Scribe' },
  { value: 'ready-for-review', label: READY_FOR_REVIEW_LABEL },
  { value: 'completed', label: 'Completed' },
]

const NOTES_SORT_OPTS = [
  { value: 'date-newest', label: 'Date (newest first)' },
  { value: 'date-oldest', label: 'Date (oldest first)' },
  { value: 'name-az', label: 'Patient Name (A-Z)' },
  { value: 'waiting-longest', label: 'Waiting Time (longest first)' },
]

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
      showToast?.('Your scribe team has received the recording.', 'success')
    } catch (e) {
      showToast?.(e.message || 'Could not send recording to scribe', 'error')
    } finally {
      setTxBusy(false)
    }
  }
  const txSt = visit?.transcription_status
  const txLabel =
    txSt === 'processing' ? 'Status: With Scribe'
      : txSt === 'completed' ? 'Status: Scribe draft ready'
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
          {txLabel ? <StatusBadge label={txLabel} className={transcriptionStatusBadgeClass(txSt)} /> : <span />}
          <button type="button" disabled={txBusy} onClick={runTx} style={{ marginLeft: 'auto', padding: '10px 16px', borderRadius: 10, border: 'none', background: 'linear-gradient(135deg,#4260E9,#7B61FF)', color: '#fff', fontSize: 13, fontWeight: 600, cursor: txBusy ? 'wait' : 'pointer', opacity: txBusy ? 0.7 : 1, fontFamily: 'inherit' }}>
            {txBusy ? 'Sending…' : 'Send to scribe'}
          </button>
        </div>
      </div>
    </div>
  )
}

// ─── NOTE PREVIEW MODAL ───────────────────────────────────────────────────────

function AIModal({ visit, onClose, showToast, hideAudioControls = false }) {
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
      showToast?.('Your scribe team has received the recording.', 'success')
      await loadNoteData()
    } catch (e) {
      showToast?.(e.message || 'Could not send recording to scribe', 'error')
    } finally {
      setTxBusy(false)
    }
  }

  const txSt = note?.transcription_status || visit?.transcription_status
  const txBadge =
    txSt === 'processing' ? 'Transcription: With Scribe'
      : txSt === 'completed' ? 'Transcription: Scribe draft ready'
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
    <div
      style={{ position:'fixed', inset:0, background:'rgba(0,0,0,0.6)', zIndex:800, display:'flex', alignItems:'center', justifyContent:'center', padding:16 }}
      onClick={onClose}
      role="presentation"
    >
      <div
        style={{ background:'#fff', borderRadius:20, width:'100%', maxWidth:700, maxHeight:'92vh', display:'flex', flexDirection:'column', boxShadow:'0 24px 64px rgba(0,0,0,0.25)' }}
        onClick={(e) => e.stopPropagation()}
        role="dialog"
        aria-modal="true"
      >
        <div style={{ padding:'20px 24px', borderBottom:'1px solid #E2E8F0', display:'flex', justifyContent:'space-between', alignItems:'flex-start', gap: 12 }}>
          <div>
            <div style={{ fontSize:17, fontWeight:700, color:'#1E293B' }}>📋 Note Preview</div>
            <div style={{ fontSize:13, color:'#94A3B8', marginTop:3 }}>{visit.patient_name} · {visit.visit_type}</div>
          </div>
          <div style={{ display:'flex', flexDirection:'column', alignItems:'flex-end', gap: 10 }}>
            <div style={{ display:'flex', flexWrap:'wrap', alignItems:'center', gap: 8, justifyContent:'flex-end' }}>
              {!hideAudioControls && txBadge ? (
                <StatusBadge label={txBadge} className={transcriptionStatusBadgeClass(txSt)} />
              ) : null}
              {!hideAudioControls && visit.audio_file ? (
                <button type="button" disabled={txBusy || loading} onClick={runTx} style={{ padding: '8px 14px', borderRadius: 10, border: 'none', background: 'linear-gradient(135deg,#4260E9,#7B61FF)', color: '#fff', fontSize: 12, fontWeight: 600, cursor: txBusy ? 'wait' : 'pointer', opacity: txBusy ? 0.75 : 1, fontFamily: 'inherit' }}>
                  {txBusy ? 'Sending…' : 'Send to scribe'}
                </button>
              ) : null}
              <button type="button" onClick={onClose} style={{ background:'#E2E8F0', border:'none', borderRadius:10, padding:'8px 16px', cursor:'pointer', fontSize:13, fontWeight:600, color:'#64748B', fontFamily: 'inherit' }}>✕</button>
            </div>
          </div>
        </div>
        {!hideAudioControls ? (
          <div style={{ display:'flex', borderBottom:'1px solid #E2E8F0', padding:'0 24px' }}>
            {[['ai','Scribe draft'],['transcription','Transcript']].map(([k,l]) => (
              <button key={k} onClick={() => setTab(k)} style={{ padding:'12px 0', marginRight:24, fontSize:14, fontWeight: tab===k ? 700 : 400, color: tab===k ? '#4260E9' : '#94A3B8', background:'none', border:'none', borderBottom: tab===k ? '2px solid #4260E9' : '2px solid transparent', cursor:'pointer', fontFamily:'inherit' }}>{l}</button>
            ))}
          </div>
        ) : null}
        <div style={{ flex:1, overflowY:'auto', padding:'20px 24px' }}>
          {loading ? (
            <div style={{ textAlign:'center', padding:60, color:'#94A3B8' }}>Loading note...</div>
          ) : tab === 'ai' || hideAudioControls ? (
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
              <div style={{ textAlign:'center', padding:60, color:'#94A3B8' }}>Your scribe team is preparing the transcript.</div>
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

const REVIEW_REMINDER_DISMISS_KEY = 'anot_cl_review_reminder_dismissed'

function ReviewReminderToast({ count, oldestHours, onReview, onDismiss }) {
  return (
    <div className="cl-review-reminder" role="alert" aria-live="polite">
      <p className="cl-review-reminder__text">
        You have {count} note{count !== 1 ? 's' : ''} ready for review. The oldest has been waiting {oldestHours}h.
      </p>
      <div className="cl-review-reminder__actions">
        <button type="button" className="cl-review-reminder__cta" onClick={onReview}>
          Review Now
        </button>
        <button type="button" className="cl-review-reminder__close" onClick={onDismiss} aria-label="Dismiss reminder">
          ✕
        </button>
      </div>
    </div>
  )
}

// ─── SIDEBAR ──────────────────────────────────────────────────────────────────

function Sidebar({ screen, setScreen, sidebar, currentUser, scheduleUpcomingBadge, readyForReviewCount, drawerMode, onRequestLogout, confirmDialog, confirmLoading, onDismissConfirm, onConfirmAction, branding }) {
  const offCanvasSidebar = useSidebarOffCanvasMode()
  const NAV = [
    { key:'schedule', label:'Schedule', icon:'📅', badge: scheduleUpcomingBadge, badgeVariant: 'schedule' },
    { key:'notes',    label:'Notes',    icon:'📝', badge: readyForReviewCount, badgeVariant: 'urgent' },
    { key:'contact',  label:'Contact Us', icon:'💬' },
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
        className={`sf-sidebar sf-sidebar--rich adm-sidebar cl-sidebar${sidebar.open ? ' open' : ''}`}
        aria-hidden={portalSidebarAriaHidden(offCanvasSidebar, sidebar.open)}
      >
        <div className="cl-sidebar__header sf-sidebar-top sf-sidebar-rich__top">
          <button
            type="button"
            className="cl-sidebar__close"
            onClick={() => sidebar.close()}
            aria-label="Close navigation menu"
          >
            ✕
          </button>
          <PortalSidebarBrand branding={branding} subtitle="Clinician Portal" />
        </div>
        <div className="cl-sidebar__body">
          <p className="sf-sidebar-rich__nav-label">Workspace</p>
          <nav className="sf-nav sf-sidebar-rich__nav" aria-label="Main">
            {NAV.map(({ key, label, icon, badge: navBadge, badgeVariant }) => (
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
                {navBadge > 0 ? (
                  <span className={`sf-sidebar-rich__nav-badge sf-sidebar-rich__nav-badge--${badgeVariant}`}>
                    {navBadge}
                  </span>
                ) : null}
              </div>
            ))}
          </nav>
        </div>
        <div className="cl-sidebar__fill" aria-hidden="true" />
        <div className="cl-sidebar__bottom">
          <PortalSidebarFooter
            userName={currentUser.name || 'Clinician'}
            role="clinician"
            onLogout={onRequestLogout}
          />
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
        <SystemProfileManager showToast={showToast} roleLabel="Clinician" compact readOnly />
      </div>
      <div className="sf-card sf-card-lg" style={{ marginTop: 16 }}>
        <div className="sf-card__title">Note templates</div>
        <p style={{ margin: '0 0 16px', fontSize: 13, color: '#64748b', lineHeight: 1.55 }}>
          Structured starters for common visit types — saved locally in this browser.
        </p>
        <TemplatesScreen showToast={showToast} />
      </div>
    </>
  )
}

/** Stable topbar (must not be defined inside Clinician — live clock re-renders every second). */
function ClinicianTopbar({
  drawerMode,
  sidebar,
  branding,
  cu,
  onViewProfile,
  onLogout,
  title,
  subtitle,
  belowTitle,
  children,
}) {
  const titleRow = belowTitle ? (
    <div className="adm-topbar__titles cl-topbar__titles">
      <div className="adm-topbar__module">{title || 'Clinician'}</div>
      {belowTitle}
      {subtitle ? <div className="adm-topbar__brand">{subtitle}</div> : null}
    </div>
  ) : undefined

  return (
    <PortalTopbar
      drawerMode={drawerMode}
      sidebarOpen={sidebar.open}
      onMenuClick={sidebar.toggle}
      moduleTitle={titleRow ? undefined : (title || 'Clinician')}
      brandName={titleRow ? undefined : (subtitle || branding.system_name || 'Anot')}
      titleRow={titleRow}
      user={cu}
      avatarFallback="C"
      navControlsId="clinician-sidebar"
      onViewProfile={onViewProfile}
      onLogout={onLogout}
      menuId="clinician-account-menu"
      accountMenuVariant="clinician"
      endBeforeAccount={
        children ? (
          <div className="cl-schedule-toolbar">
            {children}
          </div>
        ) : null
      }
    />
  )
}

// ─── BUTTON STYLES ────────────────────────────────────────────────────────────

const B = {
  primary: { display:'inline-flex', alignItems:'center', gap:8, padding:'10px 20px', borderRadius:12, background:'linear-gradient(135deg,#4260E9,#7B61FF)', color:'#fff', border:'none', fontSize:14, fontWeight:700, cursor:'pointer', fontFamily:'inherit', boxShadow:'0 4px 14px rgba(66,96,233,.35)' },
  outline: { display:'inline-flex', alignItems:'center', gap:8, padding:'10px 20px', borderRadius:12, background:'#fff', color:'#475569', border:'1.5px solid #E2E8F0', fontSize:14, fontWeight:600, cursor:'pointer', fontFamily:'inherit' },
  action:  { display:'inline-flex', alignItems:'center', gap:6, padding:'9px 16px', borderRadius:10, fontSize:13, fontWeight:700, cursor:'pointer', border:'none', fontFamily:'inherit', whiteSpace:'nowrap' },
  small:   { padding:'7px 14px', borderRadius:10, fontSize:13, fontWeight:700, cursor:'pointer', fontFamily:'inherit' },
}

// ─── MAIN COMPONENT ───────────────────────────────────────────────────────────

export default function ClinicianWithErrorBoundary() {
  return (
    <ErrorBoundary portalName="Clinician portal" fallback={<PortalCrashFallback />}>
      <Clinician />
    </ErrorBoundary>
  )
}

function Clinician() {
  const navigate    = useNavigate()
  const cu          = getCurrentUser()
  const sidebar     = useSidebar()
  const sessionTimeoutModal = useSessionTimeout(!!cu && Object.keys(cu).length > 0)

  const [screen, setScreenState]    = useState('schedule')
  const [scheduleDate, setScheduleDate] = useState(() => new Date())
  const off = useMemo(() => scheduleOffFromDate(scheduleDate), [scheduleDate])
  const [weekCenterOff, setWeekCenterOff] = useState(0)
  const [calendarOpen, setCalendarOpen] = useState(false)
  const [scheduleSort, setScheduleSort] = useState('time')
  const calendarBtnRef = useRef(null)

  const applyScheduleOff = useCallback((valueOrFn) => {
    setScheduleDate((prev) => {
      const currentOff = scheduleOffFromDate(prev)
      const nextOff = typeof valueOrFn === 'function' ? valueOrFn(currentOff) : valueOrFn
      const d = normalizeScheduleDay(new Date())
      d.setDate(d.getDate() + nextOff)
      return d
    })
  }, [])

  const [visits, setVisits]         = useState([])
  const sortedVisits = useMemo(() => {
    const list = [...visits]
    const byTime = (a, b) =>
      visitMinutesFromMidnight(a.visit_time) - visitMinutesFromMidnight(b.visit_time)
    if (scheduleSort === 'name') {
      return list.sort((a, b) =>
        (a.patient_name || '').localeCompare(b.patient_name || '', undefined, { sensitivity: 'base' }),
      )
    }
    if (scheduleSort === 'status') {
      return list.sort((a, b) => {
        const rank = scheduleStatusSortRank(a, off) - scheduleStatusSortRank(b, off)
        return rank !== 0 ? rank : byTime(a, b)
      })
    }
    return list.sort(byTime)
  }, [visits, scheduleSort, off])
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
  const [editingNote, setEditingNote] = useState(false)
  const [editedNoteContent, setEditedNoteContent] = useState('')
  const [savingNote, setSavingNote] = useState(false)
  const [aiVisit, setAiVisit]       = useState(null)
  const [aiVisitFromNotes, setAiVisitFromNotes] = useState(false)
  const [playVisit, setPlayVisit]   = useState(null)
  const [histQ, setHistQ]           = useState('')
  const [histDateFromInput, setHistDateFromInput] = useState('')
  const [histDateToInput, setHistDateToInput] = useState('')
  const [histDateFrom, setHistDateFrom] = useState('')
  const [histDateTo, setHistDateTo] = useState('')
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
  const [notesFilter, setNotesFilter]           = useState('all')
  const [notesTypeFilter, setNotesTypeFilter]   = useState('all')
  const [notesScribeFilter, setNotesScribeFilter] = useState('all')
  const [notesSortBy, setNotesSortBy]           = useState('date-newest')
  const [notesFiltersOpen, setNotesFiltersOpen] = useState(false)

  const resetNotesViewDefaults = useCallback(() => {
    setNotesFilter('all')
    setNotesTypeFilter('all')
    setNotesScribeFilter('all')
    setNotesSortBy('date-newest')
  }, [])

  const setScreen = useCallback((key) => {
    if (key === 'schedule' && screen !== 'schedule') {
      setScheduleDate(new Date())
      setWeekCenterOff(0)
    }
    if (key === 'notes') {
      resetNotesViewDefaults()
    }
    setReview(null)
    setAiVisit(null)
    setAiVisitFromNotes(false)
    setScreenState(key)
  }, [screen, resetNotesViewDefaults])

  const [scheduleDayCounts, setScheduleDayCounts] = useState({})
  const [scheduleDayBreakdown, setScheduleDayBreakdown] = useState({})
  const [todayUpcomingCount, setTodayUpcomingCount] = useState(0)
  const [reviewReminder, setReviewReminder]     = useState(null)

  const drawerMode = usePortalDrawerMode()
  const branding = useBranding()

  const tRef  = useRef(null), mRef  = useRef(null), cRef  = useRef([])
  const atRef = useRef(null), arRef = useRef(null), acRef = useRef([])
  const visitsAbortRef = useRef(null)
  const historyAbortRef = useRef(null)

  // Release the microphone and stop any in-flight recorder when the portal
  // unmounts (route change / logout). Without this the mic stays live (red
  // recording indicator) and the MediaStream leaks after the user signs out.
  // Also cancel in-flight schedule/history loads so they cannot setState after
  // unmount or resolve out of order.
  useEffect(() => {
    return () => {
      clearInterval(tRef.current)
      clearInterval(atRef.current)
      for (const rec of [mRef.current, arRef.current]) {
        try {
          if (rec && rec.state !== 'inactive') {
            rec.onstop = null
            rec.ondataavailable = null
            rec.stop()
          }
          rec?.stream?.getTracks().forEach((t) => t.stop())
        } catch { /* recorder already torn down */ }
      }
      mRef.current = null
      arRef.current = null
      cRef.current = []
      acRef.current = []
      visitsAbortRef.current?.abort()
      historyAbortRef.current?.abort()
    }
  }, [])

  const scheduleDays = useMemo(() => [-2, -1, 0, 1, 2].map((d) => weekCenterOff + d), [weekCenterOff])

  const shiftScheduleOff = (delta) => {
    applyScheduleOff((prev) => {
      const next = prev + delta
      setWeekCenterOff((wc) => {
        if (next < wc - 2 || next > wc + 2) return next
        return wc
      })
      return next
    })
  }

  const goToScheduleDate = (pickedOff) => {
    applyScheduleOff(pickedOff)
    setWeekCenterOff(pickedOff)
    setCalendarOpen(false)
  }

  const goToToday = () => {
    setScheduleDate(new Date())
    setWeekCenterOff(0)
  }

  const goRecordOverdueFromNotes = useCallback((h) => {
    const visitDate = h?.visit_date ? String(h.visit_date).slice(0, 10) : null
    if (visitDate && /^\d{4}-\d{2}-\d{2}$/.test(visitDate)) {
      const [y, m, day] = visitDate.split('-').map((n) => parseInt(n, 10))
      const d = new Date()
      d.setFullYear(y, m - 1, day, 12, 0, 0, 0)
      setScheduleDate(d)
      setWeekCenterOff(scheduleOffFromDate(d))
    } else {
      setScheduleDate(new Date())
      setWeekCenterOff(0)
    }
    setReview(null)
    setAiVisit(null)
    setAiVisitFromNotes(false)
    setScreenState('schedule')
  }, [])

  const showToast = (msg, type = 'success') => { setToast({ msg, type }); setTimeout(() => setToast(null), 3500) }
  const [confirmDialog, setConfirmDialog] = useState(null)
  const [confirmLoading, setConfirmLoading] = useState(false)
  const [lockConfirmOpen, setLockConfirmOpen] = useState(false)
  const [lockConfirmLoading, setLockConfirmLoading] = useState(false)

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

  const loadVisits = async (opts = {}) => {
    // Cancel any in-flight schedule load so a slow response for a previous day
    // can't overwrite the day the user just switched to.
    visitsAbortRef.current?.abort()
    const controller = new AbortController()
    visitsAbortRef.current = controller
    const dayKey = localDate(off)
    try {
      setLoading(true)
      const d = await visitsAPI.getByDate(dayKey, controller.signal)
      if (controller.signal.aborted) return
      setVisits(d.visits || [])
      setScheduleDayCounts((prev) => ({
        ...prev,
        [dayKey]: (d.visits || []).length,
      }))
      setScheduleDayBreakdown((prev) => ({
        ...prev,
        [dayKey]: scheduleDayStatusBreakdown(d.visits || [], off),
      }))
      setScheduleSyncedAt(new Date().toISOString())
      if (opts.notify) showToast('Schedule updated')
    } catch (e) {
      if (isAbortError(e) || controller.signal.aborted) return
      showToast(e.message, 'error')
    } finally {
      if (visitsAbortRef.current === controller) {
        visitsAbortRef.current = null
        setLoading(false)
      }
    }
  }

  const loadHistory = async (opts = {}) => {
    historyAbortRef.current?.abort()
    const controller = new AbortController()
    historyAbortRef.current = controller
    try {
      if (!opts.silent) setLoading(true)
      const d = await visitsAPI.getHistory(controller.signal)
      if (controller.signal.aborted) return
      setHistory(d.visits || [])
      setHistorySyncedAt(new Date().toISOString())
      if (opts.notify) showToast('History updated')
    } catch (e) {
      if (isAbortError(e) || controller.signal.aborted) return
      if (!opts.silent) showToast(e.message, 'error')
    } finally {
      if (historyAbortRef.current === controller) {
        historyAbortRef.current = null
        if (!opts.silent) setLoading(false)
      }
    }
  }

  useEffect(() => {
    const id = setInterval(() => setLiveNow(new Date()), 1000)
    return () => clearInterval(id)
  }, [])

  useEffect(() => {
    return installOfflineUploadFlush(() =>
      flushPendingAudioUploads({
        uploadPrimary: (visitId, blob) => visitsAPI.uploadAudio(visitId, blob),
        uploadAppend: (visitId, blob) => visitsAPI.appendAudio(visitId, blob),
        onSuccess: () => showToast('Queued recording uploaded successfully'),
      }),
    )
  }, [])

  useEffect(() => {
    const onKey = (e) => {
      const t = e.target
      if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.tagName === 'SELECT' || t.isContentEditable)) return
      if (screen === 'schedule' && e.key === 't' && !e.metaKey && !e.ctrlKey && !e.altKey) {
        e.preventDefault()
        goToToday()
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [screen])

  useEffect(() => {
    goToToday()
  }, [])

  useEffect(() => { loadHistory({ silent: true }) }, [])
  useEffect(() => { if (screen === 'schedule') loadVisits() }, [off, screen])
  useEffect(() => {
    if (screen !== 'schedule') return
    setScheduleDayCounts((prev) => ({
      ...prev,
      [localDate(off)]: visits.length,
    }))
    setScheduleDayBreakdown((prev) => ({
      ...prev,
      [localDate(off)]: scheduleDayStatusBreakdown(visits, off),
    }))
  }, [visits, off, screen])
  useEffect(() => {
    if (screen === 'notes') loadHistory()
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

  useEffect(() => {
    const todayKey = localDate(0)
    if (off === 0) {
      setTodayUpcomingCount(visits.filter((v) => v.status === 'upcoming').length)
      return
    }
    const breakdown = scheduleDayBreakdown[todayKey]
    if (breakdown && typeof breakdown.upcoming === 'number') {
      setTodayUpcomingCount(breakdown.upcoming)
    }
  }, [visits, off, scheduleDayBreakdown])

  const scheduleUpcomingBadge = useMemo(() => {
    const todayKey = localDate(0)
    if (off === 0) {
      return visits.filter((v) => v.status === 'upcoming').length
    }
    const breakdown = scheduleDayBreakdown[todayKey]
    if (breakdown && typeof breakdown.upcoming === 'number') {
      return breakdown.upcoming
    }
    return todayUpcomingCount
  }, [off, visits, scheduleDayBreakdown, todayUpcomingCount])

  const readyForReviewCount = useMemo(
    () => history.filter(notesReadyForReviewMatch).length,
    [history],
  )

  const goToReadyForReview = useCallback(() => {
    setNotesFilter('ready-for-review')
    setNotesScribeFilter('all')
    setScreenState('notes')
    sidebar.close()
  }, [sidebar])

  const dismissReviewReminder = useCallback(() => {
    sessionStorage.setItem(REVIEW_REMINDER_DISMISS_KEY, '1')
    setReviewReminder(null)
  }, [])

  useEffect(() => {
    if (sessionStorage.getItem(REVIEW_REMINDER_DISMISS_KEY)) return
    const ready = history.filter(notesReadyForReviewMatch)
    if (!ready.length) return
    const hasWaitingOver24h = ready.some((h) => notesWaitingMs(h) >= 24 * 3600000)
    if (!hasWaitingOver24h) return
    const oldestHours = Math.floor(Math.max(...ready.map(notesWaitingMs)) / 3600000)
    setReviewReminder((prev) => {
      if (prev) return prev
      return { count: readyForReviewCount, oldestHours }
    })
  }, [history, readyForReviewCount])

  useEffect(() => {
    if (!reviewReminder) return
    if (sessionStorage.getItem(REVIEW_REMINDER_DISMISS_KEY)) {
      setReviewReminder(null)
      return
    }
    const timer = setTimeout(() => setReviewReminder(null), 10000)
    return () => clearTimeout(timer)
  }, [reviewReminder])

  useEffect(() => {
    document.title = readyForReviewCount > 0
      ? `(${readyForReviewCount}) Anot — Clinician Portal`
      : 'Anot — Clinician Portal'
    return () => {
      document.title = 'Anot — Clinician Portal'
    }
  }, [readyForReviewCount])

  // Prefer OGG Opus (smallest files, fastest upload), then WebM Opus, then plain WebM.
  const getMime = () => {
    const candidates = ['audio/ogg;codecs=opus', 'audio/webm;codecs=opus', 'audio/webm']
    return candidates.find((x) => MediaRecorder.isTypeSupported(x)) || ''
  }

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
              try {
                const b = new Blob(cRef.current, { type: rec.mimeType || 'audio/webm' })
                await visitsAPI.uploadAudio(vid, b)
              } catch (err) {
                console.error(err)
                try {
                  const b = new Blob(cRef.current, { type: rec.mimeType || 'audio/webm' })
                  await queueAudioUpload({ visitId: vid, blob: b, mode: 'primary' })
                  showToast('Upload failed — recording saved and will retry when online.', 'error')
                } catch (qErr) {
                  console.error(qErr)
                  showToast('Upload failed. Check your connection and try again.', 'error')
                }
              }
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
      if (screen === 'notes') loadHistory()
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
            try {
              const b = new Blob(acRef.current, { type: arRef.current.mimeType || 'audio/webm' })
              await visitsAPI.appendAudio(vid, b)
              showToast('✓ Additional recording uploaded')
            } catch (err) {
              console.error(err)
              try {
                const b = new Blob(acRef.current, { type: arRef.current.mimeType || 'audio/webm' })
                await queueAudioUpload({ visitId: vid, blob: b, mode: 'append' })
                showToast('Upload failed — saved locally and will retry when online.', 'error')
              } catch {
                showToast('Upload failed', 'error')
              }
            }
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

  const historyDateFiltered = (() => {
    let base = histAudioOnly
      ? history.filter((h) => h.audio_file && String(h.audio_file).trim() !== '')
      : history
    return base.filter((h) => notesMatchesDateRange(h, histDateFrom, histDateTo))
  })()

  const notesTabCount = (key) => {
    if (key === 'all') return historyDateFiltered.length
    return historyDateFiltered.filter((h) => notesTabFilterMatch(h, key)).length
  }

  const historyFiltered = (() => {
    let base =
      notesFilter === 'all'
        ? historyDateFiltered
        : historyDateFiltered.filter((h) => notesTabFilterMatch(h, notesFilter))
    base = base.filter((h) => notesEncounterTypeMatch(h, notesTypeFilter))
    base = base.filter((h) => notesScribeStatusMatch(h, notesScribeFilter))
    if (histQ) {
      const q = histQ.toLowerCase()
      base = base.filter((h) => h.patient_name?.toLowerCase().includes(q) || h.mrn?.toLowerCase().includes(q))
    }
    return sortNotesHistory(base, notesSortBy)
  })()

  const notesDateRangeActive = !!(histDateFrom || histDateTo)
  const notesActiveFilterCount =
    (notesDateRangeActive ? 1 : 0) +
    (notesTypeFilter !== 'all' ? 1 : 0) +
    (notesScribeFilter !== 'all' ? 1 : 0) +
    (notesSortBy !== 'date-newest' ? 1 : 0)

  const historyTitle = 'Notes'
  const historySubtitle = (() => {
    const tabCount = notesTabCount(notesFilter)
    const countLabel = `${tabCount} encounter${tabCount !== 1 ? 's' : ''}`
    const refreshed = historySyncedAt ? ` · Refreshed ${formatSyncedLabel(historySyncedAt)}` : ''
    switch (notesFilter) {
      case 'with-scribe':
        return `With scribe · ${countLabel}${refreshed}`
      case 'ready-for-review':
        return `Ready for review · ${countLabel}${refreshed}`
      case 'all':
      default:
        return `Full timeline · ${countLabel}${refreshed}`
    }
  })()

  const openProfile = () => {
    setReview(null)
    setAiVisit(null)
    setAiVisitFromNotes(false)
    setScreenState('profile')
    sidebar.close()
  }

  const openNoteDetail = async (visitRow) => {
    try {
      const d = await notesAPI.getByVisit(visitRow.id)
      sidebar.close()
      setReview({
        ...visitRow,
        final_note: d.note?.final_note,
        note_id: d.note?.id,
        scribe_name: d.note?.scribe_name || visitRow.scribe_name,
        note_status: d.note?.status ?? visitRow.note_status,
        locked_at: d.note?.locked_at ?? visitRow.locked_at,
      })
    } catch {
      showToast('Failed to load note', 'error')
    }
  }

  const openNoteFromCard = (h) => openNoteDetail(h)

  const startEditingNote = () => {
    setEditedNoteContent(reviewNote.final_note || '')
    setEditingNote(true)
  }

  const cancelEditingNote = () => {
    setEditingNote(false)
    setEditedNoteContent('')
  }

  const saveEditedNote = async () => {
    if (!reviewNote?.note_id) return
    setSavingNote(true)
    try {
      const data = await notesAPI.updateNote(reviewNote.note_id, editedNoteContent)
      setReview((prev) => ({
        ...prev,
        final_note: editedNoteContent,
      }))
      setHistory((prev) =>
        prev.map((v) =>
          v.id === reviewNote.id
            ? { ...v, final_note: editedNoteContent }
            : v
        )
      )
      setEditingNote(false)
      showToast('Note updated successfully')
    } catch (err) {
      showToast(err.message || 'Failed to update note', 'error')
    } finally {
      setSavingNote(false)
    }
  }

  const closeNoteDetail = () => {
    setLockConfirmOpen(false)
    setReview(null)
    setEditingNote(false)
    setEditedNoteContent('')
  }

  const confirmLockNote = async () => {
    if (!reviewNote?.id) return
    setLockConfirmLoading(true)
    try {
      const d = await visitsAPI.lockNote(reviewNote.id)
      const updated = d.visit || {}
      setReview((prev) => ({
        ...prev,
        status: updated.status || 'uploaded',
        note_status: updated.note_status || 'uploaded',
        locked_at: updated.locked_at || new Date().toISOString(),
      }))
      setHistory((prev) =>
        prev.map((v) =>
          v.id === reviewNote.id
            ? {
                ...v,
                status: updated.status || 'uploaded',
                note_status: updated.note_status || 'uploaded',
                locked_at: updated.locked_at,
              }
            : v
        )
      )
      setLockConfirmOpen(false)
      showToast('Note locked and marked as completed')
    } catch (e) {
      showToast(e.message, 'error')
    } finally {
      setLockConfirmLoading(false)
    }
  }

  const sidebarProps = {
    screen,
    setScreen,
    sidebar,
    currentUser: cu,
    scheduleUpcomingBadge,
    readyForReviewCount,
    drawerMode,
    branding,
    onRequestLogout: requestLogout,
    confirmDialog,
    confirmLoading,
    onDismissConfirm: () => !confirmLoading && setConfirmDialog(null),
    onConfirmAction: runConfirm,
  }

  const reviewReminderBanner = reviewReminder ? (
    <ReviewReminderToast
      count={reviewReminder.count}
      oldestHours={reviewReminder.oldestHours}
      onReview={() => {
        goToReadyForReview()
        dismissReviewReminder()
      }}
      onDismiss={dismissReviewReminder}
    />
  ) : null

  if (screen === 'contact') {
    return (
      <div className="sf-page sf-portal adm-shell cl-clinician-shell cl-portal">
        <Sidebar {...sidebarProps} />
        <div className="sf-main sf-portal__main">
          <Overlay open={sidebar.open} onClick={sidebar.close} className="adm-shell-overlay" />
          {reviewReminderBanner}
          <PortalTopbar
            drawerMode={drawerMode}
            sidebarOpen={sidebar.open}
            onMenuClick={sidebar.toggle}
            navControlsId="clinician-sidebar"
            moduleTitle="Contact Us"
            brandName=""
            user={cu}
            avatarFallback="C"
            onViewProfile={openProfile}
            onLogout={requestLogout}
            menuId="clinician-account-menu"
            accountMenuVariant="clinician"
          />
          <div className="sf-body cl-contact-body">
            <ContactScreen currentUser={cu} showToast={showToast} />
          </div>
          {toast && <Toast toast={toast} />}
        </div>
      </div>
    )
  }

  if (screen === 'profile') {
    const pendingEnc = history.filter((h) => ['recording-uploaded', 'note-ready'].includes(h.status)).length
    const completedEnc = history.filter(
      (h) => ['uploaded', 'done'].includes(h.status) || clinicianNoteReturned(h),
    ).length
    const todayEnc = visits.length
    const encDayLabel = off === 0 ? 'Encounters today' : `Encounters · ${localDate(off)}`
    return (
      <div className="sf-page sf-portal adm-shell cl-clinician-shell cl-portal">
        <Sidebar {...sidebarProps} />
        <div className="sf-main sf-portal__main">
          <Overlay open={sidebar.open} onClick={sidebar.close} className="adm-shell-overlay" />
          {reviewReminderBanner}
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
            accountMenuVariant="clinician"
          />
          <div className="sf-body">
            <div className="sf-card sf-card-lg">
              <div className="sf-card__title">My activity</div>
              <div className="sf-metric-grid">
                {[
                  [encDayLabel, todayEnc, '#4260E9'],
                  ['With Scribe', pendingEnc, '#FFB547'],
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

  // ── Main layout ────────────────────────────────────────────────────────────

  return (
    <div className="sf-page sf-portal adm-shell cl-clinician-shell cl-portal">
      {sessionTimeoutModal}
      <Sidebar {...sidebarProps} />
      <div className="sf-main sf-portal__main">
        <Overlay open={sidebar.open} onClick={sidebar.close} className="adm-shell-overlay" />

        {reviewReminderBanner}

        {reviewNote ? (
          <>
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
              accountMenuVariant="clinician"
              moduleTitle=""
              brandName={branding.system_name || 'Anot'}
              titleRow={
                <div style={{ display: 'flex', alignItems: 'center', gap: 12, minWidth: 0, flex: 1 }}>
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
              <button type="button" className="cl-note-detail-back" onClick={closeNoteDetail}>
                ← Back to Notes
              </button>
              
              <div className="cl-note-detail-header">
                <div className="cl-note-detail-chip">
                  <span className="cl-note-detail-chip__icon" aria-hidden>📄</span>
                  <span className="cl-note-detail-chip__label">
                    Final Note — {reviewNote.scribe_name || 'Scribe'}
                  </span>
                  {isNoteDetailCompleted(reviewNote) ? (
                    <span className="cl-note-detail-chip__lock" title="Locked" aria-label="Locked">🔒</span>
                  ) : null}
                </div>
              </div>

              {/* Action Bar - Always visible for unlocked notes */}
              {!isNoteDetailCompleted(reviewNote) && (
                <div style={{
                  display: 'flex',
                  gap: '12px',
                  padding: '16px',
                  background: '#F9FAFB',
                  borderRadius: '12px',
                  marginBottom: '16px',
                  border: '1px solid #E5E7EB',
                  flexWrap: 'wrap',
                  alignItems: 'center',
                }}>
                  {editingNote ? (
                    <>
                      <button
                        type="button"
                        style={{
                          padding: '10px 20px',
                          borderRadius: '8px',
                          border: '1px solid #D1D5DB',
                          background: 'white',
                          color: '#374151',
                          fontWeight: 600,
                          fontSize: '14px',
                          cursor: 'pointer',
                        }}
                        onClick={cancelEditingNote}
                        disabled={savingNote}
                      >
                        Cancel
                      </button>
                      <button
                        type="button"
                        style={{
                          padding: '10px 20px',
                          borderRadius: '8px',
                          border: 'none',
                          background: '#10B981',
                          color: 'white',
                          fontWeight: 600,
                          fontSize: '14px',
                          cursor: savingNote ? 'not-allowed' : 'pointer',
                          opacity: savingNote ? 0.6 : 1,
                        }}
                        onClick={saveEditedNote}
                        disabled={savingNote}
                      >
                        {savingNote ? 'Saving...' : '💾 Save Changes'}
                      </button>
                    </>
                  ) : (
                    <>
                      <button
                        type="button"
                        style={{
                          padding: '10px 20px',
                          borderRadius: '8px',
                          border: 'none',
                          background: '#3B82F6',
                          color: 'white',
                          fontWeight: 600,
                          fontSize: '14px',
                          cursor: 'pointer',
                        }}
                        onClick={startEditingNote}
                      >
                        ✏️ Edit Note
                      </button>
                      
                      <button
                        type="button"
                        style={{
                          padding: '10px 20px',
                          borderRadius: '8px',
                          border: 'none',
                          background: '#10B981',
                          color: 'white',
                          fontWeight: 600,
                          fontSize: '14px',
                          cursor: 'pointer',
                        }}
                        onClick={() => setLockConfirmOpen(true)}
                      >
                        🔒 Lock Note
                      </button>
                      
                      {!editReq[reviewNote.note_id] ? (
                        <button
                          type="button"
                          style={{
                            padding: '10px 20px',
                            borderRadius: '8px',
                            border: '1px solid #D1D5DB',
                            background: 'white',
                            color: '#374151',
                            fontWeight: 600,
                            fontSize: '14px',
                            cursor: 'pointer',
                          }}
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
                          ↩️ Request Edit from Scribe
                        </button>
                      ) : (
                        <span style={{
                          padding: '8px 16px',
                          borderRadius: '8px',
                          background: '#FEF3C7',
                          color: '#92400E',
                          fontSize: '13px',
                          fontWeight: 600,
                        }}>
                          ✓ Edit Requested
                        </span>
                      )}
                    </>
                  )}
                </div>
              )}

              <div className="sf-note-card">
                {editingNote ? (
                  <textarea
                    className="sf-textarea"
                    style={{
                      width: '100%',
                      minHeight: '400px',
                      fontFamily: 'ui-monospace, monospace',
                      fontSize: '13px',
                      lineHeight: '1.6',
                      padding: '16px',
                      border: '2px solid #4F46E5',
                      borderRadius: '8px',
                      resize: 'vertical',
                    }}
                    value={editedNoteContent}
                    onChange={(e) => setEditedNoteContent(e.target.value)}
                    disabled={savingNote}
                    autoFocus
                  />
                ) : (
                  <pre className="sf-note-pre">{reviewNote.final_note || 'Note not available.'}</pre>
                )}
              </div>
              {lockConfirmOpen ? (
                <div
                  className="cl-lock-confirm-overlay"
                  role="presentation"
                  onClick={(e) => e.target === e.currentTarget && !lockConfirmLoading && setLockConfirmOpen(false)}
                >
                  <div
                    className="cl-lock-confirm-modal"
                    role="alertdialog"
                    aria-modal="true"
                    aria-labelledby="cl-lock-confirm-title"
                    onClick={(e) => e.stopPropagation()}
                  >
                    <div id="cl-lock-confirm-title" className="cl-lock-confirm-modal__title">
                      Lock this note?
                    </div>
                    <p className="cl-lock-confirm-modal__message">
                      This marks the note as completed and approved. The scribe can no longer edit it.
                    </p>
                    <div className="cl-lock-confirm-modal__footer">
                      <button
                        type="button"
                        className="cl-lock-confirm-modal__btn-cancel"
                        onClick={() => setLockConfirmOpen(false)}
                        disabled={lockConfirmLoading}
                      >
                        Cancel
                      </button>
                      <button
                        type="button"
                        className="cl-lock-confirm-modal__btn-lock"
                        onClick={confirmLockNote}
                        disabled={lockConfirmLoading}
                      >
                        {lockConfirmLoading ? 'Please wait…' : 'Lock Note'}
                      </button>
                    </div>
                  </div>
                </div>
              ) : null}
            </div>
          </>
        ) : (
          <>
        {/* NOTES — merged pending / completed / history with filter tabs */}
        {screen === 'notes' && (
          <>
            <ClinicianTopbar
              drawerMode={drawerMode}
              sidebar={sidebar}
              branding={branding}
              cu={cu}
              onViewProfile={openProfile}
              onLogout={requestLogout}
              title={historyTitle}
              subtitle={historySubtitle}
            >
              <button type="button" className="btn btn-sm" disabled={loading} onClick={() => loadHistory({ notify: true })} title="Reload list">
                ⟳ Refresh
              </button>
            </ClinicianTopbar>
            <div className="sf-body">
              <div className="cl-notes-tabs" role="tablist" aria-label="Notes filter">
                {NOTES_FILTER_TABS.map(({ key, label, tip }) => (
                  <ClinicianTooltip key={key} tip={tip} filterTip>
                    <button
                      type="button"
                      role="tab"
                      aria-selected={notesFilter === key}
                      className={`cl-notes-tab${notesFilter === key ? ' cl-notes-tab--active' : ''}`}
                      onClick={() => setNotesFilter(key)}
                    >
                      <span className="cl-notes-tab__label">{label}</span>
                      <span className="cl-notes-tab__count" aria-label={`${notesTabCount(key)} notes`}>
                        {notesTabCount(key)}
                      </span>
                    </button>
                  </ClinicianTooltip>
                ))}
              </div>

              <div
                className="cl-notes-search-row"
                style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 12 }}
              >
                <input
                  className="sf-input"
                  placeholder="Search by name or MRN…"
                  value={histQ}
                  onChange={(e) => setHistQ(e.target.value)}
                  aria-label="Search encounters"
                  style={{ flex: 1, marginBottom: 0 }}
                />
                <button
                  type="button"
                  className="cl-notes-filters-toggle"
                  aria-expanded={notesFiltersOpen}
                  onClick={() => setNotesFiltersOpen((open) => !open)}
                  style={{
                    display: 'inline-flex',
                    alignItems: 'center',
                    gap: 6,
                    whiteSpace: 'nowrap',
                    background: notesActiveFilterCount > 0 ? '#EFF6FF' : 'white',
                    border: `1px solid ${notesActiveFilterCount > 0 ? '#4F46E5' : '#E5E7EB'}`,
                    borderRadius: 6,
                    padding: '6px 12px',
                    fontSize: 13,
                    color: notesActiveFilterCount > 0 ? '#4F46E5' : '#374151',
                    cursor: 'pointer',
                  }}
                >
                  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
                    <polygon points="22 3 2 3 10 12.46 10 19 14 21 14 12.46 22 3" />
                  </svg>
                  {notesActiveFilterCount > 0 ? `Filters (${notesActiveFilterCount})` : 'Filters'}
                </button>
              </div>

              <div
                className="cl-notes-filter-panel"
                aria-hidden={!notesFiltersOpen}
                style={{
                  overflow: 'hidden',
                  transition: 'max-height 300ms ease',
                  maxHeight: notesFiltersOpen ? 600 : 0,
                }}
              >
              <div className="cl-notes-date-filter">
                <div className="cl-notes-date-filter__field">
                  <label className="cl-notes-date-filter__label" htmlFor="cl-notes-date-from">
                    From:
                  </label>
                  <input
                    id="cl-notes-date-from"
                    type="date"
                    className="cl-notes-date-filter__input"
                    value={histDateFromInput}
                    onChange={(e) => setHistDateFromInput(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter') {
                        e.preventDefault()
                        setHistDateFrom(histDateFromInput)
                        setHistDateTo(histDateToInput)
                      }
                    }}
                  />
                </div>
                <div className="cl-notes-date-filter__field">
                  <label className="cl-notes-date-filter__label" htmlFor="cl-notes-date-to">
                    To:
                  </label>
                  <input
                    id="cl-notes-date-to"
                    type="date"
                    className="cl-notes-date-filter__input"
                    value={histDateToInput}
                    onChange={(e) => setHistDateToInput(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter') {
                        e.preventDefault()
                        setHistDateFrom(histDateFromInput)
                        setHistDateTo(histDateToInput)
                      }
                    }}
                  />
                </div>
                <button
                  type="button"
                  className="cl-notes-date-filter__apply"
                  onClick={() => {
                    setHistDateFrom(histDateFromInput)
                    setHistDateTo(histDateToInput)
                  }}
                >
                  Apply
                </button>
                <button
                  type="button"
                  className="cl-notes-date-filter__clear"
                  onClick={() => {
                    setHistDateFromInput('')
                    setHistDateToInput('')
                    setHistDateFrom('')
                    setHistDateTo('')
                  }}
                >
                  Clear
                </button>
              </div>

              <div className="cl-notes-advanced-filters">
                <ClinicianTooltip tip="Filter by the type of clinical encounter" filterTip>
                  <div className="cl-notes-advanced-filters__field">
                    <label className="cl-notes-advanced-filters__label" htmlFor="cl-notes-type-filter">
                      Encounter Type
                    </label>
                    <select
                      id="cl-notes-type-filter"
                      className="cl-notes-filter-select"
                      value={notesTypeFilter}
                      onChange={(e) => setNotesTypeFilter(e.target.value)}
                    >
                      {NOTES_ENCOUNTER_FILTER_OPTS.map(({ value, label }) => (
                        <option key={value} value={value}>
                          {label}
                        </option>
                      ))}
                    </select>
                  </div>
                </ClinicianTooltip>
                <ClinicianTooltip tip="Filter by the current note processing stage" filterTip>
                  <div className="cl-notes-advanced-filters__field">
                    <label className="cl-notes-advanced-filters__label" htmlFor="cl-notes-scribe-filter">
                      Scribe Status
                    </label>
                    <select
                      id="cl-notes-scribe-filter"
                      className="cl-notes-filter-select"
                      value={notesScribeFilter}
                      onChange={(e) => setNotesScribeFilter(e.target.value)}
                    >
                      {NOTES_SCRIBE_FILTER_OPTS.map(({ value, label }) => (
                        <option key={value} value={value}>
                          {label}
                        </option>
                      ))}
                    </select>
                  </div>
                </ClinicianTooltip>
                <ClinicianTooltip tip="Change the order notes appear in the list" filterTip>
                  <div className="cl-notes-advanced-filters__field">
                    <label className="cl-notes-advanced-filters__label" htmlFor="cl-notes-sort-by">
                      Sort By
                    </label>
                    <select
                      id="cl-notes-sort-by"
                      className="cl-notes-filter-select"
                      value={notesSortBy}
                      onChange={(e) => setNotesSortBy(e.target.value)}
                    >
                      {NOTES_SORT_OPTS.map(({ value, label }) => (
                        <option key={value} value={value}>
                          {label}
                        </option>
                      ))}
                    </select>
                  </div>
                </ClinicianTooltip>
              </div>

              </div>

              {loading ? (
                <div className="sf-empty">
                  <div className="sf-empty-icon">⏳</div>
                  <div className="sf-empty-title">Loading…</div>
                </div>
              ) : historyFiltered.length === 0 ? (
                <div className="sf-empty">
                  <div className="sf-empty-icon">
                    {notesFilter === 'with-scribe' ? '✨' : notesFilter === 'ready-for-review' ? '📝' : '📜'}
                  </div>
                  <div className="sf-empty-title">
                    {notesFilter === 'with-scribe'
                      ? 'No notes with scribe.'
                      : notesFilter === 'ready-for-review'
                      ? 'No notes ready for review.'
                      : 'No encounters match your filters.'}
                  </div>
                  {notesFilter === 'with-scribe' ? (
                    <div className="sf-empty-sub">When audio is still with the scribe, it will show up here.</div>
                  ) : null}
                  {notesFilter === 'ready-for-review' ? (
                    <div className="sf-empty-sub">Notes ready for your review will appear here once the scribe returns them.</div>
                  ) : null}
                  {notesFilter === 'all' ? (
                    <div className="sf-empty-sub">
                      {notesDateRangeActive
                        ? 'No encounters in this date range. Try adjusting From/To or tap Clear.'
                        : 'Try clearing search. New activity will show after your next refresh.'}
                    </div>
                  ) : null}
                </div>
              ) : (
                historyFiltered.map((h) => {
                  const badgeKey = notesCardBadgeKey(h)
                  const notesBadge = NOTES_BADGE_META[badgeKey] || NOTES_BADGE_META.processing
                  const actionKind = notesCardActionKind(h)
                  const isReadyReview = badgeKey === 'ready'
                  const completedAgo =
                    badgeKey === 'completed' || badgeKey === 'closed'
                      ? notesRelativeAgo(h.completed_at || h.updated_at)
                      : null
                  const readyAgo =
                    badgeKey === 'ready' ? notesRelativeAgo(h.note_updated_at || h.updated_at) : null
                  const modernCard = screen === 'notes'
                  const cardVariant =
                    notesFilter === 'with-scribe'
                      ? 'processing'
                      :                     notesFilter === 'ready-for-review'
                      ? 'ready'
                      : notesFilter === 'all'
                      ? notesCardBadgeKey(h) === 'overdue'
                        ? 'overdue'
                        : h.status === 'note-ready'
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
                  const scribeUrgent = notesBadge.label === 'With Scribe' && scribeWaitingTier(h) === 'urgent'
                  const canonicalPendingClass =
                    badgeKey === 'ready'
                      ? 'cl-pending-card--ready'
                      : badgeKey === 'overdue'
                      ? 'cl-pending-card--overdue'
                      : badgeKey === 'completed' || badgeKey === 'closed'
                      ? 'cl-pending-card--completed'
                      : h.status === 'upcoming'
                      ? 'cl-pending-card--upcoming'
                      : 'cl-pending-card--with-scribe'
                  const rowClass = modernCard
                    ? `cl-pending-card cl-pending-card--${cardVariant} ${canonicalPendingClass}${isReadyReview ? ' cl-pending-card--ready-review' : ''}${scribeUrgent ? ' cl-pending-card--scribe-urgent' : ''}`
                    : 'sf-row'
                  const rowProps = modernCard ? { 'aria-label': `${h.patient_name}, ${notesBadge.label}` } : {}
                  return (
                    <RowWrap key={h.id} className={rowClass} style={modernCard ? undefined : { alignItems: 'flex-start', flexWrap: 'wrap', marginBottom: 8, justifyContent: 'flex-start', gap: 14 }} {...rowProps}>
                      <div className={modernCard ? 'cl-pending-card__main' : ''} style={modernCard ? undefined : { display:'flex', alignItems:'center', gap:14, flex:1, minWidth:0 }}>
                        <div
                          className={modernCard ? 'cl-pending-card__avatar' : 'cl-schedule-row__avatar'}
                          style={{ background: getPatientAvatarColor(h.mrn || h.patient_name) }}
                          aria-hidden
                        >
                          {initials(h.patient_name)}
                        </div>
                        <div style={{ minWidth:0, flex:1 }}>
                          <div className={modernCard ? 'cl-pending-card__title' : ''} style={modernCard ? undefined : { fontSize:15, fontWeight:700, color:'#1E293B' }}>{h.patient_name}</div>
                          <div className="cl-notes-status-row">
                            <StatusBadge
                              label={notesBadge.label === 'With Scribe' ? withScribeBadgeLabel(h) : notesBadge.label}
                              className={notesBadge.label === 'With Scribe' ? withScribeBadgeClassName(h) : notesBadge.className}
                            />
                            {notesBadge.label !== 'With Scribe' && notesBadge.className?.includes('badge-processing') ? (
                              <span className={`cl-waiting-badge cl-waiting-badge--${notesWaitingTier(h)}`}>
                                {notesWaitingLabel(h)}
                              </span>
                            ) : null}
                          </div>
                          {completedAgo ? (
                            <div style={{ fontSize: 12, color: '#9CA3AF', marginTop: 4 }}>
                              Completed {completedAgo}
                            </div>
                          ) : null}
                          {readyAgo ? (
                            <div style={{ fontSize: 12, color: '#9CA3AF', marginTop: 4 }}>
                              Ready {readyAgo}
                            </div>
                          ) : null}
                          <div className={modernCard ? 'cl-pending-card__meta' : ''} style={modernCard ? undefined : { fontSize:13, color:'#64748B', marginTop:3, display:'flex', alignItems:'center', gap:8, flexWrap:'wrap' }}>
                            <span className="cl-pending-card__meta-mrn" style={{ fontWeight:600, color:'#475569' }}>📋 {h.mrn}</span>
                            <span style={{ color:'#CBD5E1' }} aria-hidden="true">·</span>
                            <span className="cl-pending-card__meta-date">{fmtDate(h.visit_date)}</span>
                            <span style={{ color:'#CBD5E1' }} aria-hidden="true">·</span>
                            <span className="cl-pending-card__meta-type">{h.visit_type}</span>
                          </div>
                        </div>
                      </div>
                      <div className={modernCard ? 'cl-pending-card__actions' : ''} style={modernCard ? undefined : { display: 'flex', gap: 8, flexWrap: 'wrap', justifyContent: 'flex-end', marginLeft: 'auto' }}>
                        {badgeKey === 'overdue' ? (
                          <button
                            type="button"
                            style={{
                              background: '#D97706',
                              color: 'white',
                              borderRadius: '8px',
                              padding: '10px 20px',
                              fontWeight: 600,
                              border: 'none',
                              cursor: 'pointer',
                              fontSize: '13px'
                            }}
                            onClick={() => goRecordOverdueFromNotes(h)}
                          >
                            Record Now
                          </button>
                        ) : null}
                        {actionKind === 'review' ? (
                          <button type="button" className="cl-notes-btn-open" onClick={() => openNoteFromCard(h)}>
                            Review
                          </button>
                        ) : null}
                        {actionKind === 'awaiting' ? (
                          <span className="cl-notes-awaiting">Awaiting Note</span>
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
            <ClinicianTopbar
              drawerMode={drawerMode}
              sidebar={sidebar}
              branding={branding}
              cu={cu}
              onViewProfile={openProfile}
              onLogout={requestLogout}
              title={`${getGreeting()}${cu?.name ? `, Dr. ${cu.name}` : ''}`}
              belowTitle={
                readyForReviewCount > 0 ? (
                  <button type="button" className="cl-schedule-pending-reviews" onClick={goToReadyForReview}>
                    <span className="cl-schedule-pending-reviews__icon" aria-hidden>🔔</span>
                    {readyForReviewCount} note{readyForReviewCount !== 1 ? 's' : ''} waiting for your review
                  </button>
                ) : null
              }
              subtitle={`${localDate(off, 'long')} · ${today} patient${today !== 1 ? 's' : ''} on this day${
                scheduleSyncedAt ? ` · Updated ${formatSyncedLabel(scheduleSyncedAt)}` : ''
              }`}
            >
              <time
                className="cl-schedule-clock"
                dateTime={liveNow.toISOString()}
                title="Local time"
              >
                {liveNow.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' })}
              </time>
              <ClinicianTooltip tip="Update visit statistics and patient list" placement="below">
                <button type="button" className="btn btn-sm" disabled={loading} onClick={() => loadVisits({ notify: true })}>
                  ⟳ <span className="cl-refresh-label">Refresh</span>
                </button>
              </ClinicianTooltip>
              <button type="button" className="btn btn-navy btn-sm" onClick={() => { setShowAdd((f) => !f); setPtErr('') }}>
                + Add Patient
              </button>
            </ClinicianTopbar>

            <div className="sf-body cl-schedule">
              <div className="cl-schedule-banner sf-banner sf-banner-past">
                <div>
                  <div className="sf-section-label cl-schedule-section-title" style={{ marginBottom: 4 }}>
                    {visitsSectionTitle(off)}
                  </div>
                  <div style={{ fontSize: 13, color: 'var(--text-sub)' }}>
                    Press <kbd className="cl-kbd">T</kbd> to jump to today
                    {!isScheduleToday(off) ? (
                      <>
                        {' · '}
                        <button type="button" className="sf-back" style={{ display: 'inline', background: 'none', border: 'none', padding: 0, cursor: 'pointer' }} onClick={goToToday}>
                          Go to today
                        </button>
                      </>
                    ) : null}
                  </div>
                </div>
              </div>

              <div className="cl-stat-cards sf-stats">
                {[
                  ['Total Visits', today, 'cl-stat-card--total', '📅'],
                  ['With Scribe', action, 'cl-stat-card--processing', '🎙'],
                  [READY_FOR_REVIEW_LABEL, ready, 'cl-stat-card--review', '✏️'],
                  ['Completed', synced, 'cl-stat-card--completed', '✓'],
                ].map(([label, val, mod, icon]) => (
                  <div key={label} className={`cl-stat-card sf-stat ${mod}`}>
                    <span className="cl-stat-card__icon" aria-hidden>
                      {mod === 'cl-stat-card--total' ? <IconCalendar /> : icon}
                    </span>
                    <div className="cl-stat-card__val sf-stat-val">{val}</div>
                    <div className="cl-stat-card__lbl sf-stat-lbl">{label}</div>
                  </div>
                ))}
              </div>

              {active && (
                <div className="sf-rec-banner" style={{ marginBottom: 14 }}>
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
                <div className="cl-schedule-add-rec sf-banner sf-banner-future">
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
                  ⏳ Uploading audio...
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

              <div className="sf-date-nav cl-date-nav portal-cal-strip">
                <button type="button" className="cl-date-nav__jump-prev" onClick={() => shiftScheduleOff(-7)} aria-label="Previous week">
                  «
                </button>
                <button type="button" className="btn btn-sm cl-date-nav__arrow portal-cal-strip__arrow" onClick={() => shiftScheduleOff(-1)} aria-label="Previous day">
                  ‹
                </button>
                <div className="sf-date-nav-days cl-date-nav__days portal-cal-strip__days">
                  {scheduleDays.map((o) => {
                    const breakdown = scheduleDayBreakdownFor(o, off, visits, scheduleDayBreakdown)
                    const dayDots = scheduleDayDots(breakdown)
                    const isToday = localDate(o, 'input') === localDate(0, 'input')
                    return (
                      <div key={o} className="cl-date-nav__day-wrap portal-cal-strip__day-wrap">
                        <ErrorBoundary fallback={null}>
                          <ScheduleDayPreview dayOff={o ?? 0} breakdown={breakdown ?? {}} scheduleDayCounts={scheduleDayCounts ?? {}} />
                        </ErrorBoundary>
                        <div
                          role="button"
                          tabIndex={0}
                          onClick={() => goToScheduleDate(o)}
                          onKeyDown={(e) => (e.key === 'Enter' || e.key === ' ') && goToScheduleDate(o)}
                          className={`sf-date-nav-day cl-date-nav__day portal-cal-strip__day${o === off ? ' active' : ''}${localDate(o, 'input') === localDate(0, 'input') ? ' cl-date-nav__day--today portal-cal-strip__day--today' : ''}`}
                        >
                          <div className="sf-date-nav-day-name cl-date-nav__day-name portal-cal-strip__day-name">{localDate(o, 'day')}</div>
                          <div className="sf-date-nav-day-date cl-date-nav__day-num portal-cal-strip__day-num">{localDate(o, 'date')}</div>
                          {isToday ? <div className="cl-date-nav__today-label portal-cal-strip__today-label">Today</div> : null}
                          {dayDots.length > 0 ? (
                            <div
                              className="cl-date-nav__day-dots"
                              style={{ display: 'flex', justifyContent: 'center', alignItems: 'center', lineHeight: 0, marginTop: 2 }}
                              aria-hidden
                            >
                              {dayDots.map((color, i) => (
                                <span
                                  key={i}
                                  style={{
                                    width: 6,
                                    height: 6,
                                    borderRadius: '50%',
                                    display: 'inline-block',
                                    margin: '0 2px',
                                    background: isToday ? '#FFFFFF' : color,
                                  }}
                                />
                              ))}
                            </div>
                          ) : null}
                        </div>
                      </div>
                    )
                  })}
                </div>
                <button type="button" className="btn btn-sm cl-date-nav__arrow portal-cal-strip__arrow" onClick={() => shiftScheduleOff(1)} aria-label="Next day">
                  ›
                </button>
                <button type="button" className="cl-date-nav__jump-next" onClick={() => shiftScheduleOff(7)} aria-label="Next week">
                  »
                </button>
                <div className="cl-date-nav__calendar-wrap">
                  <button
                    ref={calendarBtnRef}
                    type="button"
                    className="cl-calendar-btn"
                    aria-label="Jump to date"
                    aria-expanded={calendarOpen}
                    onClick={() => setCalendarOpen((open) => !open)}
                  >
                    <IconCalendar />
                  </button>
                  {calendarOpen ? (
                    <ScheduleDatePicker
                      off={off}
                      anchorRef={calendarBtnRef}
                      onSelectDate={goToScheduleDate}
                      onClose={() => setCalendarOpen(false)}
                    />
                  ) : null}
                </div>
              </div>

              <div className="cl-schedule-list-head">
                <span className="sf-section-label" style={{ marginBottom: 0 }}>Patient List</span>
                <select
                  className="cl-schedule-list-head__sort"
                  aria-label="Sort patient list"
                  value={scheduleSort}
                  onChange={(e) => setScheduleSort(e.target.value)}
                  style={{
                    border: '1px solid #E5E7EB',
                    borderRadius: 6,
                    padding: '4px 8px',
                    fontSize: 13,
                    color: '#374151',
                    background: 'white',
                    cursor: 'pointer',
                  }}
                >
                  <option value="time">Time</option>
                  <option value="status">Status (overdue first)</option>
                  <option value="name">Name A-Z</option>
                </select>
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
                  sortedVisits.map((v, visitIdx) => {
                  const isActive = active?.id === v.id
                  const scheduleOverdue = isScheduleVisitOverdue(v, off)
                  const scheduleBadgeText = scheduleOverdue ? 'Overdue' : scheduleStatusDisplayLabel(v.status)
                  const scheduleBadgeClass = scheduleOverdue ? 'badge-overdue' : scheduleVisitBadgeClass(v.status)
                  const unifiedWithScribeBadge = !scheduleOverdue && scheduleBadgeText === WITH_SCRIBE_LABEL
                  const scribeUrgentOnSchedule = unifiedWithScribeBadge && scribeWaitingTier(v) === 'urgent'
                  const accentClass = scheduleOverdue
                    ? 'cl-patient-card--overdue'
                    : schedulePatientCardAccentClass(v, off)
                  const canonicalCardClass = scheduleOverdue
                    ? 'cl-patient-card--overdue'
                    : v.status === 'note-ready'
                    ? 'cl-patient-card--ready'
                    : v.status === 'uploaded' || v.status === 'done'
                    ? 'cl-patient-card--completed'
                    : ['recording-uploaded', 'in-progress', 'submitted'].includes(v.status)
                    ? 'cl-patient-card--with-scribe'
                    : 'cl-patient-card--upcoming'
                  const showNowBefore = scheduleSort === 'time' && shouldInsertNowBefore(sortedVisits, visitIdx, off, liveNow)
                  return (
                    <div key={v.id} className="cl-schedule-visit-wrap">
                      {showNowBefore ? <NowDivider now={liveNow} /> : null}
                    <div className={`cl-schedule-row sf-row cl-patient-card ${accentClass} ${canonicalCardClass}${scribeUrgentOnSchedule ? ' cl-patient-card--scribe-urgent' : ''}${isActive ? ' sf-row-active' : ''}`}>
                      <div className="cl-schedule-row__time">
                        <div className="cl-schedule-row__time-main">{fmtTime(v.visit_time).split(' ')[0]}</div>
                        <div className="cl-schedule-row__time-sub">{fmtTime(v.visit_time).split(' ')[1]}</div>
                      </div>
                      <div
                        className="cl-schedule-row__avatar"
                        style={{ background: getPatientAvatarColor(v.mrn || v.patient_name) }}
                        aria-hidden
                      >
                        {initials(v.patient_name)}
                      </div>
                      <div className="cl-schedule-row__info">
                        <div className="cl-schedule-row__name">{v.patient_name}</div>
                        <div className="cl-schedule-row__meta">
                          <span style={{ fontWeight:600, color:'#475569' }}>📋 {v.mrn}</span>
                          <span style={{ color:'#CBD5E1' }}>·</span>
                          <span style={{ fontWeight:500 }}>{v.visit_type}</span>
                        </div>
                        <div className="cl-schedule-status-row">
                          <StatusBadge
                            label={unifiedWithScribeBadge ? withScribeBadgeLabel(v, { schedule: true }) : scheduleBadgeText}
                            className={unifiedWithScribeBadge ? withScribeBadgeClassName(v) : scheduleBadgeClass}
                          />
                        </div>
                      </div>
                      <div className="cl-schedule-row__actions">
                        {v.status === 'upcoming' && (
                          <>
                            <ClinicianTooltip tip="Start audio recording for this encounter. Your scribe team will receive the audio and draft the note.">
                              <button type="button" className="cl-schedule-cta" onClick={() => startVisit(v)} disabled={!!active} style={{ display:'inline-flex', alignItems:'center', gap:6, padding:'10px 22px', borderRadius:14, background: active ? '#94A3B8' : 'linear-gradient(135deg,#16A34A,#15803D)', color:'#fff', border:'none', fontSize:15, fontWeight:800, cursor: active ? 'not-allowed' : 'pointer', fontFamily:'inherit', boxShadow: active ? 'none' : '0 4px 16px rgba(22,163,74,0.4)', opacity: active ? 0.6 : 1 }}>
                                <IconMic />
                                Record Encounter
                              </button>
                            </ClinicianTooltip>
                            <div className="cl-schedule-row__icon-actions">
                              <ClinicianTooltip tip="Edit patient appointment details" icon>
                                <button type="button" className="cl-icon-btn" aria-label="Edit patient appointment details" onClick={() => { setEditV(v); setEditD({ visit_time: v.visit_time, visit_type: v.visit_type }) }}>✏️</button>
                              </ClinicianTooltip>
                              <ClinicianTooltip tip="Remove this patient from today's schedule" icon>
                                <button type="button" className="cl-icon-btn" aria-label="Remove this patient from today's schedule" onClick={() => deleteVisit(v)}>🗑</button>
                              </ClinicianTooltip>
                            </div>
                          </>
                        )}
                        {v.status === 'in-progress' && (
                          <div style={{ display:'inline-flex', alignItems:'center', gap:8, padding:'8px 16px', borderRadius:10, background:'#FFF1F2', border:'1px solid #FECDD3' }}>
                            <span style={{ fontSize:14, color:'#9F1239', fontWeight:700 }}>Recording...</span>
                          </div>
                        )}
                        {/* recording-uploaded: NO "Generate Note" button.
                            Status chip already says "With Scribe".
                            Optional Preview Draft + Add to Encounter for additional audio. */}
                        {v.status === 'recording-uploaded' && (
                          <div style={{ display:'flex', gap:8, flexWrap:'wrap', justifyContent:'flex-end', alignItems:'center' }}>
                            <ClinicianTooltip tip="Add another audio recording to this encounter">
                              <button type="button" className="cl-schedule-cta" onClick={() => startAdd(v)} disabled={!!active || !!addRec} style={{ display:'inline-flex', alignItems:'center', gap:6, padding:'10px 22px', borderRadius:14, background: (active||addRec) ? '#94A3B8' : 'linear-gradient(135deg,#16A34A,#15803D)', color:'#fff', border:'none', fontSize:15, fontWeight:800, cursor: (active||addRec) ? 'not-allowed' : 'pointer', fontFamily:'inherit', boxShadow: (active||addRec) ? 'none' : '0 4px 16px rgba(22,163,74,0.4)', opacity: (active||addRec) ? 0.6 : 1 }}>
                                <IconMic />
                                Additional Recording
                              </button>
                            </ClinicianTooltip>
                          </div>
                        )}
                        {v.status === 'note-ready' && (
                          <>
                            <ClinicianTooltip tip="Review and sign off on the scribe-drafted note">
                              <button type="button" className="cl-notes-btn-open" onClick={() => openNoteDetail(v)}>
                                Review Note
                              </button>
                            </ClinicianTooltip>
                          </>
                        )}
                        {v.status === 'uploaded' && (
                          <>
                            <button type="button" className="cl-notes-btn-open" onClick={() => openNoteDetail(v)}>
                              Review Note
                            </button>
                          </>
                        )}
                      </div>
                    </div>
                    </div>
                  )
                })
                )}
                {!loading && visits.length > 0 && shouldInsertNowAfterAll(visits, off, liveNow) ? (
                  <NowDivider now={liveNow} />
                ) : null}
              </div>
            </div>
          </>
        )}
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

      {aiVisit    && <AIModal    visit={aiVisit}    onClose={() => { setAiVisit(null); setAiVisitFromNotes(false) }} hideAudioControls={aiVisitFromNotes} showToast={showToast} />}
      {playVisit  && screen !== 'notes' && <AudioModal visitId={playVisit.id} visit={playVisit} onClose={() => setPlayVisit(null)} showToast={showToast} />}
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
