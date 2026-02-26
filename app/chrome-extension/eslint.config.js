import js from '@eslint/js';
import globals from 'globals';
import tseslint from 'typescript-eslint';
import { defineConfig } from 'eslint/config';
import prettierConfig from 'eslint-config-prettier';

export default defineConfig([
  // Global ignores - these apply to all configurations
  {
    ignores: [
      'dist/**',
      '.output/**',
      '.wxt/**',
      'node_modules/**',
      'logs/**',
      '*.log',
      '.cache/**',
      '.temp/**',
      '.vscode/**',
      '!.vscode/extensions.json',
      '.idea/**',
      '.DS_Store',
      'Thumbs.db',
      '*.zip',
      '*.tar.gz',
      'stats.html',
      'stats-*.json',
      'libs/**',
      'workers/**',
      'public/libs/**',
    ],
  },
  js.configs.recommended,
  {
    files: ['**/*.{js,mjs,cjs,ts,tsx,jsx}'],
    languageOptions: {
      globals: {
        ...globals.browser,
        chrome: 'readonly',
      },
    },
  },
  ...tseslint.configs.recommended,
  {
    rules: {
      '@typescript-eslint/no-explicit-any': 'off',
      '@typescript-eslint/no-unused-vars': 'off',
      'no-empty': 'off',
    },
  },
  // Prettier configuration - must be placed last to override previous rules
  prettierConfig,
]);
