'use strict';
const { SET: TECH, COMMON, PHRASES } = require('./techterms');

/**
 * Find the parts of the person's documents a question is about.
 *
 * The documents used to be pasted whole into every request. With a CV and
 * several project write-ups that is tens of thousands of tokens per message,
 * most of them about a different project from the one being asked about, and
 * the total had to be capped, so later documents were silently cut off.
 *
 * Instead the text is split into sections once, and each question pulls only
 * the few sections that match it. Nothing here calls a model: it is word
 * matching, weighted so that a rare word ("Headscale") counts for more than a
 * common one ("project"). That keeps it instant, free and testable.
 */

const CHUNK_TARGET = 1200;   // characters a section aims for
const CHUNK_MIN = 300;       // a heading may start a new section after this much
const CHUNK_MAX = 1800;
const BUDGET = 7000;         // characters of sections sent with one question
const MAX_CHUNKS = 6;
const KEEP_RATIO = 0.3;      // drop sections scoring under this share of the best

// Two spellings of one technology. An interviewer says "Postgres" about a CV
// that says "PostgreSQL", and that must not read as a technology never used.
const SAME = {
  postgres: 'postgresql', mongo: 'mongodb', k8s: 'kubernetes', nodejs: 'node.js',
  nextjs: 'next.js', 'react.js': 'react', reactjs: 'react',
  websockets: 'websocket', webhooks: 'webhook', oauth2: 'oauth',
};

