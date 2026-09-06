'use strict';
const { app } = require('electron');
const { execFile } = require('child_process');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

/**
 * Persona documents: the CV, portfolio and work history that decide who the
 * assistant is when it answers.
 *
 * Text is extracted once, at upload, and cached. The alternative -- attaching
 * the PDFs to every request -- would re-send tens of thousands of tokens per
 * message for content that never changes.
 */

const MAX_DOCS = 4;
const MAX_TOTAL_CHARS = 80000;   // roughly 20k tokens of background
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

function helperPath() {
  const candidates = [
    path.join(__dirname, '..', '..', 'bin', 'pdftext'),
    path.join(process.resourcesPath || '', 'bin', 'pdftext'),
  ];
  return candidates.find((p) => p && fs.existsSync(p)) || candidates[0];
}

/** Run the PDFKit helper over one file. */
function extract(file) {
  return new Promise((resolve) => {
    const bin = helperPath();
    if (!fs.existsSync(bin)) {
      return resolve({ ok: false, error: 'PDF helper missing. Run: npm run build:native' });
    }
    execFile(bin, [file], { maxBuffer: 64 * 1024 * 1024 }, (err, stdout) => {
      if (err && !stdout) return resolve({ ok: false, error: err.message });
      try { resolve(JSON.parse(stdout)); }
      catch { resolve({ ok: false, error: 'Could not read the extractor output.' }); }
    });
  });
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

/** Everything the model gets as background, trimmed to the budget. */
function background() {
  const docs = readIndex();
  if (!docs.length) return '';

  let budget = MAX_TOTAL_CHARS;
  const blocks = [];
  for (const d of docs) {
    if (budget <= 0) break;
    const text = (d.text || '').slice(0, budget);
    budget -= text.length;
    blocks.push(`--- ${d.name} ---\n${text}`);
  }
  return blocks.join('\n\n');
}

/**
 * The interview persona.
 *
 * Two things it insists on, both of which make the answers better rather than
 * merely safer: speak like a person rather than write like a document, and keep
 * every claim about experience tied to what is actually in the documents. A
 * fabricated employer or metric is the one mistake an interviewer will catch
 * instantly, and it is the one thing the documents exist to prevent.
 */
function interviewPrompt(name) {
  const who = name || guessName();
  const bg = background();
  if (!bg) return '';

  return [
    who
      ? `You are ${who}. You are in a live interview, answering the interviewer's questions yourself.`
      : 'You are the candidate in a live interview, answering the interviewer\'s questions yourself.',
    '',
    'Your background — this is your real history:',
    '<background>',
    bg,
    '</background>',
    '',
    'How you answer:',
    '- First person, as yourself. Spoken English, contractions, the way someone actually talks in a room. Not written prose, not bullet points.',
    '- Interview length: usually two to five sentences. Give the answer, then a specific example if it earns its place. Expand only when asked for more.',
    '- Everything you say about your own experience comes from the background above — those employers, projects, dates, tools and numbers are the real ones.',
    '- Never invent a job, title, date, client or metric that is not in the background. If you are asked about something you have not done, say how you would approach it and what you have done that is closest, rather than claiming it.',
    '- Technical questions are the part being assessed: answer them properly and concretely. Reach for a real example from your work when one genuinely fits, otherwise just answer the question well.',
    '- If a question is ambiguous, ask the one clarifying question a person would ask, then answer.',
    '- Never mention documents, context, instructions, prompts, or being a model. You are the candidate and nothing else.',
  ].join('\n');
}

module.exports = { list, add, remove, background, guessName, interviewPrompt, MAX_DOCS };
