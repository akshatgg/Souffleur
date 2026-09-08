'use strict';

/**
 * Catches dangling references — a call to a function that no longer exists.
 *
 * `node --check` only validates syntax, so a file can parse perfectly while
 * calling functions that were deleted. That is exactly how systemPrompt,
 * ensureListener, transcriptContext and transcribeModelFor went missing during
 * a refactor: the file still parsed, every test passed, and chat threw a
 * ReferenceError on the first message in the shipped build.
 *
 * no-undef is the rule that would have caught it.
 */
const NODE_GLOBALS = {
  require: 'readonly', module: 'writable', exports: 'writable',
  process: 'readonly', console: 'readonly', Buffer: 'readonly',
  __dirname: 'readonly', __filename: 'readonly',
  setTimeout: 'readonly', clearTimeout: 'readonly',
  setInterval: 'readonly', clearInterval: 'readonly',
  setImmediate: 'readonly', fetch: 'readonly', URL: 'readonly',
  TextDecoder: 'readonly', TextEncoder: 'readonly',
  AbortController: 'readonly', FormData: 'readonly', Blob: 'readonly',
};

const BROWSER_GLOBALS = {
  window: 'readonly', document: 'readonly', navigator: 'readonly',
  console: 'readonly', fetch: 'readonly', getSelection: 'readonly',
  setTimeout: 'readonly', clearTimeout: 'readonly',
  requestAnimationFrame: 'readonly', cancelAnimationFrame: 'readonly',
  AudioContext: 'readonly', MediaStream: 'readonly', Range: 'readonly',
  Int16Array: 'readonly', Blob: 'readonly',
  localStorage: 'readonly', requestIdleCallback: 'readonly',
  location: 'readonly',
};

module.exports = [
  {
    files: ['src/main/**/*.js', 'test/**/*.js', 'packaging/**/*.mjs', 'build/**/*.js'],
    languageOptions: {
      ecmaVersion: 2023,
      sourceType: 'commonjs',
      globals: NODE_GLOBALS,
    },
    rules: {
      'no-undef': 'error',
      'no-unused-vars': ['warn', { args: 'none', varsIgnorePattern: '^_' }],
    },
  },
  {
    files: ['packaging/**/*.mjs'],
    languageOptions: { sourceType: 'module' },
  },
  /* The website. Same reason as the renderer: these files call each other and
     the browser only finds a dangling reference when a visitor clicks. */
  {
    files: ['web/**/*.js'],
    ignores: ['web/api/**/*.js'],
    languageOptions: {
      ecmaVersion: 2023,
      sourceType: 'module',
      globals: BROWSER_GLOBALS,
    },
    rules: {
      'no-undef': 'error',
      'no-unused-vars': ['warn', { args: 'none' }],
    },
  },
  /* The one serverless function, which runs on Node rather than in a browser. */
  {
    files: ['web/api/**/*.js'],
    languageOptions: {
      ecmaVersion: 2023,
      sourceType: 'module',
      globals: NODE_GLOBALS,
    },
    rules: {
      'no-undef': 'error',
      'no-unused-vars': ['warn', { args: 'none' }],
    },
  },
  {
    files: ['src/renderer/**/*.js'],
    languageOptions: {
      ecmaVersion: 2023,
      sourceType: 'script',
      globals: BROWSER_GLOBALS,
    },
    rules: {
      'no-undef': 'error',
      'no-unused-vars': ['warn', { args: 'none' }],
    },
  },
];
