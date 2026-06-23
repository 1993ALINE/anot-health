const { getAllFiles, readFile, generateReport } = require('./audit-lib');
const path = require('path');

function auditEncryption() {
  const backendDir = path.join(__dirname, '../anot-backend-main/anot-backend-main/src');
  const findings = [];
  const checks = { bcrypt: false, crypto: false, https: false };

  const files = getAllFiles(backendDir, '.js');
  for (const file of files) {
    const content = readFile(file);
    if (content.includes('bcrypt')) checks.bcrypt = true;
    if (content.includes('crypto')) checks.crypto = true;
    if (content.includes('https') || content.includes('tls')) checks.https = true;
  }

  return generateReport('Encryption', checks, findings);
}

module.exports = auditEncryption;
if (require.main === module) {
  const report = auditEncryption();
  console.log('Encryption:', report.score);
}
