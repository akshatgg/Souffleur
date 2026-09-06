'use strict';
const { desktopCapturer, screen } = require('electron');

/**
 * Grab a screen as a PNG data URL, plus a small preview of what was grabbed.
 *
 * We do NOT hide the overlay first. It carries setContentProtection(true),
 * which excludes it from every ScreenCaptureKit consumer -- and desktopCapturer
 * is one. So the model sees your screen without seeing its own last answer, and
 * there is no hide/capture/show flicker.
 *
 * Downscaled before sending: vision models gain nothing from a 3x retina buffer
 * and you pay for every pixel in tokens and latency.
 */
const MAX_WIDTH = 1600;
const THUMB_WIDTH = 260;

/**
 * Capture the display the overlay is sitting on, not always the primary one.
 *
 * With two monitors the question is usually on the screen you are looking at,
 * which is the screen you dragged the overlay to. Defaulting to the primary
 * display silently captured the wrong monitor and the answer made no sense,
 * with nothing on screen to explain why.
 */
async function captureScreen(bounds) {
  const display = bounds
    ? screen.getDisplayMatching(bounds)
    : screen.getPrimaryDisplay();

  const { width, height } = display.size;
  const scale = display.scaleFactor || 1;

  const sources = await desktopCapturer.getSources({
    types: ['screen'],
    thumbnailSize: { width: Math.round(width * scale), height: Math.round(height * scale) },
    fetchWindowIcons: false,
  });
  if (!sources.length) {
    throw new Error('No screen source available. Grant Screen Recording permission.');
  }

  const src =
    sources.find((s) => String(s.display_id) === String(display.id)) || sources[0];

  let img = src.thumbnail;
  if (img.isEmpty()) {
    throw new Error(
      'Screen capture came back empty. Grant Screen Recording to Souffleur in ' +
      'System Settings, then try again.'
    );
  }

  const full = img.getSize();
  const sent = full.width > MAX_WIDTH ? img.resize({ width: MAX_WIDTH, quality: 'good' }) : img;

  return {
    dataUrl: sent.toDataURL(),
    // Small enough to cross IPC and sit in the transcript without cost.
    thumb: img.resize({ width: THUMB_WIDTH, quality: 'good' }).toDataURL(),
    displayId: display.id,
    displayCount: screen.getAllDisplays().length,
    label: `${full.width}x${full.height}`,
  };
}

module.exports = { captureScreen };
