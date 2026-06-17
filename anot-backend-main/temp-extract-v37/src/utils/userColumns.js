const { columnExists } = require('./schemaDdl')

let rateColumnReady = null

async function hasRatePerNoteColumn() {
    if (rateColumnReady === null) {
        rateColumnReady = await columnExists('users', 'rate_per_note')
    }
    return rateColumnReady
}

/** Comma-separated SELECT list for users (optional rate_per_note when present). */
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
    cols.push(`${p}admin_modules`, `${p}created_at`)
    return cols.join(', ')
}

function invalidateUserColumnCache() {
    rateColumnReady = null
}

module.exports = { userSelectList, hasRatePerNoteColumn, invalidateUserColumnCache }
