'use strict';
const { execFile, spawn } = require('child_process');
const { once } = require('events');
const { promisify } = require('util');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const run = promisify(execFile);

/**
 * Update now: fetch the newest release from GitHub and install it over the
 * running copy.
 *
 * Done by hand rather than with electron-updater because the macOS build has no
 * Developer ID (docs/SIGNING.md). Squirrel, which electron-updater drives on
 * macOS, refuses to install over an ad-hoc signature, so it would work on
 * Windows and fail on every Mac. The release already carries everything needed:
 * a DMG per architecture and the NSIS installer, each with a SHA-256 that
 * GitHub publishes beside it.
 *
 *   macOS    mount the DMG, copy the app next to the installed one, and swap
 *            the two once this process has exited
 *   Windows  run the installer silently; it replaces the app and reopens it
 *
 * Nothing here touches Electron, so the tests can load it under plain Node.
 */

// The source repository is private, and a private repository's releases cannot
// be read or downloaded without signing in. The installers are published to
// this public one, which holds nothing else.
const REPO = 'akshatgg/souffleur-releases';
const LATEST_URL = `https://api.github.com/repos/${REPO}/releases/latest`;
// The newest release's own files. A plain download, not an API call, so the
// API's limit of 60 calls an hour does not apply to it.
const LATEST_FILES = `https://github.com/${REPO}/releases/latest/download/`;
const RELEASES_PAGE = `https://github.com/${REPO}/releases/latest`;
// Installers are only ever taken from that repository's releases.
const DOWNLOADS = `https://github.com/${REPO}/releases/download/`;
const BUNDLE_ID = 'com.akshatgg.souffleur';

function parts(v) {
  const [core, pre = ''] = String(v || '').trim().replace(/^v/i, '').split('-');
  const nums = core.split('.').map((n) => parseInt(n, 10) || 0);
  return { nums: [nums[0] || 0, nums[1] || 0, nums[2] || 0], pre };
}

/** True when `candidate` is a later version than `current`. */
function isNewer(candidate, current) {
  const a = parts(candidate);
  const b = parts(current);
  for (let i = 0; i < 3; i++) {
    if (a.nums[i] !== b.nums[i]) return a.nums[i] > b.nums[i];
  }
  // Same numbers: 0.2.0 is newer than 0.2.0-beta, and nothing else differs.
  return !a.pre && Boolean(b.pre);
}

/**
 * The installer for this machine. The release holds two DMGs, named apart only
 * by an -arm64 suffix, and one Windows installer that covers both architectures.
 */
function pickAsset(assets, platform, arch) {
  const list = (assets || []).filter((a) => a && a.name && a.browser_download_url);
  let found = null;
  if (platform === 'darwin') {
    const dmgs = list.filter((a) => /\.dmg$/i.test(a.name));
    const isArm = (a) => /arm64/i.test(a.name);
    found = dmgs.find((a) => (arch === 'arm64' ? isArm(a) : !isArm(a)));
  } else if (platform === 'win32') {
    found = list.find((a) => /\.exe$/i.test(a.name));
  }
  if (!found) return null;
  return {
    name: path.basename(found.name),
    url: found.browser_download_url,
    size: found.size || 0,
    sha256: /^sha256:[0-9a-f]{64}$/i.test(found.digest || '') ? found.digest.slice(7).toLowerCase() : '',
    sha512: /^[A-Za-z0-9+/]{86}==$/.test(found.sha512 || '') ? found.sha512 : '',
  };
}

/**
 * The update manifest each release carries, the same format electron-builder
 * writes: the version, then each installer's name, sha512 and size. Only the
 * shape packaging/latest-yml.js writes is read; it is not a YAML parser.
 */
