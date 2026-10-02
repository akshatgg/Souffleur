'use strict';
const {
  search, overview, techIn, mentions, queryTerms, subjectTerms, isSpecific, tokens,
} = require('./retrieve');

/**
 * Decide what a question needs before any model sees it.
 *
 * Two kinds of question come up in an interview, and they want different
 * things. "What is PostgreSQL?" tests knowledge: the documents are not read at
 * all, so the answer cannot drift into the person's own projects. "How did you
 * use PostgreSQL at Mark AI?" is about them: the matching sections of their
 * documents are found and sent, and nothing else.
 *
 * This is rules, not a model call. A second call per question would add half a
 * second to an answer someone is waiting on mid-sentence, and would spend the
 * free key's daily limit twice as fast. A wrong guess here is cheap either
 * way: the answer is still given, with a few sections it did not need or
 * without a few it could have used.
 */

// Said to the person, about the person.
const ABOUT_YOU = [
  /\b(your|yours|yourself|you'?ve|you'?re)\b/,
  /\b(did|have|had|were|are|was) you\b/,
  /\byou (built|build|made|make|used|use|using|worked|work|did|chose|choose|picked|faced|fixed|handled|designed|implemented|wrote|shipped|deployed|learned|led|owned|own|solved|decided|have|had|were|are)\b/,
  /\b(tell me about|walk me through|talk about|describe) (a|an|the|one|some|any) (time|project|situation|challenge|bug|problem|decision)\b/,
  /\b(resume|cv|about you|introduce|hire you|notice period|strengths?|weakness(es)?)\b/,
];

// Asks for the whole picture rather than one part of it.
const WHOLE_PICTURE = /\b(about yourself|introduce yourself|who are you|your (background|experience|journey|profile|resume|cv|career|work history)|walk me through your)\b/;

// Leans on what was said before: "why did you pick that?"
const POINTS_BACK = /\b(this|that|it|there|those|these|same)\b/;

/** The latest thing the user sent, and the one before it. */
function lastQuestions(messages) {
  const mine = (messages || []).filter((m) => m && m.role === 'user' && typeof m.content === 'string');
  return {
    question: mine.length ? mine[mine.length - 1].content : '',
    previous: mine.length > 1 ? mine[mine.length - 2].content : '',
  };
}

function weightsFor(index, text, scale, into) {
  const tech = new Set(techIn(text).flatMap((t) => tokens(t)));
  for (const t of queryTerms(text)) {
    const w = (index.entities.has(t) || tech.has(t) || isSpecific(index, t) ? 2 : 1) * scale;
    if (w > (into.get(t) || 0)) into.set(t, w);
  }
  return into;
}

/**
 * Returns
 *   { kind: 'knowledge' }
 *   { kind: 'personal', chunks, tech, missing, overview }
 *
 * `tech` is every technology the question names; `missing` is the ones the
 * documents never mention, so the answer can explain them without claiming
 * the person used them.
 */
function route(index, messages, { image = false } = {}) {
  const { question, previous } = lastQuestions(messages);
  const q = question.toLowerCase();
  if (!q.trim() || !index.chunks.length) return { kind: 'knowledge' };

  const terms = queryTerms(question);
  const tech = techIn(question);
  const weights = weightsFor(index, question, 1, new Map());
  let chunks = search(index, weights);

  // "How does the Updater work?" has no "you" in it at all. What gives it away
  // is that everything it asks after is in the documents: "what is technical
  // debt" is not, because nothing in them is about debt. Sending a few
  // sections to a question that did not need them costs little; answering a
  // question about their own product with none would be an invented answer.
  const subject = subjectTerms(question);
  const namesTheirWork = terms.some((t) => index.entities.has(t)) ||
    (subject.length > 0 && subject.every((t) => index.df.has(t)));
  const aboutYou = ABOUT_YOU.some((re) => re.test(q));
  // "How do you handle proof of play?" says "you" without saying "your". It is
  // about their work only if the documents talk about the same thing, and not
  // when it names a technology: "how do you reverse a linked list" is not.
  const maybeYou = !tech.length && /\byou\b/.test(q) && sameSubject(chunks[0], terms);
  // With a screenshot attached the question is about what is on the screen,
  // usually a problem to solve. Only an outright "your" turns it personal.
  if (!aboutYou && (image || (!namesTheirWork && !maybeYou))) return { kind: 'knowledge' };

  const missing = tech.filter((t) => !mentions(index, t));
  // A follow-up carries its subject in the question before it.
  if (previous && (!chunks.length || POINTS_BACK.test(q))) {
    chunks = search(index, weightsFor(index, previous, 0.5, weights));
  }

  const whole = WHOLE_PICTURE.test(q);
  if (whole || !chunks.length) {
    const seen = new Set(chunks);
    const opening = overview(index).filter((c) => !seen.has(c));
    chunks = whole ? [...opening, ...chunks] : opening;
    chunks = fit(chunks);
  }

  return { kind: 'personal', chunks, tech, missing, overview: whole };
}

/** Two of the question's words in one section, or one in its heading. */
function sameSubject(chunk, terms) {
  if (!chunk) return false;
  if (terms.some((t) => chunk.head.has(t))) return true;
  return terms.filter((t) => chunk.tf.has(t)).length >= 2;
}

function fit(chunks, budget = 7000, max = 6) {
  const out = [];
  let used = 0;
  for (const c of chunks) {
    if (out.length >= max || (out.length && used + c.text.length > budget)) break;
    out.push(c);
    used += c.text.length;
  }
  return out;
}

module.exports = { route, lastQuestions };
