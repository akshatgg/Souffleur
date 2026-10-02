'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { buildIndex, techIn, render } = require('../src/main/retrieve.js');
const { route } = require('../src/main/router.js');
const { knowledgePrompt, personalPrompt } = require('../src/main/prompts.js');

/**
 * Interview mode: which questions read the person's documents, which sections
 * they get, and what the model is told to do with them.
 * No model and no PDFs; the documents are plain text, as extraction leaves them.
 */

const CV = {
  name: 'Riya_CV.pdf',
  text: [
    'Riya Sharma',
    'Backend engineer with four years building logistics software.',
    'Experience',
    'Northwind Freight, Software Engineer, 2023 to present.',
    'Built Lumen, the dispatch service that assigns drivers to loads.',
    'Earlier at Harbor Labs, where I worked on the Tidepool billing system.',
    'Skills',
    'Python, FastAPI, PostgreSQL, Redis, Docker and Kubernetes.',
  ].join('\n'),
};

const LUMEN = {
  name: 'Lumen - What I Built.pdf',
  text: [
    'Lumen dispatch service',
    'Lumen assigns drivers to loads for Northwind Freight. I am the only engineer on it.',
    'It handles about 40,000 assignments a day across three regions of the country.',
    'The first version held every driver in memory and fell over at the morning peak.',
    'I rewrote it so that nothing about a driver lives in the service between requests.',
    'Storage',
    'Every assignment is stored in PostgreSQL, in one table partitioned by region.',
    'I chose PostgreSQL because an assignment and its payment must commit together.',
    'A partial index on open assignments keeps the dispatch query under ten milliseconds.',
    'Before the partitioning the same query took close to a second at the morning peak.',
    'Backups are taken nightly and restored into a scratch database once a week as a test.',
    'Driver network',
    'Each driver tablet joins a private network through Headscale with a stamped join key.',
    'The tablet checks in every five minutes and reports its battery and its location.',
    'A tablet that misses three check-ins is shown as offline to the dispatcher on duty.',
    'Join keys are rotated when a tablet is retired, so a lost device cannot rejoin later.',
    'The Dockhand app runs on each tablet and shows the driver the next load to collect.',
  ].join('\n'),
};

const TIDEPOOL = {
  name: 'Tidepool - What I Built.pdf',
  text: [
    'Tidepool billing system',
    'Tidepool produced invoices for Harbor Labs customers at the end of every month.',
    'I moved invoice rendering onto a queue so a slow customer no longer blocked the rest.',
    'Invoices are rendered to PDF by a worker pool and emailed once the render completes.',
    'A failed render is retried three times and then raised to the finance team by email.',
    'Month end used to take nine hours and now finishes in under forty minutes of work.',
  ].join('\n'),
};

const index = buildIndex([CV, LUMEN, TIDEPOOL]);
const ask = (q, opts) => route(index, [{ role: 'user', content: q }], opts);
const sent = (r) => render(r.chunks);

test('a knowledge question reads no documents', () => {
  for (const q of [
    'What is PostgreSQL?',
    'What is the difference between SQL and NoSQL?',
    'Can you explain what a closure is?',
    'How would you design a rate limiter?',
    'Do you know what Docker is?',
    'what is memoization',
  ]) {
    assert.equal(ask(q).kind, 'knowledge', q);
  }
});

test('a knowledge question is answered without the person\'s history in the prompt', () => {
  const prompt = knowledgePrompt('Riya Sharma');
  assert.match(prompt, /Riya Sharma/);
  assert.doesNotMatch(prompt, /<background>/);
  assert.doesNotMatch(prompt, /Lumen|Northwind|Tidepool/);
  assert.match(prompt, /Do not bring up your own projects/);
});

test('a question about their work gets the sections that match it, and not the rest', () => {
  const r = ask('How did you store assignments in your Lumen project?');
  assert.equal(r.kind, 'personal');
  assert.match(sent(r), /partitioned by region/);
  assert.doesNotMatch(sent(r), /invoice/i);
});

test('a technology they used is found in the project that used it', () => {
  const r = ask('You are using Headscale in your project, how do you use it?');
  assert.equal(r.kind, 'personal');
  assert.deepEqual(r.tech, ['headscale']);
  assert.deepEqual(r.missing, []);
  assert.match(r.chunks[0].text, /Headscale with a stamped join key/);
});

