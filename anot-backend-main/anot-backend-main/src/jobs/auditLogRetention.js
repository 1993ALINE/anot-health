/**
 * Audit Log Retention Policy - ISSUE-022 Fix
 * HIPAA Requirement: 6 years retention
 */

const { pool } = require('../config/db');
const AWS = require('aws-sdk');
const s3 = new AWS.S3();

const HOT_STORAGE_DAYS = 90; // Keep in DB for 90 days
const TOTAL_RETENTION_YEARS = 6; // HIPAA requirement

async function archiveOldLogs() {
  console.log('Starting audit log archival...');
  
  const cutoffDate = new Date();
  cutoffDate.setDate(cutoffDate.getDate() - HOT_STORAGE_DAYS);
  
  // Get logs older than 90 days
  const result = await pool.query(
    'SELECT * FROM audit_logs WHERE created_at < $1 ORDER BY created_at',
    [cutoffDate]
  );
  
  if (result.rows.length === 0) {
    console.log('No logs to archive');
    return;
  }
  
  // Archive to S3
  const archiveKey = `audit-logs/archive-${cutoffDate.toISOString().split('T')[0]}.json`;
  await s3.putObject({
    Bucket: process.env.AUDIT_ARCHIVE_BUCKET,
    Key: archiveKey,
    Body: JSON.stringify(result.rows),
    ServerSideEncryption: 'AES256',
    StorageClass: 'GLACIER' // Cold storage
  }).promise();
  
  // Delete from database
  await pool.query('DELETE FROM audit_logs WHERE created_at < $1', [cutoffDate]);
  
  console.log(`[OK] Archived ${result.rows.length} logs to S3: ${archiveKey}`);
}

// Run daily
setInterval(archiveOldLogs, 24 * 60 * 60 * 1000);

module.exports = { archiveOldLogs };
