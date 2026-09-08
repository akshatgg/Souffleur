'use strict';

const test = require('node:test');
const assert = require('node:assert');

// web/report-model.js is an ES module because the browser loads it directly.
const model = import('../web/report-model.js');

test('detectOs reads Windows from either the platform or the agent string', async () => {
  const { detectOs } = await model;
  assert.equal(detectOs('Mozilla/5.0 (Windows NT 10.0; Win64; x64)', ''), 'windows');
  assert.equal(detectOs('', 'Win32'), 'windows');
});

test('detectOs reads macOS from either the platform or the agent string', async () => {
  const { detectOs } = await model;
  assert.equal(detectOs('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)', ''), 'mac');
  assert.equal(detectOs('', 'MacIntel'), 'mac');
});

test('detectOs falls back to other, and never throws on missing input', async () => {
  const { detectOs } = await model;
  assert.equal(detectOs('Mozilla/5.0 (X11; Linux x86_64)', 'Linux x86_64'), 'other');
  assert.equal(detectOs(), 'other');
});

test('summarise counts an empty list as zero rather than failing', async () => {
  const { summarise } = await model;
  assert.deepEqual(summarise([]), {
    total: 0,
    downloaders: 0,
    signups: { mac: 0, windows: 0, other: 0 },
    downloads: { mac: 0, windows: 0, total: 0 },
  });
});

test('summarise separates people from install actions', async () => {
  const { summarise } = await model;

  // Three people, four downloads: one of them took both installers.
  const s = summarise([
    { os: 'mac', mac: 1, windows: 1 },
    { os: 'windows', mac: 0, windows: 2 },
    { os: 'mac', mac: 0, windows: 0 },
  ]);

  assert.equal(s.total, 3);
  assert.equal(s.downloaders, 2, 'the third signed in but never downloaded');
  assert.deepEqual(s.signups, { mac: 2, windows: 1, other: 0 });
  assert.deepEqual(s.downloads, { mac: 1, windows: 3, total: 4 });
});

test('summarise tolerates missing and unknown fields on a record', async () => {
  const { summarise } = await model;

  // A document written by an older version of the site, or by a Linux visitor.
  const s = summarise([{ os: 'freebsd' }, {}]);

  assert.equal(s.total, 2);
  assert.equal(s.downloaders, 0);
  assert.deepEqual(s.signups, { mac: 0, windows: 0, other: 2 });
  assert.equal(s.downloads.total, 0);
});