test('a technology the documents never mention is reported as missing', () => {
  const r = ask('How do you use Kafka in your Lumen project?');
  assert.equal(r.kind, 'personal');
  assert.deepEqual(r.missing, ['kafka']);

  const prompt = personalPrompt('Riya Sharma', r);
  assert.match(prompt, /never mentions kafka/);
  assert.match(prompt, /Do not say you used it/);
  assert.match(prompt, /Still answer/);
});

test('two spellings of one technology are the same technology', () => {
  const r = ask('Why did you pick Postgres for your project?');
  assert.deepEqual(r.tech, ['postgresql']);
  assert.deepEqual(r.missing, []);
  assert.match(sent(r), /must commit together/);
});

test('a question that names their product needs no "you" to be about them', () => {
  for (const q of ['What is Lumen?', 'How does the Dockhand app work?', 'Explain Tidepool']) {
    assert.equal(ask(q).kind, 'personal', q);
  }
  assert.match(sent(ask('How does the Dockhand app work?')), /shows the driver the next load/);
});

test('a follow-up is searched with the question before it', () => {
  const r = route(index, [
    { role: 'user', content: 'Tell me about the driver network in Lumen' },
    { role: 'assistant', content: '...' },
    { role: 'user', content: 'Why did you do it that way?' },
  ]);
  assert.equal(r.kind, 'personal');
  assert.match(sent(r), /Headscale/);
});

test('"tell me about yourself" gets the opening of every document', () => {
  const r = ask('Tell me about yourself');
  assert.equal(r.kind, 'personal');
  assert.equal(r.overview, true);
  assert.match(sent(r), /Riya Sharma/);
  assert.match(sent(r), /Lumen assigns drivers/);
  assert.match(sent(r), /Tidepool produced invoices/);
});

test('a question about them that matches nothing still gets who they are', () => {
  const r = ask('What are your strengths?');
  assert.equal(r.kind, 'personal');
  assert.match(sent(r), /Riya Sharma/);
});

test('a screenshot question is about the screen unless it says "your"', () => {
  assert.equal(ask('What is on my screen?', { image: true }).kind, 'knowledge');
  assert.equal(ask('How does the Dockhand app work?', { image: true }).kind, 'knowledge');
  assert.equal(ask('Is this like your Lumen project?', { image: true }).kind, 'personal');
});

test('with no documents every question is a knowledge question', () => {
  const empty = buildIndex([]);
  assert.equal(route(empty, [{ role: 'user', content: 'Tell me about your project' }]).kind, 'knowledge');
});

test('what is sent stays inside the budget however much has been uploaded', () => {
  const big = { name: 'Big.pdf', text: Array.from({ length: 400 },
    (_, i) => `Lumen release ${i} changed how the dispatch service assigns a driver to a load.`).join('\n') };
  const r = route(buildIndex([CV, LUMEN, big]), [{ role: 'user', content: 'Tell me about your Lumen dispatch work' }]);
  assert.ok(r.chunks.length <= 6);
  assert.ok(r.chunks.reduce((n, c) => n + c.text.length, 0) <= 7000 + 1800);
});

test('plain English that is also a technology is not read as one', () => {
  assert.deepEqual(techIn('How did you go about the rest of the process?'), []);
  assert.deepEqual(techIn('We put a load balancer in front of Node.js and k8s').sort(),
    ['kubernetes', 'load balancer', 'node.js']);
});

test('the personal prompt carries the sections, the two-part answer and the speaking rules', () => {
  const r = ask('How did you store assignments in your Lumen project?');
  const prompt = personalPrompt('Riya Sharma', r);
  assert.match(prompt, /<background>[\s\S]*partitioned by region[\s\S]*<\/background>/);
  assert.match(prompt, /WHAT YOU DID/);
  assert.match(prompt, /THE TECHNOLOGY BEHIND IT/);
  assert.match(prompt, /Never invent a job/);
  assert.match(prompt, /You are talking, not writing/);
  assert.match(prompt, /Never use: leverage/);
  assert.match(prompt, /Markdown headings \(#\), tables and numbered lists/);
});
