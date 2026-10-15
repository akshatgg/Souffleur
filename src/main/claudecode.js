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
const { finder, childEnv, foldTurns } = require('./cli');

// Aliases the CLI resolves to the newest model of each tier.
const MODELS = ['opus', 'sonnet', 'haiku'];

const NOT_FOUND =
  'Claude Code was not found on this computer. Install it from claude.com/claude-code, ' +
  'sign in once by running `claude` in a terminal, then press the refresh button in settings.';

const { locate, located } = finder('claude');

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

/** One user turn for the CLI, the screenshot in front of the question. */
function userContent(messages, image) {
  const text = foldTurns(messages);
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
