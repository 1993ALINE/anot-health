// Seeds/repairs the core user accounts. Schema notes: this app stores the
// bcrypt hash in users.password (not password_hash) and uses a status
// ('active'/'inactive') column instead of is_active.
//
// SECURITY: Passwords are randomly generated at seed time (never hardcoded /
// committed) and every seeded account is flagged force_password_change = true,
// so the credential printed below is a one-time bootstrap secret only.
const bcrypt = require('bcryptjs');
const crypto = require('crypto');
const pool = require('./src/config/db');

const generateRandomPassword = () => {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789!@#$%^&*';
  let password = '';
  for (let i = 0; i < 16; i++) {
    password += chars.charAt(crypto.randomInt(chars.length));
  }
  return password;
};

const users = [
  { email: 'atiqur@anot.health', password: generateRandomPassword(), role: 'super_admin', name: 'Atiqur Rahman' },
  { email: 'fahad@anot.health', password: generateRandomPassword(), role: 'clinician', name: 'Dr. Fahad Rafi' },
  { email: 'shahib@anot.health', password: generateRandomPassword(), role: 'scribe', name: 'Shahib Hassan' },
  { email: 'farhan@anot.health', password: generateRandomPassword(), role: 'qps', name: 'Farhan Khan' },
  { email: 'ashikur@anot.health', password: generateRandomPassword(), role: 'admin', name: 'Ashikur Rahman' }
];

async function seedUsers() {
  const client = await pool.connect();
  try {
    // Ensure the force_password_change column exists before we rely on it.
    await client.query(
      'ALTER TABLE users ADD COLUMN IF NOT EXISTS force_password_change BOOLEAN DEFAULT false'
    );

    await client.query('BEGIN');

    for (const user of users) {
      const hashedPassword = await bcrypt.hash(user.password, 10);

      const result = await client.query(
        `UPDATE users SET password = $1, role = $2, name = $3, status = 'active', force_password_change = true WHERE email = $4 RETURNING id`,
        [hashedPassword, user.role, user.name, user.email]
      );

      if (result.rows.length === 0) {
        await client.query(
          `INSERT INTO users (email, password, role, name, status, force_password_change) VALUES ($1, $2, $3, $4, 'active', true)`,
          [user.email, hashedPassword, user.role, user.name]
        );
        console.log(`✅ Created: ${user.email} (${user.role})`);
      } else {
        console.log(`✅ Updated: ${user.email} (${user.role})`);
      }
    }

    // Defensive: make sure every seeded account is flagged for a forced change.
    await client.query(
      'UPDATE users SET force_password_change = true WHERE email = ANY($1)',
      [users.map(u => u.email)]
    );

    await client.query('COMMIT');
    console.log('\n✅ All users seeded successfully');

    // Print credentials ONCE to stdout (NOT persisted / logged). Save securely;
    // every account must change its password on first login.
    console.log('\n🔐 SEEDED USERS — Save these credentials securely (one-time display):');
    users.forEach(u => {
      console.log(`${u.email}: ${u.password} (${u.role})`);
    });
    console.log('\n⚠️  All accounts must change their password on first login.');
  } catch (error) {
    await client.query('ROLLBACK');
    console.error('❌ Seeding failed:', error.message);
    process.exitCode = 1;
  } finally {
    client.release();
  }
}

seedUsers().catch(console.error).finally(() => process.exit());
