/**
 * DEVELOPMENT-ONLY clinical data cleanup.
 *
 * Deletes ALL patients/visits/notes/grades and resets their sequences. This is
 * intentionally NOT exposed through the API (it was removed from the production
 * settings route for HIPAA §164.312(b) compliance). Run it manually against a
 * local/dev database only.
 *
 * Safety guards:
 *   - Refuses to run when NODE_ENV === 'production'.
 *   - Requires the explicit confirmation flag: --yes-i-understand
 *
 * Usage:
 *   node scripts/cleanup-dev.js --yes-i-understand
 */
const pool = require('../src/config/db')

async function cleanupDev() {
    if (process.env.NODE_ENV === 'production') {
        console.error('❌ Refusing to run cleanup-dev.js with NODE_ENV=production.')
        process.exitCode = 1
        return
    }

    if (!process.argv.includes('--yes-i-understand')) {
        console.error('❌ This deletes ALL clinical data. Re-run with: node scripts/cleanup-dev.js --yes-i-understand')
        process.exitCode = 1
        return
    }

    const client = await pool.connect()
    try {
        await client.query('BEGIN')

        // Delete in FK order: grades -> notes -> visits -> patients
        await client.query('DELETE FROM grades')
        await client.query('DELETE FROM notes')
        await client.query('DELETE FROM visits')
        await client.query('DELETE FROM patients')

        await client.query('ALTER SEQUENCE grades_id_seq RESTART WITH 1')
        await client.query('ALTER SEQUENCE notes_id_seq RESTART WITH 1')
        await client.query('ALTER SEQUENCE visits_id_seq RESTART WITH 1')
        await client.query('ALTER SEQUENCE patients_id_seq RESTART WITH 1')

        await client.query('COMMIT')
        console.log('✅ Dev database cleaned (grades, notes, visits, patients).')
    } catch (error) {
        await client.query('ROLLBACK')
        console.error('❌ Cleanup failed:', error.message)
        process.exitCode = 1
    } finally {
        client.release()
    }
}

cleanupDev().catch(console.error).finally(() => process.exit())
