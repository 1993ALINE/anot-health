const { getAllFiles, readFile, generateReport } = require('./audit-lib');
const path = require('path');

function auditAPISecurity() {
  const backendDir = path.join(__dirname, '../anot-backend-main/anot-backend-main/src');
  const findings = [];
  const checks = { validation: false, authentication: false, authorization: false };

  const files = getAllFiles(backendDir, '.js');
  for (const file of files) {
    const content = readFile(file);
    if (content.includes('validate')) checks.validation = true;
    if (content.includes('jwt') || content.includes('token')) checks.authentication = true;
    if (content.includes('protect')) checks.authorization = true;
  }

  return generateReport('API Security', checks, findings);
}

module.exports = auditAPISecurity;
if (require.main === module) {
  const report = auditAPISecurity();
  console.log('API Security:', report.score);
}
