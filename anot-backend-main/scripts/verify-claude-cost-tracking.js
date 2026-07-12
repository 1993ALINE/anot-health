#!/usr/bin/env node
/**
 * Verify Claude Cost Tracking Implementation
 * 
 * Checks that all components are properly installed and configured
 * 
 * Usage:
 *   node scripts/verify-claude-cost-tracking.js
 */

require('dotenv').config({ path: require('path').join(__dirname, '../.env') });
const fs = require('fs');
const path = require('path');

const colors = {
  reset: '\x1b[0m',
  red: '\x1b[31m',
  green: '\x1b[32m',
  yellow: '\x1b[33m',
  blue: '\x1b[34m',
  bold: '\x1b[1m'
};

function colorize(color, text) {
  return `${colors[color]}${text}${colors.reset}`;
}

function checkmark() {
  return colorize('green', '✅');
}

function crossmark() {
  return colorize('red', '❌');
}

function warning() {
  return colorize('yellow', '⚠️ ');
}

console.log('\n' + colorize('bold', '═══════════════════════════════════════════════════════════'));
console.log(colorize('bold', '     CLAUDE COST TRACKING - VERIFICATION'));
console.log(colorize('bold', '═══════════════════════════════════════════════════════════\n'));

let allPassed = true;

// Check 1: Core service file
console.log(colorize('blue', '1. Checking Core Service File...'));
const servicePath = path.join(__dirname, '../src/services/claudeService.js');
if (fs.existsSync(servicePath)) {
  const content = fs.readFileSync(servicePath, 'utf8');
  
  const checks = [
    { name: 'CLAUDE_COSTS constant', pattern: 'CLAUDE_COSTS', found: content.includes('CLAUDE_COSTS') },
    { name: 'trackCost function', pattern: 'trackCost', found: content.includes('async function trackCost') },
    { name: 'checkRateLimit function', pattern: 'checkRateLimit', found: content.includes('function checkRateLimit') },
    { name: 'checkCostLimit function', pattern: 'checkCostLimit', found: content.includes('function checkCostLimit') },
    { name: 'getCostStats function', pattern: 'getCostStats', found: content.includes('function getCostStats') },
    { name: 'resetDailyCost function', pattern: 'resetDailyCost', found: content.includes('function resetDailyCost') }
  ];
  
  checks.forEach(check => {
    if (check.found) {
      console.log(`   ${checkmark()} ${check.name}`);
    } else {
      console.log(`   ${crossmark()} ${check.name} - NOT FOUND`);
      allPassed = false;
    }
  });
} else {
  console.log(`   ${crossmark()} claudeService.js not found`);
  allPassed = false;
}
console.log('');

// Check 2: Database migration
console.log(colorize('blue', '2. Checking Database Migration...'));
const migrationPath = path.join(__dirname, '../src/migrations/add_claude_usage_log.sql');
if (fs.existsSync(migrationPath)) {
  console.log(`   ${checkmark()} Migration file exists`);
  
  const content = fs.readFileSync(migrationPath, 'utf8');
  if (content.includes('CREATE TABLE') && content.includes('claude_usage_log')) {
    console.log(`   ${checkmark()} Table creation SQL found`);
  } else {
    console.log(`   ${crossmark()} Table creation SQL not found`);
    allPassed = false;
  }
  
  if (content.includes('CREATE VIEW') && content.includes('claude_daily_costs')) {
    console.log(`   ${checkmark()} Daily costs view SQL found`);
  } else {
    console.log(`   ${warning()}Daily costs view SQL not found (optional)`);
  }
} else {
  console.log(`   ${crossmark()} Migration file not found`);
  allPassed = false;
}
console.log('');

// Check 3: API routes
console.log(colorize('blue', '3. Checking API Routes...'));
const routesPath = path.join(__dirname, '../src/routes/claude-stats.js');
if (fs.existsSync(routesPath)) {
  console.log(`   ${checkmark()} claude-stats.js exists`);
  
  const content = fs.readFileSync(routesPath, 'utf8');
  const endpoints = [
    { name: '/current', pattern: "'/current'" },
    { name: '/today', pattern: "'/today'" },
    { name: '/daily', pattern: "'/daily'" },
    { name: '/monthly', pattern: "'/monthly'" },
    { name: '/reset', pattern: "'/reset'" }
  ];
  
  endpoints.forEach(endpoint => {
    if (content.includes(endpoint.pattern)) {
      console.log(`   ${checkmark()} Endpoint ${endpoint.name}`);
    } else {
      console.log(`   ${crossmark()} Endpoint ${endpoint.name} - NOT FOUND`);
      allPassed = false;
    }
  });
} else {
  console.log(`   ${crossmark()} claude-stats.js not found`);
  allPassed = false;
}
console.log('');

