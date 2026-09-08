/* POST /api/welcome — greet a new signup, and tell the owner about them.
 *
 * Two things have to be true before this sends anything.
 *
 * First, the caller must prove who they are. The browser posts the Firebase ID
 * token it just received, and that token is a JWT signed by Google, so it is
 * verified here against Google's published keys. Without that check this route
 * would be an open mail relay: anyone could POST a stranger's address and have
 * our domain send them mail.
 *
 * Second, the person must be new. The browser only calls this on the sign-in
 * that created the row, but two tabs can race, so the row is re-read here and
 * stamped after sending. A repeat call is answered 200 with sent:false, which
 * is a success — the mail already went out.
 *
 * Environment, all set in the Vercel project (see web/SETUP.md):
 *   FIREBASE_PROJECT_ID   the project whose tokens we accept
 *   SMTP_HOST SMTP_PORT SMTP_USER SMTP_PASS    outgoing mail
 *   MAIL_FROM             optional, defaults to SMTP_USER
 *   ADMIN_EMAIL           where the "someone new" notice goes
 */

import nodemailer from 'nodemailer';
import { createRemoteJWKSet, jwtVerify } from 'jose';

const SITE = 'https://getsouffleur.vercel.app';

/* Google's signing keys for Firebase ID tokens. Built once per warm instance —
   jose caches the fetch and honours the cache headers on it. */
const JWKS = createRemoteJWKSet(
  new URL('https://www.googleapis.com/service_accounts/v1/jwk/securetoken@system.gserviceaccount.com'),
);

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return res.status(405).json({ error: 'POST only' });
  }

  const projectId = process.env.FIREBASE_PROJECT_ID;
  if (!projectId) return res.status(500).json({ error: 'FIREBASE_PROJECT_ID is not set' });

  const body = typeof req.body === 'string' ? safeParse(req.body) : (req.body || {});
  const idToken = body.idToken;
  if (!idToken) return res.status(400).json({ error: 'idToken missing' });

  let claims;
  try {
    ({ payload: claims } = await jwtVerify(idToken, JWKS, {
      issuer: `https://securetoken.google.com/${projectId}`,
      audience: projectId,
    }));
  } catch (err) {
    return res.status(401).json({ error: 'token rejected', detail: String(err?.message || err) });
  }

  const uid = claims.sub;
  const email = claims.email;
  if (!uid || !email) return res.status(400).json({ error: 'the token carries no uid or email' });

  const name = claims.name || email.split('@')[0];
  const os = normaliseOs(body.os);

  // Already greeted? Say so and send nothing.
  const already = await welcomeAlreadySent({ projectId, uid, idToken });
  if (already) return res.status(200).json({ ok: true, sent: false, reason: 'already welcomed' });

  let transport;
  try {
    transport = buildTransport();
  } catch (err) {
    return res.status(500).json({ error: String(err.message) });
  }

  const from = process.env.MAIL_FROM || process.env.SMTP_USER;
  const admin = process.env.ADMIN_EMAIL;

  // The visitor's mail is the one that matters; the owner's notice must not be
  // able to take it down with it, so they are settled independently.
  const [welcome, notice] = await Promise.allSettled([
    transport.sendMail({ from, to: email, ...welcomeMail(name) }),
    admin
      ? transport.sendMail({ from, to: admin, ...noticeMail({ name, email, os }) })
      : Promise.resolve(null),
  ]);

  if (welcome.status === 'rejected') {
    console.error('[welcome] send failed', welcome.reason);
    return res.status(502).json({ error: 'could not send the welcome mail', detail: String(welcome.reason?.message || welcome.reason) });
  }
  if (notice.status === 'rejected') console.error('[welcome] owner notice failed', notice.reason);

  await markWelcomeSent({ projectId, uid, idToken });

  return res.status(200).json({ ok: true, sent: true, notified: notice.status === 'fulfilled' });
}

/* ------------------------------- the mail -------------------------------- */

