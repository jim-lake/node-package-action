import js from '@eslint/js';
import tseslint from 'typescript-eslint';
import globals from 'globals';

export default tseslint.config(
  {
    ignores: ['dist/**', 'node_modules/**'],
  },
  {
    // Shared language options for every linted file.
    languageOptions: {
      ecmaVersion: 2023,
      sourceType: 'module',
      globals: {
        ...globals.node,
      },
    },
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    rules: {
      curly: 'error',
    },
  },
  {
    files: ['test/**/*.mjs'],
    // Tests are plain ESM run by `node --test`; no type-aware linting.
    ...tseslint.configs.disableTypeChecked,
  }
);
