/**
 * CloudWatch Logging Validator
 * ISSUE-008 Fix: Ensure CloudWatch logging is operational in production
 */

const AWS = require('aws-sdk');

class CloudWatchValidator {
  constructor() {
    this.cloudWatchLogs = new AWS.CloudWatchLogs({
      region: process.env.AWS_REGION || 'us-east-1'
    });
    
    this.logGroupName = process.env.CLOUDWATCH_LOG_GROUP || '/aws/anot-health/application';
    this.logStreamName = process.env.CLOUDWATCH_LOG_STREAM || `app-${process.env.NODE_ENV}-${Date.now()}`;
    this.isValidated = false;
    this.lastHealthCheck = null;
  }

  /**
   * Validate CloudWatch configuration
   */
  async validate() {
    console.log('Validating CloudWatch configuration...');
    
    try {
      // Step 1: Check AWS credentials
      await this.checkCredentials();
      
      // Step 2: Check log group exists
      await this.checkLogGroup();
      
      // Step 3: Check/create log stream
      await this.checkLogStream();
      
      // Step 4: Test writing a log
      await this.testWrite();
      
      this.isValidated = true;
      this.lastHealthCheck = new Date();
      
      console.log('[OK] CloudWatch validation successful');
      return true;
    } catch (error) {
      console.error('[X] CloudWatch validation failed:', error);
      
      if (process.env.NODE_ENV === 'production') {
        throw new Error(`CloudWatch validation failed in production: ${error.message}`);
      }
      
      console.warn('CloudWatch validation failed in non-production environment - continuing');
      return false;
    }
  }

  /**
   * Check AWS credentials are valid
   */
  async checkCredentials() {
    console.log('  Checking AWS credentials...');
    
    const sts = new AWS.STS();
    
    try {
      const identity = await sts.getCallerIdentity().promise();
      console.log(`  [OK] AWS credentials valid (Account: ${identity.Account})`);
      return true;
    } catch (error) {
      throw new Error(`Invalid AWS credentials: ${error.message}`);
    }
  }

  /**
   * Check log group exists, create if needed
   */
  async checkLogGroup() {
    console.log(`  Checking log group: ${this.logGroupName}...`);
    
    try {
      const result = await this.cloudWatchLogs.describeLogGroups({
        logGroupNamePrefix: this.logGroupName
      }).promise();
      
      const exists = result.logGroups?.some(lg => lg.logGroupName === this.logGroupName);
      
      if (!exists) {
        console.log('  Log group not found, creating...');
        await this.cloudWatchLogs.createLogGroup({
          logGroupName: this.logGroupName
        }).promise();
        
        // Set retention policy (6 years for HIPAA compliance)
        await this.cloudWatchLogs.putRetentionPolicy({
          logGroupName: this.logGroupName,
          retentionInDays: 2192 // ~6 years
        }).promise();
        
        console.log('  [OK] Log group created with 6-year retention');
      } else {
        console.log('  [OK] Log group exists');
      }
      
      return true;
    } catch (error) {
      throw new Error(`Log group check failed: ${error.message}`);
    }
  }

  /**
   * Check log stream exists, create if needed
   */
  async checkLogStream() {
    console.log(`  Checking log stream: ${this.logStreamName}...`);
    
    try {
      const result = await this.cloudWatchLogs.describeLogStreams({
        logGroupName: this.logGroupName,
        logStreamNamePrefix: this.logStreamName
      }).promise();
      
      const exists = result.logStreams?.some(ls => ls.logStreamName === this.logStreamName);
      
      if (!exists) {
        console.log('  Log stream not found, creating...');
        await this.cloudWatchLogs.createLogStream({
          logGroupName: this.logGroupName,
          logStreamName: this.logStreamName
        }).promise();
        console.log('  [OK] Log stream created');
      } else {
        console.log('  [OK] Log stream exists');
      }
      
      return true;
    } catch (error) {
      throw new Error(`Log stream check failed: ${error.message}`);
    }
  }

  /**
   * Test writing a log event
   */
  async testWrite() {
    console.log('  Testing CloudWatch write...');
    
    try {
      await this.cloudWatchLogs.putLogEvents({
        logGroupName: this.logGroupName,
        logStreamName: this.logStreamName,
        logEvents: [{
          message: JSON.stringify({
            event: 'CLOUDWATCH_VALIDATION',
            timestamp: new Date().toISOString(),
            message: 'CloudWatch logging validation successful'
          }),
          timestamp: Date.now()
        }]
      }).promise();
      
      console.log('  [OK] CloudWatch write test successful');
      return true;
    } catch (error) {
      throw new Error(`CloudWatch write test failed: ${error.message}`);
    }
  }

  /**
   * Health check for CloudWatch logging
   */
  async healthCheck() {
    try {
      // Re-validate every 5 minutes
      const fiveMinutesAgo = new Date(Date.now() - 5 * 60 * 1000);
      
      if (!this.lastHealthCheck || this.lastHealthCheck < fiveMinutesAgo) {
        await this.validate();
      }
      
      return {
        status: 'healthy',
        validated: this.isValidated,
        lastCheck: this.lastHealthCheck,
        logGroup: this.logGroupName,
        logStream: this.logStreamName
      };
    } catch (error) {
      return {
        status: 'unhealthy',
        error: error.message,
        validated: false
      };
    }
  }

  /**
   * Get validator status
   */
  getStatus() {
    return {
      validated: this.isValidated,
      lastHealthCheck: this.lastHealthCheck,
      logGroupName: this.logGroupName,
      logStreamName: this.logStreamName
    };
  }
}

module.exports = CloudWatchValidator;
