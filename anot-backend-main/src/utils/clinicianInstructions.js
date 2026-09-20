const pool = require('../config/db')

/**
 * Fetch clinician-specific AI note instructions / Claude directives.
 * @param {number|string} clinicianId
 * @returns {Promise<string|null>} The custom instructions string if set and non-empty, otherwise null.
 */
async function getClinicianAiInstructions(clinicianId) {
    if (!clinicianId) return null
    try {
        const id = parseInt(clinicianId, 10)
        if (!Number.isInteger(id)) return null
        const res = await pool.query('SELECT ai_note_instructions FROM users WHERE id = $1', [id])
        const val = res.rows[0]?.ai_note_instructions
        return (typeof val === 'string' && val.trim().length > 0) ? val.trim() : null
    } catch (err) {
        console.warn(`[clinicianInstructions] Could not query ai_note_instructions for user ${clinicianId}:`, err.message)
        return null
    }
}

module.exports = { getClinicianAiInstructions }
