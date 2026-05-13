import js from '@eslint/js'
import globals from 'globals'
import reactHooks from 'eslint-plugin-react-hooks'
import reactRefresh from 'eslint-plugin-react-refresh'
import { defineConfig, globalIgnores } from 'eslint/config'

export default defineConfig([
  globalIgnores(['dist']),
  {
    files: ['**/*.{js,jsx}'],
    extends: [
      js.configs.recommended,
      reactHooks.configs.flat.recommended,
      reactRefresh.configs.vite,
    ],
    languageOptions: {
      globals: globals.browser,
      parserOptions: { ecmaFeatures: { jsx: true } },
    },
  },
  {
    files: ['src/pages/shared.jsx'],
    rules: {
      // Shared module exports hooks + small components (not a refresh boundary).
      'react-refresh/only-export-components': 'off',
    },
  },
  {
    files: [
      'src/pages/Clinician/index.jsx',
      'src/pages/QPS/index.jsx',
      'src/pages/Scribe/index.jsx',
    ],
    rules: {
      // Large legacy dashboards: inner layout helpers + data-loading effects predate stricter React Compiler-style hooks.
      'react-hooks/static-components': 'off',
      'react-hooks/set-state-in-effect': 'off',
      'react-hooks/immutability': 'off',
    },
  },
])
