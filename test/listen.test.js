'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { Listener, Segmenter, toWav, frameRms, SILENCE_RMS } = require('../src/main/listen.js');

/** Build one AudioTap frame around a PCM payload. */
function frame(source, pcm) {
  const head = Buffer.alloc(8);
  head[0] = 0x56; head[1] = 0x41; head[2] = source; head[3] = 0;
  head.writeUInt32LE(pcm.length, 4);
  return Buffer.concat([head, pcm]);
}

/** `ms` of a loud tone, as s16le. */
function tone(ms, amplitude = 0.5) {
  const n = Math.round(16000 * ms / 1000);
  const b = Buffer.alloc(n * 2);
  for (let i = 0; i < n; i++) b.writeInt16LE(Math.round(Math.sin(i / 4) * amplitude * 32767), i * 2);
  return b;
}

/** `ms` of digital silence. */
function quiet(ms) {
  return Buffer.alloc(Math.round(16000 * ms / 1000) * 2);
}

/** A Listener whose transcription step just records what it was handed. */
function harness() {
  const got = [];
  const l = new Listener(async (wav) => {
    got.push(wav);
    return 'transcribed';
  });
  const lines = [];
  l.on('transcript', (e) => lines.push(e));
  return { l, got, lines };
}

test('WAV header describes the payload exactly', () => {
  const pcm = quiet(1000);
  const w = toWav(pcm);
  assert.strictEqual(w.length, 44 + pcm.length);
  assert.strictEqual(w.toString('ascii', 0, 4), 'RIFF');
  assert.strictEqual(w.toString('ascii', 8, 12), 'WAVE');
  assert.strictEqual(w.readUInt32LE(4), 36 + pcm.length);  // RIFF size
  assert.strictEqual(w.readUInt32LE(40), pcm.length);      // data size
  assert.strictEqual(w.readUInt32LE(24), 16000);           // sample rate
  assert.strictEqual(w.readUInt16LE(22), 1);               // mono
  assert.strictEqual(w.readUInt16LE(34), 16);              // bit depth
});

test('the silence gate separates speech from silence', () => {
  assert.ok(frameRms(quiet(100)) < SILENCE_RMS, 'silence must read as silent');
  assert.ok(frameRms(tone(100)) > SILENCE_RMS, 'a tone must read as speech');
});

test('speech followed by a pause produces one utterance', () => {
  const out = [];
  const seg = new Segmenter('them', (pcm, ms) => out.push(ms));
  seg.push(tone(1500));
  seg.push(quiet(900));         // longer than the 700ms hangover
  assert.strictEqual(out.length, 1);
  assert.ok(out[0] >= 1400, `expected ~1500ms of speech, got ${out[0]}`);
});

test('a burst too short to be speech is discarded', () => {
  const out = [];
  const seg = new Segmenter('them', (pcm, ms) => out.push(ms));
  seg.push(tone(300));          // below the 900ms floor
  seg.push(quiet(900));
  assert.strictEqual(out.length, 0);
});

test('pure silence never triggers a transcription request', () => {
  const out = [];
  const seg = new Segmenter('them', (pcm, ms) => out.push(ms));
  seg.push(quiet(5000));
  assert.strictEqual(out.length, 0, 'silence must not cost an API call');
});

test('framed audio reaches the right source', () => {
  const { l, lines } = harness();
  l.ingest(frame(0, tone(1500)));
  l.ingest(frame(0, quiet(900)));
  return new Promise((resolve) => setImmediate(() => {
    assert.strictEqual(lines.length, 1);
    assert.strictEqual(lines[0].who, 'them');
    resolve();
  }));
});

test('mic frames are labelled as you, separately from them', () => {
  const { l, lines } = harness();
  l.ingest(frame(1, tone(1500)));
  l.ingest(frame(1, quiet(900)));
  return new Promise((resolve) => setImmediate(() => {
    assert.strictEqual(lines.length, 1);
    assert.strictEqual(lines[0].who, 'you');
    resolve();
  }));
});

test('a frame split across two reads is reassembled', () => {
  const { l, lines } = harness();
  const f = Buffer.concat([frame(0, tone(1500)), frame(0, quiet(900))]);
  const cut = Math.floor(f.length / 3);
  l.ingest(f.subarray(0, cut));
  l.ingest(f.subarray(cut));
  return new Promise((resolve) => setImmediate(() => {
    assert.strictEqual(lines.length, 1, 'a split frame must not be lost');
    resolve();
  }));
});

test('garbage in the stream resynchronises instead of poisoning audio', () => {
  const { l, lines } = harness();
  l.ingest(Buffer.from([1, 2, 3, 4, 5]));            // junk, no magic
  l.ingest(frame(0, tone(1500)));
  l.ingest(frame(0, quiet(900)));
  return new Promise((resolve) => setImmediate(() => {
    assert.strictEqual(lines.length, 1, 'should recover and still emit the utterance');
    resolve();
  }));
});
