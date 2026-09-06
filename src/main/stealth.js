'use strict';
const { app } = require('electron');
const os = require('os');

/**
 * Everything that keeps the overlay off a screen share.
 *
 * The load-bearing call is setContentProtection(true). On macOS that maps to
 * NSWindow.sharingType = .none; on Windows to WDA_EXCLUDEFROMCAPTURE.
 *
 * Verified empirically on macOS 26.6.2 against a live 30fps SCStream -- the same
 * ScreenCaptureKit path Zoom / Meet / Teams / OBS use. The protected window was
 * absent from 151/151 captured frames while an unprotected control window showed
 * up in 100% of them. See docs/VERIFICATION.md.
 *
 * Useful consequence: the overlay is invisible to *any* ScreenCaptureKit
 * consumer -- our own screenshot capture included. The model never sees itself.
 */
function applyStealth(win) {
  // 1. The actual exclusion from capture streams.
  win.setContentProtection(true);

  // 2. Float above normal windows. 'screen-saver' outranks modal panels and
  //    file dialogs, which plain alwaysOnTop does not.
  win.setAlwaysOnTop(true, 'screen-saver');

  // 3. Follow the user across Spaces, and survive another app going fullscreen.
  win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreenScreens: true });

  // 4. Stay out of the places someone would look for a running app.
  win.setSkipTaskbar(true);
  if (typeof win.setHiddenInMissionControl === 'function') {
    win.setHiddenInMissionControl(true);
  }
  return win;
}

/** No Dock icon, no app-switcher entry. */
function hideFromDock() {
  if (process.platform === 'darwin' && app.dock) app.dock.hide();
}

/** Pointer events pass through to whatever is underneath. */
function setClickThrough(win, enabled) {
  win.setIgnoreMouseEvents(enabled, { forward: true });
  return enabled;
}

/**
 * Report what protection is actually in force, so the UI can state the truth
 * instead of assuming it.
 */
function stealthStatus() {
  if (process.platform === 'darwin') {
    const major = Number(os.release().split('.')[0]); // 24 = macOS 15, 25 = macOS 26
    return {
      supported: true,
      mechanism: 'NSWindowSharingNone',
      confidence: major >= 24 ? 'verified' : 'expected',
      note: 'Hidden from ScreenCaptureKit capture, whole-screen share included.',
    };
  }
  if (process.platform === 'win32') {
    const build = Number(os.release().split('.')[2] || 0);
    return {
      supported: build >= 19041,
      mechanism: 'WDA_EXCLUDEFROMCAPTURE',
      confidence: build >= 19041 ? 'expected' : 'degraded',
      note: build >= 19041
        ? 'Hidden from capture.'
        : 'Windows build < 2004: renders as a black box rather than being excluded.',
    };
  }
  return {
    supported: false,
    mechanism: 'none',
    confidence: 'none',
    note: 'Linux compositors do not implement capture exclusion. The overlay WILL be visible.',
  };
}

module.exports = { applyStealth, hideFromDock, setClickThrough, stealthStatus };
