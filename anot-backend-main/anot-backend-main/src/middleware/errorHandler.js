/**
 * Error Handler Middleware - ISSUE-018 Fix
 * Sanitizes error messages in production
 */

function sanitizeError(error) {
  // In production, hide sensitive details
  if (process.env.NODE_ENV === 'production') {
    // Map of safe error messages
    const safeMessages = {
      'VALIDATION_ERROR': 'Invalid input provided',
      'UNAUTHORIZED': 'Authentication required',
      'FORBIDDEN': 'Access denied',
      'NOT_FOUND': 'Resource not found',
      'CONFLICT': 'Resource already exists',
      'INTERNAL_ERROR': 'An unexpected error occurred'
    };
    
    return {
      message: safeMessages[error.code] || 'An error occurred',
      code: error.code || 'INTERNAL_ERROR'
    };
  }
  
  // In development, return full details
  return {
    message: error.message,
    code: error.code,
    stack: error.stack
  };
}

function errorHandler(err, req, res, next) {
  console.error('Error:', err);
  
  const status = err.status || err.statusCode || 500;
  const sanitized = sanitizeError(err);
  
  res.status(status).json({
    error: sanitized.message,
    ...(process.env.NODE_ENV !== 'production' && { details: sanitized })
  });
}

module.exports = errorHandler;
