import js from '@eslint/js';
import tseslint from 'typescript-eslint';

export default [
  { ignores: ['**/dist/**', '**/node_modules/**', '**/__snapshots__/**', 'mcp/collab.db*'] },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    rules: {
      '@typescript-eslint/no-explicit-any': 'off',
      'no-empty': ['error', { allowEmptyCatch: true }],
    },
  },
  {
    // UI parity D13: the web UI uses its own dialogs and toasts, never the browser's.
    files: ['ui/src/**/*.{ts,tsx}'],
    rules: {
      'no-restricted-globals': ['error',
        { name: 'alert', message: 'Use a toast (components/Toast).' },
        { name: 'confirm', message: 'Use a Dialog (components/Dialog).' },
        { name: 'prompt', message: 'Use a Dialog with a field (components/Dialog).' }],
      'no-restricted-properties': ['error',
        { object: 'window', property: 'alert', message: 'Use a toast (components/Toast).' },
        { object: 'window', property: 'confirm', message: 'Use a Dialog (components/Dialog).' },
        { object: 'window', property: 'prompt', message: 'Use a Dialog with a field (components/Dialog).' }],
    },
  },
];
