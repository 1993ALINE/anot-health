/**
 * Common Validators - ISSUE-015 Fix
 */

const { body, param, query, validationResult } = require('express-validator');

const handleValidationErrors = (req, res, next) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) {
    return res.status(400).json({ errors: errors.array() });
  }
  next();
};

// Common validators
const validateId = [
  param('id').isInt().withMessage('ID must be an integer')
];

const validateEmail = [
  body('email').isEmail().normalizeEmail().withMessage('Invalid email')
];

const validatePassword = [
  body('password')
    .isLength({ min: 8 })
    .withMessage('Password must be at least 8 characters')
    .matches(/^(?=.*[a-z])(?=.*[A-Z])(?=.*\d)/)
    .withMessage('Password must contain uppercase, lowercase, and number')
];

module.exports = {
  handleValidationErrors,
  validateId,
  validateEmail,
  validatePassword
};
