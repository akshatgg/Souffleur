'use strict';
const test = require('node:test');
const assert = require('node:assert');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const {
  isNewer, pickAsset, check, download, blocker, macBundle, swapMac,
  parseLatestYml, formatLatestYml,
} = require('../src/main/updater.js');
const { writeLatestYml } = require('../packaging/latest-yml.js');

/**
 * Update now: which release counts as newer, which installer this machine
 * takes, and that a download which does not match the release is thrown away.
 * No network; fetch is stubbed.
 */

const BASE = 'https://github.com/akshatgg/souffleur-releases/releases/download/v0.2.0/';
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

const SHA512 = (c) => c.repeat(86) + '==';
const MANIFEST_MAC = formatLatestYml({
  version: '0.2.0',
  files: [
    { file: 'Souffleur-0.2.0-arm64.dmg', sha512: SHA512('a'), size: 11 },
    { file: 'Souffleur-0.2.0.dmg', sha512: SHA512('b'), size: 12 },
  ],
  releaseDate: '2026-10-14T00:00:00.000Z',
});
const MANIFEST_WIN = formatLatestYml({
  version: '0.2.0',
  files: [{ file: 'Souffleur.Setup.0.2.0.exe', sha512: SHA512('c'), size: 13 }],
  releaseDate: '2026-10-14T00:00:00.000Z',
});
const LATEST = 'https://github.com/akshatgg/souffleur-releases/releases/latest/download/';

/** A fetch that answers by URL: `routes` maps a URL prefix to a response. */
function routed(routes, calls = []) {
  return async (url, init = {}) => {
    calls.push({ url, method: init.method || 'GET' });
    const hit = Object.keys(routes).find((prefix) => url.startsWith(prefix));
    if (!hit) return { ok: false, status: 404, headers: { get: () => null } };
    const r = routes[hit];
    return typeof r === 'function' ? r(url) : r;
  };
}
const text = (body) => ({ ok: true, status: 200, text: async () => body });

test('check reads the newest release from its manifest, not the API', async () => {
  const calls = [];
  const fetchImpl = routed({ [LATEST + 'latest-mac.yml']: text(MANIFEST_MAC), [LATEST + 'latest.yml']: text(MANIFEST_WIN) }, calls);

  const up = await check({ current: '0.1.4', platform: 'darwin', arch: 'arm64', fetchImpl });
  assert.equal(up.version, '0.2.0');
  assert.equal(up.newer, true);
  assert.deepEqual(up.asset, {
    name: 'Souffleur-0.2.0-arm64.dmg', url: BASE + 'Souffleur-0.2.0-arm64.dmg', size: 11, sha256: '', sha512: SHA512('a'),
  });
  assert.equal(up.page, 'https://github.com/akshatgg/souffleur-releases/releases/tag/v0.2.0');
  assert.ok(calls.every((c) => !c.url.startsWith('https://api.github.com/')), 'never touches the API');

  const intel = await check({ current: '0.1.4', platform: 'darwin', arch: 'x64', fetchImpl });
  assert.equal(intel.asset.name, 'Souffleur-0.2.0.dmg');

  const win = await check({ current: '0.2.0', platform: 'win32', arch: 'x64', fetchImpl });
  assert.equal(win.newer, false);
  assert.equal(win.asset.url, BASE + 'Souffleur.Setup.0.2.0.exe');
  assert.equal(win.asset.sha512, SHA512('c'));
});

test('a release without a manifest is asked about through the API', async () => {
  const rel = { tag_name: 'v0.2.0', html_url: 'https://example.test/r', assets: ASSETS };
  const fetchImpl = routed({ 'https://api.github.com/': { ok: true, status: 200, json: async () => rel } });

  const up = await check({ current: '0.1.4', platform: 'darwin', arch: 'arm64', fetchImpl });
  assert.equal(up.version, '0.2.0');
  assert.equal(up.asset.name, 'Souffleur-0.2.0-arm64.dmg');
  assert.equal(up.page, 'https://example.test/r');

  const broken = routed({ [LATEST]: { ok: false, status: 500 } });
  await assert.rejects(check({ current: '0.1.4', fetchImpl: broken }), /500/);
  await assert.rejects(
    check({ current: '0.1.4', fetchImpl: async () => { throw new Error('offline'); } }),
    /Could not reach GitHub/
  );
});

test('when GitHub limits the API, the release page still gives the version', async () => {
  const calls = [];
  const fetchImpl = routed({
    'https://api.github.com/': { ok: false, status: 403, headers: { get: () => '1791965632' } },
    'https://github.com/akshatgg/souffleur-releases/releases/latest': (url) => (url.includes('/download/')
      ? { ok: false, status: 404 }
      : { ok: true, status: 200, url: 'https://github.com/akshatgg/souffleur-releases/releases/tag/v0.2.0' }),
  }, calls);

  const up = await check({ current: '0.1.4', platform: 'darwin', arch: 'arm64', fetchImpl });
  assert.equal(up.version, '0.2.0');
  assert.equal(up.newer, true);
  assert.equal(up.limited, true);
  assert.equal(up.asset, null, 'no checksum, so nothing to download');
  assert.equal(up.page, 'https://github.com/akshatgg/souffleur-releases/releases/tag/v0.2.0');
  assert.deepEqual(calls.map((c) => c.method), ['GET', 'GET', 'HEAD']);
});

