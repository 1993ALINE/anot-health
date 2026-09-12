const pool = require('../config/db')
const { sendHttpError } = require('../utils/errorMessages')
const { ensureClinicianTemplatesSchema } = require('../utils/ensureClinicianTemplatesSchema')
const { visitTypeToTemplateId } = require('../utils/noteTemplateSections')

const DEFAULT_TEMPLATES = [
    {
        id: 'new-patient',
        name: 'New Patient Comprehensive Intake (H&P)',
        category: 'Core Primary Care',
        icon: '🆕',
        color: '#E3F2FD',
        accent: '#1565C0',
        content:
            'CHIEF COMPLAINT:\n\n\nHISTORY OF PRESENT ILLNESS (HPI):\n\n\nVITAL SIGNS:\n\n\nPAST MEDICAL HISTORY:\n\n\nFAMILY HISTORY:\n\n\nSOCIAL HISTORY:\n\n\nREVIEW OF SYSTEMS:\n\n\nPHYSICAL EXAMINATION:\n\n\nASSESSMENT & PLAN (A&P):\n',
    },
    {
        id: 'soap-adult',
        name: 'SOAP Note — Adult (Standard / Episodic)',
        category: 'Core Primary Care',
        icon: '🩺',
        color: '#E3F2FD',
        accent: '#0284C7',
        content:
            'CHIEF COMPLAINT:\n\n\nHISTORY OF PRESENT ILLNESS (HPI):\n\n\nVITAL SIGNS:\n\n\nPHYSICAL EXAMINATION (PE):\n\n\nASSESSMENT & PLAN (A&P):\n',
    },
    {
        id: 'follow-up',
        name: 'Follow-Up / Chronic Disease Review',
        category: 'Core Primary Care',
        icon: '🔄',
        color: '#E8F5E9',
        accent: '#2E7D32',
        content:
            'REASON FOR VISIT:\n\n\nINTERVAL HISTORY:\n\n\nVITAL SIGNS & BIOMETRICS:\n\n\nCURRENT MEDICATIONS & ADHERENCE:\n\n\nPHYSICAL EXAMINATION:\n\n\nASSESSMENT & PLAN:\n',
    },
    {
        id: 'periodic-health',
        name: 'Periodic Health Review (CTFPHC Guidelines)',
        category: 'Preventive & Life-Stage',
        icon: '📋',
        color: '#F3E8FF',
        accent: '#7E22CE',
        content:
            'REASON FOR VISIT / PREVENTIVE REVIEW:\n\n\nRISK FACTORS & LIFESTYLE:\n\n\nPREVENTIVE SCREENING STATUS (FIT, MAMMOGRAPHY, CERVICAL, BONE DENSITY):\n\n\nIMMUNIZATIONS:\n\n\nVITAL SIGNS & BMI:\n\n\nPHYSICAL EXAMINATION:\n\n\nASSESSMENT & PREVENTIVE PLAN:\n',
    },
    {
        id: 'rourke-pediatric',
        name: 'Well-Baby / Well-Child (Rourke Baby Record)',
        category: 'Preventive & Life-Stage',
        icon: '👶',
        color: '#FEF3C7',
        accent: '#D97706',
        content:
            'AGE & VISIT INTERVAL (ROURKE BABY RECORD):\n\n\nNUTRITION & FEEDING:\n\n\nGROWTH PERCENTILES (WEIGHT, LENGTH, HEAD CIRCUMFERENCE):\n\n\nDEVELOPMENTAL MILESTONES (MOTOR, COGNITIVE, SPEECH, SOCIAL):\n\n\nPHYSICAL EXAMINATION:\n\n\nIMMUNIZATIONS & ANTICIPATORY GUIDANCE:\n\n\nASSESSMENT & PLAN:\n',
    },
    {
        id: 'geriatric-frailty',
        name: 'Comprehensive Geriatric & Frailty Assessment',
        category: 'Preventive & Life-Stage',
        icon: '🧓',
        color: '#E0E7FF',
        accent: '#4338CA',
        content:
            'REASON FOR ASSESSMENT:\n\n\nCOGNITIVE SCREENING (MOCA / MMSE):\n\n\nFUNCTIONAL STATUS (ADLS & IADLS):\n\n\nFALLS RISK & MOBILITY:\n\n\nMEDICATION REVIEW & POLYPHARMACY:\n\n\nVITAL SIGNS & ORTHOSTATICS:\n\n\nPHYSICAL EXAMINATION:\n\n\nASSESSMENT & MULTIDISCIPLINARY CARE PLAN:\n',
    },
    {
        id: 'diabetes-cdm',
        name: 'Diabetes Mellitus Care (Diabetes Canada)',
        category: 'Chronic Disease Management (CDM)',
        icon: '🩸',
        color: '#FEE2E2',
        accent: '#B91C1C',
        content:
            'REASON FOR VISIT:\n\n\nGLYCEMIC CONTROL (A1C, HOME SMBG, HYPOGLYCEMIA HISTORY):\n\n\nCARDIOVASCULAR & RENAL RISK (ACR, EGFR, STATIN):\n\n\nDIABETIC FOOT EXAMINATION (10G MONOFILAMENT, PULSES):\n\n\nMEDICATION RECONCILIATION:\n\n\nVITAL SIGNS (BP TARGET < 130/80):\n\n\nASSESSMENT & MANAGEMENT PLAN:\n',
    },
    {
        id: 'hypertension-cvd',
        name: 'Hypertension & Cardiovascular (Hypertension Canada)',
        category: 'Chronic Disease Management (CDM)',
        icon: '❤️',
        color: '#FFE4E6',
        accent: '#BE123C',
        content:
            'REASON FOR VISIT:\n\n\nBLOOD PRESSURE LOG (HOME BP / CLINIC BP):\n\n\nCARDIOVASCULAR RISK EVALUATION (FRAMINGHAM / CVS):\n\n\nLIFESTYLE MODIFICATIONS (DASH DIET, SODIUM, EXERCISE):\n\n\nCURRENT ANTIHYPERTENSIVE THERAPY & ADHERENCE:\n\n\nTARGETED EXAM & VITAL SIGNS:\n\n\nASSESSMENT & TREATMENT PLAN:\n',
    },
    {
        id: 'respiratory-cts',
        name: 'Asthma & COPD Action Visit (CTS Guidelines)',
        category: 'Chronic Disease Management (CDM)',
        icon: '🫁',
        color: '#E0F2FE',
        accent: '#0369A1',
        content:
            'REASON FOR VISIT:\n\n\nSYMPTOM CONTROL (ACT SCORE / CAT / MMRC):\n\n\nEXACERBATIONS & RESCUE INHALER FREQUENCY:\n\n\nTRIGGER IDENTIFICATION & INHALER TECHNIQUE:\n\n\nPULMONARY EXAM & PEAK FLOW / SPIROMETRY:\n\n\nASSESSMENT & ASTHMA/COPD ACTION PLAN:\n',
    },
    {
        id: 'chronic-pain-msk',
        name: 'Chronic Pain & MSK Management Visit',
        category: 'Chronic Disease Management (CDM)',
        icon: '🦴',
        color: '#FEF9C3',
        accent: '#A16207',
        content:
            'CHIEF COMPLAINT / PAIN REGION:\n\n\nPAIN ASSESSMENT & FUNCTIONAL IMPACT (PEG SCORE):\n\n\nNON-PHARMACOLOGIC & PHYSICAL THERAPY RESPONSE:\n\n\nMEDICATION RECONCILIATION & OPIOID RISK ASSESSMENT:\n\n\nFOCUSED MSK / NEUROLOGICAL EXAM:\n\n\nASSESSMENT & PAIN MANAGEMENT PLAN:\n',
    },
    {
        id: 'mental-health-canmat',
        name: 'Mental Health Assessment (CANMAT Guidelines)',
        category: 'Mental Health & Addictions',
        icon: '🧠',
        color: '#EDE9FE',
        accent: '#6D28D9',
        content:
            'CHIEF COMPLAINT & PRESENTING CRISIS:\n\n\nSYMPTOM BURDEN & SCORES (PHQ-9 / GAD-7):\n\n\nPSYCHOSOCIAL STRESSORS & SLEEP HYGIENE:\n\n\nSAFETY & SUICIDE RISK ASSESSMENT:\n\n\nMENTAL STATUS EXAMINATION (MSE):\n\n\nASSESSMENT & PSYCHOTHERAPY / PHARMACOTHERAPY PLAN:\n',
    },
    {
        id: 'addictions-oat',
        name: 'Substance Use & Addictions / OAT Encounter',
        category: 'Mental Health & Addictions',
        icon: '💊',
        color: '#F1F5F9',
        accent: '#475569',
        content:
            'SUBSTANCE INVOLVED & PATTERN OF USE:\n\n\nWITHDRAWAL & CRAVINGS ASSESSMENT:\n\n\nOPIOID AGONIST THERAPY (METHADONE / SUBOXONE / BUPRENORPHINE):\n\n\nHARM REDUCTION & TOXICOLOGY / UDS:\n\n\nPHYSICAL & MENTAL STATUS EXAM:\n\n\nASSESSMENT & RECOVERY CARE PLAN:\n',
    },
    {
        id: 'prenatal-sogc',
        name: 'Prenatal / Antenatal Visit (SOGC Guidelines)',
        category: "Women's Health & Perinatal",
        icon: '🤰',
        color: '#FCE7F3',
        accent: '#BE185D',
        content:
            'ESTIMATED GESTATIONAL AGE (EGA) & SYMPTOMS:\n\n\nFETAL MOVEMENT & MATERNAL WELLBEING:\n\n\nMATERNAL VITAL SIGNS (BP, WEIGHT):\n\n\nSYMPHYSIS-FUNDAL HEIGHT (SFH) & FETAL HEART RATE (FHR):\n\n\nINVESTIGATIONS & ULTRASOUND REVIEW:\n\n\nASSESSMENT & ANTENATAL CARE PLAN:\n',
    },
    {
        id: 'postpartum-6wk',
        name: 'Postpartum & Newborn 6-Week Examination',
        category: "Women's Health & Perinatal",
        icon: '🤱',
        color: '#FFEDD5',
        accent: '#C2410C',
        content:
            'REASON FOR VISIT / POSTPARTUM INTERVAL:\n\n\nMATERNAL PHYSICAL RECOVERY (LOCHIA, PERINEUM / INCISION):\n\n\nPERINATAL MOOD & EDINBURGH SCREENING (EPDS):\n\n\nINFANT FEEDING & PEDIATRIC PROGRESS:\n\n\nCONTRACEPTION & CERVICAL SCREENING:\n\n\nEXAMINATION (MATERNAL & INFANT):\n\n\nASSESSMENT & PLAN:\n',
    },
    {
        id: 'virtual-visit',
        name: 'Virtual Care / Telehealth Encounter (CMPA)',
        category: 'Virtual Care & Occupational',
        icon: '💻',
        color: '#EDE9FE',
        accent: '#4527A0',
        content:
            'VIRTUAL CARE INFORMED CONSENT & PATIENT LOCATION:\n\n\nTECHNOLOGY MODALITY (PHONE / VIDEO):\n\n\nCHIEF COMPLAINT & HISTORY:\n\n\nVIRTUAL OBSERVATION & REVIEW OF SYSTEMS:\n\n\nRED FLAGS & IN-PERSON CLINIC ESCALATION CRITERIA:\n\n\nASSESSMENT & TREATMENT PLAN:\n\nNOTE: This visit was conducted via telemedicine. Physical examination was not performed.\n',
    },
    {
        id: 'specialist-referral',
        name: 'Specialist Referral & Consultation Request',
        category: 'Virtual Care & Occupational',
        icon: '✉️',
        color: '#CCFBF1',
        accent: '#0F766E',
        content:
            'REFERRING PHYSICIAN & SPECIALTY REQUESTED:\n\n\nCLINICAL QUESTION / REASON FOR CONSULTATION:\n\n\nPERTINENT CLINICAL HISTORY & PRIOR INVESTIGATIONS:\n\n\nCURRENT MEDICATIONS & ALLERGIES:\n\n\nPREVIOUS TREATMENTS TRIED & OUTCOMES:\n\n\nPROVISIONAL DIAGNOSIS & CLINICAL URGENCY:\n',
    },
    {
        id: 'wcb-occupational',
        name: "Occupational Injury / Worker's Comp (WCB / WSIB)",
        category: 'Virtual Care & Occupational',
        icon: '👷',
        color: '#FEF08A',
        accent: '#854D0E',
        content:
            'WORKPLACE INJURY INCIDENT DETAILS & DATE:\n\n\nMECHANISM OF INJURY & SYMPTOM ONSET:\n\n\nOBJECTIVE PHYSICAL FINDINGS & FUNCTIONAL LIMITATIONS:\n\n\nMODIFIED DUTIES & WORK CAPABILITY ASSESSMENT:\n\n\nESTIMATED RETURN TO WORK TIMELINE:\n\n\nASSESSMENT, DIAGNOSIS & REHABILITATION PLAN:\n',
    },
    {
        id: 'other',
        name: 'Other / General',
        category: 'Other / General',
        icon: '📋',
        color: '#FFF8E1',
        accent: '#F57F17',
        content: 'VISIT TYPE:\n\n\nCHIEF COMPLAINT:\n\n\nVITAL SIGNS:\n\n\nHISTORY:\n\n\nEXAMINATION:\n\n\nASSESSMENT & PLAN:\n',
    },
]

