/* POST /api/free?kind=chat|transcribe — answer on the owner's Gemini key.
 *
 * This is what lets the app work with no setup. Someone who has not added a key
 * of their own gets answers on ours, for as long as the switch in
 * free-key.json is on. The switch is flipped from GitHub (Actions -> Free key),
 * which commits that file and so redeploys this function with it.
 *
 * The app sends the same Gemini request it builds for a user's own key, minus
 * the key and the model. Both are added here, after three checks:
 *
 *   1. the switch is on,
 *   2. this install, and this connection, are under today's limit,
 *   3. the request has the shape and size the app produces,
 *
 * and Google's reply is piped straight back, so the app reads it with the
 * parser it already has.
 *
 * Nothing the user sends is logged or stored. The only thing kept is a count
 * per install and per connection, under hashed names, for two days.
 *
 * Environment, set in the Vercel project (see web/SETUP.md):
 *   GEMINI_API_KEY                        the owner's key; it never leaves here
 *   KV_REST_API_URL, KV_REST_API_TOKEN    the counter store (Upstash for Redis)
 *   FREE_MODEL             optional, default gemini-3.1-flash-lite
 *   FREE_TRANSCRIBE_MODEL  optional, defaults to FREE_MODEL
 *   FREE_DAILY_ANSWERS     optional, answers per install per day, default 100
 *   FREE_DAILY_CLIPS       optional, listening clips per install per day, default 600
 *   FREE_IP_FACTOR         optional, one connection gets this many installs' worth, default 3
 *   FREE_SALT              optional, mixed into the hashed counter names
 */

import { readFileSync } from 'node:fs';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { Redis } from '@upstash/redis';
import {
  KINDS, settingsFrom, dayOf, counterKeys, overLimit, limitMessage,
  validInstallId, clientIp, cleanBody,
} from './_free-rules.js';

const GEMINI = 'https://generativelanguage.googleapis.com/v1beta/models';
const TWO_DAYS = 2 * 24 * 60 * 60;

const PAUSED = 'The free key is paused. Add your own key in Settings to keep going.';

/* Trying this on your own machine: `./dev_start.sh --free-key` runs `vercel dev`
   with FREE_KEY_TEST=1, which turns the switch on without editing
   free-key.json, and counts in memory when no counter store is set up. It is
   ignored on the production deployment even if it were ever set there. */