/** "screens" and "screen" are the same word to a search. */
function norm(t) {
  if (SAME[t]) return SAME[t];
  if (/[.+#]/.test(t)) return t;            // "node.js" is a name, not a plural
  return t.length > 3 && t.endsWith('s') && !t.endsWith('ss') ? t.slice(0, -1) : t;
}

// Words that say nothing about which section is wanted.
const STOP = new Set((
  'a an the and or but if then so of in on at to for from by with without into over about as ' +
  'is are was were be been being am do does did done have has had having can could would ' +
  'should will shall may might must i me my mine we us our you your yours yourself he she it ' +
  'its they them their this that these those there here what which who whom whose when where ' +
  'why how not no yes any some all more most other such only just also very too than up out ' +
  'tell explain describe walk talk give say said know think please okay ok right well like ' +
  'thing things something anything way use used using make made get got go going one two ' +
  'project projects work worked working time lot bit kind sort mean basically actually ' +
  // how questions are phrased, whatever they are about
  'difference different between compare comparison versus vs example examples type types ' +
  'advantage advantages disadvantage disadvantages benefit benefits pros cons purpose ' +
  'concept definition define meaning main key important good best better worse simple ' +
  'detail details briefly short quick quickly exactly really want need help question ' +
  'answer first second next last new old many much few same able whether each every both ' +
  'either while because since before after during again still even ever never always ' +
  'often usually generally common commonly case cases scenario situation problem problems ' +
  'issue issues approach handle handled happen happens happened choose chose pick picked ' +
  'prefer preferred instead rather over under inside within across through put take took ' +
  'come came see look show let try tried start started end called named name term word'
).split(' ').map(norm));

/** Lower-case words, keeping the punctuation that is part of a name. */
function tokens(text) {
  const out = [];
  for (const raw of String(text).toLowerCase().match(/[a-z0-9+#.]+/g) || []) {
    const t = raw.replace(/^\.+|\.+$/g, '');
    if (t) out.push(norm(t));
  }
  return out;
}

function phraseKey(text) {
  return ` ${tokens(text).join(' ')} `;
}

// Search word -> the name as the lexicon spells it, for showing to the model.
const TECH_WORDS = new Map();
for (const t of TECH) {
  const w = tokens(t);
  if (w.length === 1 && !TECH_WORDS.has(w[0])) TECH_WORDS.set(w[0], SAME[t] || t);
}
const COMMON_WORDS = new Set([...COMMON].flatMap((t) => tokens(t)));
const TECH_PHRASES = PHRASES.filter((p) => tokens(p).length > 1)
  .map((p) => ({ term: p, key: phraseKey(p) }));

/** A short line that names what follows, rather than being part of it. */
function looksLikeHeading(line) {
  if (line.length > 90 || !/[A-Za-z]{3}/.test(line)) return false;
  if (/[.,;:]$/.test(line)) return false;
  if (/^[•\-–*#(▲▼│]/.test(line)) return false;
  return /^[^a-z]/.test(line);          // starts with a capital, digit or symbol
}

/** Split one document into sections of roughly CHUNK_TARGET characters. */
function chunkDoc(doc) {
  const chunks = [];
  let heading = '';        // the latest heading seen
  let label = '';          // the heading in force when this section began
  let lines = [];
  let size = 0;

  const flush = () => {
    if (!lines.length) return;
    chunks.push({ doc: doc.name, heading: label, text: lines.join('\n') });
    lines = [];
    size = 0;
  };

  for (const raw of String(doc.text || '').split('\n')) {
    const line = raw.trim();
    if (!line) continue;
    const head = looksLikeHeading(line);
    if ((head && size >= CHUNK_MIN) || size + line.length > CHUNK_MAX) flush();
    if (head) heading = line;
    if (!lines.length) label = heading;
    lines.push(line);
    size += line.length + 1;
    if (size >= CHUNK_TARGET && /[.!?]$/.test(line)) flush();
  }
  flush();
  return chunks;
}

/**
 * Names that belong to this person: their projects, employers and products.
 *
 * A word counts when the documents mostly write it with a capital, do so at
 * least once in the middle of a sentence, and it is not a technology anyone
 * would know. "Beryl" and "Updater" pass; "PostgreSQL" is common knowledge and
 * "Built" is only ever capitalised because it starts a bullet.
 */
function findEntities(docs) {
  const cap = new Map();
  const mid = new Set();
  const lower = new Map();
  const bump = (m, k) => m.set(k, (m.get(k) || 0) + 1);

  for (const d of docs) {
    const text = String(d.text || '');
    const re = /[A-Za-z][A-Za-z0-9+#.]*/g;
    let m;
    while ((m = re.exec(text))) {
      const word = m[0].replace(/\.+$/, '');
      const key = norm(word.toLowerCase());
      if (key.length < 3) continue;
      // Part of a path, address or compound ("akshatgg/loupe", "Markai-Updater"):
      // its capitalisation says nothing about how the name is written.
      const before = text[m.index - 1] || ' ';
      const after = text[m.index + m[0].length] || ' ';
      if (/[/\-_@.]/.test(before) || /[/_@]/.test(after)) continue;

      if (/^[a-z]/.test(word)) { bump(lower, key); continue; }
      bump(cap, key);
      if (/[a-z,] $/.test(text.slice(Math.max(0, m.index - 2), m.index))) mid.add(key);
    }
  }

  const out = new Set();
  for (const [key, n] of cap) {
    if (n < 2 || !mid.has(key) || STOP.has(key) || COMMON_WORDS.has(key)) continue;
    if ((lower.get(key) || 0) <= n * 0.34) out.add(key);
  }
  return out;
}

/** Everything a search needs, built once per set of documents. */
function buildIndex(docs) {
  const chunks = [];
  for (const d of docs) {
    const parts = chunkDoc(d);
    parts.forEach((c, i) => { c.first = i === 0; });
    chunks.push(...parts);
  }

  const df = new Map();
  for (const c of chunks) {
    c.tf = new Map();
    for (const t of tokens(c.text)) c.tf.set(t, (c.tf.get(t) || 0) + 1);
    c.head = new Set(tokens(c.heading));
    c.key = phraseKey(c.text);
    for (const t of c.tf.keys()) df.set(t, (df.get(t) || 0) + 1);
  }
  return { chunks, df, entities: findEntities(docs) };
}

/** The technologies a piece of text names, as the lexicon spells them. */
function techIn(text) {
  const found = new Set();
  for (const t of tokens(text)) if (TECH_WORDS.has(t)) found.add(TECH_WORDS.get(t));
  const key = phraseKey(text);
  for (const p of TECH_PHRASES) if (key.includes(p.key)) found.add(p.term);
  return [...found];
}

/** Whether the documents mention a technology anywhere. */
function mentions(index, term) {
  const words = tokens(term);
  if (words.length === 1) return index.df.has(words[0]);
  const key = phraseKey(term);
  return index.chunks.some((c) => c.key.includes(key));
}

/**
 * Whether a word is one of the documents' own subjects: present in them, not
 * in most of them, and not a technology or CV word anyone might say.
 * "Updater" and "clock" in a signage write-up are; "PostgreSQL" is not.
 */
function isSpecific(index, t) {
  if (STOP.has(t) || COMMON_WORDS.has(t) || t.length < 3) return false;
  const df = index.df.get(t) || 0;
  return df > 0 && df <= Math.max(3, index.chunks.length * 0.25);
}

/** The words of a question that are neither phrasing nor common technology. */
function subjectTerms(text) {
  return queryTerms(text).filter((t) => !COMMON_WORDS.has(t) && t.length > 2);
}

/** The words of a question worth searching for. */
function queryTerms(text) {
  return [...new Set(tokens(text).filter((t) => !STOP.has(t) && t.length > 1))];
}

/**
 * The sections that best match the given words, best first.
 *
 * `weights` maps a word to how much it counts; names and technologies are
 * passed in heavier than ordinary words. Each of those heavy words is given
 * its own best section before the rest are filled in by score. Without that,
 * "how do you use Tailscale at Mark AI" returns six sections about Mark AI and
 * none about Tailscale, because the project's name is in every heading.
 */
function search(index, weights, { budget = BUDGET, max = MAX_CHUNKS } = {}) {
  const n = index.chunks.length;
  if (!n || !weights.size) return [];
  const idf = (t) => Math.log(1 + n / index.df.get(t));

  const scored = [];
  for (const c of index.chunks) {
    let score = 0;
    for (const [t, w] of weights) {
      const tf = c.tf.get(t);
      if (!tf) continue;
      // Rarity is squared and repetition saturates: one mention of "Headscale"
      // has to outweigh any number of mentions of the employer's name, which
      // is in every section of a write-up about that employer.
      const rare = idf(t) ** 2;
      score += w * rare * (tf / (tf + 1));
      if (c.head.has(t)) score += w * rare * 0.5;
    }
    if (score > 0) scored.push({ c, score });
  }
  scored.sort((a, b) => b.score - a.score);
  if (!scored.length) return [];

  const strong = [...weights].filter(([t, w]) => w >= 2 && index.df.has(t))
    .map(([t]) => t).sort((a, b) => idf(b) - idf(a));
  const picked = [];
  for (const t of strong) {
    // The section that is most about this word, not merely the best overall
    // section that happens to contain it.
    const own = (c) => c.tf.get(t) + (c.head.has(t) ? 3 : 0);
    let best = null;
    for (const s of scored) {
      if (s.c.tf.has(t) && (!best || own(s.c) > own(best))) best = s.c;
    }
    if (best && !picked.includes(best)) picked.push(best);
  }

  const floor = scored[0].score * KEEP_RATIO;
  for (const s of scored) {
    if (s.score >= floor && !picked.includes(s.c)) picked.push(s.c);
  }
  return take(picked, budget, max);
}

/** The opening section of every document: who the person is, in brief. */
function overview(index, opts = {}) {
  return take(index.chunks.filter((c) => c.first), opts.budget || BUDGET, opts.max || MAX_CHUNKS);
}

function take(chunks, budget, max) {
  const out = [];
  let used = 0;
  for (const c of chunks) {
    if (out.length >= max) break;
    if (out.length && used + c.text.length > budget) continue;
    out.push(c);
    used += c.text.length;
  }
  return out;
}

/** Sections as the model sees them, each labelled with where it came from. */
function render(chunks) {
  return chunks.map((c) => {
    const where = c.heading && !c.text.startsWith(c.heading) ? `${c.doc} · ${c.heading}` : c.doc;
    return `--- ${where} ---\n${c.text}`;
  }).join('\n\n');
}

module.exports = {
  buildIndex, chunkDoc, findEntities, search, overview, render,
  techIn, mentions, queryTerms, subjectTerms, isSpecific, tokens, STOP,
};
