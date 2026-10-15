'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

/**
 * The GitHub Copilot route against a fake `copilot` placed first on PATH. No
 * account, no network, no Copilot CLI needed.
 */

// A stand-in CLI. It reads the prompt from stdin and answers according to
// FAKE_COPILOT: echo what it was given, fail like a signed-out CLI, answer in
// one piece with no deltas, or hang.
const fakeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'souffleur-fake-copilot-'));
fs.writeFileSync(path.join(fakeDir, 'copilot'), `#!${process.execPath}
const fs = require('fs');
const args = process.argv.slice(2);
const opt = (name) => (args.includes(name) ? args[args.indexOf(name) + 1] : null);
if (args[0] === 'help' && args[1] === 'config') {
  process.stdout.write([
    'Configuration Settings:', '',
    '  \\'model\\': AI model to use for Copilot CLI; can be changed with /model command.',
    '    - "claude-sonnet-5.5"',
    '    - "gpt-5.5"',
    '',
    '  \\'contextTier\\': context window tier.',
    '    - "default"',
  ].join('\\n').replaceAll("'", '\`') + '\\n');
  process.exit(0);
}
let input = '';
process.stdin.on('data', (d) => { input += d; });
process.stdin.on('end', () => {
  const out = (j) => process.stdout.write(JSON.stringify(j) + '\\n');
  const delta = (deltaContent) => out({ type: 'assistant.message_delta', data: { messageId: 'm1', deltaContent } });
  const mode = process.env.FAKE_COPILOT;
  if (mode === 'signed-out') {
    process.stderr.write('Error: No authentication information found.\\n\\nTo authenticate, ...\\n');
    process.exit(1);
  }
  if (mode === 'hang') { delta('partial'); setTimeout(() => {}, 60000); return; }
  out({ type: 'session.tools_updated', data: {} });
  if (mode === 'whole') {
    out({ type: 'assistant.message', data: { messageId: 'm1', content: 'all at once' } });
  } else {
    const attachment = opt('--attachment');
    const reply = JSON.stringify({
      prompt: input,
      model: opt('--model'),
      tools: opt('--available-tools'),
      cwdEmpty: fs.readdirSync(process.cwd()).filter((f) => !f.startsWith('screen.')).length === 0,
      attachment: attachment && { name: require('path').basename(attachment), data: fs.readFileSync(attachment, 'base64') },
    });
    delta(reply.slice(0, 10));
    delta(reply.slice(10));
    out({ type: 'assistant.message', data: { messageId: 'm1', content: reply } });
  }
  out({ type: 'result', exitCode: 0 });
});
`, { mode: 0o755 });
process.env.PATH = fakeDir + path.delimiter + process.env.PATH;

// The stand-in runs through its #! line, which Windows does not honour, and on
// Windows the app looks for copilot.exe. So these run on macOS and Linux.
const cliOnly = { skip: process.platform === 'win32' };

const { streamChat, listModels } = require('../src/main/providers.js');

async function viaCli(mode, opts) {
  process.env.FAKE_COPILOT = mode;
  try {
    let out = '';
    for await (const d of streamChat({ provider: 'copilot', ...opts })) out += d;
    return out;
  } finally {
    delete process.env.FAKE_COPILOT;
  }
}

test('Copilot: the question, history and system prompt reach the CLI, tools off', cliOnly, async () => {
  const got = JSON.parse(await viaCli('echo', {
    model: 'gpt-5.5',
    system: 'Be terse.',
    messages: [
      { role: 'user', content: 'What is Postgres?' },
      { role: 'assistant', content: 'A database.' },
      { role: 'user', content: 'Why pick it?' },
    ],
  }));
  assert.strictEqual(got.model, 'gpt-5.5');
  assert.strictEqual(got.tools, 'none');
  assert.strictEqual(got.cwdEmpty, true);
  assert.strictEqual(got.attachment, null);
  assert.match(got.prompt, /^<instructions>\nBe terse\.\n<\/instructions>/);
  assert.match(got.prompt, /User: What is Postgres\?/);
  assert.match(got.prompt, /Assistant: A database\./);
  assert.match(got.prompt, /Now reply to this:\s+Why pick it\?$/);
});

test('Copilot: a screenshot goes in as an attached image file', cliOnly, async () => {
  const got = JSON.parse(await viaCli('echo', {
    model: 'auto',
    image: 'data:image/jpeg;base64,AAAA',
    messages: [{ role: 'user', content: 'What is this?' }],
  }));
  assert.deepStrictEqual(got.attachment, { name: 'screen.jpg', data: 'AAAA' });
  assert.strictEqual(got.prompt, 'What is this?');
});

test('Copilot: an answer that arrives whole, without deltas, is still shown', cliOnly, async () => {
  assert.strictEqual(await viaCli('whole', { messages: [{ role: 'user', content: 'hi' }] }), 'all at once');
});

test('Copilot: a signed-out CLI says how to sign in', cliOnly, async () => {
  await assert.rejects(
    viaCli('signed-out', { model: 'auto', messages: [{ role: 'user', content: 'hi' }] }),
    /GitHub Copilot: No authentication information found\. Run `copilot login`/,
  );
});

test('Copilot: stopping an answer ends the process', cliOnly, async () => {
  const ctrl = new AbortController();
  process.env.FAKE_COPILOT = 'hang';
  const started = Date.now();
  try {
    await assert.rejects(async () => {
      for await (const d of streamChat({
        provider: 'copilot', model: 'auto', signal: ctrl.signal,
        messages: [{ role: 'user', content: 'hi' }],
      })) {
        assert.strictEqual(d, 'partial');
        ctrl.abort();
      }
    }, { name: 'AbortError' });
  } finally {
    delete process.env.FAKE_COPILOT;
  }
  assert.ok(Date.now() - started < 10000, 'the hung CLI was killed, not waited out');
});

test('Copilot: the model list is auto, then what the CLI says it knows', cliOnly, async () => {
  assert.deepStrictEqual(await listModels({ provider: 'copilot' }), ['auto', 'claude-sonnet-5.5', 'gpt-5.5']);
});
