'use strict';

/**
 * Claude through the Claude Code CLI the user already has, signed in to their
 * own Claude account. No key is stored here: each question runs
 * `claude -p` once, with every tool switched off, and its streamed reply is
 * read line by line.
 *
 * Slower to start than an API call (the CLI boots for each answer), and like
 * every Claude route it cannot take audio.
 */

const { spawn, execFile } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const readline = require('readline');
const { imageBlock, abortError } = require('./claude');

// Aliases the CLI resolves to the newest model of each tier.
const MODELS = ['opus', 'sonnet', 'haiku'];

const WIN = process.platform === 'win32';
const EXE = WIN ? 'claude.exe' : 'claude';
const HOME = os.homedir();

const NOT_FOUND =
  'Claude Code was not found on this computer. Install it from claude.com/claude-code, ' +
  'sign in once by running `claude` in a terminal, then press the refresh button in settings.';

/**
 * Where installers put `claude`. An app opened from Finder gets launchd's bare
 * PATH, not the shell's, so the usual places are listed by hand.
 */
function searchDirs() {
  const nvm = path.join(HOME, '.nvm', 'versions', 'node');
  let nvmBins = [];
  try {
    nvmBins = fs.readdirSync(nvm).sort().reverse().map((v) => path.join(nvm, v, 'bin'));
  } catch { /* no nvm */ }

  return [...new Set([
    ...(process.env.PATH || '').split(path.delimiter),
    path.join(HOME, '.local', 'bin'),       // native installer
    path.join(HOME, '.claude', 'local'),    // older local install
    '/opt/homebrew/bin',
    '/usr/local/bin',
    path.join(HOME, '.npm-global', 'bin'),
    path.join(HOME, '.bun', 'bin'),
    path.join(HOME, '.volta', 'bin'),
    ...nvmBins,
  ].filter(Boolean))];
}

function isExecutable(p) {
  try {
    fs.accessSync(p, fs.constants.X_OK);
    return fs.statSync(p).isFile();
  } catch {
    return false;
  }
}

/** Ask the user's login shell, for installs in a place not listed above. */
function fromLoginShell() {
  return new Promise((resolve) => {
    const shell = process.env.SHELL || '/bin/zsh';
    execFile(shell, ['-ilc', 'command -v claude'], { timeout: 4000 }, (_err, stdout) => {
      const line = String(stdout || '').trim().split('\n').pop() || '';
      resolve(path.isAbsolute(line) && isExecutable(line) ? line : null);
    });
  });
}

let found = null;   // path of the binary, once located

/** Find the binary. `fresh` looks again, for after the user installs it. */
async function locate({ fresh = false } = {}) {
  if (found && !fresh) return found;
  found = searchDirs().map((d) => path.join(d, EXE)).find(isExecutable) || null;
  if (!found && !WIN) found = await fromLoginShell();
  return found;
}

/** The binary's path as last located, without searching. */
const located = () => found;

/**
 * The CLI may be a node script (npm installs), so its own directory and the
 * usual ones go on PATH for it to find `node`.
 */
function childEnv(bin) {
  return { ...process.env, PATH: [path.dirname(bin), ...searchDirs()].join(path.delimiter) };
}

/**
 * Whether Claude Code is installed and signed in. Answers the model list, so
 * pressing refresh in settings is also how the user checks the setup.
 */
async function listClaudeCodeModels() {
  const bin = await locate({ fresh: true });
  if (!bin) throw new Error(NOT_FOUND);

  const out = await new Promise((resolve) => {
    // Signed out exits non-zero but still prints the status.
    execFile(bin, ['auth', 'status'], { env: childEnv(bin), timeout: 10000 },
      (_err, stdout) => resolve(String(stdout || '')));
  });
  let auth = null;
  try { auth = JSON.parse(out); } catch { /* older CLI without JSON status: let the first answer tell */ }
  // Bedrock, Vertex and Foundry setups sign in through their cloud, not here.
  if (auth && !auth.loggedIn && (auth.apiProvider || 'firstParty') === 'firstParty') {
    throw new Error('Claude Code is installed but not signed in. Run `claude` in a terminal, ' +
                    'sign in, then press the refresh button.');
  }
  return MODELS;
}

