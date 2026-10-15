'use strict';

/**
 * Finding a coding CLI the user installed (Claude Code, GitHub Copilot) so it
 * can answer on their own signed-in account.
 */

const { execFile } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const WIN = process.platform === 'win32';
const HOME = os.homedir();

/**
 * Where installers put these CLIs. An app opened from Finder gets launchd's
 * bare PATH, not the shell's, so the usual places are listed by hand.
 */
function searchDirs() {
  const nvm = path.join(HOME, '.nvm', 'versions', 'node');
  let nvmBins = [];
  try {
    nvmBins = fs.readdirSync(nvm).sort().reverse().map((v) => path.join(nvm, v, 'bin'));
  } catch { /* no nvm */ }

  return [...new Set([
    ...(process.env.PATH || '').split(path.delimiter),
    path.join(HOME, '.local', 'bin'),       // native installers
    path.join(HOME, '.claude', 'local'),    // older local Claude Code install
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
function fromLoginShell(name) {
  return new Promise((resolve) => {
    const shell = process.env.SHELL || '/bin/zsh';
    execFile(shell, ['-ilc', `command -v ${name}`], { timeout: 4000 }, (_err, stdout) => {
      const line = String(stdout || '').trim().split('\n').pop() || '';
      resolve(path.isAbsolute(line) && isExecutable(line) ? line : null);
    });
  });
}

/**
 * A finder for one CLI. `locate()` searches once and remembers; `fresh` looks
 * again, for after the user installs it. `located()` is the last answer,
 * without searching.
 */
function finder(name) {
  const exe = WIN ? `${name}.exe` : name;
  let found = null;

  async function locate({ fresh = false } = {}) {
    if (found && !fresh) return found;
    found = searchDirs().map((d) => path.join(d, exe)).find(isExecutable) || null;
    if (!found && !WIN) found = await fromLoginShell(name);
    return found;
  }

  return { locate, located: () => found };
}

/**
 * The CLI may be a node script (npm installs), so its own directory and the
 * usual ones go on PATH for it to find `node` (and, for Copilot, `gh`).
 */
function childEnv(bin) {
  return { ...process.env, PATH: [path.dirname(bin), ...searchDirs()].join(path.delimiter) };
}

/**
 * The conversation as one prompt. These CLIs answer a single prompt, so
 * earlier turns are folded into the text rather than sent as a history they
 * could replay.
 */
function foldTurns(messages) {
  const turns = (messages || []).filter((m) => typeof m.content === 'string' && m.content.trim());
  const last = turns.length && turns[turns.length - 1].role === 'user' ? turns.pop() : null;

  let text = last ? last.content : '';
  if (turns.length) {
    const history = turns
      .map((m) => `${m.role === 'assistant' ? 'Assistant' : 'User'}: ${m.content}`)
      .join('\n\n');
    text = `Earlier in this conversation:\n\n${history}\n\nNow reply to this:\n\n${text}`;
  }
  return text || 'What is on my screen?';
}

module.exports = { finder, childEnv, foldTurns };
