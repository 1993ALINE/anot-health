const { Pool } = require("pg");

const pool = new Pool({
  host: "anot-postgres.c5casia24do8.ap-southeast-1.rds.amazonaws.com",
  user: "anot_app",
  password: "paubO8YPhQyB9rBUYrbBwTCUS4ab0tM4",
  database: "anot",
  port: 5432,
  ssl: { rejectUnauthorized: false }
});

async function cleanup() {
  const client = await pool.connect();
  try {
    console.log("🗑️  Starting data cleanup...\n");
    
    await client.query("DELETE FROM notes WHERE id > 0");
    console.log("✅ Deleted notes");
    
    await client.query("DELETE FROM visits WHERE id > 0");
    console.log("✅ Deleted visits");
    
    await client.query("DELETE FROM patients WHERE id > 0");
    console.log("✅ Deleted patients");
    
    await client.query("UPDATE audio_files SET deleted_at = NOW() WHERE id > 0");
    console.log("✅ Marked audio files as deleted");
    
    await client.query("DELETE FROM users WHERE role NOT IN ('admin', 'super_admin')");
    console.log("✅ Deleted non-admin users");
    
    await client.query("ALTER SEQUENCE patients_id_seq RESTART WITH 1");
    await client.query("ALTER SEQUENCE visits_id_seq RESTART WITH 1");
    await client.query("ALTER SEQUENCE notes_id_seq RESTART WITH 1");
    await client.query("ALTER SEQUENCE users_id_seq RESTART WITH 100");
    await client.query("ALTER SEQUENCE audio_files_id_seq RESTART WITH 1");
    console.log("✅ Reset sequences");
    
    console.log("\n📊 Verification:");
    const results = await client.query(`
      SELECT 'Patients' as type, COUNT(*) as count FROM patients
      UNION ALL
      SELECT 'Visits', COUNT(*) FROM visits
      UNION ALL
      SELECT 'Notes', COUNT(*) FROM notes
      UNION ALL
      SELECT 'Admin users', COUNT(*) FROM users WHERE role IN ('admin', 'super_admin')
      UNION ALL
      SELECT 'Total users', COUNT(*) FROM users
    `);
    
    results.rows.forEach(row => {
      console.log(`   ${row.type}: ${row.count}`);
    });
    
    console.log("\n✅ CLEANUP COMPLETE!");
    
  } catch (err) {
    console.error("❌ Error:", err.message);
  } finally {
    client.release();
    await pool.end();
  }
}

cleanup();
