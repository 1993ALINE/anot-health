const fs = require('fs');
const path = require('path');

function getAllFiles(dir, ext = '.js') {
  let files = [];
  try {
    const entries = fs.readdirSync(dir, { withFileTypes: true });
    for (const entry of entries) {
      const fullPath = path.join(dir, entry.name);
      if (entry.isDirectory() && !entry.name.startsWith('.') && entry.name !== 'node_modules') {
        files = files.concat(getAllFiles(fullPath, ext));
      } else if (entry.isFile() && fullPath.endsWith(ext)) {
        files.push(fullPath);
      }
    }
  } catch (e) {}
  return files;
}

function readFile(filePath) {
  try {
    return fs.readFileSync(filePath, 'utf8');
  } catch (err) {
    return '';
  }
}

function scoreCategory(findings, maxFindings = 10) {
  if (findings.length === 0) return 100;
  const severity = findings.reduce((sum, f) => sum + (f.severity || 1), 0);
  return Math.max(0, 100 - (severity * 5));
}

function generateReport(name, checks, findings) {
  return {
    category: name,
    timestamp: new Date().toISOString(),
    checks: checks,
    findings: findings.length,
    score: scoreCategory(findings),
    status: findings.length === 0 ? 'PASS' : 'FAIL',
    details: findings
  };
}

module.exports = { getAllFiles, readFile, scoreCategory, generateReport };