function parseLatestYml(text) {
  const unquote = (v) => v.trim().replace(/^(['"])(.*)\1$/, '$2');
  const out = { files: [] };
  let inFiles = false;
  let file = null;
  for (const raw of String(text).split(/\r?\n/)) {
    if (!raw.trim() || raw.trim().startsWith('#')) continue;
    const item = /^\s*-\s+(\w+):\s*(.*)$/.exec(raw);
    const nested = /^\s+(\w+):\s*(.*)$/.exec(raw);
    const top = /^(\w+):\s*(.*)$/.exec(raw);
    if (top) {
      inFiles = top[1] === 'files' && top[2].trim() === '';
      if (!inFiles) out[top[1]] = unquote(top[2]);
    } else if (inFiles && item) {
      file = { [item[1]]: unquote(item[2]) };
      out.files.push(file);
    } else if (inFiles && nested && file) {
      file[nested[1]] = unquote(nested[2]);
    }
  }
  for (const f of out.files) if (f.size !== undefined) f.size = Number(f.size);
  return out;
}

function formatLatestYml({ version, files, releaseDate }) {
  return [
    `version: ${version}`,
    'files:',
    ...files.flatMap((f) => [`  - url: ${f.file}`, `    sha512: ${f.sha512}`, `    size: ${f.size}`]),
    `path: ${files[0].file}`,
    `sha512: ${files[0].sha512}`,
    `releaseDate: '${releaseDate}'`,
    '',
  ].join('\n');
}

async function sha512OfFile(file) {
  const hash = crypto.createHash('sha512');
  for await (const chunk of fs.createReadStream(file)) hash.update(chunk);
  return hash.digest('base64');
}

const manifestFor = (platform) => (platform === 'win32' ? 'latest.yml' : 'latest-mac.yml');

/**
 * Ask GitHub for the newest release. Throws with a message fit to show.
 *
 * Reads the newest release's manifest, a plain download that GitHub does not
 * count against its API limit, so a busy shared network cannot block it.
 * Releases from before the manifest existed are asked about through the API.
 */
async function check({ current, platform = process.platform, arch = process.arch,
                       fetchImpl = fetch, timeoutMs = 8000 } = {}) {
  let res;
  try {
    res = await fetchImpl(LATEST_FILES + manifestFor(platform), { signal: AbortSignal.timeout(timeoutMs) });
  } catch {
    throw new Error('Could not reach GitHub to check for updates.');
  }
  if (res.status === 404) return checkApi({ current, platform, arch, fetchImpl, timeoutMs });
  if (!res.ok) throw new Error(`Could not check for updates (GitHub answered ${res.status}).`);

  let manifest;
  try {
    manifest = parseLatestYml(await res.text());
  } catch {
    throw new Error('Could not check for updates: the download was cut off.');
  }
  const version = String(manifest.version || '').replace(/^v/i, '');
  if (!version) throw new Error('Could not check for updates: GitHub sent something unexpected.');

  const tag = `${DOWNLOADS}v${encodeURIComponent(version)}/`;
  const assets = manifest.files.filter((f) => f.url).map((f) => ({
    name: f.url, browser_download_url: tag + encodeURIComponent(f.url), size: f.size, sha512: f.sha512,
  }));
  return {
    version,
    newer: isNewer(version, current),
    asset: pickAsset(assets, platform, arch),
    page: `https://github.com/${REPO}/releases/tag/v${encodeURIComponent(version)}`,
  };
}

/** The same question through the API, for a release that has no manifest. */
async function checkApi({ current, platform, arch, fetchImpl, timeoutMs }) {
  let res;
  try {
    res = await fetchImpl(LATEST_URL, {
      headers: { accept: 'application/vnd.github+json' },
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch {
    throw new Error('Could not reach GitHub to check for updates.');
  }
  if (res.status === 403 || res.status === 429) {
    return fromReleasesPage({ current, fetchImpl, timeoutMs, reset: res.headers?.get?.('x-ratelimit-reset') });
  }
  if (!res.ok) throw new Error(`Could not check for updates (GitHub answered ${res.status}).`);

  const rel = await res.json();
  const version = String(rel.tag_name || '').replace(/^v/i, '');
  return {
    version,
    newer: isNewer(version, current),
    asset: pickAsset(rel.assets, platform, arch),
    page: rel.html_url || RELEASES_PAGE,
  };
}

/**
 * GitHub allows 60 API calls an hour from one address, shared by everyone
 * behind it, so an office or a carrier's network can use them all up. The
 * release page is not counted against that: it redirects to the newest tag,
 * which gives the version. It lists no checksum, so `limited` marks a release
 * found this way, and nothing is downloaded on its word alone.
 */
async function fromReleasesPage({ current, fetchImpl, timeoutMs, reset }) {
  try {
    const res = await fetchImpl(RELEASES_PAGE, { method: 'HEAD', signal: AbortSignal.timeout(timeoutMs) });
    const tag = /\/releases\/tag\/v?([^/?#]+)$/.exec(res.ok ? res.url : '');
    if (tag) {
      const version = decodeURIComponent(tag[1]);
      return { version, newer: isNewer(version, current), asset: null, page: res.url, limited: true };
    }
  } catch { /* fall through to the rate-limit message */ }
  throw new Error(rateLimited(reset));
}

function rateLimited(reset) {
  const at = new Date(Number(reset) * 1000);
  const when = Number(reset) > 0
    ? ` after ${at.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}`
    : ' in an hour';
  return `GitHub is limiting update checks from your network right now. Try again${when}.`;
}

/**
 * Download the installer into `dir`, checking it against the size and the
 * checksum the release lists for it: the manifest's sha512, or the SHA-256
 * GitHub's API lists. Resolves to the file's path.
 */
async function download(asset, dir, { onProgress, fetchImpl = fetch } = {}) {
  if (!asset.url.startsWith(DOWNLOADS)) throw new Error('The update points somewhere unexpected.');

  await fs.promises.mkdir(dir, { recursive: true });
  const file = path.join(dir, asset.name);

  let res;
  try {
    res = await fetchImpl(asset.url);
  } catch {
    throw new Error('The download could not start. Check your connection and try again.');
  }
  if (!res.ok || !res.body) throw new Error(`The download failed (${res.status}).`);

  const total = asset.size || Number(res.headers.get('content-length')) || 0;
  const hash = crypto.createHash(asset.sha512 ? 'sha512' : 'sha256');
  const out = fs.createWriteStream(file);
  let got = 0;
  try {
    for await (const chunk of res.body) {
      hash.update(chunk);
      got += chunk.length;
      if (!out.write(chunk)) await once(out, 'drain');
      if (onProgress && total) onProgress(Math.min(1, got / total));
    }
  } catch {
    throw new Error('The download was interrupted. Try again.');
  } finally {
    await new Promise((done) => out.end(done));
  }

  const digest = hash.digest(asset.sha512 ? 'base64' : 'hex');
  const intact = (!asset.size || got === asset.size)
    && (asset.sha512 ? digest === asset.sha512 : !asset.sha256 || digest === asset.sha256);
  if (!intact) {
    await fs.promises.rm(file, { force: true });
    throw new Error('The download did not match the release. Try again.');
  }
  return file;
}

/** /Applications/Souffleur.app, from the path of the binary inside it. */
function macBundle(execPath) {
  const bundle = path.resolve(execPath, '..', '..', '..');
  return /\.app$/.test(bundle) && path.basename(path.dirname(execPath)) === 'MacOS' ? bundle : null;
}

/**
 * Why this copy cannot replace itself, or '' when it can. Asked before the
 * download, so nobody waits for 150 MB that cannot be installed.
 */
function blocker({ platform = process.platform, execPath = process.execPath, packaged }) {
  if (!packaged) return 'This is a development copy, so there is nothing to replace.';
  if (platform === 'win32') return '';
  if (platform !== 'darwin') return 'Updates are installed by hand on this platform.';

  const bundle = macBundle(execPath);
  // Opened straight from the disk image, or from Downloads before being moved:
  // macOS runs it from a read-only copy that cannot be written back to.
  if (!bundle || bundle.startsWith('/Volumes/') || bundle.includes('/AppTranslocation/')) {
    return 'Move Souffleur into Applications first, then update.';
  }
  try {
    fs.accessSync(path.dirname(bundle), fs.constants.W_OK);
  } catch {
    return 'This account cannot write to the folder Souffleur is installed in.';
  }
  return '';
}

// Runs after this process is gone: it cannot replace a bundle that is still
// executing. The old app is moved aside rather than deleted first, so a failed
// move puts it back and the user is never left with no app at all.
//
// An ad-hoc signature changes with every build, so macOS no longer matches the
// new app to the Screen Recording grant the old one had, yet still shows it as
// on. Resetting it makes macOS ask again instead of failing silently.
const SWAP = `
pid="$1"; target="$2"; staged="$3"; old="$4"; relaunch="$5"; id="$6"
n=0
while kill -0 "$pid" 2>/dev/null; do
  n=$((n + 1))
  if [ "$n" -gt 150 ]; then rm -rf "$staged"; exit 1; fi
  sleep 0.2
done
rm -rf "$old"
swapped=0
if mv "$target" "$old"; then
  if mv "$staged" "$target"; then rm -rf "$old"; swapped=1; else mv "$old" "$target"; fi
fi
if [ "$swapped" = 1 ] && /usr/bin/codesign -dv "$target" 2>&1 | grep -q "Signature=adhoc"; then
  /usr/bin/tccutil reset All "$id" >/dev/null 2>&1
fi
[ "$relaunch" = 1 ] && /usr/bin/open "$target"
exit 0
`;

/**
 * macOS, step one, done as soon as the download is verified: put the new app
 * beside the installed one and check it. Resolves to what swapMac needs.
 */
async function stageMac({ dmg, execPath = process.execPath }) {
  const target = macBundle(execPath);
  if (!target) throw new Error('Could not find the installed app to replace.');

  const parent = path.dirname(target);
  const staged = path.join(parent, '.Souffleur.update.app');
  const old = path.join(parent, '.Souffleur.old.app');
  const mount = await fs.promises.mkdtemp(path.join(path.dirname(dmg), 'mount-'));

  try {
    await run('/usr/bin/hdiutil', ['attach', '-nobrowse', '-readonly', '-noautoopen', '-mountpoint', mount, dmg]);
    const name = (await fs.promises.readdir(mount)).find((f) => /\.app$/.test(f));
    if (!name) throw new Error('The update has no app inside it.');

    await fs.promises.rm(staged, { recursive: true, force: true });
    await run('/usr/bin/ditto', [path.join(mount, name), staged]);
  } catch (err) {
    await fs.promises.rm(staged, { recursive: true, force: true });
    throw new Error(err.stderr ? 'The update could not be unpacked.' : err.message);
  } finally {
    await run('/usr/bin/hdiutil', ['detach', mount, '-force']).catch(() => {});
    await fs.promises.rm(mount, { recursive: true, force: true }).catch(() => {});
  }

  // Never swap in something that is not this app, or that macOS would call
  // damaged: once the old bundle is gone there is no button left to retry with.
  try {
    const { stdout } = await run('/usr/bin/plutil',
      ['-extract', 'CFBundleIdentifier', 'raw', path.join(staged, 'Contents', 'Info.plist')]);
    if (stdout.trim() !== BUNDLE_ID) throw new Error('wrong bundle');
    await run('/usr/bin/codesign', ['--verify', '--deep', '--strict', staged]);
  } catch {
    await fs.promises.rm(staged, { recursive: true, force: true });
    throw new Error('The update failed its checks and was not installed.');
  }
  // What the Homebrew cask does after installing; without it a copy that picked
  // up the quarantine flag would be refused on its first launch.
  await run('/usr/bin/xattr', ['-dr', 'com.apple.quarantine', staged]).catch(() => {});
  return { target, staged, old };
}

/**
 * macOS, step two, as Souffleur quits: leave a helper waiting to swap the
 * staged app in once this process has exited, and to open it again when
 * `relaunch` is set. Returns the helper's process.
 */
function swapMac({ target, staged, old, relaunch, pid = process.pid, bundleId = BUNDLE_ID }) {
  const child = spawn('/bin/sh', ['-c', SWAP, 'sh', String(pid), target, staged, old, relaunch ? '1' : '0', bundleId],
    { detached: true, stdio: 'ignore' });
  child.unref();
  return child;
}

/**
 * Windows: hand over to the installer. These are the switches electron-builder's
 * NSIS installer takes for an update: no wizard, close the running app, install
 * where it already is, and, with `relaunch`, open it again.
 */
function installWin({ exe, relaunch }) {
  const args = relaunch ? ['--updated', '/S', '--force-run'] : ['--updated', '/S'];
  spawn(exe, args, { detached: true, stdio: 'ignore' }).unref();
}

module.exports = {
  isNewer, pickAsset, check, download, blocker, macBundle, stageMac, swapMac, installWin,
  parseLatestYml, formatLatestYml, sha512OfFile, RELEASES_PAGE,
};
