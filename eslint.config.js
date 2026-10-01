import js from '@eslint/js'
import globals from 'globals'
import reactHooks from 'eslint-plugin-react-hooks'
import tseslint from 'typescript-eslint'

export default tseslint.config(
  { ignores: ['**/node_modules/**', '**/dist/**', '**/coverage/**', '**/src/generated/**'] },

  js.configs.recommended,
  ...tseslint.configs.recommended,

  {
    rules: {
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_' },
      ],
      '@typescript-eslint/consistent-type-imports': 'error',
      eqeqeq: ['error', 'always'],
    },
  },

  // Server-side code: Node globals, structured logger only (CLAUDE.md, docs/05 §4.3).
  {
    files: ['backend/**/*.ts', 'shared/**/*.ts', 'signer/**/*.ts'],
    languageOptions: { globals: globals.node },
    rules: {
      'no-console': 'error',
      // Floats must never be used for asset amounts — flag the usual suspects (CLAUDE.md rule 8).
      'no-restricted-globals': [
        'error',
        { name: 'parseFloat', message: 'Use bigint base units for amounts (CLAUDE.md rule 8).' },
      ],
      'no-restricted-properties': [
        'error',
        {
          object: 'Number',
          property: 'parseFloat',
          message: 'Use bigint base units for amounts (CLAUDE.md rule 8).',
        },
      ],
    },
  },

  {
    files: ['frontend/**/*.{ts,tsx}'],
    languageOptions: { globals: globals.browser },
    plugins: { 'react-hooks': reactHooks },
    rules: reactHooks.configs.recommended.rules,
  },
)
