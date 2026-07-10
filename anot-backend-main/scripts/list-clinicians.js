#!/usr/bin/env node
require('dotenv').config()
const pool = require('../src/config/db')

async function listClinicians() {
  try {
    const result = await pool.query(
      `SELECT id, email, role, status, name 
       FROM users 
       WHERE role = 'clinician'
       ORDER BY id
       LIMIT 20`
    )
    
    console.log('\n═══════════════════════════════════════════════════════════')
    console.log('CLINICIAN ACCOUNTS')
    console.log('═══════════════════════════════════════════════════════════\n')
    
    if (result.rows.length === 0) {
      console.log('❌ No clinician accounts found!')
    } else {
      console.log(`Found ${result.rows.length} clinician(s):\n`)
      result.rows.forEach(user => {
        const statusIcon = user.status === 'active' ? '✅' : '⚠️'
        console.log(`${statusIcon} ${user.email}`)
        console.log(`   ID: ${user.id}`)
        console.log(`   Name: ${user.name}`)
        console.log(`   Status: ${user.status}`)
        console.log('')
      })
    }
    
    console.log('═══════════════════════════════════════════════════════════')
    
  } catch (error) {
    console.error('Error listing clinicians:', error.message)
  } finally {
    await pool.end()
  }
}

listClinicians()