// Check 4: Server registration
console.log(colorize('blue', '4. Checking Server Route Registration...'));
const serverPath = path.join(__dirname, '../src/server.js');
if (fs.existsSync(serverPath)) {
  const content = fs.readFileSync(serverPath, 'utf8');
  
  if (content.includes("require('./routes/claude-stats')")) {
    console.log(`   ${checkmark()} Route registered in server.js`);
  } else {
    console.log(`   ${crossmark()} Route NOT registered in server.js`);
    console.log(`   ${warning()}Add this line to server.js:`);
    console.log(`   app.use('/api/claude-stats', require('./routes/claude-stats'))`);
    allPassed = false;
  }
} else {
  console.log(`   ${crossmark()} server.js not found`);
  allPassed = false;
}
console.log('');

// Check 5: Monitoring script
console.log(colorize('blue', '5. Checking Monitoring Script...'));
const monitorPath = path.join(__dirname, '../scripts/monitor-claude-costs.js');
if (fs.existsSync(monitorPath)) {
  console.log(`   ${checkmark()} monitor-claude-costs.js exists`);
} else {
  console.log(`   ${crossmark()} monitor-claude-costs.js not found`);
  allPassed = false;
}
console.log('');

// Check 6: Environment variables
console.log(colorize('blue', '6. Checking Environment Configuration...'));

const envVars = [
  { name: 'CLAUDE_DAILY_LIMIT', value: process.env.CLAUDE_DAILY_LIMIT, default: '5.00' },
  { name: 'CLAUDE_ENFORCE_CAP', value: process.env.CLAUDE_ENFORCE_CAP, default: 'false' },
  { name: 'CLAUDE_RATE_LIMIT', value: process.env.CLAUDE_RATE_LIMIT, default: '30' }
];

envVars.forEach(envVar => {
  if (envVar.value) {
    console.log(`   ${checkmark()} ${envVar.name} = ${envVar.value}`);
  } else {
    console.log(`   ${warning()}${envVar.name} not set (will use default: ${envVar.default})`);
  }
});
console.log('');

// Check 7: Package.json scripts
console.log(colorize('blue', '7. Checking npm Scripts...'));
const packagePath = path.join(__dirname, '../package.json');
if (fs.existsSync(packagePath)) {
  const packageJson = JSON.parse(fs.readFileSync(packagePath, 'utf8'));
  const scripts = packageJson.scripts || {};
  
  const expectedScripts = [
    { name: 'claude:costs', cmd: 'monitor-claude-costs.js' },
    { name: 'claude:watch', cmd: 'monitor-claude-costs.js --watch' },
    { name: 'claude:alert', cmd: 'monitor-claude-costs.js --watch --alert' }
  ];
  
  expectedScripts.forEach(script => {
    if (scripts[script.name] && scripts[script.name].includes('monitor-claude-costs')) {
      console.log(`   ${checkmark()} npm run ${script.name}`);
    } else {
      console.log(`   ${crossmark()} npm run ${script.name} - NOT FOUND`);
      allPassed = false;
    }
  });
} else {
  console.log(`   ${crossmark()} package.json not found`);
  allPassed = false;
}
console.log('');

// Check 8: Documentation
console.log(colorize('blue', '8. Checking Documentation...'));
const docs = [
  { name: 'CLAUDE_COST_TRACKING.md', path: '../CLAUDE_COST_TRACKING.md' },
  { name: 'CLAUDE_COST_CONTROL_SETUP.md', path: '../../CLAUDE_COST_CONTROL_SETUP.md' },
  { name: 'CLAUDE_COST_IMPLEMENTATION_SUMMARY.md', path: '../../CLAUDE_COST_IMPLEMENTATION_SUMMARY.md' }
];

docs.forEach(doc => {
  const docPath = path.join(__dirname, doc.path);
  if (fs.existsSync(docPath)) {
    console.log(`   ${checkmark()} ${doc.name}`);
  } else {
    console.log(`   ${warning()}${doc.name} not found`);
  }
});
console.log('');

// Database check (optional)
console.log(colorize('blue', '9. Checking Database (optional)...'));
console.log(`   ${warning()}Run this command to check if table exists:`);
console.log(`   psql -d anot_db -c "\\d claude_usage_log"`);
console.log('');

// Summary
console.log(colorize('bold', '═══════════════════════════════════════════════════════════'));
if (allPassed) {
  console.log(colorize('green', '✅ ALL CHECKS PASSED!'));
  console.log('');
  console.log('Next steps:');
  console.log('  1. Run database migration:');
  console.log('     psql -d anot_db -f src/migrations/add_claude_usage_log.sql');
  console.log('');
  console.log('  2. Restart server:');
  console.log('     npm run dev');
  console.log('');
  console.log('  3. Test monitoring:');
  console.log('     npm run claude:costs');
} else {
  console.log(colorize('red', '❌ SOME CHECKS FAILED'));
  console.log('');
  console.log('Please review the failed checks above and fix the issues.');
  console.log('Refer to CLAUDE_COST_CONTROL_SETUP.md for installation instructions.');
}
console.log(colorize('bold', '═══════════════════════════════════════════════════════════\n'));

process.exit(allPassed ? 0 : 1);
