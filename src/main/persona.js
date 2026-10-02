'use strict';
const { app } = require('electron');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { extractPdf } = require('./pdftext');
const { buildIndex } = require('./retrieve');
const { route } = require('./router');
const { knowledgePrompt, personalPrompt } = require('./prompts');

/**
 * Persona documents: the CV, portfolio and work history that decide who the
 * assistant is when it answers.
 *
 * Text is extracted once, at upload, and cached. The alternative -- attaching
 * the PDFs to every request -- would re-send tens of thousands of tokens per
 * message for content that never changes.
 *
 * Nor is the cached text sent whole. Each question gets only the sections that
 * match it (see retrieve.js), and a question that is not about the person gets
 * none. That is why the limit is a count of documents and no longer a total
 * size: a long project write-up costs nothing until someone asks about it.
 */

const MAX_DOCS = 10;
const MAX_DOC_BYTES = 25 * 1024 * 1024;

function dir() {
  const d = path.join(app.getPath('userData'), 'documents');
  fs.mkdirSync(d, { recursive: true });
  return d;
}
function indexPath() { return path.join(dir(), 'index.json'); }

function readIndex() {
  try { return JSON.parse(fs.readFileSync(indexPath(), 'utf8')); } catch { return []; }
}
function writeIndex(docs) {
  fs.writeFileSync(indexPath(), JSON.stringify(docs, null, 2), { mode: 0o600 });
}

/**
 * Read one PDF.
 *
 * This used to shell out to a Swift PDFKit helper, which meant interview mode
 * silently did not exist on Windows -- a cross-platform feature limited by a
 * build convenience. pdfjs is pure JavaScript, so it runs wherever Electron
 * does, and extracts the same text: 13,220 characters against PDFKit's 13,208
 * on the same three-page CV.
 */
function extract(file) {
  return extractPdf(file);
}

/** Metadata only. The extracted text stays in the main process. */
function list() {
  return readIndex().map(({ id, name, pages, chars, addedAt }) =>
    ({ id, name, pages, chars, addedAt }));
}

async function add(file) {
  const docs = readIndex();
  if (docs.length >= MAX_DOCS) {
    return { ok: false, error: `You can keep ${MAX_DOCS} documents. Remove one first.` };
  }
  let stat;
  try { stat = fs.statSync(file); } catch { return { ok: false, error: 'File not found.' }; }
  if (stat.size > MAX_DOC_BYTES) return { ok: false, error: 'That PDF is larger than 25 MB.' };

  const res = await extract(file);
  if (!res.ok) return { ok: false, error: res.error || 'Could not read that PDF.' };

  const id = crypto.randomUUID();
  const name = path.basename(file);
  // Keep a copy: the original may move or be deleted, and re-extraction should
  // stay possible without asking the user to find the file again.
  try { fs.copyFileSync(file, path.join(dir(), `${id}.pdf`)); } catch { /* copy is best-effort */ }

  docs.push({ id, name, pages: res.pages, chars: res.chars, addedAt: Date.now(), text: res.text });
  writeIndex(docs);
  return { ok: true, docs: list() };
}

function remove(id) {
  const docs = readIndex().filter((d) => d.id !== id);
  writeIndex(docs);
  try { fs.unlinkSync(path.join(dir(), `${id}.pdf`)); } catch { /* already gone */ }
  return { ok: true, docs: list() };
}

/**
 * Best guess at the person's name, for addressing them as themselves.
 * A CV almost always opens with it on the first line.
 */
function guessName() {
  const first = readIndex()[0];
  if (!first) return '';
  const line = (first.text || '').split('\n').map((s) => s.trim()).find(Boolean) || '';
  const words = line.split(/\s+/);
  const plausible = words.length >= 2 && words.length <= 4 &&
    words.every((w) => /^[A-Z][A-Za-z.'-]*$/.test(w));
  return plausible ? line : '';
}

/**
 * The search index over every document, rebuilt only when the documents change.
 * Building it is a few milliseconds, but it would otherwise run per message.
 */
let cached = { stamp: '', index: null };
function searchIndex() {
  let stamp = '';
  try {
    const st = fs.statSync(indexPath());
    stamp = `${st.mtimeMs}:${st.size}`;
  } catch { /* no documents yet */ }
  if (!cached.index || cached.stamp !== stamp) {
    cached = { stamp, index: buildIndex(readIndex()) };
  }
  return cached.index;
}

/**
 * The interview persona, for this question.
 *
 * Returns '' when no document has been added, so the caller falls back to the
 * plain assistant. Otherwise the question is routed first: a knowledge
 * question gets a prompt with no documents in it, and a question about the
 * person gets the sections that match it. Either way there is an answer.
 */
function interviewPrompt(name, messages, { image = false } = {}) {
  const index = searchIndex();
  if (!index.chunks.length) return '';

  const who = name || guessName();
  const r = route(index, messages, { image });
  return r.kind === 'personal' ? personalPrompt(who, r) : knowledgePrompt(who);
}

module.exports = { list, add, remove, guessName, interviewPrompt, MAX_DOCS };
