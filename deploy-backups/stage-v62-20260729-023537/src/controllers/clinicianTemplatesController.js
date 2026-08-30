const pool = require('../config/db')
const { sendHttpError } = require('../utils/errorMessages')
const { ensureClinicianTemplatesSchema } = require('../utils/ensureClinicianTemplatesSchema')
const { visitTypeToTemplateId } = require('../utils/noteTemplateSections')

const DEFAULT_TEMPLATES = [
    {
        id: 'new-patient',
        name: 'New Patient Visit',
        icon: '🆕',
        color: '#E3F2FD',
        accent: '#1565C0',
        content:
            'CHIEF COMPLAINT:\n\n\nHISTORY OF PRESENT ILLNESS (HPI):\n\n\nPAST MEDICAL HISTORY:\n\n\nFAMILY HISTORY:\n\n\nSOCIAL HISTORY:\n\n\nREVIEW OF SYSTEMS:\n\n\nPHYSICAL EXAMINATION:\n\n\nIMAGING:\n\n\nASSESSMENT & PLAN (A&P):\n',
    },
    {
        id: 'follow-up',
        name: 'Follow-Up Visit',
        icon: '🔄',
        color: '#E8F5E9',
        accent: '#2E7D32',
        content:
            'REASON FOR VISIT:\n\n\nINTERVAL HISTORY:\n\n\nCURRENT MEDICATIONS:\n\n\nPHYSICAL EXAMINATION:\n\n\nIMAGING:\n\n\nASSESSMENT & PLAN:\n',
    },
    {
        id: 'virtual-visit',
        name: 'Virtual Visit',
        icon: '💻',
        color: '#EDE9FE',
        accent: '#4527A0',
        content:
            'CHIEF COMPLAINT:\n\n\nHISTORY OF PRESENT ILLNESS (HPI):\n\n\nREVIEW OF SYSTEMS:\n\n\nCURRENT MEDICATIONS:\n\n\nIMAGING / LAB RESULTS:\n\n\nASSESSMENT & PLAN (A&P):\n\nNOTE: This visit was conducted via telemedicine. Physical examination was not performed.\n',
    },
    {
        id: 'other',
        name: 'Other / General',
        icon: '📋',
        color: '#FFF8E1',
        accent: '#F57F17',
        content: 'VISIT TYPE:\n\n\nCHIEF COMPLAINT:\n\n\nHISTORY:\n\n\nEXAMINATION:\n\n\nASSESSMENT & PLAN:\n',
    },
]

function mapRow(row) {
    return {
        id: row.template_id,
        name: row.name,
        icon: row.icon || '',
        color: row.color || '',
        accent: row.accent || '',
        content: row.content,
    }
}

async function seedDefaultsForUser(userId) {
    for (const t of DEFAULT_TEMPLATES) {
        await pool.query(
            `INSERT INTO clinician_templates (user_id, template_id, name, icon, color, accent, content)
             VALUES ($1, $2, $3, $4, $5, $6, $7)
             ON CONFLICT (user_id, template_id) DO NOTHING`,
            [userId, t.id, t.name, t.icon, t.color, t.accent, t.content],
        )
    }
}

async function listTemplatesForUser(userId) {
    const { rows } = await pool.query(
        `SELECT template_id, name, icon, color, accent, content
         FROM clinician_templates
         WHERE user_id = $1
         ORDER BY template_id`,
        [userId],
    )
    if (rows.length === 0) {
        await seedDefaultsForUser(userId)
        return DEFAULT_TEMPLATES.map((t) => ({ ...t }))
    }
    return rows.map(mapRow)
}

/**
 * Resolve the clinician's saved template matching a visit type (e.g. 'Follow-up' → 'follow-up'),
 * for AI draft generation. Returns null if the clinician has no matching template.
 */
async function getTemplateForVisitType(userId, visitType) {
  await ensureClinicianTemplatesSchema()
  const templates = await listTemplatesForUser(userId)
  const templateId = visitTypeToTemplateId(visitType)
  return templates.find((t) => t.id === templateId) || null
}

const getClinicianTemplates = async (req, res) => {
    try {
        await ensureClinicianTemplatesSchema()
        const templates = await listTemplatesForUser(req.user.id)
        res.status(200).json({ templates })
    } catch (err) {
        sendHttpError(res, 500, err, { context: 'settings.clinicianTemplates.get', req })
    }
}

const saveClinicianTemplates = async (req, res) => {
    try {
        await ensureClinicianTemplatesSchema()
        const { templates } = req.body || {}
        if (!Array.isArray(templates) || templates.length === 0) {
            return res.status(400).json({ error: 'templates array is required.' })
        }

        const client = await pool.connect()
        try {
            await client.query('BEGIN')
            await client.query('DELETE FROM clinician_templates WHERE user_id = $1', [req.user.id])
            for (const t of templates) {
                const id = String(t.id || '').trim()
                const name = String(t.name || '').trim()
                const content = String(t.content || '')
                if (!id || !name) {
                    await client.query('ROLLBACK')
                    return res.status(400).json({ error: 'Each template requires id and name.' })
                }
                await client.query(
                    `INSERT INTO clinician_templates (user_id, template_id, name, icon, color, accent, content, updated_at)
                     VALUES ($1, $2, $3, $4, $5, $6, $7, NOW())`,
                    [
                        req.user.id,
                        id.slice(0, 64),
                        name.slice(0, 255),
                        String(t.icon || '').slice(0, 16) || null,
                        String(t.color || '').slice(0, 32) || null,
                        String(t.accent || '').slice(0, 32) || null,
                        content,
                    ],
                )
            }
            await client.query('COMMIT')
        } catch (txErr) {
            await client.query('ROLLBACK')
            throw txErr
        } finally {
            client.release()
        }

        const saved = await listTemplatesForUser(req.user.id)
        res.status(200).json({ templates: saved })
    } catch (err) {
        sendHttpError(res, 500, err, { context: 'settings.clinicianTemplates.save', req })
    }
}

const deleteClinicianTemplate = async (req, res) => {
    try {
        await ensureClinicianTemplatesSchema()
        const templateId = String(req.params.id || '').trim()
        if (!templateId) {
            return res.status(400).json({ error: 'Template id is required.' })
        }
        const result = await pool.query(
            'DELETE FROM clinician_templates WHERE user_id = $1 AND template_id = $2 RETURNING template_id',
            [req.user.id, templateId],
        )
        if (result.rowCount === 0) {
            return res.status(404).json({ error: 'Template not found.' })
        }
        const templates = await listTemplatesForUser(req.user.id)
        res.status(200).json({ templates })
    } catch (err) {
        sendHttpError(res, 500, err, { context: 'settings.clinicianTemplates.delete', req })
    }
}

module.exports = {
    getClinicianTemplates,
    saveClinicianTemplates,
    deleteClinicianTemplate,
    DEFAULT_TEMPLATES,
    listTemplatesForUser,
    getTemplateForVisitType,
}
