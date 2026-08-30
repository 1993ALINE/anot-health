/**
 * Claude Cost Monitoring API
 * 
 * Endpoints for tracking Claude API usage and costs
 * Access: Admin only
 */

const express = require('express');
const router = express.Router();
const pool = require('../config/db');
const { protect } = require('../middleware/auth');
const claudeService = require('../services/claudeService');

/**
 * GET /api/claude-stats/current
 * Get current session cost statistics (in-memory)
 */
router.get('/current', protect, async (req, res) => {
  try {
    // Only admins can view costs
    if (req.user.role !== 'admin') {
      return res.status(403).json({ error: 'Admin access required' });
    }
    
    const stats = claudeService.getCostStats();
    
    res.json({
      success: true,
      stats,
      timestamp: new Date().toISOString()
    });
    
  } catch (error) {
    console.error('[Claude Stats] Error getting current stats:', error);
    res.status(500).json({ error: 'Failed to get cost statistics' });
  }
});

/**
 * GET /api/claude-stats/daily
 * Get daily cost breakdown from database
 */
router.get('/daily', protect, async (req, res) => {
  try {
    if (req.user.role !== 'admin') {
      return res.status(403).json({ error: 'Admin access required' });
    }
    
    const days = parseInt(req.query.days) || 30;
    
    const result = await pool.query(
      `SELECT * FROM claude_daily_costs 
       WHERE date > NOW() - INTERVAL '${days} days'
       ORDER BY date DESC`,
      []
    );
    
    res.json({
      success: true,
      days,
      data: result.rows,
      total: result.rows.reduce((sum, row) => sum + parseFloat(row.total_cost || 0), 0)
    });
    
  } catch (error) {
    console.error('[Claude Stats] Error getting daily stats:', error);
    res.status(500).json({ error: 'Failed to get daily statistics' });
  }
});

/**
 * GET /api/claude-stats/monthly
 * Get monthly cost breakdown
 */
router.get('/monthly', protect, async (req, res) => {
  try {
    if (req.user.role !== 'admin') {
      return res.status(403).json({ error: 'Admin access required' });
    }
    
    const result = await pool.query(
      `SELECT * FROM claude_monthly_costs 
       ORDER BY month DESC 
       LIMIT 12`,
      []
    );
    
    res.json({
      success: true,
      data: result.rows
    });
    
  } catch (error) {
    console.error('[Claude Stats] Error getting monthly stats:', error);
    res.status(500).json({ error: 'Failed to get monthly statistics' });
  }
});

/**
 * GET /api/claude-stats/today
 * Get today's usage in real-time
 */
router.get('/today', protect, async (req, res) => {
  try {
    if (req.user.role !== 'admin') {
      return res.status(403).json({ error: 'Admin access required' });
    }
    
    const result = await pool.query(
      `SELECT 
        COUNT(*) as calls,
        SUM(input_tokens) as input_tokens,
        SUM(output_tokens) as output_tokens,
        SUM(cache_read_tokens) as cache_hits,
        SUM(cost) as total_cost,
        MIN(created_at) as first_call,
        MAX(created_at) as last_call
       FROM claude_usage_log 
       WHERE DATE(created_at) = CURRENT_DATE`,
      []
    );
    
    const row = result.rows[0];
    const memoryStats = claudeService.getCostStats();
    
    res.json({
      success: true,
      date: new Date().toISOString().split('T')[0],
      database: {
        calls: parseInt(row.calls) || 0,
        inputTokens: parseInt(row.input_tokens) || 0,
        outputTokens: parseInt(row.output_tokens) || 0,
        cacheHits: parseInt(row.cache_hits) || 0,
        totalCost: parseFloat(row.total_cost) || 0,
        firstCall: row.first_call,
        lastCall: row.last_call
      },
      memory: memoryStats.daily,
      limits: memoryStats.limits
    });
    
  } catch (error) {
    console.error('[Claude Stats] Error getting today stats:', error);
    res.status(500).json({ error: 'Failed to get today statistics' });
  }
});

/**
 * POST /api/claude-stats/reset
 * Manually reset daily counter (admin only)
 */
router.post('/reset', protect, async (req, res) => {
  try {
    if (req.user.role !== 'admin') {
      return res.status(403).json({ error: 'Admin access required' });
    }
    
    const previous = claudeService.resetDailyCost();
    
    res.json({
      success: true,
      message: 'Daily cost counter reset',
      previous,
      timestamp: new Date().toISOString()
    });
    
  } catch (error) {
    console.error('[Claude Stats] Error resetting daily cost:', error);
    res.status(500).json({ error: 'Failed to reset daily cost' });
  }
});

/**
 * GET /api/claude-stats/usage-by-visit/:visitId
 * Get Claude usage for a specific visit
 */
router.get('/usage-by-visit/:visitId', protect, async (req, res) => {
  try {
    const visitId = parseInt(req.params.visitId);
    
    const result = await pool.query(
      `SELECT 
        id, input_tokens, output_tokens, cache_creation_tokens, 
        cache_read_tokens, cost, model, created_at
       FROM claude_usage_log 
       WHERE visit_id = $1
       ORDER BY created_at DESC`,
      [visitId]
    );
    
    res.json({
      success: true,
      visitId,
      calls: result.rows.length,
      data: result.rows,
      totalCost: result.rows.reduce((sum, row) => sum + parseFloat(row.cost), 0)
    });
    
  } catch (error) {
    console.error('[Claude Stats] Error getting visit usage:', error);
    res.status(500).json({ error: 'Failed to get visit usage' });
  }
});

module.exports = router;
