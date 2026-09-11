'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { pickRoute, readSwitch, isFreeStop, FREE_URL } = require('../src/main/freekey.js');
const { streamChat, transcribe } = require('../src/main/providers.js');

/**
 * The app side of the free key: which key answers, how the switch is read,
 * and that free-key requests go to our server without a key in them.
 * No network; fetch is stubbed.
 */

const INSTALL = '0f8b6a3e-2c1d-4e5f-9a7b-1c2d3e4f5a6b';

test('a saved key always answers, whatever the switch says', () => {
  assert.equal(pickRoute({ hasOwnKey: true, freeOn: true }), 'own');
  assert.equal(pickRoute({ hasOwnKey: true, freeOn: false }), 'own');
});

test('with no key, the switch decides between the free key and none', () => {
  assert.equal(pickRoute({ hasOwnKey: false, freeOn: true }), 'free');
  assert.equal(pickRoute({ hasOwnKey: false, freeOn: false }), 'none');
});

test('readSwitch returns the switch, and null when it cannot tell', async () => {
  const serve = (status, body) => async () => ({
    ok: status === 200, status, json: async () => (typeof body === 'string' ? JSON.parse(body) : body),
  });
  assert.equal(await readSwitch({ fetchImpl: serve(200, { enabled: true }) }), true);
  assert.equal(await readSwitch({ fetchImpl: serve(200, { enabled: false }) }), false);
  // A site that is down, or a file that is not the switch, is not "off".
  assert.equal(await readSwitch({ fetchImpl: serve(404, {}) }), null);
  assert.equal(await readSwitch({ fetchImpl: serve(200, { enabled: 'yes' }) }), null);
  assert.equal(await readSwitch({ fetchImpl: serve(200, '<html>') }), null);
  assert.equal(await readSwitch({ fetchImpl: async () => { throw new Error('offline'); } }), null);
});

/** Run fn with fetch stubbed, returning what it was called with. */
async function withFetch(response, fn) {
  const original = global.fetch;
  const calls = [];
  global.fetch = async (url, init) => { calls.push({ url, init }); return response; };
  try {
    return { result: await fn().catch((e) => e), calls };
  } finally {
    global.fetch = original;
  }
}

function sseResponse(text) {
  const enc = new TextEncoder();
  let sent = false;
  const payload = `data: ${JSON.stringify({ candidates: [{ content: { parts: [{ text }] } }] })}\n\n`;
  return {
    ok: true,
    status: 200,
    headers: { get: () => 'text/event-stream' },
    body: {
      getReader: () => ({
        read: async () => (sent ? { done: true } : ((sent = true), { done: false, value: enc.encode(payload) })),
        cancel: async () => {},
      }),
    },
  };
}

test('a free-key chat goes to our server with the install id and no key', async () => {
  const { result, calls } = await withFetch(sseResponse('hi'), async () => {
    let out = '';
    for await (const d of streamChat({
      provider: 'gemini',
      free: { installId: INSTALL },
      messages: [{ role: 'user', content: 'hello' }],
    })) out += d;
    return out;
  });
  assert.equal(result, 'hi');
  assert.equal(calls[0].url, `${FREE_URL}?kind=chat`);
  assert.equal(calls[0].init.headers['x-souffleur-install'], INSTALL);
  assert.equal(calls[0].init.headers['x-goog-api-key'], undefined);
});

test('the free key is used whichever provider is selected', async () => {
  const { calls } = await withFetch(sseResponse('ok'), async () => {
    for await (const _ of streamChat({
      provider: 'openai',
      free: { installId: INSTALL },
      messages: [{ role: 'user', content: 'hello' }],
    })) { /* drain */ }
  });
  assert.equal(calls[0].url, `${FREE_URL}?kind=chat`);
});

test('a free-key transcription goes to our server as kind=transcribe', async () => {
  const json = {
    ok: true, status: 200,
    json: async () => ({ candidates: [{ content: { parts: [{ text: ' hello there ' }] } }] }),
  };
  const { result, calls } = await withFetch(json, () =>
    transcribe({ provider: 'openai', free: { installId: INSTALL }, wav: Buffer.from('RIFF') }));
  assert.equal(result, 'hello there');
  assert.equal(calls[0].url, `${FREE_URL}?kind=transcribe`);
  assert.equal(calls[0].init.headers['x-goog-api-key'], undefined);
});

test("the server's refusal reaches the user word for word, with its code", async () => {
  const message = "You've used today's 100 free answers. More in 6 hours, or add your own key in Settings to keep going.";
  const refused = {
    ok: false, status: 429,
    text: async () => JSON.stringify({ error: { message, code: 'free_limit' } }),
  };
  const { result } = await withFetch(refused, async () => {
    for await (const _ of streamChat({
      provider: 'gemini', free: { installId: INSTALL }, messages: [{ role: 'user', content: 'x' }],
    })) { /* drain */ }
  });
  assert.equal(result.message, message);
  assert.equal(result.code, 'free_limit');
  assert.ok(isFreeStop(result));
});

test('an ordinary Gemini failure is not mistaken for the free key stopping', () => {
  assert.equal(isFreeStop(new Error('Gemini: HTTP 500')), false);
  const upstream = Object.assign(new Error('Gemini refused'), { code: 'upstream' });
  assert.equal(isFreeStop(upstream), false);
});