function welcomeMail(name) {
  const text = [
    `${name},`,
    '',
    'Thanks for signing in at getsouffleur.vercel.app.',
    '',
    'Souffleur is the prompter in the box below the stage: a small always-on-top',
    'window that reads your screen, hears the call, and answers — while staying',
    'out of the screen share everyone else is watching.',
    '',
    `  macOS     brew install --cask akshatgg/tap/souffleur`,
    `  Windows   ${SITE}/#download`,
    `  Docs      ${SITE}/docs`,
    '',
    'It is free and open source, it runs on your own API key, and nothing you do',
    'in it is sent anywhere except to the provider whose key you entered.',
    '',
    'Akshat',
  ].join('\n');

  const html = `
    <div style="font:16px/1.6 -apple-system,Segoe UI,system-ui,sans-serif;color:#1a1d24;max-width:34em">
      <p>${esc(name)},</p>
      <p>Thanks for signing in at <a href="${SITE}">getsouffleur.vercel.app</a>.</p>
      <p>Souffleur is the prompter in the box below the stage: a small always-on-top
         window that reads your screen, hears the call, and answers &mdash; while
         staying out of the screen share everyone else is watching.</p>
      <p>
        <strong>macOS</strong><br>
        <code style="background:#f2f3f5;padding:2px 6px;border-radius:4px">brew install --cask akshatgg/tap/souffleur</code><br><br>
        <strong>Windows</strong> &middot; <a href="${SITE}/#download">download the installer</a><br>
        <strong>Docs</strong> &middot; <a href="${SITE}/docs">${SITE}/docs</a>
      </p>
      <p>It is free and open source, it runs on your own API key, and nothing you do
         in it is sent anywhere except to the provider whose key you entered.</p>
      <p>Akshat</p>
    </div>`;

  return { subject: 'Welcome to Souffleur', text, html };
}

function noticeMail({ name, email, os }) {
  const when = new Date().toISOString().replace('T', ' ').slice(0, 16) + ' UTC';
  const text = [
    'Someone new signed in to Souffleur.',
    '',
    `  Name      ${name}`,
    `  Email     ${email}`,
    `  Signed in from  ${os}`,
    `  When      ${when}`,
    '',
    `The full report is on the download section at ${SITE}/#download once you sign in.`,
  ].join('\n');

  return {
    subject: `New Souffleur sign-in — ${name}`,
    text,
    html: `
      <div style="font:15px/1.6 -apple-system,Segoe UI,system-ui,sans-serif;color:#1a1d24">
        <p>Someone new signed in to Souffleur.</p>
        <table cellpadding="4" style="border-collapse:collapse">
          <tr><td style="color:#6b7280">Name</td><td><strong>${esc(name)}</strong></td></tr>
          <tr><td style="color:#6b7280">Email</td><td>${esc(email)}</td></tr>
          <tr><td style="color:#6b7280">Signed in from</td><td>${esc(os)}</td></tr>
          <tr><td style="color:#6b7280">When</td><td>${when}</td></tr>
        </table>
        <p><a href="${SITE}/#download">Open the report</a></p>
      </div>`,
  };
}

/* ------------------------------ the plumbing ------------------------------ */

function buildTransport() {
  const { SMTP_HOST, SMTP_USER, SMTP_PASS } = process.env;
  const missing = ['SMTP_HOST', 'SMTP_USER', 'SMTP_PASS'].filter((k) => !process.env[k]);
  if (missing.length) throw new Error(`mail is not configured: ${missing.join(', ')} unset`);

  const port = Number(process.env.SMTP_PORT || 465);
  return nodemailer.createTransport({
    host: SMTP_HOST,
    port,
    secure: port === 465,          // 465 is implicit TLS; 587 upgrades with STARTTLS
    auth: { user: SMTP_USER, pass: SMTP_PASS },
  });
}

const docUrl = (projectId, uid) =>
  `https://firestore.googleapis.com/v1/projects/${projectId}/databases/(default)/documents/users/${uid}`;

/**
 * Has this person already been greeted?
 *
 * Read with the caller's own token rather than a service account, so the
 * security rules apply here exactly as they do in the browser and there is no
 * private key to store. A failure here is answered "no": a duplicate mail is a
 * smaller problem than a new user who never hears from us.
 */
async function welcomeAlreadySent({ projectId, uid, idToken }) {
  try {
    const res = await fetch(docUrl(projectId, uid), { headers: { authorization: `Bearer ${idToken}` } });
    if (!res.ok) return false;
    const json = await res.json();
    return Boolean(json?.fields?.welcomeSentAt?.timestampValue);
  } catch {
    return false;
  }
}

async function markWelcomeSent({ projectId, uid, idToken }) {
  try {
    await fetch(`${docUrl(projectId, uid)}?updateMask.fieldPaths=welcomeSentAt`, {
      method: 'PATCH',
      headers: { authorization: `Bearer ${idToken}`, 'content-type': 'application/json' },
      body: JSON.stringify({ fields: { welcomeSentAt: { timestampValue: new Date().toISOString() } } }),
    });
  } catch (err) {
    // The mail is already gone; losing the stamp only risks one duplicate.
    console.error('[welcome] could not stamp welcomeSentAt', err);
  }
}

function normaliseOs(value) {
  return value === 'mac' || value === 'windows' ? value : 'other';
}

function safeParse(s) {
  try { return JSON.parse(s); } catch { return {}; }
}

function esc(s) {
  return String(s).replace(/[&<>"']/g, (c) => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
  ));
}
