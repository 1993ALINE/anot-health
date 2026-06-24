const fs = require('fs')
const path = require('path')
const pool = require('../config/db')
const { canDecrypt } = require('../utils/settingsEncryption')
const { getSystemSettingsColumns, invalidateSettingsColumnCache } = require('../utils/settingsSchemaCompat')
const {
  ADMIN_META_KEY,
  parseSocialLinks,
  readAdminMeta,
} = require('../utils/settingsExtensions')
const { invalidateAiSettingsCache } = require('../services/aiSettings')

const ENCRYPTED_FIELDS = ['deepgram_api_key_enc', 'anthropic_api_key_enc']

function resolveFlagPath() {
  if (process.env.SETTINGS_CLEANUP_FLAG_PATH) {
    return process.env.SETTINGS_CLEANUP_FLAG_PATH
  }
  if (process.env.NODE_ENV === 'production' && fs.existsSync('/var/app/current')) {
    return '/var/app/current/.settings-cleaned'
  }
  return path.join(process.cwd(), '.settings-cleaned')
}

function flagExists(flagPath) {
  try {
    return fs.existsSync(flagPath)
  } catch {
    return false
  }
}

function writeFlag(flagPath) {
  const payload = JSON.stringify({
    cleanedAt: new Date().toISOString(),
    pid: process.pid,
  })
  fs.writeFileSync(flagPath, payload, 'utf8')
}

function isCorrupted(blob) {
  if (!blob || String(blob).trim().length === 0) return false
  return !canDecrypt(blob)
}

function collectCorruptedFields(row, columnSet) {
  const corrupted = []

  for (const field of ENCRYPTED_FIELDS) {
    if (columnSet.has(field) && isCorrupted(row[field])) {
      corrupted.push({ field, source: 'column' })
    }
  }

  const meta = readAdminMeta(row?.social_links)
  for (const field of ENCRYPTED_FIELDS) {
    if (columnSet.has(field)) continue
    if (isCorrupted(meta[field])) {
      corrupted.push({ field, source: 'social_links_meta' })
    }
  }

  return corrupted
}

function buildSocialLinksUpdate(currentSocialLinks, corruptedMetaFields) {
  const social = parseSocialLinks(currentSocialLinks)
  const meta = social[ADMIN_META_KEY] && typeof social[ADMIN_META_KEY] === 'object'
    ? { ...social[ADMIN_META_KEY] }
    : {}

  for (const field of corruptedMetaFields) {
    delete meta[field]
  }

  if (Object.keys(meta).length > 0) {
    social[ADMIN_META_KEY] = meta
  } else {
    delete social[ADMIN_META_KEY]
  }

  return social
}

/**
 * One-time startup cleanup: remove encrypted API keys that cannot be decrypted
 * with the current SETTINGS_ENCRYPTION_KEY. Non-fatal — logs errors and continues.
 */
async function cleanCorruptedSettings() {
  const flagPath = resolveFlagPath()

  if (flagExists(flagPath)) {
    console.log(`[cleanCorruptedSettings] Already ran (flag: ${flagPath}) — skipping`)
    return { skipped: true, flagPath }
  }

  console.log('[cleanCorruptedSettings] Checking system_settings for undecryptable API keys...')

  try {
    const columnSet = await getSystemSettingsColumns()
    const { rows } = await pool.query('SELECT * FROM system_settings WHERE id = 1')
    const row = rows[0]

    if (!row) {
      console.log('[cleanCorruptedSettings] No system_settings row — nothing to clean')
      writeFlag(flagPath)
      return { skipped: false, cleared: [], flagPath }
    }

    const corrupted = collectCorruptedFields(row, columnSet)
    if (corrupted.length === 0) {
      console.log('[cleanCorruptedSettings] No corrupted encrypted settings found')
      writeFlag(flagPath)
      return { skipped: false, cleared: [], flagPath }
    }

    const columnClears = corrupted.filter((c) => c.source === 'column').map((c) => c.field)
    const metaClears = corrupted.filter((c) => c.source === 'social_links_meta').map((c) => c.field)

    const sets = []
    const values = []
    let idx = 1

    for (const field of columnClears) {
      sets.push(`${field} = NULL`)
    }

    if (metaClears.length > 0) {
      const updatedSocial = buildSocialLinksUpdate(row.social_links, metaClears)
      sets.push(`social_links = $${idx++}`)
      values.push(JSON.stringify(updatedSocial))
    }

    sets.push('updated_at = NOW()')
    const sql = `UPDATE system_settings SET ${sets.join(', ')} WHERE id = 1`
    await pool.query(sql, values)

    invalidateSettingsColumnCache()
    invalidateAiSettingsCache()

    const clearedNames = corrupted.map((c) => `${c.field} (${c.source})`)
    console.warn('[cleanCorruptedSettings] Cleared corrupted encrypted settings:', clearedNames.join(', '))
    console.warn('[cleanCorruptedSettings] Re-enter API keys in Admin > Settings to restore AI features')

    writeFlag(flagPath)
    return { skipped: false, cleared: clearedNames, flagPath }
  } catch (err) {
    console.error('[cleanCorruptedSettings] Cleanup failed (non-fatal):', err.message)
    return { skipped: false, error: err.message, flagPath }
  }
}

module.exports = { cleanCorruptedSettings, resolveFlagPath }
