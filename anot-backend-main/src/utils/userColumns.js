const { columnExists } = require('./schemaDdl')

let rateColumnReady = null
let ehrColumnsReady = null
let aiNoteInstructionsColumnReady = null
let packageColumnsReady = null

async function hasRatePerNoteColumn() {
    if (rateColumnReady === null) {
        rateColumnReady = await columnExists('users', 'rate_per_note')
    }
    return rateColumnReady
}

async function hasEhrColumns() {
    if (ehrColumnsReady === null) {
        ehrColumnsReady = await columnExists('users', 'ehr_connection_id')
    }
    return ehrColumnsReady
}

async function hasAiNoteInstructionsColumn() {
    if (aiNoteInstructionsColumnReady === null) {
        aiNoteInstructionsColumnReady = await columnExists('users', 'ai_note_instructions')
    }
    return aiNoteInstructionsColumnReady
}

async function hasPackageColumns() {
    if (packageColumnsReady === null) {
        packageColumnsReady = await columnExists('users', 'package_name')
    }
    return packageColumnsReady
}

/** Comma-separated SELECT list for users (optional rate_per_note/EHR/ai_note_instructions/package columns when present). */
async function userSelectList(tableAlias = '') {
    const p = tableAlias ? `${tableAlias}.` : ''
    const cols = [
        `${p}id`,
        `${p}name`,
        `${p}email`,
        `${p}role`,
        `${p}specialty`,
        `${p}phone`,
        `${p}npi`,
        `${p}license`,
        `${p}status`,
    ]
    if (await hasRatePerNoteColumn()) cols.push(`${p}rate_per_note`)
    if (await hasEhrColumns()) cols.push(`${p}ehr_connection_id`, `${p}ehr_provider_id`)
    if (await hasAiNoteInstructionsColumn()) cols.push(`${p}ai_note_instructions`)
    if (await hasPackageColumns()) {
        cols.push(
            `${p}package_name`,
            `${p}package_amount_paid`,
            `${p}package_duration_days`,
            `${p}package_start_date`,
            `${p}package_end_date`,
            `${p}package_status`
        )
    }
    cols.push(`${p}clinic_code`, `${p}clinic_name`, `${p}ui_mode`, `${p}admin_modules`, `${p}created_at`)
    return cols.join(', ')
}

function invalidateUserColumnCache() {
    rateColumnReady = null
    ehrColumnsReady = null
    aiNoteInstructionsColumnReady = null
    packageColumnsReady = null
}

module.exports = {
    userSelectList,
    hasRatePerNoteColumn,
    hasEhrColumns,
    hasAiNoteInstructionsColumn,
    hasPackageColumns,
    invalidateUserColumnCache,
}
