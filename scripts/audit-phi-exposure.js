const { getAllFiles, readFile, generateReport } = require('./audit-lib');
const path = require('path');

function auditPHI() {
  const backendDir = path.join(__dirname, '../anot-backend-main/anot-backend-main/src');
  const findings = [];

  const phiPatterns = [
    /console\.log\(user/i,
    /console\.log\(patient/i,
    /console\.log\(data/i,
    /console\.error\(response/i
  ];

  const files = getAllFiles(backendDir, '.js');
  for (const file of files) {
    const content = readFile(file);
    for (const pattern of phiPatterns) {
      if (pattern.test(content)) {
        findings.push({
          file: file.replace(backendDir, ''),
          issue: 'Potential PHI in logs',
          severity: 2
        });
      }
    }
  }

  return generateReport('PHI Exposure', {}, findings);
}

module.exports = auditPHI;
if (require.main === module) {
  const report = auditPHI();
  console.log('PHI:', report.score);
}
