const pool = require('../config/db')

async function columnExists(tableName, columnName) {
    const { rows } = await pool.query(
        `SELECT 1 FROM information_schema.columns
         WHERE table_schema = 'public' AND table_name = $1 AND column_name = $2`,
        [tableName, columnName],
    )
    return rows.length > 0
}

async function indexExists(indexName) {
    const { rows } = await pool.query(
        `SELECT 1 FROM pg_indexes WHERE schemaname = 'public' AND indexname = $1`,
        [indexName],
    )
    return rows.length > 0
}

/** Run DDL only when the column is missing; ignore owner errors if column appeared meanwhile. */
async function addColumnIfMissing(tableName, columnName, ddl) {
    if (await columnExists(tableName, columnName)) return
    try {
        await pool.query(ddl)
    } catch (err) {
        if (err.code === '42501') {
            if (await columnExists(tableName, columnName)) return
            console.warn(
                `[schema] Skipping ${tableName}.${columnName} — run scripts/fix-local-schema-gaps.ps1 as postgres`,
            )
            return
        }
        throw err
    }
}

/** Run DDL only when the index is missing; ignore owner errors if index appeared meanwhile. */
async function addIndexIfMissing(indexName, ddl) {
    if (await indexExists(indexName)) return
    try {
        await pool.query(ddl)
    } catch (err) {
        if (err.code === '42501' && (await indexExists(indexName))) return
        throw err
    }
}

module.exports = { columnExists, indexExists, addColumnIfMissing, addIndexIfMissing }
