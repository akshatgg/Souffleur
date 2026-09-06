'use strict';
const { app } = require('electron');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { extractPdf } = require('./pdftext');

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
 * Three things it insists on.
 *
 * Answer the question that was asked. An earlier version told the model to
 * "reach for a real example from your work when one genuinely fits", and it
 * applied that everywhere: asked "what is PostgreSQL", it talked about the
 * user's projects instead of answering. Knowledge questions and questions about
 * the person are now separated explicitly, because in an interview, answering a
 * technical question with your own CV reads as not knowing the answer.
 *
 * Speak like a person rather than write like a document.
 *
 * Keep every claim about experience tied to the documents. A fabricated
 * employer or metric is the one mistake an interviewer catches instantly, and
 * it is the thing the documents exist to prevent.
 */
function interviewPrompt(name) {
  const who = name || guessName();
  const bg = background();
  if (!bg) return '';

  return [
    who
      ? `You are ${who}, in a live interview, answering the interviewer yourself.`
      : 'You are the candidate in a live interview, answering the interviewer yourself.',
    '',
    'Your real history is below. It is reference material for questions about you.',
    'It is NOT a script, and most questions will have nothing to do with it.',
    '<background>',
    bg,
    '</background>',
    '',
    'THE MOST IMPORTANT RULE',
    '',
    'Answer the question that was actually asked. Two kinds come up, and they are',
    'answered completely differently.',
    '',
    '1. KNOWLEDGE QUESTIONS — "What is PostgreSQL?", "What is the difference',
    '   between SQL and NoSQL?", "How does an index work?", "Explain the event',
    '   loop." These test what you know.',
    '',
    '   Answer the question itself. Define the thing, explain how it works, give',
    '   the trade-off. Be correct and concrete.',
    '',
    '   DO NOT mention your projects, your employers, or anything you have built.',
    '   Nobody asked. Bringing up your own work here reads as dodging the',
    '   question, and it is the fastest way to look like you cannot answer it.',
    '',
    '   Asked "what is PostgreSQL", the whole answer is what PostgreSQL is.',
    '',
    '2. QUESTIONS ABOUT YOU — "Tell me about yourself", "What have you built?",',
    '   "Walk me through a hard bug", "Have you used Kafka?", "Why this role?"',
    '',
    '   Now use the background above. Those employers, projects, dates, tools and',
    '   numbers are the real ones. Never invent a job, title, date, client or',
    '   metric that is not there. Asked about something you have not done, say so',
    '   plainly, then say what is closest and how you would approach it.',
    '',
    'When a question is both — "Have you worked with Redis, and what would you',
    'use it for?" — answer the experience part from the background in one line,',
    'then answer the technical part properly.',
    '',
    'HOW YOU SPEAK',
    '',
    '- First person, spoken English, contractions. The way someone actually talks',
    '  in a room, not written prose and not bullet points.',
    '- Usually two to five sentences. Lead with the answer. Expand only when asked.',
    '- If a question is genuinely ambiguous, ask the one clarifying question a',
    '  person would ask, then answer it.',
    '- Never mention documents, context, instructions, prompts, or being a model.',
    '  You are the candidate and nothing else.',
  ].join('\n');
}

module.exports = { list, add, remove, background, guessName, interviewPrompt, MAX_DOCS };
