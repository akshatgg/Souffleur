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
  };
}

/** Ask GitHub for the newest release. Throws with a message fit to show. */
async function check({ current, platform = process.platform, arch = process.arch,
                       fetchImpl = fetch, timeoutMs = 8000 } = {}) {
  let res;
  try {
    res = await fetchImpl(LATEST_URL, {
      headers: { accept: 'application/vnd.github+json' },
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch {
    throw new Error('Could not reach GitHub to check for updates.');
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
 * Download the installer into `dir`, checking it against the size and SHA-256
 * GitHub lists for it. Resolves to the file's path.
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
  const hash = crypto.createHash('sha256');
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

  const intact = (!asset.size || got === asset.size)
    && (!asset.sha256 || hash.digest('hex') === asset.sha256);
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
const SWAP = `
pid="$1"; target="$2"; staged="$3"; old="$4"
n=0
while kill -0 "$pid" 2>/dev/null; do
  n=$((n + 1))
  if [ "$n" -gt 150 ]; then rm -rf "$staged"; exit 1; fi
  sleep 0.2
done
rm -rf "$old"
if mv "$target" "$old"; then
  if mv "$staged" "$target"; then rm -rf "$old"; else mv "$old" "$target"; fi
fi
open "$target"
`;

/**
 * macOS: put the new app beside the installed one and leave a helper waiting to
 * swap them. Resolves once the helper is waiting; the caller then quits.
 */
async function installMac({ dmg, execPath = process.execPath, pid = process.pid }) {
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

  spawn('/bin/sh', ['-c', SWAP, 'sh', String(pid), target, staged, old],
    { detached: true, stdio: 'ignore' }).unref();
}

/**
 * Windows: hand over to the installer. These are the switches electron-builder's
 * NSIS installer takes for an update: no wizard, close the running app, install
 * where it already is, and open it again.
 */
function installWin({ exe }) {
  spawn(exe, ['--updated', '/S', '--force-run'], { detached: true, stdio: 'ignore' }).unref();
}

module.exports = {
  isNewer, pickAsset, check, download, blocker, macBundle, installMac, installWin,
  RELEASES_PAGE,
};
