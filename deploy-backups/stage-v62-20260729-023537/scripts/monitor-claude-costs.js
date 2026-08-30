#!/usr/bin/env node
/**
 * Claude Cost Monitor
 * 
 * Monitors Claude API usage and costs in real-time
 * 
 * Usage:
 *   node scripts/monitor-claude-costs.js
 *   node scripts/monitor-claude-costs.js --watch     # Watch mode (updates every 30s)
 *   node scripts/monitor-claude-costs.js --alert 5   # Alert if daily cost exceeds $5
 */

require('dotenv').config({ path: require('path').join(__dirname, '../.env') });
const pool = require('../src/config/db');

const WATCH_MODE = process.argv.includes('--watch');
const ALERT_THRESHOLD = parseFloat(process.argv[process.argv.indexOf('--alert') + 1] || '5.00');

// Colors for terminal output
const colors = {
  reset: '\x1b[0m',
  red: '\x1b[31m',
  green: '\x1b[32m',
  yellow: '\x1b[33m',
  blue: '\x1b[34m',
  magenta: '\x1b[35m',
  cyan: '\x1b[36m',
  bold: '\x1b[1m'
};

function colorize(color, text) {
  return `${colors[color]}${text}${colors.reset}`;
}

async function getCostStats() {
  try {
    // Today's stats
    const todayResult = await pool.query(
      `SELECT 
        COUNT(*) as calls,
        SUM(input_tokens) as input_tokens,
        SUM(output_tokens) as output_tokens,
        SUM(cache_read_tokens) as cache_hits,
        SUM(cost) as total_cost,
        MIN(created_at) as first_call,
        MAX(created_at) as last_call
       FROM claude_usage_log 
       WHERE DATE(created_at) = CURRENT_DATE`
    );
    
    // This month's stats
    const monthResult = await pool.query(
      `SELECT 
        COUNT(*) as calls,
        SUM(cost) as total_cost
       FROM claude_usage_log 
       WHERE DATE_TRUNC('month', created_at) = DATE_TRUNC('month', CURRENT_DATE)`
    );
    
    // Last 7 days
    const weekResult = await pool.query(
      `SELECT 
        DATE(created_at) as date,
        COUNT(*) as calls,
        SUM(cost) as total_cost
       FROM claude_usage_log 
       WHERE created_at > NOW() - INTERVAL '7 days'
       GROUP BY DATE(created_at)
       ORDER BY date DESC`
    );
    
    // Recent calls (last 10)
    const recentResult = await pool.query(
      `SELECT 
        visit_id,
        input_tokens,
        output_tokens,
        cache_read_tokens,
        cost,
        created_at
       FROM claude_usage_log 
       ORDER BY created_at DESC 
       LIMIT 10`
    );
    
    return {
      today: todayResult.rows[0],
      month: monthResult.rows[0],
      week: weekResult.rows,
      recent: recentResult.rows
    };
    
  } catch (error) {
    console.error('Error fetching cost stats:', error.message);
    return null;
  }
}

function formatCurrency(amount) {
  const num = parseFloat(amount) || 0;
  return `$${num.toFixed(4)}`;
}

function formatNumber(num) {
  return parseInt(num || 0).toLocaleString();
}

