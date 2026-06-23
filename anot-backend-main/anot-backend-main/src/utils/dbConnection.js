/**
 * Database Connection Manager with Retry Logic
 * ISSUE-004 Fix: Enhanced connection recovery and resilience
 */

const { Pool } = require('pg');

class DatabaseConnectionManager {
  constructor(config) {
    this.config = config;
    this.pool = null;
    this.retryCount = 0;
    this.maxRetries = 5;
    this.retryDelay = 1000; // Start with 1 second
    this.maxRetryDelay = 30000; // Max 30 seconds
    this.isConnecting = false;
    this.circuitBreakerOpen = false;
    this.circuitBreakerTimeout = null;
  }

  /**
   * Calculate exponential backoff delay
   */
  getBackoffDelay() {
    const delay = Math.min(
      this.retryDelay * Math.pow(2, this.retryCount),
      this.maxRetryDelay
    );
    // Add jitter to prevent thundering herd
    return delay + Math.random() * 1000;
  }

  /**
   * Initialize database connection pool
   */
  async initialize() {
    try {
      console.log('Initializing database connection pool...');
      
      this.pool = new Pool({
        ...this.config,
        // Connection pool settings
        max: 20, // Maximum connections
        min: 2, // Minimum connections
        idleTimeoutMillis: 30000,
        connectionTimeoutMillis: 10000,
        
        // Retry settings
        allowExitOnIdle: false
      });

      // Handle pool errors
      this.pool.on('error', (err, client) => {
        console.error('Unexpected database pool error:', err);
        this.handlePoolError(err);
      });

      // Handle client connect
      this.pool.on('connect', (client) => {
        console.log('New database client connected');
        this.retryCount = 0; // Reset retry count on successful connection
        this.circuitBreakerOpen = false;
      });

      // Handle client removal
      this.pool.on('remove', (client) => {
        console.log('Database client removed from pool');
      });

      // Test initial connection
      await this.testConnection();
      
      console.log('[OK] Database connection pool initialized successfully');
      return this.pool;
    } catch (error) {
      console.error('Failed to initialize database connection:', error);
      throw error;
    }
  }

  /**
   * Test database connection
   */
  async testConnection() {
    const client = await this.pool.connect();
    try {
      const result = await client.query('SELECT NOW()');
      console.log('[OK] Database connection test successful');
      return true;
    } finally {
      client.release();
    }
  }

  /**
   * Handle pool errors and trigger reconnection
   */
  async handlePoolError(error) {
    if (this.isConnecting || this.circuitBreakerOpen) {
      return; // Already attempting reconnection or circuit breaker is open
    }

    console.error('Database connection error, attempting recovery...');
    await this.reconnectWithRetry();
  }

  /**
   * Reconnect with exponential backoff
   */
  async reconnectWithRetry() {
    if (this.retryCount >= this.maxRetries) {
      console.error('Max retry attempts reached. Opening circuit breaker.');
      this.openCircuitBreaker();
      return;
    }

    this.isConnecting = true;
    this.retryCount++;

    const delay = this.getBackoffDelay();
    console.log(`Retry attempt ${this.retryCount}/${this.maxRetries} after ${Math.round(delay)}ms...`);

    await new Promise(resolve => setTimeout(resolve, delay));

    try {
      await this.testConnection();
      console.log('[OK] Database reconnection successful');
      this.retryCount = 0;
      this.isConnecting = false;
    } catch (error) {
      console.error(`Reconnection attempt ${this.retryCount} failed:`, error.message);
      this.isConnecting = false;
      await this.reconnectWithRetry();
    }
  }

  /**
   * Open circuit breaker (stop trying to reconnect temporarily)
   */
  openCircuitBreaker() {
    this.circuitBreakerOpen = true;
    console.log('Circuit breaker opened. Waiting 60s before retry...');
    
    // Clear existing timeout
    if (this.circuitBreakerTimeout) {
      clearTimeout(this.circuitBreakerTimeout);
    }
    
    // Close circuit breaker after 60 seconds
    this.circuitBreakerTimeout = setTimeout(() => {
      console.log('Circuit breaker closed. Retrying connection...');
      this.circuitBreakerOpen = false;
      this.retryCount = 0;
      this.reconnectWithRetry();
    }, 60000);
  }

  /**
   * Execute query with automatic retry
   */
  async query(text, params) {
    const maxAttempts = 3;
    let lastError;

    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      try {
        return await this.pool.query(text, params);
      } catch (error) {
        lastError = error;
        
        // Check if error is recoverable
        if (this.isRecoverableError(error) && attempt < maxAttempts) {
          console.warn(`Query failed (attempt ${attempt}/${maxAttempts}), retrying...`);
          await new Promise(resolve => setTimeout(resolve, 500 * attempt));
          continue;
        }
        
        throw error;
      }
    }

    throw lastError;
  }

  /**
   * Check if error is recoverable
   */
  isRecoverableError(error) {
    const recoverableCodes = [
      'ECONNREFUSED',
      'ECONNRESET',
      'ETIMEDOUT',
      'ENOTFOUND',
      '57P01', // PostgreSQL admin shutdown
      '57P02', // PostgreSQL crash shutdown
      '57P03', // PostgreSQL cannot connect now
      '08006', // Connection failure
      '08003', // Connection does not exist
      '08000'  // Connection exception
    ];

    return recoverableCodes.some(code => 
      error.code === code || error.message.includes(code)
    );
  }

  /**
   * Get pool instance
   */
  getPool() {
    if (!this.pool) {
      throw new Error('Database pool not initialized');
    }
    return this.pool;
  }

  /**
   * Graceful shutdown
   */
  async close() {
    if (this.circuitBreakerTimeout) {
      clearTimeout(this.circuitBreakerTimeout);
    }

    if (this.pool) {
      console.log('Closing database connection pool...');
      await this.pool.end();
      console.log('[OK] Database connection pool closed');
    }
  }
}

module.exports = DatabaseConnectionManager;
