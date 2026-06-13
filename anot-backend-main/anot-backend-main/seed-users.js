// Seeds/repairs the core user accounts. Schema notes: this app stores the
// bcrypt hash in users.password (not password_hash) and uses a status
// ('active'/'inactive') column instead of is_active.
const bcrypt = require('bcryptjs');
const pool = require('./src/config/db');

const users = [
  { email: 'atiqur@anot.health', password: 'password@2026', role: 'super_admin', name: 'Atiqur Rahman' },
  { email: 'fahad@anot.health', password: 'password@2026', role: 'clinician', name: 'Dr. Fahad Rafi' },
  { email: 'shahib@anot.health', password: 'password@2026', role: 'scribe', name: 'Shahib Hassan' },
  { email: 'farhan@anot.health', password: 'password@2026', role: 'qps', name: 'Farhan Khan' },
  { email: 'ashikur@anot.health', password: 'password@2026', role: 'admin', name: 'Ashikur Rahman' }
];

async function seedUsers() {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    for (const user of users) {
      const hashedPassword = await bcrypt.hash(user.password, 10);

      const result = await client.query(
        `UPDATE users SET password = $1, role = $2, name = $3, status = 'active' WHERE email = $4 RETURNING id`,
        [hashedPassword, user.role, user.name, user.email]
      );

      if (result.rows.length === 0) {
        await client.query(
          `INSERT INTO users (email, password, role, name, status) VALUES ($1, $2, $3, $4, 'active')`,
          [user.email, hashedPassword, user.role, user.name]
        );
        console.log(`✅ Created: ${user.email} (${user.role})`);
      } else {
        console.log(`✅ Updated: ${user.email} (${user.role})`);
      }
    }

    await client.query('COMMIT');
    console.log('\n✅ All users seeded successfully');
  } catch (error) {
    await client.query('ROLLBACK');
    console.error('❌ Seeding failed:', error.message);
    process.exitCode = 1;
  } finally {
    client.release();
  }
}

seedUsers().catch(console.error).finally(() => process.exit());
