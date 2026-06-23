const { getAllFiles, readFile, generateReport } = require('./audit-lib');
const path = require('path');

function auditCodeQuality() {
  const backendDir = path.join(__dirname, '../anot-backend-main/anot-backend-main/src');
  const findings = [];

  const antiPatterns = [
    { pattern: /console\.debug/gi, issue: 'console.debug in production' },
    { pattern: /debugger;/gi, issue: 'debugger statement' },
    { pattern: /\/\/\s*TODO/gi, issue: 'TODO comment' },
    { pattern: /\.then\(\)\s*\.catch\(\s*err\s*=>\s*{\s*}\s*\)/gi, issue: 'empty catch' }
  ];

  const files = getAllFiles(backendDir, '.js');
  for (const file of files) {
    const content = readFile(file);
    for (const { pattern, issue } of antiPatterns) {
      if (pattern.test(content)) {
        findings.push({
          file: file.replace(backendDir, ''),
          issue: issue,
          severity: 1
        });
      }
    }
  }

  return generateReport('Code Quality', {}, findings);
}

module.exports = auditCodeQuality;
if (require.main === module) {
  const report = auditCodeQuality();
  console.log('Code Quality:', report.score);
}