test('when GitHub limits both ways, the message says so instead of a bare 403', async () => {
  const limited = routed({ 'https://api.github.com/': { ok: false, status: 429, headers: { get: () => null } } });
  await assert.rejects(check({ current: '0.1.4', fetchImpl: limited }),
    /GitHub is limiting update checks from your network right now\. Try again in an hour\./);

  const pageDown = routed({
    'https://api.github.com/': { ok: false, status: 403, headers: { get: () => '1791965632' } },
    'https://github.com/akshatgg/souffleur-releases/releases/latest': (url) => (url.includes('/download/')
      ? { ok: false, status: 404 }
      : Promise.reject(new Error('offline'))),
  });
  await assert.rejects(check({ current: '0.1.4', fetchImpl: pageDown }), /Try again after /);
});

test('the release workflow\'s manifest reads back as written', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'souffleur-yml-'));
  const arm = path.join(dir, 'Souffleur-0.2.0-arm64.dmg');
  const intel = path.join(dir, 'Souffleur-0.2.0.dmg');
  fs.writeFileSync(arm, 'arm build');
  fs.writeFileSync(intel, 'intel build!');

  const out = await writeLatestYml({ version: '0.2.0', installer: [arm, intel], out: path.join(dir, 'latest-mac.yml') });
  const m = parseLatestYml(fs.readFileSync(out, 'utf8'));
  assert.equal(m.version, '0.2.0');
  assert.deepEqual(m.files.map((f) => [f.url, f.size]), [['Souffleur-0.2.0-arm64.dmg', 9], ['Souffleur-0.2.0.dmg', 12]]);
  assert.equal(m.files[0].sha512, crypto.createHash('sha512').update('arm build').digest('base64'));

  await assert.rejects(writeLatestYml({ version: 'v0.2', installer: [arm] }), /Not a version/);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('electron-builder\'s own manifest format reads too', () => {
  const m = parseLatestYml([
    'version: 0.3.0',
    'files:',
    '  - url: Souffleur Setup 0.3.0.exe',
    `    sha512: ${SHA512('d')}`,
    '    size: 99',
    'path: Souffleur Setup 0.3.0.exe',
    `sha512: ${SHA512('d')}`,
    "releaseDate: '2026-10-14T00:00:00.000Z'",
  ].join('\r\n'));
  assert.equal(m.version, '0.3.0');
  assert.deepEqual(m.files, [{ url: 'Souffleur Setup 0.3.0.exe', sha512: SHA512('d'), size: 99 }]);
  assert.equal(m.releaseDate, '2026-10-14T00:00:00.000Z');
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

  // The manifest's sha512 is checked when there is one, in place of the SHA-256.
  const sha512 = crypto.createHash('sha512').update(bytes).digest('base64');
  const listed = { ...good, name: 'V.exe', sha256: '', sha512 };
  assert.deepEqual(fs.readFileSync(await download(listed, dir, { fetchImpl: serveBytes(bytes) })), bytes);
  await assert.rejects(download({ ...listed, name: 'W.exe', sha512: SHA512('e') }, dir, { fetchImpl: serveBytes(bytes) }),
    /did not match/);
  assert.equal(fs.existsSync(path.join(dir, 'W.exe')), false);

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

test('at quit, the staged app is swapped in, and reopened only when asked', { skip: process.platform === 'win32' }, async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'souffleur-swap-'));
  const target = path.join(dir, 'Souffleur.app');
  const staged = path.join(dir, '.Souffleur.update.app');
  const old = path.join(dir, '.Souffleur.old.app');
  fs.mkdirSync(target);
  fs.writeFileSync(path.join(target, 'version'), 'old');
  fs.mkdirSync(staged);
  fs.writeFileSync(path.join(staged, 'version'), 'new');

  // A process that has already exited stands in for the quitting app. Not
  // signed, so the permission reset is skipped; relaunch off, so nothing opens.
  const gone = require('child_process').spawnSync(process.execPath, ['-e', '']).pid;
  const child = swapMac({ target, staged, old, relaunch: false, pid: gone, bundleId: 'test.invalid.souffleur' });
  child.ref();   // detached and unref'd so it outlives the app; here, wait for it
  const [code] = await require('events').once(child, 'exit');

  assert.equal(code, 0);
  assert.equal(fs.readFileSync(path.join(target, 'version'), 'utf8'), 'new');
  assert.equal(fs.existsSync(staged), false);
  assert.equal(fs.existsSync(old), false);
  fs.rmSync(dir, { recursive: true, force: true });
});