function mapRow(row) {
    return {
        id: row.template_id,
        name: row.name,
        category: row.category || 'Core Primary Care',
        icon: row.icon || '',
        color: row.color || '',
        accent: row.accent || '',
        content: row.content,
    }
}

async function seedDefaultsForUser(userId) {
    for (const t of DEFAULT_TEMPLATES) {
        await pool.query(
            `INSERT INTO clinician_templates (user_id, template_id, name, icon, color, accent, content, category)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
             ON CONFLICT (user_id, template_id) DO UPDATE
             SET category = EXCLUDED.category WHERE clinician_templates.category IS NULL`,
            [userId, t.id, t.name, t.icon, t.color, t.accent, t.content, t.category || 'Core Primary Care'],
        )
    }
}

async function listTemplatesForUser(userId) {
    const { rows } = await pool.query(
        `SELECT template_id, name, icon, color, accent, content, category
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
  return (
    templates.find((t) => t.id === templateId) ||
    templates.find((t) => t.id === visitType) ||
    templates.find((t) => t.name.toLowerCase() === String(visitType || '').trim().toLowerCase()) ||
    templates.find((t) => t.name.toLowerCase().includes(String(visitType || '').trim().toLowerCase())) ||
    null
  )
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
                    `INSERT INTO clinician_templates (user_id, template_id, name, icon, color, accent, content, category, updated_at)
                     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, NOW())`,
                    [
                        req.user.id,
                        id.slice(0, 64),
                        name.slice(0, 255),
                        String(t.icon || '').slice(0, 16) || null,
                        String(t.color || '').slice(0, 32) || null,
                        String(t.accent || '').slice(0, 32) || null,
                        content,
                        String(t.category || 'Core Primary Care').slice(0, 128) || null,
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