const LOCAL_TEST = process.env.FREE_KEY_TEST === '1' && process.env.VERCEL_ENV !== 'production';

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return fail(res, 405, 'POST only', 'bad_request');
  }

  const kind = req.query?.kind;
  if (!KINDS[kind]) return fail(res, 400, 'kind must be chat or transcribe', 'bad_request');

  if (!switchIsOn()) return fail(res, 403, PAUSED, 'free_off');

  const key = process.env.GEMINI_API_KEY;
  const redis = counterStore();
  if (!key || !redis) {
    console.error('[free] not configured:', !key ? 'GEMINI_API_KEY unset' : 'counter store unset');
    return fail(res, 503, PAUSED, 'free_off');
  }

  const installId = req.headers['x-souffleur-install'];
  if (!validInstallId(installId)) return fail(res, 400, 'Update Souffleur to use the free key.', 'bad_request');

  const body = cleanBody(kind, typeof req.body === 'string' ? safeParse(req.body) : req.body);
  if (!body) return fail(res, 400, 'The request was too large or not in the shape the app sends.', 'bad_request');

  const settings = settingsFrom(process.env);
  const now = new Date();

  // Counted before Google is called, so parallel requests cannot all slip in
  // under the limit together.
  const keys = counterKeys({
    day: dayOf(now), kind, installId, ip: clientIp(req.headers), salt: process.env.FREE_SALT || '',
  });
  try {
    const [installCount, , ipCount] = await redis.pipeline()
      .incr(keys.install).expire(keys.install, TWO_DAYS)
      .incr(keys.ip).expire(keys.ip, TWO_DAYS)
      .exec();
    if (overLimit({ kind, installCount, ipCount, settings })) {
      return fail(res, 429, limitMessage(kind, settings, now), 'free_limit');
    }
  } catch (err) {
    // A counter outage should not take the app down with it. The daily quota
    // on the key in Google Cloud still caps what this can spend.
    console.error('[free] counter store failed, allowing the request', err?.message || err);
  }

  // Stop paying for an answer nobody is waiting for.
  const upstream = new AbortController();
  res.on('close', () => { if (!res.writableFinished) upstream.abort(); });

  let google;
  try {
    google = await fetch(`${GEMINI}/${encodeURIComponent(settings.model[kind])}:${KINDS[kind].method}`, {
      method: 'POST',
      signal: upstream.signal,
      headers: { 'content-type': 'application/json', 'x-goog-api-key': key },
      body: JSON.stringify(body),
    });
  } catch (err) {
    if (err?.name === 'AbortError') return;
    return fail(res, 502, 'Could not reach Gemini. Try again.', 'upstream');
  }

  if (!google.ok) return relayFailure(res, google);

  res.status(200);
  res.setHeader('Content-Type', google.headers.get('content-type') || 'application/json');
  try {
    await pipeline(Readable.fromWeb(google.body), res);
  } catch (err) {
    // The app hung up mid-answer (Esc, or a new question). Nothing to report.
    if (err?.name !== 'AbortError' && err?.code !== 'ERR_STREAM_PREMATURE_CLOSE') {
      console.error('[free] stream failed', err?.message || err);
    }
  }
}

/* ------------------------------ the plumbing ------------------------------ */

/**
 * Read on every request rather than once, so a function instance that is kept
 * warm across a redeploy can never answer with a stale switch.
 */
function switchIsOn() {
  if (LOCAL_TEST) return true;
  try {
    return JSON.parse(readFileSync(new URL('../free-key.json', import.meta.url), 'utf8')).enabled === true;
  } catch {
    return false;
  }
}

let redisClient;
function counterStore() {
  if (redisClient !== undefined) return redisClient;
  const url = process.env.KV_REST_API_URL || process.env.UPSTASH_REDIS_REST_URL;
  const token = process.env.KV_REST_API_TOKEN || process.env.UPSTASH_REDIS_REST_TOKEN;
  redisClient = url && token ? new Redis({ url, token }) : LOCAL_TEST ? memoryCounters() : null;
  return redisClient;
}

/** Just enough of the Redis pipeline for local testing. Forgets on restart. */
function memoryCounters() {
  const counts = new Map();
  return {
    pipeline() {
      const ops = [];
      const p = {
        incr(k) { ops.push(() => counts.set(k, (counts.get(k) || 0) + 1).get(k)); return p; },
        expire() { ops.push(() => 1); return p; },
        exec: async () => ops.map((op) => op()),
      };
      return p;
    },
  };
}

/**
 * Google refused. Its message goes back to the user, except when the owner's
 * key has hit its own daily quota, which the user can do nothing about except
 * bring a key of their own.
 */
async function relayFailure(res, google) {
  if (google.status === 429) {
    return fail(res, 429,
      'The free key is used up for today. Add your own key in Settings to keep going.',
      'free_exhausted');
  }
  let detail = '';
  try {
    const j = JSON.parse(await google.text());
    detail = j?.error?.message || '';
  } catch { /* not JSON */ }
  console.error('[free] gemini', google.status, detail.slice(0, 200));
  return fail(res, 502, `Gemini refused the request (${google.status}). ${detail}`.trim(), 'upstream');
}

/** Errors in Gemini's own shape, so the app's existing error reader shows them. */
function fail(res, status, message, code) {
  return res.status(status).json({ error: { message, code } });
}

function safeParse(s) {
  try { return JSON.parse(s); } catch { return null; }
}
