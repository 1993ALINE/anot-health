/**
 * Load Test Monitor
 * 
 * Real-time monitoring of load test progress
 * Shows visit statuses, transcription progress, and system metrics
 */

const https = require('https');

const CONFIG = {
  apiBaseURL: process.env.API_BASE_URL || 'https://api.anot.health',
  refreshInterval: 5000, // 5 seconds
  testDate: new Date().toISOString().split('T')[0]
};

let authToken = null;

// Make API request
async function apiRequest(method, endpoint, data = null, token = null) {
  return new Promise((resolve, reject) => {
    const url = new URL(endpoint, CONFIG.apiBaseURL);
    
    const options = {
      method,
      hostname: url.hostname,
      port: 443,
      path: url.pathname + url.search,
      headers: {
        'Content-Type': 'application/json'
      }
    };
    
    if (token) {
      options.headers['Authorization'] = `Bearer ${token}`;
    }
    
    const req = https.request(options, (res) => {
      let responseData = '';
      
      res.on('data', (chunk) => {
        responseData += chunk;
      });
      
      res.on('end', () => {
        try {
          const parsed = responseData ? JSON.parse(responseData) : {};
          resolve({ status: res.statusCode, data: parsed });
        } catch (error) {
          resolve({ status: res.statusCode, data: responseData });
        }
      });
    });
    
    req.on('error', reject);
    
    if (data) {
      req.write(JSON.stringify(data));
    }
    
    req.end();
  });
}

// Login
async function login() {
  const email = process.env.TEST_EMAIL || 'load-test-doctor@anot.health';
  const password = process.env.TEST_PASSWORD || 'LoadTest@2026';
  
  try {
    const response = await apiRequest('POST', '/api/auth/login', {
      email,
      password
    });
    
    authToken = response.data.token;
    return true;
  } catch (error) {
    console.error('Login failed:', error.message);
    return false;
  }
}

// Get visit statistics
async function getVisitStats() {
  try {
    const response = await apiRequest('GET', `/api/visits?date=${CONFIG.testDate}`, null, authToken);
    
    const visits = response.data.visits || response.data || [];
    
    const stats = {
      total: visits.length,
      pending: 0,
      processing: 0,
      transcribed: 0,
      notesGenerated: 0,
      reviewed: 0,
      graded: 0,
      locked: 0
    };
    
    visits.forEach(visit => {
      const status = visit.status?.toLowerCase() || 'unknown';
      
      if (status.includes('pending')) stats.pending++;
      else if (status.includes('processing') || status.includes('transcribing')) stats.processing++;
      else if (status.includes('transcribed')) stats.transcribed++;
      else if (status.includes('notes') || status.includes('generated')) stats.notesGenerated++;
      else if (status.includes('review')) stats.reviewed++;
      else if (status.includes('graded')) stats.graded++;
      else if (status.includes('locked') || status.includes('complete')) stats.locked++;
    });
    
    return stats;
  } catch (error) {
    console.error('Failed to get visit stats:', error.message);
    return null;
  }
}

// Display dashboard
function displayDashboard(stats) {
  console.clear();
  
  console.log('═══════════════════════════════════════════════════════════');
  console.log('LOAD TEST MONITOR - REAL-TIME DASHBOARD');
  console.log(`Test Date: ${CONFIG.testDate}`);
  console.log(`Updated: ${new Date().toLocaleTimeString()}`);
  console.log('═══════════════════════════════════════════════════════════\n');
  
  if (!stats) {
    console.log('⚠️  Unable to fetch statistics. Check API connection.\n');
    return;
  }
  
  // Progress bar function
  const progressBar = (current, total, label) => {
    const percentage = total > 0 ? Math.round((current / total) * 100) : 0;
    const filled = Math.round(percentage / 5);
    const empty = 20 - filled;
    const bar = '█'.repeat(filled) + '░'.repeat(empty);
    const status = percentage === 100 ? '✅' : percentage > 0 ? '🔄' : '⏸️';
    
    return `${status} ${label.padEnd(20)} [${bar}] ${current}/${total} (${percentage}%)`;
  };
  
  console.log('VISIT STATISTICS:');
  console.log(`  Total Visits: ${stats.total}`);
  console.log('');
  
  console.log('WORKFLOW PROGRESS:\n');
  console.log(progressBar(stats.total - stats.pending, stats.total, '1. Visits Created'));
  console.log(progressBar(stats.processing + stats.transcribed + stats.notesGenerated + stats.reviewed + stats.graded + stats.locked, stats.total, '2. Audio Uploaded'));
  console.log(progressBar(stats.transcribed + stats.notesGenerated + stats.reviewed + stats.graded + stats.locked, stats.total, '3. Transcribed'));
  console.log(progressBar(stats.notesGenerated + stats.reviewed + stats.graded + stats.locked, stats.total, '4. Notes Generated'));
  console.log(progressBar(stats.reviewed + stats.graded + stats.locked, stats.total, '5. Scribe Reviewed'));
  console.log(progressBar(stats.graded + stats.locked, stats.total, '6. QPS Graded'));
  console.log(progressBar(stats.locked, stats.total, '7. Clinician Locked'));
  
  console.log('\n');
  
  // Status breakdown
  console.log('DETAILED STATUS:');
  console.log(`  ⏸️  Pending:          ${stats.pending}`);
  console.log(`  🔄 Processing:       ${stats.processing}`);
  console.log(`  📝 Transcribed:      ${stats.transcribed}`);
  console.log(`  ✍️  Notes Generated:  ${stats.notesGenerated}`);
  console.log(`  👁️  Scribe Reviewed:  ${stats.reviewed}`);
  console.log(`  ⭐ QPS Graded:       ${stats.graded}`);
  console.log(`  🔒 Locked:           ${stats.locked}`);
  
  console.log('\n');
  
  // Completion estimate
  if (stats.locked === stats.total && stats.total > 0) {
    console.log('🎉 LOAD TEST COMPLETE! All visits processed successfully.');
  } else if (stats.total > 0) {
    const remaining = stats.total - stats.locked;
    console.log(`📊 Progress: ${stats.locked}/${stats.total} complete (${remaining} remaining)`);
  }
  
  console.log('\n');
  console.log('Press Ctrl+C to exit');
  console.log('═══════════════════════════════════════════════════════════');
}

// Main monitoring loop
async function startMonitoring() {
  console.log('Starting load test monitor...\n');
  
  // Login
  const loggedIn = await login();
  if (!loggedIn) {
    console.error('Failed to login. Exiting.');
    process.exit(1);
  }
  
  console.log('✓ Logged in successfully\n');
  console.log('Monitoring load test progress...\n');
  
  // Initial display
  const stats = await getVisitStats();
  displayDashboard(stats);
  
  // Refresh every 5 seconds
  setInterval(async () => {
    const stats = await getVisitStats();
    displayDashboard(stats);
  }, CONFIG.refreshInterval);
}

// Handle graceful shutdown
process.on('SIGINT', () => {
  console.log('\n\nMonitoring stopped.');
  process.exit(0);
});

// Start monitoring
if (require.main === module) {
  startMonitoring().catch(error => {
    console.error('Monitor failed:', error.message);
    process.exit(1);
  });
}

module.exports = { startMonitoring };
