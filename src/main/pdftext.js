'use strict';
const fs = require('fs');

/**
 * Extract text from a PDF, on every platform.
 *
 * This replaces a Swift PDFKit helper. PDFKit produced good text but existed
 * only in macOS builds, which quietly made interview mode macOS-only — a
 * cross-platform feature limited by a build convenience rather than by
 * anything about the problem. pdfjs is pure JavaScript and runs wherever
 * Electron does.
 *
 * Returns the same shape the Swift helper did, so callers did not change:
 *   { ok: true, pages, chars, title, text } | { ok: false, error }
 */

const MAX_PAGES = 200;

let pdfjs = null;
async function lib() {
  if (!pdfjs) {
    // The legacy build is the one that runs under Node without a DOM.
    pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs');
  }
  return pdfjs;
}

/**
 * Rebuild lines from positioned text items.
 *
 * pdfjs hands back fragments with coordinates, not lines. Joining them with
 * spaces turns a two-column CV into interleaved nonsense, so fragments are
 * grouped by their vertical position first and only then joined left to right.
 */
function itemsToText(items) {
  const rows = new Map();

  for (const it of items) {
    if (typeof it.str !== 'string' || !it.str) continue;
    const y = Math.round((it.transform?.[5] ?? 0) * 2) / 2;   // half-point buckets
    const x = it.transform?.[4] ?? 0;
    if (!rows.has(y)) rows.set(y, []);
    rows.get(y).push({ x, s: it.str, eol: it.hasEOL });
  }

  return [...rows.entries()]
    .sort((a, b) => b[0] - a[0])              // PDF origin is bottom-left
    .map(([, frags]) => frags
      .sort((a, b) => a.x - b.x)
      .map((f) => f.s)
      .join('')
      .replace(/\s+/g, ' ')
      .trim())
    .filter(Boolean)
    .join('\n');
}

async function extractPdf(file) {
  if (!fs.existsSync(file)) return { ok: false, error: `File not found: ${file}` };

  let doc, task;
  try {
    const { getDocument } = await lib();
    // Keep the loading task: in pdfjs 6 that is what owns destroy(), not the
    // document, and leaking it keeps a worker alive per upload.
    task = getDocument({
      data: new Uint8Array(fs.readFileSync(file)),
      // Nothing here renders, so skip the machinery that only matters on screen.
      disableFontFace: true,
      useSystemFonts: false,
      isEvalSupported: false,
    });
    doc = await task.promise;
  } catch (err) {
    const msg = String(err && err.message || err);
    if (/password/i.test(msg)) return { ok: false, error: 'That PDF is password protected.' };
    return { ok: false, error: `Could not open that PDF: ${msg}` };
  }

  try {
    const pages = Math.min(doc.numPages, MAX_PAGES);
    const chunks = [];
    for (let i = 1; i <= pages; i++) {
      const page = await doc.getPage(i);
      const content = await page.getTextContent();
      const text = itemsToText(content.items);
      if (text) chunks.push(text);
      page.cleanup();
    }

    let text = chunks.join('\n')
      .replace(/ /g, ' ')
      // Icon fonts (FontAwesome and friends) map glyphs into the Unicode
      // private use area, or onto stray Latin letters. They extract as noise
      // that means nothing to a model and costs tokens on every request.
      .replace(/[\uE000-\uF8FF]/g, ' ')
      // Only the private use area is stripped. A wider rule that also removed
      // lone symbols looked tempting, but it deleted the em dashes and
      // ampersands in real job titles. A few leftover glyph characters cost
      // almost nothing; losing punctuation from the person's own history does.
      .replace(/[ \t]+/g, ' ')
      .replace(/ +\|/g, ' |')
      .replace(/\n{3,}/g, '\n\n')
      .trim();

    if (!text) {
      return {
        ok: false,
        pages: doc.numPages,
        error: 'No selectable text found — this looks like a scanned image, which needs OCR.',
      };
    }

    const meta = await doc.getMetadata().catch(() => null);
    return {
      ok: true,
      pages: doc.numPages,
      chars: text.length,
      title: meta?.info?.Title || '',
      text,
    };
  } finally {
    await task?.destroy?.().catch?.(() => {});
  }
}

module.exports = { extractPdf };
