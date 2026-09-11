'use strict';

/**
 * The free key: answers on the owner's Gemini key, for anyone who has not
 * added a key of their own.
 *
 * Whether it is available is a switch the owner flips on GitHub (Actions ->
 * Free key), which rewrites free-key.json on the website. The app reads that
 * switch, never a key. The key stays on the server, which adds it to each
 * request (web/api/free.js) -- a key shipped inside the app could be read out
 * of it by anyone who unpacked it.
 *
 * SOUFFLEUR_SITE points all of this at another deployment, e.g. `vercel dev`.
 *
 * SOUFFLEUR_FREE_TEST=1 is for trying the free key on this machine, and is set
 * by `./dev_start.sh --free-key`: the switch reads as on, the site defaults to
 * the local one, and main.js starts the app in a profile of its own.
 */

const TEST = process.env.SOUFFLEUR_FREE_TEST === '1';
const SITE = (process.env.SOUFFLEUR_SITE || (TEST ? 'http://localhost:3000' : 'https://getsouffleur.vercel.app'))
  .replace(/\/+$/, '');
const SWITCH_URL = `${SITE}/free-key.json`;
const FREE_URL = `${SITE}/api/free`;

/**
 * Which key answers: the user's own when they saved one, ours when the switch
 * is on, otherwise none. A saved key always wins, so turning the free key on
 * never moves anyone off a key they chose.
 */
function pickRoute({ hasOwnKey, freeOn }) {
  if (hasOwnKey) return 'own';
  return freeOn ? 'free' : 'none';
}

/**
 * Read the switch. Resolves true or false, or null when it could not be read
 * (offline, site down), so the caller keeps the last answer it had rather than
 * treating a network blip as the owner switching it off.
 */
async function readSwitch({ fetchImpl = fetch, timeoutMs = 4000 } = {}) {
  if (TEST) return true;
  try {
    const res = await fetchImpl(SWITCH_URL, { signal: AbortSignal.timeout(timeoutMs) });
    if (!res.ok) return null;
    const j = await res.json();
    return typeof j?.enabled === 'boolean' ? j.enabled : null;
  } catch {
    return null;
  }
}

/** Errors from the free key's server that mean it cannot answer for now. */
const STOPS = new Set(['free_off', 'free_limit', 'free_exhausted']);
const isFreeStop = (err) => STOPS.has(err?.code);

module.exports = { pickRoute, readSwitch, isFreeStop, FREE_URL, SWITCH_URL, TEST };
