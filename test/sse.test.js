'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { streamChat } = require('../src/main/providers.js');

/**
 * These exercise the SSE parser through the real provider entry point, with
 * fetch stubbed out. No API key, no network.
 *
 * The regression they lock down: events terminated with CRLF. Splitting on the
 * literal "\n\n" never matches inside "\r\n\r\n", so every event was swallowed
 * and the user saw a successful request that produced no text.
 */

/** A Response-alike that hands back `chunks` one read() at a time. */
function stubResponse(chunks, ctype = 'text/event-stream') {
  const enc = new TextEncoder();
  let i = 0;
  return {
    ok: true,
    status: 200,
    headers: { get: (k) => (k.toLowerCase() === 'content-type' ? ctype : null) },
    body: {
      getReader: () => ({
        read: async () =>
          i < chunks.length
            ? { done: false, value: enc.encode(chunks[i++]) }
            : { done: true, value: undefined },
        cancel: async () => {},
      }),
    },
    text: async () => chunks.join(''),
  };
}

const chunk = (text) =>
  JSON.stringify({ candidates: [{ content: { parts: [{ text }] } }] });

async function collect(chunks, ctype) {
  const original = global.fetch;
  global.fetch = async () => stubResponse(chunks, ctype);
  try {
    let out = '';
    for await (const d of streamChat({
      provider: 'gemini',
      apiKey: 'test-key',
      model: 'test-model',
      messages: [{ role: 'user', content: 'hi' }],
    })) out += d;
    return out;
  } finally {
    global.fetch = original;
  }
}

test('CRLF-separated events are parsed', async () => {
  const body =
    `data: ${chunk('Hello')}\r\n\r\n` +
    `data: ${chunk(' world')}\r\n\r\n`;
  assert.strictEqual(await collect([body]), 'Hello world');
});

test('LF-separated events are parsed', async () => {
  const body =
    `data: ${chunk('Hello')}\n\n` +
    `data: ${chunk(' world')}\n\n`;
  assert.strictEqual(await collect([body]), 'Hello world');
});

test('an event split across two network chunks survives', async () => {
  const full = `data: ${chunk('split')}\n\n`;
  const cut = Math.floor(full.length / 2);
  assert.strictEqual(await collect([full.slice(0, cut), full.slice(cut)]), 'split');
});

test('a final event with no trailing blank line is not dropped', async () => {
  const body = `data: ${chunk('last')}`;   // stream ends abruptly
  assert.strictEqual(await collect([body]), 'last');
});

test('thinking parts are skipped, answer text is kept', async () => {
  const mixed = JSON.stringify({
    candidates: [{ content: { parts: [
      { text: 'internal reasoning', thought: true },
      { text: 'the answer' },
    ] } }],
  });
  assert.strictEqual(await collect([`data: ${mixed}\n\n`]), 'the answer');
});

test('a non-SSE JSON array body is still read', async () => {
  const body = JSON.stringify([
    { candidates: [{ content: { parts: [{ text: 'from' }] } }] },
    { candidates: [{ content: { parts: [{ text: ' json' }] } }] },
  ]);
  assert.strictEqual(await collect([body], 'application/json'), 'from json');
});

test('a text-free response reports why instead of returning silence', async () => {
  const blocked = JSON.stringify({
    candidates: [{ finishReason: 'SAFETY' }],
  });
  await assert.rejects(
    () => collect([`data: ${blocked}\n\n`]),
    /SAFETY/,
  );
});
