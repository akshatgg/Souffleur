#!/usr/bin/env node
// Regenerate the Homebrew cask for the newest release.
//
// Homebrew verifies the download against a SHA-256, so the cask has to be
// updated every release or `brew install` fails on a checksum mismatch. This
// fetches the release, hashes both DMGs, and writes the file.
//
//   npm run cask:update

import { createHash } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';

const REPO = 'akshatgg/souffleur-releases';

// The installers live in a public repository, so no token is needed. One is
// still sent when present: it lifts the anonymous rate limit on CI runners.
const TOKEN = process.env.GITHUB_TOKEN || process.env.GH_TOKEN || '';
const auth = TOKEN ? { Authorization: `Bearer ${TOKEN}` } : {};

async function sha256(url) {
  const res = await fetch(url, {
    redirect: 'follow',
    headers: { ...auth, Accept: 'application/octet-stream' },
  });
  if (!res.ok) throw new Error(`${res.status} fetching ${url}`);
  const hash = createHash('sha256');
  for await (const chunk of res.body) hash.update(chunk);
  return hash.digest('hex');
}

const relRes = await fetch(`https://api.github.com/repos/${REPO}/releases/latest`, { headers: auth });
if (!relRes.ok) {
  throw new Error(`${relRes.status} reading the latest release`);
}
const rel = await relRes.json();
const version = String(rel.tag_name).replace(/^v/, '');
const asset = (re) => rel.assets.find((a) => re.test(a.name));

const arm = asset(/arm64\.dmg$/);
const x64 = asset(/^(?!.*arm64).*\.dmg$/);
if (!arm || !x64) throw new Error('release is missing one of the DMGs');

process.stdout.write(`hashing ${version}\n`);
const [armSha, x64Sha] = await Promise.all([
  sha256(arm.url),
  sha256(x64.url),
]);

const out = (await readFile('packaging/souffleur.rb', 'utf8'))
  .replace(/version "[^"]*"/, `version "${version}"`)
  .replace(/sha256 "[^"]*"\n(\s*)url (.*arm64\.dmg")/, `sha256 "${armSha}"\n$1url $2`)
  .replace(/REPLACE_ARM64_SHA/, armSha)
  .replace(/REPLACE_X64_SHA/, x64Sha);

// Second pass: replace whichever sha still holds an old value, matched by the
// url that follows it, so re-running on an already-updated file stays correct.
const fixed = out
  .replace(/(on_arm do\n\s*sha256 ")[0-9a-f]{64}(")/, `$1${armSha}$2`)
  .replace(/(on_intel do\n\s*sha256 ")[0-9a-f]{64}(")/, `$1${x64Sha}$2`);

await writeFile('packaging/souffleur.rb', fixed);
console.log(`souffleur ${version}`);
console.log(`  arm64 ${armSha}`);
console.log(`  x64   ${x64Sha}`);
console.log('\nThe release workflow copies packaging/souffleur.rb to Casks/souffleur.rb in akshatgg/homebrew-tap.');
