const { getAllFiles, readFile, generateReport } = require('./audit-lib');
const path = require('path');

function auditDataHandling() {
  const backendDir = path.join(__dirname, '../anot-backend-main/anot-backend-main/src');
  const findings = [];
  const checks = { retention: false, deletion: false, anonymization: false };

  const files = getAllFiles(backendDir, '.js');
  for (const file of files) {
    const content = readFile(file);
    if (content.includes('retention') || content.includes('lifecycle')) checks.retention = true;
    if (content.includes('delete')) checks.deletion = true;
    if (content.includes('anonymize')) checks.anonymization = true;
  }

  return generateReport('Data Handling', checks, findings);
}

module.exports = auditDataHandling;
if (require.main === module) {
  const report = auditDataHandling();
  console.log('Data Handling:', report.score);
}