function displayStats(stats) {
  if (!stats) {
    console.error('❌ Failed to fetch statistics');
    return;
  }
  
  const today = stats.today;
  const month = stats.month;
  
  console.clear();
  console.log('\n' + colorize('bold', '═══════════════════════════════════════════════════════════'));
  console.log(colorize('bold', '               CLAUDE API COST MONITOR'));
  console.log(colorize('bold', '═══════════════════════════════════════════════════════════\n'));
  
  // Today's Stats
  console.log(colorize('cyan', '📊 TODAY\'S USAGE'));
  console.log('─────────────────────────────────────────────────────────');
  
  const todayCost = parseFloat(today.total_cost) || 0;
  const todayCalls = parseInt(today.calls) || 0;
  
  let costColor = 'green';
  if (todayCost >= ALERT_THRESHOLD) {
    costColor = 'red';
    console.log(colorize('red', `⚠️  ALERT: Daily cost exceeds $${ALERT_THRESHOLD.toFixed(2)}!\n`));
  } else if (todayCost >= ALERT_THRESHOLD * 0.8) {
    costColor = 'yellow';
  }
  
  console.log(`   Cost:         ${colorize(costColor, formatCurrency(todayCost))}`);
  console.log(`   API Calls:    ${formatNumber(todayCalls)}`);
  console.log(`   Input Tokens: ${formatNumber(today.input_tokens)}`);
  console.log(`   Output Tokens: ${formatNumber(today.output_tokens)}`);
  console.log(`   Cache Hits:   ${formatNumber(today.cache_hits)}`);
  
  if (todayCalls > 0) {
    const avgCost = todayCost / todayCalls;
    console.log(`   Avg/Call:     ${formatCurrency(avgCost)}`);
  }
  
  if (today.first_call) {
    console.log(`   First Call:   ${new Date(today.first_call).toLocaleTimeString()}`);
    console.log(`   Last Call:    ${new Date(today.last_call).toLocaleTimeString()}`);
  }
  
  console.log('');
  
  // This Month
  console.log(colorize('cyan', '📅 THIS MONTH'));
  console.log('─────────────────────────────────────────────────────────');
  console.log(`   Cost:         ${formatCurrency(month.total_cost)}`);
  console.log(`   API Calls:    ${formatNumber(month.calls)}`);
  console.log('');
  
  // Last 7 Days
  console.log(colorize('cyan', '📈 LAST 7 DAYS'));
  console.log('─────────────────────────────────────────────────────────');
  if (stats.week.length > 0) {
    stats.week.forEach(day => {
      const date = new Date(day.date).toLocaleDateString('en-US', { 
        month: 'short', 
        day: 'numeric' 
      });
      const cost = formatCurrency(day.total_cost);
      const calls = parseInt(day.calls);
      console.log(`   ${date}: ${cost} (${calls} calls)`);
    });
  } else {
    console.log('   No usage in last 7 days');
  }
  console.log('');
  
  // Recent Calls
  console.log(colorize('cyan', '🕐 RECENT API CALLS (Last 10)'));
  console.log('─────────────────────────────────────────────────────────');
  if (stats.recent.length > 0) {
    stats.recent.forEach((call, idx) => {
      const time = new Date(call.created_at).toLocaleTimeString();
      const cost = formatCurrency(call.cost);
      const tokens = `${call.input_tokens}→${call.output_tokens}`;
      const cache = call.cache_read_tokens > 0 ? colorize('green', ' ⚡') : '';
      console.log(`   ${idx + 1}. Visit ${call.visit_id} | ${time} | ${cost} | ${tokens}${cache}`);
    });
  } else {
    console.log('   No recent calls');
  }
  
  console.log('\n' + colorize('bold', '═══════════════════════════════════════════════════════════'));
  console.log(colorize('yellow', `Alert Threshold: $${ALERT_THRESHOLD.toFixed(2)}/day`));
  
  if (WATCH_MODE) {
    console.log(colorize('blue', 'Watch mode: Updates every 30 seconds (Ctrl+C to exit)'));
  }
  
  console.log('');
}

async function main() {
  try {
    // Check database connection
    await pool.query('SELECT 1');
    
    // Check if table exists
    const tableCheck = await pool.query(
      `SELECT EXISTS (
        SELECT FROM information_schema.tables 
        WHERE table_name = 'claude_usage_log'
      )`
    );
    
    if (!tableCheck.rows[0].exists) {
      console.error('❌ claude_usage_log table does not exist');
      console.log('\nRun the migration first:');
      console.log('  psql -d your_database -f src/migrations/add_claude_usage_log.sql');
      process.exit(1);
    }
    
    // Display stats
    const stats = await getCostStats();
    displayStats(stats);
    
    if (WATCH_MODE) {
      // Refresh every 30 seconds
      setInterval(async () => {
        const updatedStats = await getCostStats();
        displayStats(updatedStats);
      }, 30000);
    } else {
      // Exit after single display
      pool.end();
    }
    
  } catch (error) {
    console.error('❌ Error:', error.message);
    pool.end();
    process.exit(1);
  }
}

// Run
main();
