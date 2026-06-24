import { useEffect, useState } from 'react'
import { settingsAPI } from './api'

/** Static fallback when `logo_data_url` is empty — file in `public/brand/`. */
export const DEFAULT_BRAND_LOGO_SRC = '/brand/anot-logo.jfif'

export const DEFAULT_BRANDING = {
  system_name: 'Anot',
  system_email: '',
  phone: '',
  address: '',
  company_info: '',
  footer_text: '',
  support_contact: '',
  social_links: {},
  logo_data_url: '',
  favicon_data_url: '',
  primary_color: '#2563eb',
  secondary_color: '#0d9488',
  system_description: 'Clinical documentation platform',
}

const STORAGE_KEY = 'anot_branding_settings'
const EVENT_NAME = 'anot:branding-updated'

export function normalizeBranding(data = {}) {
  const next = { ...DEFAULT_BRANDING, ...(data || {}) }
  if (next.social_links && typeof next.social_links === 'object') {
    const social = { ...next.social_links }
    delete social.__admin_meta
    next.social_links = social
  }
  return next
}

export function getCachedBranding() {
  try {
    return normalizeBranding(JSON.parse(localStorage.getItem(STORAGE_KEY) || '{}'))
  } catch {
    return { ...DEFAULT_BRANDING }
  }
}

export function applyBrandingToDocument(settings) {
  const s = normalizeBranding(settings)
  document.documentElement.style.setProperty('--brand-primary', s.primary_color || DEFAULT_BRANDING.primary_color)
  document.documentElement.style.setProperty('--brand-secondary', s.secondary_color || DEFAULT_BRANDING.secondary_color)
  document.title = `${s.system_name || 'Anot'}`

  if (s.favicon_data_url) {
    let link = document.querySelector("link[rel='icon']")
    if (!link) {
      link = document.createElement('link')
      link.rel = 'icon'
      document.head.appendChild(link)
    }
    link.href = s.favicon_data_url
  }
}

export function setBranding(settings) {
  const normalized = normalizeBranding(settings)
  localStorage.setItem(STORAGE_KEY, JSON.stringify(normalized))
  applyBrandingToDocument(normalized)
  window.dispatchEvent(new CustomEvent(EVENT_NAME, { detail: normalized }))
}

export async function refreshBranding() {
  const data = await settingsAPI.getPublic()
  setBranding(data.settings || {})
  return getCachedBranding()
}

export function useBranding() {
  const [branding, setBrandingState] = useState(() => getCachedBranding())

  useEffect(() => {
    applyBrandingToDocument(branding)
  }, [branding])

  useEffect(() => {
    let alive = true
    refreshBranding()
      .then((value) => { if (alive) {setBrandingState(value)} })
      .catch(() => {})
    const onUpdate = (event) => setBrandingState(normalizeBranding(event.detail))
    window.addEventListener(EVENT_NAME, onUpdate)
    return () => {
      alive = false
      window.removeEventListener(EVENT_NAME, onUpdate)
    }
  }, [])

  return branding
}