/**
 * One user turn for the CLI. It answers a single prompt, so earlier turns are
 * folded into the text rather than sent as a history it could replay.
 */
function userContent(messages, image) {
  const turns = (messages || []).filter((m) => typeof m.content === 'string' && m.content.trim());
  const last = turns.length && turns[turns.length - 1].role === 'user' ? turns.pop() : null;

  let text = last ? last.content : '';
  if (turns.length) {
    const history = turns
      .map((m) => `${m.role === 'assistant' ? 'Assistant' : 'User'}: ${m.content}`)
      .join('\n\n');
    text = `Earlier in this conversation:\n\n${history}\n\nNow reply to this:\n\n${text}`;
  }
  if (!text) text = 'What is on my screen?';

  return image ? [imageBlock(image), { type: 'text', text }] : [{ type: 'text', text }];
}

async function* streamClaudeCode({ model, messages, image, system, signal }) {
  const bin = await locate();
  if (!bin) throw new Error(NOT_FOUND);
  if (signal?.aborted) throw abortError();

  // The system prompt goes through a file: it carries the transcript and
  // document excerpts, which can outgrow a command line.
  const dir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'souffleur-'));
  const promptFile = path.join(dir, 'system.txt');
  await fs.promises.writeFile(promptFile, system || 'You are a helpful assistant.', { mode: 0o600 });

  const args = [
    '-p',
    '--input-format', 'stream-json',
    '--output-format', 'stream-json',
    '--verbose',                       // stream-json output requires it
    '--include-partial-messages',      // token-by-token deltas, not one block at the end
    '--tools', '',                     // answer only: no files, no shell
    '--system-prompt-file', promptFile,
    '--no-session-persistence',
    '--strict-mcp-config',             // skip the user's MCP servers, which slow every start
    '--setting-sources', '',           // and their hooks and settings
    '--disable-slash-commands',
  ];
  if (model) args.push('--model', model);

  // Run from the empty temp directory so no CLAUDE.md is picked up.
  const child = spawn(bin, args, { cwd: dir, env: childEnv(bin), windowsHide: true });

  let failed = null;
  let stderr = '';
  const exited = new Promise((resolve) => {
    child.on('close', resolve);
    child.on('error', (err) => { failed = err; resolve(null); });
  });
  child.stderr.on('data', (d) => { stderr = (stderr + d).slice(-2000); });
  child.stdin.on('error', () => {});   // EPIPE when it exits before reading

  const kill = () => child.kill();
  signal?.addEventListener('abort', kill, { once: true });

  child.stdin.end(JSON.stringify({
    type: 'user',
    message: { role: 'user', content: userContent(messages, image) },
  }) + '\n');

  let result = null;
  try {
    for await (const line of readline.createInterface({ input: child.stdout, crlfDelay: Infinity })) {
      let j;
      try { j = JSON.parse(line); } catch { continue; }
      if (j.type === 'stream_event') {
        const ev = j.event;
        if (ev?.type === 'content_block_delta' && ev.delta?.type === 'text_delta' && ev.delta.text) {
          yield ev.delta.text;
        }
      } else if (j.type === 'result') {
        result = j;
      }
    }
    const code = await exited;

    if (signal?.aborted) throw abortError();
    if (failed) throw new Error(`Claude Code could not start: ${failed.message}`);
    if (result?.is_error) {
      const msg = String(result.result || result.subtype || 'failed');
      const hint = /log ?in|auth/i.test(msg) ? ' Run `claude` in a terminal and sign in.' : '';
      throw new Error(`Claude Code: ${msg}${hint}`);
    }
    if (!result && code !== 0) {
      const tail = stderr.trim().split('\n').pop() || '';
      throw new Error(`Claude Code exited with code ${code}. ${tail}`.trim());
    }
  } finally {
    signal?.removeEventListener('abort', kill);
    if (child.exitCode === null && child.signalCode === null) child.kill();
    fs.promises.rm(dir, { recursive: true, force: true }).catch(() => {});
  }
}

module.exports = { streamClaudeCode, listClaudeCodeModels, locate, located, MODELS };
