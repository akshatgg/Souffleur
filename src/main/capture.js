'use strict';
const { desktopCapturer, screen } = require('electron');

/**
 * Grab the current screen as a PNG data URL.
 *
 * We do NOT need to hide the overlay first. It carries setContentProtection(true),
 * which excludes it from every ScreenCaptureKit consumer -- and desktopCapturer is
 * one. So the model sees your screen without seeing itself, and there is no
 * hide/capture/show flicker.
 *
 * Downscaled before sending: vision models gain nothing from a 3x retina buffer
 * and you pay for every pixel in tokens and latency.
 */
const MAX_WIDTH = 1600;

async function captureScreen() {
  const display = screen.getPrimaryDisplay();
  const { width, height } = display.size;
  const scale = display.scaleFactor || 1;

  const sources = await desktopCapturer.getSources({
    types: ['screen'],
    thumbnailSize: { width: Math.round(width * scale), height: Math.round(height * scale) },
    fetchWindowIcons: false,
  });
  if (!sources.length) throw new Error('No screen source available. Grant Screen Recording permission.');

  // Prefer the display the overlay is actually on.
  const src =
    sources.find((s) => String(s.display_id) === String(display.id)) || sources[0];

  let img = src.thumbnail;
  if (img.isEmpty()) {
    throw new Error('Screen capture returned an empty image. Screen Recording permission is likely missing.');
  }

  const size = img.getSize();
  if (size.width > MAX_WIDTH) {
    img = img.resize({ width: MAX_WIDTH, quality: 'good' });
  }
  return img.toDataURL();
}

module.exports = { captureScreen };
