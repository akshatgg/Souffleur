'use strict';
const { execFileSync } = require('child_process');
const path = require('path');

/**
 * Ad-hoc sign the macOS bundle after packaging.
 *
 * Without this, the app reports as **damaged** on any Mac that downloads it —
 * not the usual "unidentified developer" warning, but a hard refusal with only
 * a "Move to Bin" button.
 *
 * The cause is that `mac.identity: null` tells electron-builder to skip signing
 * altogether. The Electron binary inside still carries its own ad-hoc
 * signature, so the finished bundle ends up claiming to be signed while its
 * seal describes different contents:
 *
 *     Identifier = Electron
 *     code has no resources but signature indicates they must be present
 *
 * Gatekeeper reads that as tampering. Signing the assembled bundle here — with
 * the real bundle identifier — produces a consistent seal, so the app is merely
 * unsigned-by-an-unknown-developer, which users can get past.
 *
 * arm64 Macs additionally refuse to execute any binary with no signature at
 * all, so this is not optional on Apple Silicon.
 *
 * None of this replaces notarisation. It makes the app installable; a Developer
 * ID would make it open without ceremony.
 */
exports.default = async function afterPack(context) {
  if (context.electronPlatformName !== 'darwin') return;

  const appName = `${context.packager.appInfo.productFilename}.app`;
  const appPath = path.join(context.appOutDir, appName);
  const bundleId = context.packager.appInfo.id;

  console.log(`  • ad-hoc signing  ${appName} as ${bundleId}`);

  execFileSync('codesign', [
    '--force',
    '--deep',
    '--sign', '-',
    '--identifier', bundleId,
    appPath,
  ], { stdio: 'inherit' });

  // Fail the build rather than ship something that will be called damaged.
  execFileSync('codesign', ['--verify', '--strict', '--deep', appPath], { stdio: 'inherit' });

  const info = execFileSync('codesign', ['-dv', appPath], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  console.log(`  • signature verified (${(info.match(/Identifier=(\S+)/) || [])[1]})`);
};
