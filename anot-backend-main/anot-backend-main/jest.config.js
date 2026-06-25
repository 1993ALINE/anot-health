/** Jest config — security-focused coverage for Phase 4 (M13). */
module.exports = {
  testEnvironment: 'node',
  roots: ['<rootDir>/src'],
  testMatch: ['**/__tests__/**/*.test.js'],
  collectCoverageFrom: [
    'src/middleware/csrf.js',
    'src/middleware/fileValidation.js',
    'src/middleware/s3StreamUpload.js',
    'src/middleware/rateLimit.js',
    'src/middleware/auth.js',
    'src/utils/passwordPolicy.js',
    'src/utils/errorMessages.js',
    'src/utils/webhookSignature.js',
    'src/utils/roles.js',
    'src/services/mfaService.js',
  ],
  coverageDirectory: 'coverage',
  coverageThreshold: {
    global: {
      statements: 60,
      branches: 55,
      functions: 60,
      lines: 60,
    },
  },
  verbose: true,
}
