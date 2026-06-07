#!/usr/bin/env node
require('dotenv').config();
const { Pool } = require('pg');

const pool = new Pool({
  connectionString: process.env.DATABASE_URL
});

/**
 * Extract bcrypt rounds from a bcrypt hash.
 * bcrypt hash format: $2a$10$...
 *                          ^^
 *                      rounds in base64
 */
function getBcryptRounds(hash) {
  if (!hash || !hash.startsWith('$2')) return null;
  const parts = hash.split('$');
  if (parts.length < 3) return null;
  return parseInt(parts[2], 10);
}

async function checkBcryptRounds() {
  try {
    console.log('Checking bcrypt rounds for all users...\n');
    
    const result = await pool.query(
      'SELECT id, email, role, password FROM users ORDER BY id'
    );

    if (result.rows.length === 0) {
      console.log('No users found in database.');
      await pool.end();
      process.exit(0);
    }

    const roundsStats = {};
    
    console.log('User ID | Email                          | Role       | Rounds');
    console.log('--------|--------------------------------|------------|-------');
    
    result.rows.forEach(user => {
      const rounds = getBcryptRounds(user.password);
      roundsStats[rounds] = (roundsStats[rounds] || 0) + 1;
      
      console.log(
        `${String(user.id).padEnd(7)} | ${user.email.padEnd(30)} | ${user.role.padEnd(10)} | ${rounds || 'N/A'}`
      );
    });

    console.log('\n' + '='.repeat(70));
    console.log('SUMMARY:');
    console.log('='.repeat(70));
    
    Object.entries(roundsStats).sort(([a], [b]) => b - a).forEach(([rounds, count]) => {
      const performance = rounds <= 10 ? '✅ FAST' : rounds <= 12 ? '⚠️  MEDIUM' : '❌ SLOW';
      console.log(`  ${rounds} rounds: ${count} user(s) ${performance}`);
    });

    console.log('\n📊 Performance Impact:');
    console.log('  10 rounds: ~100ms per login (optimal)');
    console.log('  12 rounds: ~400ms per login (slower)');
    console.log('  14 rounds: ~1600ms per login (very slow)');
    
    const hasSlowPasswords = Object.keys(roundsStats).some(r => parseInt(r) > 10);
    
    if (hasSlowPasswords) {
      console.log('\n⚠️  RECOMMENDATION:');
      console.log('  Some users have passwords hashed with >10 rounds.');
      console.log('  Consider implementing automatic password rehashing on login.');
      console.log('  See: anot-backend-main/LOGIN_PERFORMANCE_ANALYSIS.md');
    } else {
      console.log('\n✅ All passwords are using optimal bcrypt rounds!');
    }

    await pool.end();
    process.exit(0);
  } catch (error) {
    console.error('❌ Error:', error.message);
    await pool.end();
    process.exit(1);
  }
}

checkBcryptRounds();
