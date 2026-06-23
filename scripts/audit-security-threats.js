const { getAllFiles, readFile, generateReport } = require('./audit-lib');
const path = require('path');

function auditSecurity() {
  const backendDir = path.join(__dirname, '../anot-backend-main/anot-backend-main/src');
  const findings = [];
  const checks = { csrf: false, rateLimit: false, validation: false };

  const files = getAllFiles(backendDir, '.js');
  for (const file of files) {
    const content = readFile(file);
    if (content.includes('csrf') || content.includes('CSRF')) checks.csrf = true;
    if (content.includes('rateLimit')) checks.rateLimit = true;
    if (content.includes('validate')) checks.validation = true;

    if (content.includes('eval(')) {
      findings.push({
        file: file.replace(backendDir, ''),
        issue: 'eval() detected - security risk',
        severity: 3
      });
    }
  }

  return generateReport('Security Threats', checks, findings);
}

module.exports = auditSecurity;
if (require.main === module) {
  const report = auditSecurity();
  console.log('Security:', report.score);
}
