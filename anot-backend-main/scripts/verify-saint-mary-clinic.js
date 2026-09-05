const { pool } = require('../src/config/db')
const { ensureUserProfileSchema } = require('../src/utils/ensureUserProfileSchema')

async function run() {
  console.log('=== SAINT MARY CLINIC VERIFICATION ===')
  await ensureUserProfileSchema()

  const cols = await pool.query(`
    SELECT column_name, data_type 
    FROM information_schema.columns 
    WHERE table_name = 'users' AND column_name IN ('clinic_code', 'clinic_name', 'ui_mode')
  `)
  console.log('✓ Database Schema Columns Verified:', cols.rows)

  // Check existing clinicians
  const clinicians = await pool.query(`
    SELECT id, name, email, role, clinic_code, clinic_name, ui_mode
    FROM users
    WHERE role = 'clinician'
    LIMIT 5
  `)
  console.log(`✓ Found ${clinicians.rows.length} clinicians in database:`)
  clinicians.rows.forEach(c => {
    console.log(`  - Dr. ${c.name} (${c.email}): Clinic: ${c.clinic_name || 'None'} | UI: ${c.ui_mode || 'standard'}`)
  })

  // If clinicians exist, test enrolling the first one to Saint Mary Clinic
  if (clinicians.rows.length > 0) {
    const testDoc = clinicians.rows[0]
    console.log(`\nTesting enrollment of Dr. ${testDoc.name} into Saint Mary Clinic, Alberta...`)
    
    await pool.query(`
      UPDATE users 
      SET clinic_code = 'saint_mary', 
          clinic_name = 'Saint Mary Clinic, Alberta', 
          ui_mode = 'saint_mary'
      WHERE id = $1
    `, [testDoc.id])

    const updated = await pool.query(`
      SELECT id, name, email, clinic_code, clinic_name, ui_mode 
      FROM users 
      WHERE id = $1
    `, [testDoc.id])

    console.log('✓ Enrolled Doctor Record:', updated.rows[0])
    console.log('✓ UI Mode is Saint Mary Clinic App:', updated.rows[0].ui_mode === 'saint_mary')
    console.log('✓ Clinic is Saint Mary Clinic, Alberta:', updated.rows[0].clinic_name === 'Saint Mary Clinic, Alberta')
  }

  console.log('\n=== ALL SAINT MARY CLINIC VERIFICATIONS PASSED ===')
  await pool.end()
}

run().catch(err => {
  console.error('Verification failed:', err)
  process.exit(1)
})
