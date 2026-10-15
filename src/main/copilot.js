'use strict';

/**
 * Answers through the GitHub Copilot CLI the user already has, signed in to
 * their own GitHub account (through `copilot login` or the `gh` CLI). No key
 * is stored here: each question runs `copilot` once in prompt mode, with every
 * tool switched off, and its JSONL event stream is read line by line.
 *
 * Like Claude Code, it boots for each answer, and it cannot take audio.
 */

const { spawn, execFile } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const readline = require('readline');
const { abortError } = require('./claude');
const { finder, childEnv, foldTurns } = require('./cli');

// Copilot picks a model the account can use. Named models depend on the plan.
const DEFAULT_MODEL = 'auto';

const NOT_FOUND =
  'GitHub Copilot CLI was not found on this computer. Install it from github.com/features/copilot/cli, ' +
  'sign in once by running `copilot login` in a terminal, then press the refresh button in settings.';

const { locate, located } = finder('copilot');

/**
 * The model names this version of the CLI knows, read from its own help so
 * the list moves with the CLI. Which of them a given account may use is only
 * known when one is asked for; `auto` always works.
 */
function parseModels(help) {
  const at = help.search(/^[ \t]*`model`:/m);
  if (at < 0) return [];
  const models = [];
  for (const line of help.slice(at).split('\n').slice(1)) {
    const m = /^\s+- "([^"]+)"\s*$/.exec(line);
    if (!m) break;
    models.push(m[1]);
  }
  return models;
}

/**
 * Whether the Copilot CLI is installed. Answers the model list, so pressing
 * refresh in settings is also how the user checks the setup. Sign-in has no
 * status command short of spending a request, so a signed-out CLI says so on
 * the first answer instead.
 */
async function listCopilotModels() {
  const bin = await locate({ fresh: true });
  if (!bin) throw new Error(NOT_FOUND);

  const help = await new Promise((resolve) => {
    execFile(bin, ['help', 'config'], { env: childEnv(bin), timeout: 10000 },
      (_err, stdout) => resolve(String(stdout || '')));
  });
  return [...new Set([DEFAULT_MODEL, ...parseModels(help)])];
}

/** The screenshot as a file the CLI can attach. */
async function writeImage(dir, dataUrl) {
  const m = /^data:image\/([\w.+-]+);base64,(.*)$/s.exec(dataUrl);
  const ext = m ? m[1].replace('jpeg', 'jpg').replace(/\W.*$/, '') : 'png';
  const file = path.join(dir, `screen.${ext}`);
  await fs.promises.writeFile(file, Buffer.from(m ? m[2] : dataUrl, 'base64'), { mode: 0o600 });
  return file;
}

/**
 * The CLI has no option for a system prompt of our own, so it leads the
 * prompt instead. The prompt goes in on stdin: it carries the transcript and
 * document excerpts, which can outgrow a command line.
 */
function promptText(system, messages) {
  const turn = foldTurns(messages);
  return system ? `<instructions>\n${system}\n</instructions>\n\n${turn}` : turn;
}

/** The useful line of what the CLI printed before giving up. */
function failure(stderr) {
  const lines = stderr.split('\n').map((l) => l.trim()).filter(Boolean);
  const line = lines.find((l) => /^error:/i.test(l)) || lines[0] || '';
  return line.replace(/^error:\s*/i, '');
}

async function* streamCopilot({ model, messages, image, system, signal }) {
  const bin = await locate();
  if (!bin) throw new Error(NOT_FOUND);
  if (signal?.aborted) throw abortError();

  const dir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'souffleur-'));

  const args = [
    '--output-format', 'json',         // JSONL events, one per line
    '--stream', 'on',                  // token-by-token deltas
    '--available-tools', 'none',       // answer only: no files, no shell, no MCP tools
    '--disable-builtin-mcps',          // and do not start the GitHub MCP server
    '--disallow-temp-dir',
    '--no-custom-instructions',        // ignore any AGENTS.md
    '--no-ask-user',
  ];
  if (model) args.push('--model', model);

  let child = null;
  let result = null;
  let stderr = '';
  let kill = null;
  try {
    if (image) args.push('--attachment', await writeImage(dir, image));

    // Run from the empty temp directory so no repository is picked up.
    child = spawn(bin, args, { cwd: dir, env: childEnv(bin), windowsHide: true });

    let failed = null;
    const exited = new Promise((resolve) => {
      child.on('close', resolve);
      child.on('error', (err) => { failed = err; resolve(null); });
    });
    child.stderr.on('data', (d) => { stderr = (stderr + d).slice(-2000); });
    child.stdin.on('error', () => {});   // EPIPE when it exits before reading

    kill = () => child.kill();
    signal?.addEventListener('abort', kill, { once: true });

    child.stdin.end(promptText(system, messages));

    // A message that arrives whole, with no deltas before it, is still shown.
    const streamed = new Set();
    for await (const line of readline.createInterface({ input: child.stdout, crlfDelay: Infinity })) {
      let j;
      try { j = JSON.parse(line); } catch { continue; }
      const d = j.data || {};
      if (j.type === 'assistant.message_delta' && d.deltaContent) {
        streamed.add(d.messageId);
        yield d.deltaContent;
      } else if (j.type === 'assistant.message' && d.content && !streamed.has(d.messageId)) {
        yield d.content;
      } else if (j.type === 'result') {
        result = j;
      }
    }
    const code = await exited;

    if (signal?.aborted) throw abortError();
    if (failed) throw new Error(`GitHub Copilot could not start: ${failed.message}`);
    if (code !== 0 || (result && result.exitCode !== 0)) {
      const msg = failure(stderr) || `exited with code ${result?.exitCode ?? code}`;
      const hint = /authenticat|log ?in|token/i.test(msg) ? ' Run `copilot login` in a terminal and sign in.' : '';
      throw new Error(`GitHub Copilot: ${msg}${hint}`);
    }
  } finally {
    if (kill) signal?.removeEventListener('abort', kill);
    if (child && child.exitCode === null && child.signalCode === null) child.kill();
    fs.promises.rm(dir, { recursive: true, force: true }).catch(() => {});
  }
}

module.exports = { streamCopilot, listCopilotModels, locate, located, parseModels, DEFAULT_MODEL };
