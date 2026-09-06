#!/usr/bin/env node
// Render the Open Graph card that Google, Slack, X, LinkedIn and iMessage show
// when the site is linked.
//
// It is a real 1200x630 PNG rather than a screenshot of the page: link previews
// crop hard and shrink to a thumbnail, so the card needs its own layout with
// text large enough to survive that. Headless Chrome renders the same HTML the
// site is built from, so it stays on-brand for free.
//
//   npm run site:og

import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const SOURCE = resolve('packaging/og-image.html');
const OUT = resolve('web/og.png');

const CHROME = [
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/Applications/Chromium.app/Contents/MacOS/Chromium',
  '/usr/bin/google-chrome',
  '/usr/bin/chromium',
].find(existsSync);

if (!CHROME) {
  console.error('No Chrome or Chromium found. Install one, or edit the list in this file.');
  process.exit(1);
}

const raw = join(mkdtempSync(join(tmpdir(), 'og-')), 'raw.png');

// Rendered at 2x and scaled down: the serif headline looks thin and ragged at
// 1x, and the file is still well under the 5 MB that link unfurlers accept.
execFileSync(CHROME, [
  '--headless', '--disable-gpu', '--hide-scrollbars',
  '--force-device-scale-factor=2',
  '--window-size=1200,630',
  '--default-background-color=0d1016ff',
  '--virtual-time-budget=6000',        // let the webfont arrive before the shot
  `--screenshot=${raw}`,
  `file://${SOURCE}`,
], { stdio: 'ignore' });

execFileSync('sips', ['-z', '630', '1200', raw, '--out', OUT], { stdio: 'ignore' });
console.log(`web/og.png <- packaging/og-image.html`);
