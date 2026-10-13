'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

/**
 * Both Claude routes, with nothing real behind them: the API route against a
 * stubbed fetch, the Claude Code route against a fake `claude` placed first on
 * PATH. No key, no network, no Claude Code needed.
 */

// A stand-in CLI. It reads the one stream-json turn and answers according to
// FAKE_CLAUDE: echo the turn back, fail like a signed-out CLI, or hang.
const fakeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'souffleur-fake-claude-'));
fs.writeFileSync(path.join(fakeDir, 'claude'), `#!${process.execPath}
const args = process.argv.slice(2);
let input = '';
process.stdin.on('data', (d) => { input += d; });
process.stdin.on('end', () => {
  const out = (j) => process.stdout.write(JSON.stringify(j) + '\\n');
  const delta = (text) => out({ type: 'stream_event',
    event: { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text } } });
  const mode = process.env.FAKE_CLAUDE;
  if (mode === 'signed-out') {
    out({ type: 'result', subtype: 'success', is_error: true, result: 'Not logged in · Please run /login' });
    return;
  }
  if (mode === 'hang') { delta('partial'); setTimeout(() => {}, 60000); return; }
  const turn = JSON.parse(input.trim());
  const system = require('fs').readFileSync(args[args.indexOf('--system-prompt-file') + 1], 'utf8');
  out({ type: 'system', subtype: 'init' });
  delta(JSON.stringify({
    content: turn.message.content,
    model: args.includes('--model') ? args[args.indexOf('--model') + 1] : null,
    tools: args[args.indexOf('--tools') + 1],
    system,
  }));
  out({ type: 'result', subtype: 'success', is_error: false, result: 'done' });
});
`, { mode: 0o755 });
process.env.PATH = fakeDir + path.delimiter + process.env.PATH;

const { streamChat } = require('../src/main/providers.js');

async function collect(opts) {
  let out = '';
  for await (const d of streamChat(opts)) out += d;
  return out;
}

async function viaCli(mode, opts) {
  process.env.FAKE_CLAUDE = mode;
  try {
    return await collect({ provider: 'claude-code', ...opts });
  } finally {
    delete process.env.FAKE_CLAUDE;
  }
}

test('Claude Code: the question, history and system prompt reach the CLI, tools off', async () => {
  const got = JSON.parse(await viaCli('echo', {
    model: 'haiku',
    system: 'Be terse.',
    messages: [
      { role: 'user', content: 'What is Postgres?' },
      { role: 'assistant', content: 'A database.' },
      { role: 'user', content: 'Why pick it?' },
    ],
  }));
  assert.strictEqual(got.model, 'haiku');
  assert.strictEqual(got.tools, '');
  assert.strictEqual(got.system, 'Be terse.');
  const text = got.content.at(-1).text;
  assert.match(text, /User: What is Postgres\?/);
  assert.match(text, /Assistant: A database\./);
  assert.match(text, /Now reply to this:\s+Why pick it\?$/);
});

test('Claude Code: a screenshot goes in as an image block before the question', async () => {
  const got = JSON.parse(await viaCli('echo', {
    model: 'opus',
    image: 'data:image/png;base64,AAAA',
    messages: [{ role: 'user', content: 'What is this?' }],
  }));
  assert.deepStrictEqual(got.content[0], {
    type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'AAAA' },
  });
  assert.deepStrictEqual(got.content[1], { type: 'text', text: 'What is this?' });
});

test('Claude Code: a signed-out CLI says how to sign in', async () => {
  await assert.rejects(
    viaCli('signed-out', { model: 'opus', messages: [{ role: 'user', content: 'hi' }] }),
    /Not logged in.*sign in/,
  );
});

test('Claude Code: stopping an answer ends the process', async () => {
  const ctrl = new AbortController();
  process.env.FAKE_CLAUDE = 'hang';
  const started = Date.now();
  try {
    await assert.rejects(async () => {
      for await (const d of streamChat({
        provider: 'claude-code', model: 'opus', signal: ctrl.signal,
        messages: [{ role: 'user', content: 'hi' }],
      })) {
        assert.strictEqual(d, 'partial');
        ctrl.abort();
      }
    }, { name: 'AbortError' });
  } finally {
    delete process.env.FAKE_CLAUDE;
  }
  assert.ok(Date.now() - started < 10000, 'the hung CLI was killed, not waited out');
});

