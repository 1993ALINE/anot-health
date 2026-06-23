/**
 * PHI-Safe Logger - ISSUE-009 Fix
 * Filters sensitive information before logging
 */

const winston = require('winston');

// Sensitive field patterns to redact
const SENSITIVE_PATTERNS = [
  /password/i,
  /token/i,
  /secret/i,
  /api[_-]?key/i,
  /ssn/i,
  /social[_-]?security/i,
  /credit[_-]?card/i,
  /patient[_-]?name/i,
  /dob|date[_-]?of[_-]?birth/i,
  /medical[_-]?record/i,
  /diagnosis/i,
  /prescription/i,
  /phone/i,
  /email/i,
  /address/i
];

// Redact sensitive data
function redactSensitiveData(obj) {
  if (typeof obj !== 'object' || obj === null) return obj;
  
  const redacted = Array.isArray(obj) ? [] : {};
  
  for (const key in obj) {
    const isSensitive = SENSITIVE_PATTERNS.some(pattern => pattern.test(key));
    
    if (isSensitive) {
      redacted[key] = '[REDACTED]';
    } else if (typeof obj[key] === 'object' && obj[key] !== null) {
      redacted[key] = redactSensitiveData(obj[key]);
    } else {
      redacted[key] = obj[key];
    }
  }
  
  return redacted;
}

// Create Winston logger
const logger = winston.createLogger({
  level: process.env.LOG_LEVEL || 'info',
  format: winston.format.combine(
    winston.format.timestamp(),
    winston.format.errors({ stack: true }),
    winston.format.json()
  ),
  transports: [
    new winston.transports.Console({
      format: winston.format.combine(
        winston.format.colorize(),
        winston.format.printf(({ timestamp, level, message, ...meta }) => {
          const redactedMeta = redactSensitiveData(meta);
          return `${timestamp} ${level}: ${message} ${Object.keys(redactedMeta).length ? JSON.stringify(redactedMeta) : ''}`;
        })
      )
    })
  ]
});

module.exports = logger;
