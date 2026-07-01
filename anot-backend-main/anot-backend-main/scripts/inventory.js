const mysql = require("mysql2/promise");

(async () => {
  try {
    const conn = await mysql.createConnection({
      host: "anot-postgres.c5casia24do8.ap-southeast-1.rds.amazonaws.com",
      user: "admin",
      password: process.env.DB_PASSWORD || "YOUR_PASSWORD",
      database: "anot"
    });

    const tables = ["users", "patients", "visits", "notes", "grades", "sessions", "audit_log"];
    
    console.log("[inventory] Database Summary:\n");
    
    for (const table of tables) {
      const [rows] = await conn.execute(`SELECT COUNT(*) as count FROM ${table}`);
      console.log(`${table}: ${rows[0].count}`);
    }
    
    const [users] = await conn.execute("SELECT id, email, role FROM users");
    console.log("\nUsers:");
    users.forEach(u => console.log(`  - ${u.email} (${u.role})`));
    
    conn.end();
  } catch (error) {
    console.error("Error:", error.message);
  }
})();