/* ------------------------------- API key route ------------------------------ */

function sse(events) {
  return events.map((e) => `event: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`).join('');
}

const message = (extra = {}) => ({
  id: 'msg_1', type: 'message', role: 'assistant', model: 'm', content: [],
  stop_reason: null, stop_sequence: null, usage: { input_tokens: 1, output_tokens: 0 }, ...extra,
});

function answer(text, stopReason = 'end_turn') {
  return sse([
    { type: 'message_start', message: message() },
    { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
    ...text.map((t) => ({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: t } })),
    { type: 'content_block_stop', index: 0 },
    { type: 'message_delta', delta: { stop_reason: stopReason, stop_sequence: null }, usage: { output_tokens: 2 } },
    { type: 'message_stop' },
  ]);
}

async function viaApi(response, opts) {
  const original = global.fetch;
  const sent = [];
  global.fetch = async (url, init) => {
    sent.push({ url: String(url), headers: new Headers(init.headers), body: JSON.parse(init.body) });
    return response();
  };
  try {
    return { text: await collect({ provider: 'anthropic', apiKey: 'sk-test', ...opts }), sent };
  } finally {
    global.fetch = original;
  }
}

const streamed = (body) => () =>
  new Response(body, { status: 200, headers: { 'content-type': 'text/event-stream' } });

test('Claude API: deltas stream through, with the screenshot attached', async () => {
  const { text, sent } = await viaApi(streamed(answer(['Hello', ' there'])), {
    model: 'claude-opus-5-5',
    system: 'Be terse.',
    image: 'data:image/png;base64,AAAA',
    messages: [
      { role: 'user', content: 'first' },
      { role: 'assistant', content: '' },        // a stopped answer: dropped
      { role: 'user', content: 'What is this?' },
    ],
  });
  assert.strictEqual(text, 'Hello there');

  const { body, headers } = sent[0];
  assert.strictEqual(headers.get('x-api-key'), 'sk-test');
  assert.strictEqual(body.system, 'Be terse.');
  assert.strictEqual(body.stream, true);
  assert.deepStrictEqual(body.messages.map((m) => m.role), ['user', 'user']);
  assert.strictEqual(body.messages[1].content[0].type, 'image');
  assert.deepStrictEqual(body.messages[1].content[1], { type: 'text', text: 'What is this?' });
});

test('Claude API: current models ask for low effort and refusal fallbacks; older ones do not', async () => {
  const current = await viaApi(streamed(answer(['ok'])), {
    model: 'claude-opus-5-5', messages: [{ role: 'user', content: 'hi' }],
  });
  assert.deepStrictEqual(current.sent[0].body.output_config, { effort: 'low' });
  assert.strictEqual(current.sent[0].body.fallbacks, 'default');
  assert.match(current.sent[0].headers.get('anthropic-beta'), /server-side-fallback-2026-07-01/);

  const older = await viaApi(streamed(answer(['ok'])), {
    model: 'claude-haiku-4-5', messages: [{ role: 'user', content: 'hi' }],
  });
  assert.strictEqual(older.sent[0].body.output_config, undefined);
  assert.strictEqual(older.sent[0].body.fallbacks, undefined);
});

test('Claude API: a rejected key reads as one', async () => {
  const rejected = () => new Response(
    JSON.stringify({ type: 'error', error: { type: 'authentication_error', message: 'invalid x-api-key' } }),
    { status: 401, headers: { 'content-type': 'application/json' } });
  await assert.rejects(
    viaApi(rejected, { model: 'claude-opus-5-5', messages: [{ role: 'user', content: 'hi' }] }),
    /Claude: key rejected \(401\)\. invalid x-api-key/,
  );
});

test('Claude API: a refusal is reported, not passed off as an empty answer', async () => {
  await assert.rejects(
    viaApi(streamed(answer([], 'refusal')), {
      model: 'claude-opus-5-5', messages: [{ role: 'user', content: 'hi' }],
    }),
    /Claude declined to answer this/,
  );
});
