'use strict'

const js = require('@eslint/js')
const globals = require('globals')

module.exports = [
  {
    ignores: [
      'coverage/**',
      'node_modules/**',
      'scripts/**',
      'instrument.js',
    ],
  },
  {
    files: ['src/**/*.js'],
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: 'commonjs',
      globals: {
        ...globals.node,
        ...globals.jest,
      },
    },
    rules: {
      ...js.configs.recommended.rules,
      'no-unused-vars': ['warn', { argsIgnorePattern: '^_', varsIgnorePattern: '^_' }],
      'no-console': 'off',
      // Existing codebase style — tighten incrementally in follow-up PRs.
      eqeqeq: 'off',
      curly: 'off',
      'no-useless-escape': 'warn',
    },
  },
]
