'use strict';
const test = require('node:test');
const assert = require('node:assert');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { isNewer, pickAsset, check, download, blocker, macBundle } = require('../src/main/updater.js');

/**
 * Update now: which release counts as newer, which installer this machine
 * takes, and that a download which does not match the release is thrown away.
 * No network; fetch is stubbed.
 */

const BASE = 'https://github.com/akshatgg/Souffleur/releases/download/v0.2.0/';
const asset = (name, extra = {}) => ({ name, browser_download_url: BASE + name, size: 10, ...extra });
const ASSETS = [
  asset('Souffleur-0.2.0-arm64.dmg'),
  asset('Souffleur-0.2.0.dmg'),
  asset('Souffleur.Setup.0.2.0.exe'),
];

test('a version is newer by its numbers, not by how it reads', () => {
  assert.equal(isNewer('0.1.5', '0.1.4'), true);
  assert.equal(isNewer('v0.1.10', '0.1.9'), true);
  assert.equal(isNewer('1.0.0', '0.9.9'), true);
  assert.equal(isNewer('0.1.4', '0.1.4'), false);
  assert.equal(isNewer('0.1.3', '0.1.4'), false);
  // A finished release replaces its own beta, and never the other way round.
  assert.equal(isNewer('0.2.0', '0.2.0-beta.1'), true);
  assert.equal(isNewer('0.2.0-beta.1', '0.2.0'), false);
  assert.equal(isNewer('', '0.1.4'), false);
});

test('each machine takes its own installer', () => {
  assert.equal(pickAsset(ASSETS, 'darwin', 'arm64').name, 'Souffleur-0.2.0-arm64.dmg');
  assert.equal(pickAsset(ASSETS, 'darwin', 'x64').name, 'Souffleur-0.2.0.dmg');
  assert.equal(pickAsset(ASSETS, 'win32', 'x64').name, 'Souffleur.Setup.0.2.0.exe');
  assert.equal(pickAsset(ASSETS, 'win32', 'arm64').name, 'Souffleur.Setup.0.2.0.exe');
  assert.equal(pickAsset(ASSETS, 'linux', 'x64'), null);
  assert.equal(pickAsset([], 'darwin', 'arm64'), null);
});

test('the checksum GitHub lists is kept, and anything else is ignored', () => {
  const sum = 'a'.repeat(64);
  assert.equal(pickAsset([asset('S.exe', { digest: 'sha256:' + sum })], 'win32', 'x64').sha256, sum);
  assert.equal(pickAsset([asset('S.exe', { digest: 'md5:abc' })], 'win32', 'x64').sha256, '');
  assert.equal(pickAsset([asset('S.exe')], 'win32', 'x64').sha256, '');
});

test('check reports the newest release and whether it is newer', async () => {
  const serve = (status, body) => async () => ({ ok: status === 200, status, json: async () => body });
  const rel = { tag_name: 'v0.2.0', html_url: 'https://example.test/r', assets: ASSETS };

  const up = await check({ current: '0.1.4', platform: 'darwin', arch: 'arm64', fetchImpl: serve(200, rel) });
  assert.equal(up.version, '0.2.0');
  assert.equal(up.newer, true);
  assert.equal(up.asset.name, 'Souffleur-0.2.0-arm64.dmg');

  const same = await check({ current: '0.2.0', platform: 'win32', fetchImpl: serve(200, rel) });
  assert.equal(same.newer, false);

  await assert.rejects(check({ current: '0.1.4', fetchImpl: serve(403, {}) }), /403/);
  await assert.rejects(
    check({ current: '0.1.4', fetchImpl: async () => { throw new Error('offline'); } }),
    /Could not reach GitHub/
  );
});

/** A fetch that serves `bytes` as a one-chunk body. */
const serveBytes = (bytes) => async () => ({
  ok: true, status: 200, headers: { get: () => String(bytes.length) },
  body: (async function* () { yield bytes; })(),
});

test('a download is kept only when it matches the release', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'souffleur-update-'));
  const bytes = Buffer.from('the installer');
  const sha256 = crypto.createHash('sha256').update(bytes).digest('hex');
  const good = { name: 'S.exe', url: BASE + 'S.exe', size: bytes.length, sha256 };

  const seen = [];
  const file = await download(good, dir, { fetchImpl: serveBytes(bytes), onProgress: (p) => seen.push(p) });
  assert.deepEqual(fs.readFileSync(file), bytes);
  assert.deepEqual(seen, [1]);

  // Same bytes, but the release says they should hash to something else.
  const wrong = { ...good, name: 'T.exe', sha256: 'b'.repeat(64) };
  await assert.rejects(download(wrong, dir, { fetchImpl: serveBytes(bytes) }), /did not match/);
  assert.equal(fs.existsSync(path.join(dir, 'T.exe')), false);

  // Cut short.
  const short = { ...good, name: 'U.exe', size: bytes.length + 5, sha256: '' };
  await assert.rejects(download(short, dir, { fetchImpl: serveBytes(bytes) }), /did not match/);

  fs.rmSync(dir, { recursive: true, force: true });
});

test('an installer from anywhere but our releases is never fetched', async () => {
  let called = false;
  const fetchImpl = async () => { called = true; };
  const elsewhere = { name: 'S.exe', url: 'https://example.test/S.exe', size: 1, sha256: '' };
  await assert.rejects(download(elsewhere, os.tmpdir(), { fetchImpl }), /unexpected/);
  assert.equal(called, false);
});

test('a copy that cannot replace itself says why before downloading', () => {
  assert.equal(blocker({ platform: 'win32', execPath: 'C:\\Souffleur\\Souffleur.exe', packaged: true }), '');
  assert.match(blocker({ platform: 'win32', execPath: 'C:\\Souffleur\\Souffleur.exe', packaged: false }),
    /development copy/);
  assert.match(blocker({ platform: 'linux', execPath: '/opt/souffleur/souffleur', packaged: true }), /by hand/);
});

// These walk macOS bundle paths, which only resolve as written on a POSIX
// machine. CI also runs the suite on Windows, where the code is never reached.
test('on macOS, only a copy installed somewhere writable replaces itself', { skip: process.platform === 'win32' }, () => {
  const exe = (bundle) => path.join(bundle, 'Contents', 'MacOS', 'Souffleur');
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'souffleur-apps-'));

  assert.equal(macBundle(exe('/Applications/Souffleur.app')), '/Applications/Souffleur.app');
  assert.equal(macBundle('/usr/local/bin/electron'), null);

  assert.equal(blocker({ platform: 'darwin', execPath: exe(path.join(home, 'Souffleur.app')), packaged: true }), '');

  assert.match(blocker({ platform: 'darwin', execPath: exe(path.join(home, 'Souffleur.app')), packaged: false }),
    /development copy/);
  assert.match(blocker({ platform: 'darwin', execPath: exe('/Volumes/Souffleur 0.2.0/Souffleur.app'), packaged: true }),
    /Applications first/);
  assert.match(blocker({
    platform: 'darwin', packaged: true,
    execPath: exe('/private/var/folders/x/T/AppTranslocation/ABC/d/Souffleur.app'),
  }), /Applications first/);

  fs.rmSync(home, { recursive: true, force: true });
});
