/* The rules the free key enforces, kept apart from the request plumbing in
 * free.js so they can be tested without a network, a key or a counter store.
 *
 * The underscore keeps Vercel from serving this file as a route of its own.
 */

import { createHash } from 'node:crypto';

/* What each kind of request may carry, and what it costs against the limit.
   Screenshots are PNGs downscaled to 1600px by the app; clips are short WAVs
   cut at pauses. The byte caps sit well above both. */
export const KINDS = {
  chat: {
    method: 'streamGenerateContent?alt=sse',
    mime: 'image/png',
    maxBytes: 12 * 1024 * 1024,
    maxOutputTokens: 4096,
  },
  transcribe: {
    method: 'generateContent',
    mime: 'audio/wav',
    maxBytes: 8 * 1024 * 1024,
    maxOutputTokens: 2048,
    temperature: 0,
  },
};

/** Everything tunable, read from the Vercel environment with safe defaults. */
export function settingsFrom(env) {
  const num = (v, d) => (Number.isFinite(Number(v)) && Number(v) > 0 ? Number(v) : d);
  const model = env.FREE_MODEL || 'gemini-3.1-flash-lite';
  return {
    model: { chat: model, transcribe: env.FREE_TRANSCRIBE_MODEL || model },
    perInstall: {
      chat: num(env.FREE_DAILY_ANSWERS, 100),
      transcribe: num(env.FREE_DAILY_CLIPS, 600),
    },
    ipFactor: num(env.FREE_IP_FACTOR, 3),
  };
}

/** The day a count belongs to. Days are UTC, so every limit resets at 00:00 UTC. */
export function dayOf(now) {
  return now.toISOString().slice(0, 10);
}

/** Whole hours until the next reset, rounded up, never less than one. */
export function hoursUntilReset(now) {
  const next = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 1);
  return Math.max(1, Math.ceil((next - now.getTime()) / 3_600_000));
}

/** Counters are stored under hashes, so no install id or IP address is kept. */
export function hashed(value, salt = '') {
  return createHash('sha256').update(salt + value).digest('hex').slice(0, 24);
}

export function counterKeys({ day, kind, installId, ip, salt }) {
  return {
    install: `free:${day}:${kind}:i:${hashed(installId, salt)}`,
    ip: `free:${day}:${kind}:n:${hashed(ip, salt)}`,
  };
}

/* A connection gets several installs' worth, because a college hostel or an
   office puts many people behind one address. */
export function overLimit({ kind, installCount, ipCount, settings }) {
  const perInstall = settings.perInstall[kind];
  return installCount > perInstall || ipCount > perInstall * settings.ipFactor;
}

export function limitMessage(kind, settings, now) {
  const h = hoursUntilReset(now);
  const when = h === 1 ? 'in about an hour' : `in ${h} hours`;
  const what = kind === 'chat'
    ? `today's ${settings.perInstall.chat} free answers`
    : "today's free listening";
  return `You've used ${what}. More ${when}, or add your own key in Settings to keep going.`;
}

const INSTALL_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function validInstallId(v) {
  return typeof v === 'string' && INSTALL_ID.test(v);
}

/** The caller's address as Vercel reports it. */
export function clientIp(headers) {
  const real = headers['x-real-ip'];
  if (real) return String(real).trim();
  const fwd = String(headers['x-forwarded-for'] || '').split(',')[0].trim();
  return fwd || 'unknown';
}

/**
 * Rebuild the Gemini request from only the fields the app sends.
 *
 * Copying the body through would let a caller switch on tools, lift the output
 * cap or attach any file type on the owner's key. Anything this does not
 * recognise makes the whole request invalid rather than being quietly dropped,
 * so a mismatch with the app shows up as an error instead of a strange answer.
 *
 * Returns the body to send to Google, or null when the request is not valid.
 */
export function cleanBody(kind, body) {
  const spec = KINDS[kind];
  const contents = body?.contents;
  if (!spec || !Array.isArray(contents) || !contents.length || contents.length > 200) return null;

  const out = { contents: [] };
  for (const turn of contents) {
    if (!turn || (turn.role !== 'user' && turn.role !== 'model')) return null;
    if (!Array.isArray(turn.parts) || !turn.parts.length || turn.parts.length > 4) return null;

    const parts = [];
    for (const p of turn.parts) {
      if (typeof p?.text === 'string') {
        parts.push({ text: p.text });
      } else if (p?.inline_data?.mime_type === spec.mime && typeof p.inline_data.data === 'string') {
        parts.push({ inline_data: { mime_type: spec.mime, data: p.inline_data.data } });
      } else {
        return null;
      }
    }
    out.contents.push({ role: turn.role, parts });
  }

  const system = body.systemInstruction?.parts?.[0]?.text;
  if (typeof system === 'string' && system) out.systemInstruction = { parts: [{ text: system }] };

  out.generationConfig = { maxOutputTokens: spec.maxOutputTokens };
  if (spec.temperature !== undefined) out.generationConfig.temperature = spec.temperature;

  if (JSON.stringify(out).length > spec.maxBytes) return null;
  return out;
}
