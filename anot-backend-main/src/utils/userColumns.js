const { columnExists } = require('./schemaDdl')

let rateColumnReady = null
let ehrColumnsReady = null

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

/** Comma-separated SELECT list for users (optional rate_per_note/EHR columns when present). */
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
    cols.push(`${p}clinic_code`, `${p}clinic_name`, `${p}ui_mode`, `${p}admin_modules`, `${p}created_at`)
    return cols.join(', ')
}

function invalidateUserColumnCache() {
    rateColumnReady = null
    ehrColumnsReady = null
}

module.exports = { userSelectList, hasRatePerNoteColumn, hasEhrColumns, invalidateUserColumnCache }
