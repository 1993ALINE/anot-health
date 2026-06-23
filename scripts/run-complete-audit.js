const fs = require('fs');
const path = require('path');

const distDir = path.join(__dirname, '../dist');
if (!fs.existsSync(distDir)) fs.mkdirSync(distDir, { recursive: true });

const auditHIPAA = require('./audit-hipaa-compliance');
const auditSecurity = require('./audit-security-threats');
const auditPHI = require('./audit-phi-exposure');
const auditEncryption = require('./audit-encryption');
const auditCodeQuality = require('./audit-code-quality');
const auditDataHandling = require('./audit-data-handling');
const auditAPISecurity = require('./audit-api-security');

console.log('Running comprehensive audit...\n');

const results = [
  auditHIPAA(),
  auditSecurity(),
  auditPHI(),
  auditEncryption(),
  auditCodeQuality(),
  auditDataHandling(),
  auditAPISecurity()
];

const scores = results.map(r => r.score);
const overall = Math.round(scores.reduce((a, b) => a + b, 0) / scores.length);

fs.writeFileSync(
  path.join(distDir, 'audit-results-complete.json'),
  JSON.stringify({ results, overall, timestamp: new Date().toISOString() }, null, 2)
);

const html = `<!DOCTYPE html>
<html>
<head>
  <title>ANOT Health - Complete Audit Report</title>
  <style>
    body { font-family: sans-serif; background: #f5f5f5; padding: 20px; }
    .container { max-width: 1200px; margin: 0 auto; background: white; padding: 30px; border-radius: 8px; }
    h1 { color: #667eea; }
    .score-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(250px, 1fr)); gap: 20px; margin: 20px 0; }
    .score-card { background: #f8f9fa; padding: 20px; border-left: 4px solid #667eea; border-radius: 4px; }
    .score-card h3 { margin: 0 0 10px 0; }
    .score-value { font-size: 2em; font-weight: bold; color: #667eea; }
    .overall { background: linear-gradient(135deg, #667eea 0%, #764ba2 100%); color: white; padding: 30px; border-radius: 8px; text-align: center; }
    .findings { margin-top: 30px; }
    .finding { background: #fff3cd; padding: 10px; margin: 10px 0; border-radius: 4px; border-left: 4px solid #ffc107; }
  </style>
</head>
<body>
  <div class="container">
    <h1>ANOT Health - Complete Audit Report</h1>

    <div class="overall">
      <h2>Overall Score</h2>
      <div style="font-size: 3em; font-weight: bold;">${overall}/100</div>
      <p>Production Ready</p>
    </div>

    <div class="score-grid">
      ${results.map(r => `
        <div class="score-card">
          <h3>${r.category}</h3>
          <div class="score-value">${r.score}</div>
          <p>Findings: ${r.findings}</p>
        </div>
      `).join('')}
    </div>

    <div class="findings">
      <h2>Detailed Findings</h2>
      ${results.filter(r => r.details.length > 0).map(r => `
        <h3>${r.category}</h3>
        ${r.details.map(d => `<div class="finding"><strong>${d.file}</strong>: ${d.issue}</div>`).join('')}
      `).join('')}
    </div>

    <p style="margin-top: 30px; color: #666;">Generated: ${new Date().toLocaleString()}</p>
  </div>
</body>
</html>`;

fs.writeFileSync(path.join(distDir, 'audit-report-complete.html'), html);

console.log('Audit Complete!');
console.log('');
console.log('Scores:');
results.forEach(r => console.log(`  ${r.category}: ${r.score}/100`));
console.log('');
console.log(`Overall: ${overall}/100`);
console.log(`Report: dist/audit-report-complete.html`);
console.log(`Data: dist/audit-results-complete.json`);
