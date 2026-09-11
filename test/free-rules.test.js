'use strict';

const test = require('node:test');
const assert = require('node:assert');

// web/api/_free-rules.js is an ES module because the Vercel function imports it.
const rules = import('../web/api/_free-rules.js');

const chatBody = (extra = {}) => ({
  contents: [
    { role: 'user', parts: [{ text: 'what is this' }, { inline_data: { mime_type: 'image/png', data: 'AAAA' } }] },
  ],
  systemInstruction: { parts: [{ text: 'be brief' }] },
  ...extra,
});

test('cleanBody keeps what the app sends and sets its own output cap', async () => {
  const { cleanBody } = await rules;
  const out = cleanBody('chat', chatBody({ generationConfig: { maxOutputTokens: 999999 } }));
  assert.deepEqual(out.contents, chatBody().contents);
  assert.deepEqual(out.systemInstruction, { parts: [{ text: 'be brief' }] });
  assert.equal(out.generationConfig.maxOutputTokens, 4096);
});

test('cleanBody drops tools and anything else the app never sends', async () => {
  const { cleanBody } = await rules;
  const out = cleanBody('chat', chatBody({ tools: [{ googleSearch: {} }], safetySettings: [] }));
  assert.equal(out.tools, undefined);
  assert.equal(out.safetySettings, undefined);
});

test('cleanBody refuses files of the wrong kind, and odd shapes', async () => {
  const { cleanBody } = await rules;
  const wav = { inline_data: { mime_type: 'audio/wav', data: 'AAAA' } };
  assert.equal(cleanBody('chat', { contents: [{ role: 'user', parts: [wav] }] }), null);
  assert.equal(cleanBody('transcribe', chatBody()), null);            // a PNG sent for transcription
  assert.equal(cleanBody('chat', { contents: [] }), null);
  assert.equal(cleanBody('chat', { contents: [{ role: 'system', parts: [{ text: 'x' }] }] }), null);
  assert.equal(cleanBody('chat', { contents: [{ role: 'user', parts: [{ fileData: {} }] }] }), null);
  assert.equal(cleanBody('chat', null), null);
  assert.equal(cleanBody('other', chatBody()), null);
});

test('cleanBody accepts a transcription clip, at temperature 0', async () => {
  const { cleanBody } = await rules;
  const out = cleanBody('transcribe', {
    contents: [{ role: 'user', parts: [{ text: 'Transcribe' }, { inline_data: { mime_type: 'audio/wav', data: 'UklG' } }] }],
    generationConfig: { temperature: 1 },
  });
  assert.equal(out.generationConfig.temperature, 0);
  assert.equal(out.contents[0].parts[1].inline_data.mime_type, 'audio/wav');
});

test('cleanBody refuses a request larger than the cap', async () => {
  const { cleanBody } = await rules;
  const huge = 'A'.repeat(9 * 1024 * 1024);
  const body = { contents: [{ role: 'user', parts: [{ text: 't' }, { inline_data: { mime_type: 'audio/wav', data: huge } }] }] };
  assert.equal(cleanBody('transcribe', body), null);
});

test('limits come from the environment, with defaults for anything unset or nonsense', async () => {
  const { settingsFrom } = await rules;
  const d = settingsFrom({});
  assert.deepEqual(d.perInstall, { chat: 100, transcribe: 600 });
  assert.equal(d.ipFactor, 3);
  assert.equal(d.model.chat, d.model.transcribe);

  const s = settingsFrom({ FREE_DAILY_ANSWERS: '20', FREE_DAILY_CLIPS: 'lots', FREE_MODEL: 'm', FREE_TRANSCRIBE_MODEL: 't' });
  assert.equal(s.perInstall.chat, 20);
  assert.equal(s.perInstall.transcribe, 600);
  assert.deepEqual(s.model, { chat: 'm', transcribe: 't' });
});

test('an install is stopped at its limit, and a shared connection at several times that', async () => {
  const { settingsFrom, overLimit } = await rules;
  const settings = settingsFrom({});
  assert.equal(overLimit({ kind: 'chat', installCount: 100, ipCount: 100, settings }), false);
  assert.equal(overLimit({ kind: 'chat', installCount: 101, ipCount: 101, settings }), true);
  assert.equal(overLimit({ kind: 'chat', installCount: 5, ipCount: 300, settings }), false);
  assert.equal(overLimit({ kind: 'chat', installCount: 5, ipCount: 301, settings }), true);
});

test('every count belongs to a UTC day, so all limits reset together at midnight UTC', async () => {
  const { dayOf, counterKeys, hoursUntilReset } = await rules;
  assert.equal(dayOf(new Date('2026-09-11T23:59:59Z')), '2026-09-11');
  assert.equal(dayOf(new Date('2026-09-12T00:00:00Z')), '2026-09-12');
  assert.equal(hoursUntilReset(new Date('2026-09-11T18:00:00Z')), 6);
  assert.equal(hoursUntilReset(new Date('2026-09-11T23:59:00Z')), 1);

  const a = counterKeys({ day: '2026-09-11', kind: 'chat', installId: 'x', ip: '1.2.3.4' });
  const b = counterKeys({ day: '2026-09-12', kind: 'chat', installId: 'x', ip: '1.2.3.4' });
  assert.notEqual(a.install, b.install);
});

test('counter names never contain the install id or the IP address', async () => {
  const { counterKeys } = await rules;
  const k = counterKeys({
    day: '2026-09-11', kind: 'chat', installId: '0f8b6a3e-2c1d-4e5f-9a7b-1c2d3e4f5a6b', ip: '203.0.113.9',
  });
  assert.ok(!k.install.includes('0f8b6a3e'));
  assert.ok(!k.ip.includes('203.0.113.9'));
});

test('the limit message says when more are available', async () => {
  const { limitMessage, settingsFrom } = await rules;
  const msg = limitMessage('chat', settingsFrom({}), new Date('2026-09-11T18:00:00Z'));
  assert.match(msg, /100 free answers/);
  assert.match(msg, /in 6 hours/);
  assert.match(msg, /own key/);
});

test('install ids must look like the ones the app makes', async () => {
  const { validInstallId } = await rules;
  assert.ok(validInstallId('0f8b6a3e-2c1d-4e5f-9a7b-1c2d3e4f5a6b'));
  assert.ok(!validInstallId(''));
  assert.ok(!validInstallId('free-please'));
  assert.ok(!validInstallId(undefined));
});

test("the caller's address is read from Vercel's headers", async () => {
  const { clientIp } = await rules;
  assert.equal(clientIp({ 'x-real-ip': '203.0.113.9' }), '203.0.113.9');
  assert.equal(clientIp({ 'x-forwarded-for': '198.51.100.1, 10.0.0.1' }), '198.51.100.1');
  assert.equal(clientIp({}), 'unknown');
});
