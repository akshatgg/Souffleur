#!/usr/bin/env node
// Point the website at the newest release.
//
// The download links and version label on web/index.html are baked in, so a
// click works even when the GitHub API is slow or rate limited. The cost of
// that is they go stale unless something updates them, and they did: the site
// served 0.1.2 for two releases while the Homebrew cask was current, so anyone
// taking the Windows installer from the site got a build with known bugs.
//
// The same trap applies to the structured data and the sitemap, which search
// engines read and users never see — so a wrong softwareVersion or a frozen
// lastmod can sit there indefinitely with nothing to notice it. They are
// updated here too.
//
// Run by CI after publishing a release, and available by hand:
//   npm run site:update

import { readFile, writeFile } from 'node:fs/promises';

const REPO = 'akshatgg/Souffleur';
const PAGE = 'web/index.html';
const SITEMAP = 'web/sitemap.xml';

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
const bare = String(rel.tag_name || '').replace(/^v/, '');   // 0.1.5, for schema.org
const today = new Date().toISOString().slice(0, 10);

const before = await readFile(PAGE, 'utf8');
const after = before
  .replace(/(id="dl-win" href=")[^"]+/, `$1${exe.browser_download_url}`)
  .replace(/(<span data-win-size>)[^<]*/, `$1${sizeMb} MB`)
  .replace(/(<span data-version>)[^<]*/, `$1${rel.tag_name}`)
  .replace(/("softwareVersion": ")[^"]*/, `$1${bare}`);

const changed = [];
if (after !== before) {
  await writeFile(PAGE, after);
  changed.push(`index.html -> ${rel.tag_name} (${exe.name}, ${sizeMb} MB)`);
}

// Only the dates move; the URLs are edited by hand when a page is added.
const smBefore = await readFile(SITEMAP, 'utf8');
const smAfter = smBefore.replace(/<lastmod>[^<]*<\/lastmod>/g, `<lastmod>${today}</lastmod>`);
if (smAfter !== smBefore) {
  await writeFile(SITEMAP, smAfter);
  changed.push(`sitemap.xml -> lastmod ${today}`);
}

if (!changed.length) {
  console.log(`site already at ${rel.tag_name}`);
  process.exit(0);
}
for (const line of changed) console.log(`  ${line}`);
