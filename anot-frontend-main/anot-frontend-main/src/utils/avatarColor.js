/** Clinician portal: single indigo avatar color for all patients */
export const CLINICIAN_AVATAR_BG = '#4F46E5'
export const CLINICIAN_AVATAR_COLOR = '#ffffff'

/** Scribe portal: consistent indigo avatars */
export const SCRIBE_AVATAR_STYLE = {
  background: CLINICIAN_AVATAR_BG,
  color: CLINICIAN_AVATAR_COLOR,
  border: 'none',
}

export function getAvatarColor() {
  return CLINICIAN_AVATAR_BG
}

export function getPatientAvatarColor() {
  return CLINICIAN_AVATAR_BG
}

export function getScribePatientAvatarStyle() {
  return SCRIBE_AVATAR_STYLE
}

/** @deprecated Unused — kept so existing imports do not break */
export const PATIENT_AVATAR_COLORS = CLINICIAN_AVATAR_BG
export const SCRIBE_AVATAR_COLORS = SCRIBE_AVATAR_STYLE.background
