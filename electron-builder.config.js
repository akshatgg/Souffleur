'use strict';

/**
 * Build configuration.
 *
 * A JS config rather than a block in package.json because signing has to adapt
 * to what credentials are present. With certificates in the environment the
 * build signs and notarises; without them it falls back to an ad-hoc signature
 * that still installs. Adding certificates later needs no code change.
 *
 * ── The three tiers a user can experience ───────────────────────────────────
 *
 *   1. BROKEN      "Souffleur is damaged and can't be opened."
 *                  A hard refusal with only "Move to Bin". This is what an
 *                  inconsistent signature produces, and it is not bypassable.
 *                  Prevented by build/afterPack.js, which signs the assembled
 *                  bundle so its seal matches its contents.
 *
 *   2. UNSIGNED    "cannot be opened because it is from an unidentified
 *                  developer." Bypassable: right-click → Open, or
 *                  System Settings → Privacy & Security → Open Anyway.
 *                  This is where the project sits with no certificates.
 *
 *   3. SIGNED      No warning at all. Requires the Apple Developer Program
 *                  (99 USD/year) for macOS, and an OV or EV code-signing
 *                  certificate for Windows. There is no free path to this on
 *                  either platform; it is vendor policy, not configuration.
 *
 * ── Turning on tier 3 ───────────────────────────────────────────────────────
 *
 *   macOS    CSC_LINK                     base64 .p12, or a file path
 *            CSC_KEY_PASSWORD             its password
 *            APPLE_ID                     Apple ID for notarisation
 *            APPLE_APP_SPECIFIC_PASSWORD  app-specific password
 *            APPLE_TEAM_ID                team identifier
 *
 *   Windows  WIN_CSC_LINK                 base64 .pfx, or a file path
 *            WIN_CSC_KEY_PASSWORD         its password
 *
 * In CI these are repository secrets; nothing here needs editing.
 */

const hasMacCert = Boolean(process.env.CSC_LINK);
const canNotarize = Boolean(
  process.env.APPLE_ID && process.env.APPLE_APP_SPECIFIC_PASSWORD && process.env.APPLE_TEAM_ID
);

module.exports = {
  appId: 'com.akshatgg.souffleur',
  productName: 'Souffleur',
  copyright: 'Copyright (c) 2026 akshatgg',
  directories: { output: 'release', buildResources: 'build' },
  files: ['src/**/*', 'package.json', '!**/*.map'],
  afterPack: 'build/afterPack.js',

  mac: {
    category: 'public.app-category.productivity',
    target: [{ target: 'dmg', arch: ['arm64', 'x64'] }],
    icon: 'build/icon.png',

    // null means "do not sign" — afterPack then applies a consistent ad-hoc
    // signature. With a certificate present, let electron-builder sign properly
    // and afterPack steps aside.
    identity: hasMacCert ? undefined : null,

    // Notarisation without a Developer ID certificate fails the build, so it is
    // only requested when both are available.
    notarize: hasMacCert && canNotarize ? { teamId: process.env.APPLE_TEAM_ID } : false,

    hardenedRuntime: hasMacCert,
    gatekeeperAssess: false,
    entitlements: 'build/entitlements.mac.plist',
    entitlementsInherit: 'build/entitlements.mac.plist',

    extendInfo: {
      // Accessory app: no Dock icon, no app-switcher entry.
      LSUIElement: true,
      NSMicrophoneUsageDescription:
        'Souffleur transcribes your own voice only when you turn on microphone capture.',
      NSCameraUsageDescription: 'Not used.',
    },
    extraResources: [{ from: 'bin', to: 'bin', filter: ['**/*'] }],
  },

  dmg: {
    title: 'Souffleur ${version}',
    contents: [
      { x: 140, y: 200, type: 'file' },
      { x: 400, y: 200, type: 'link', path: '/Applications' },
    ],
  },

  win: {
    target: [{ target: 'nsis', arch: ['x64', 'arm64'] }],
    icon: 'build/icon.png',
    // Unsigned Windows builds trigger SmartScreen's "Windows protected your
    // PC". A certificate removes it; an EV certificate removes it immediately,
    // while an OV certificate needs download reputation to accumulate first.
    signtoolOptions: process.env.WIN_CSC_LINK ? {} : undefined,
  },

  nsis: {
    oneClick: false,
    perMachine: false,
    allowToChangeInstallationDirectory: true,
    shortcutName: 'Souffleur',
  },

  linux: { target: ['AppImage'], category: 'Utility', icon: 'build/icon.png' },
};
