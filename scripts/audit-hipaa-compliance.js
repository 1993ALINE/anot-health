const { getAllFiles, readFile, generateReport } = require('./audit-lib');
const path = require('path');

function auditHIPAA() {
  const backendDir = path.join(__dirname, '../anot-backend-main/anot-backend-main/src');
  const findings = [];
  const checks = { encryption: false, logging: false, access_control: false };

  const files = getAllFiles(backendDir, '.js');
  for (const file of files) {
    const content = readFile(file);
    if (content.includes('bcrypt')) checks.encryption = true;
    if (content.includes('auditLog') || content.includes('audit')) checks.logging = true;
    if (content.includes('protect') || content.includes('authorize')) checks.access_control = true;

    if (content.match(/password\s*=\s*['"]/i) && !content.includes('process.env')) {
      findings.push({
        file: file.replace(backendDir, ''),
        issue: 'Hardcoded password',
        severity: 3
      });
    }
  }

  return generateReport('HIPAA Compliance', checks, findings);
}

module.exports = auditHIPAA;
if (require.main === module) {
  const report = auditHIPAA();
  console.log('HIPAA:', report.score);
}
