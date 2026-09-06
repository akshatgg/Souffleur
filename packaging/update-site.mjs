#!/usr/bin/env node
// Point the website at the newest release.
//
// The download links and version label on web/index.html are baked in, so a
// click works even when the GitHub API is slow or rate limited. The cost of
// that is they go stale unless something updates them, and they did: the site
// served 0.1.2 for two releases while the Homebrew cask was current, so anyone
// taking the Windows installer from the site got a build with known bugs.
//
// Run by CI after publishing a release, and available by hand:
//   npm run site:update

import { readFile, writeFile } from 'node:fs/promises';

const REPO = 'akshatgg/Souffleur';
const PAGE = 'web/index.html';

const res = await fetch(`https://api.github.com/repos/${REPO}/releases/latest`, {
  headers: process.env.GITHUB_TOKEN
    ? { authorization: `Bearer ${process.env.GITHUB_TOKEN}` }
    : {},
});
if (!res.ok) throw new Error(`${res.status} fetching the latest release`);

const rel = await res.json();
const exe = (rel.assets || []).find((a) => /\.exe$/i.test(a.name));
if (!exe) throw new Error('the release has no Windows installer');

const sizeMb = Math.round(exe.size / 1048576);
const before = await readFile(PAGE, 'utf8');

const after = before
  .replace(/(id="dl-win" href=")[^"]+/, `$1${exe.browser_download_url}`)
  .replace(/(<span data-win-size>)[^<]*/, `$1${sizeMb} MB`)
  .replace(/(<span data-version>)[^<]*/, `$1${rel.tag_name}`);

if (after === before) {
  console.log(`site already at ${rel.tag_name}`);
  process.exit(0);
}

await writeFile(PAGE, after);
console.log(`site -> ${rel.tag_name}`);
console.log(`  windows: ${exe.name} (${sizeMb} MB)`);
