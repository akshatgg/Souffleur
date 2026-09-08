/* Google sign-up, the download gate, install tracking, and the owner's report.
 *
 * Downloads on this page are gated: the Windows installer and the Homebrew
 * command both ask for a Google sign-in first, and unlock the moment it
 * succeeds. What that buys is a name and an address for the people who take
 * the app, and nothing else is stored.
 *
 * Two honest limits on the numbers it produces.
 *
 * The gate covers this page, not the release. The installers also sit on a
 * public GitHub releases page that this site still links to, and that page
 * asks for nothing — so these are people who came through the front door, not
 * everyone who has the app.
 *
 * And the macOS figure counts a command being copied, not an install. The
 * Windows figure is a real download.
 *
 * The Firebase SDK is loaded lazily — about 90KB for something a visitor may
 * never touch — but warmed as soon as one is plainly on the way to needing it,
 * so the sign-in popup still opens inside the click that asked for it.
 */

import { firebaseConfig, ADMIN_EMAIL, isConfigured } from './firebase-config.js';
import { detectOs, summarise } from './report-model.js';

const SDK = 'https://www.gstatic.com/firebasejs/12.4.0';

/* Everything the gate stands in front of. */
const GATED = '#dl-win, #brewCmd';

/* Display-only memory of the last signed-in account, so a reload can paint the
   bar before the SDK has loaded. Never read as authority for anything.

   Declared up here, not beside the functions that use it at the foot of the
   file: init() runs before those lines are reached, so a const declared down
   there is still in its temporal dead zone and reading it throws — which the
   catch in remembered() would quietly report as "nothing cached". */
const PROFILE = 'souffleur:profile';

const all = (sel) => [...document.querySelectorAll(sel)];

const ui = {
  shells:   all('#navAuth, #account'),    // the two containers, hidden until ready
  out:      all('[data-authout]'),
  in:       all('[data-authin]'),
  signIn:   all('[data-signin]'),
  signOut:  all('[data-signout]'),
  report:   all('[data-report]'),
  profile:  document.querySelector('[data-profile]'),
  pop:      document.querySelector('[data-profilepop]'),
  initial:  all('[data-initial]'),
  who:      all('[data-who]'),
  email:    all('[data-email]'),
  note:     document.getElementById('authNote'),
  section:  document.getElementById('report'),
  stats:    document.getElementById('reportStats'),
  table:    document.getElementById('reportTable'),
  status:   document.getElementById('reportStatus'),
  refresh:  document.getElementById('reportRefresh'),
};

const os = detectOs(
  navigator.userAgent,
  navigator.userAgentData?.platform || navigator.platform || '',
);

/* A gate that cannot open would be worse than no gate: with the config still on
   its placeholders, sign-in is impossible, so the downloads stay open and the
   controls hide. On localhost that silence reads as a bug, so it says so. */
if (ui.signIn.length && isConfigured) init();
else if (ui.signIn.length && isLocal()) explainUnconfigured();

function init() {
  for (const el of ui.shells) el.hidden = false;

  let booting = null;
  const firebase = () => (booting ||= boot());

  for (const el of ui.signIn) el.addEventListener('click', () => { note(''); startSignIn(); });
  for (const el of ui.signOut) {
    el.addEventListener('click', async () => {
      openProfile(false);
      const fb = await firebase();
      fb.signOut(fb.auth).catch(() => {});
    });
  }
  for (const el of ui.report) el.addEventListener('click', toggleReport);

  ui.profile?.addEventListener('click', (e) => {
    e.stopPropagation();          // the outside-click handler below must not see this
    openProfile(!profileOpen());
  });

  // Anywhere else, or Escape, puts it away — the two ways a menu is expected
  // to close when you have decided against it.
  document.addEventListener('click', (e) => {
    if (profileOpen() && !ui.pop.contains(e.target)) openProfile(false);
  });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && profileOpen()) {
      openProfile(false);
      ui.profile.focus();
    }
  });
  ui.refresh?.addEventListener('click', () => loadReport());

  /* The gate. Registered on the document in the capture phase so it runs before
     the handlers site.js put on the buttons themselves — a listener on the
     element could not be relied on to win, because listeners on the target run
     in the order they were added regardless of the capture flag. */
  document.addEventListener('click', gate, true);

  /* Warm the SDK on the first sign of intent. Without this the dynamic import
     runs inside the click, and a slow one costs the popup its user gesture —
     which is how a sign-in button ends up silently blocked. */
  for (const el of [...ui.signIn, ...all(GATED)]) {
    el.addEventListener('pointerenter', firebase, { once: true });
    el.addEventListener('focus', firebase, { once: true });
  }

  /* Restore an existing session. Firebase keeps one in local storage, so its
     presence costs nothing to check, and a first-time visitor still loads no SDK.

     When there is one, two things happen at once. The last known name and
     letter go straight into the bar, so a reload does not show "Sign up" for
     the second it takes the SDK to arrive and answer. And the SDK is fetched
     immediately rather than at the next idle moment, because we already know it
     is needed.

     The cache is display only. It is not proof of anything: the report button
     is deliberately left out of it, so admin is granted by real auth alone, and
     every read is checked again by the Firestore rules regardless. Seeding it
     by hand buys a circle with a letter in it and nothing else. */
  if (hasStoredSession()) {
    const last = remembered();
    if (last) {
      for (const el of ui.out) el.hidden = true;
      for (const el of ui.in) el.hidden = false;
      show(last);
    }
    firebase();
  }

  /* -------------------------------- gate -------------------------------- */

  let allowOnce = null;

  function gate(e) {
    const el = e.target?.closest?.(GATED);
    if (!el) return;

    // Our own replay of the click, once the gate has opened.
    if (el === allowOnce) { allowOnce = null; return; }

    e.preventDefault();
    e.stopPropagation();
    pass(el);
  }

  async function pass(el) {
    if (await signedIn()) return replay(el);

    note('Sign up to download — it takes one click, and the download starts straight after.');
    if (await startSignIn()) {
      note('');
      replay(el);
    }
  }

  /* Let the original click through untouched, so the Windows link downloads and
     site.js copies the Homebrew command exactly as they do when signed in. */
  function replay(el) {
    allowOnce = el;
    el.click();
  }

  async function signedIn() {
    if (!booting && !hasStoredSession()) return false;   // nobody, and nothing to load
    const fb = await firebase();
    return !!fb.auth.currentUser;
  }

  /* ------------------------------- sign in ------------------------------- */

  async function startSignIn() {
    for (const el of ui.signIn) el.disabled = true;
    try {
      const fb = await firebase();
      const { user } = await fb.signInWithPopup(fb.auth, fb.provider);
      await recordVisitor(fb, user);
      return true;
    } catch (err) {
      // A closed popup is someone changing their mind, not a fault.
      if (err?.code === 'auth/popup-closed-by-user' || err?.code === 'auth/cancelled-popup-request') return false;
      note(err?.code === 'auth/popup-blocked'
        ? 'Your browser blocked the sign-in window. Allow popups for this site, then try again.'
        : `Sign-in failed: ${err?.code || err?.message || err}`);
      return false;
    } finally {
      for (const el of ui.signIn) el.disabled = false;
    }
  }

  async function boot() {
    const [app, auth, store] = await Promise.all([
      import(`${SDK}/firebase-app.js`),
      import(`${SDK}/firebase-auth.js`),
      import(`${SDK}/firebase-firestore.js`),
    ]);

    const instance = app.initializeApp(firebaseConfig);
    const provider = new auth.GoogleAuthProvider();
    provider.setCustomParameters({ prompt: 'select_account' });

    const fb = {
      auth: auth.getAuth(instance),
      db: store.getFirestore(instance),
      provider,
      signInWithPopup: auth.signInWithPopup,
      signOut: auth.signOut,
      ...store,
    };

    auth.onAuthStateChanged(fb.auth, paint);
    return fb;
  }

  /* --------------------------------- UI ---------------------------------- */

  function paint(user) {
    const admin = !!user && user.email === ADMIN_EMAIL;

    for (const el of ui.out) el.hidden = !!user;
    for (const el of ui.in) el.hidden = !user;
    for (const el of ui.report) el.hidden = !admin;
    if (!admin && ui.section) ui.section.hidden = true;

    if (!user) {
      remember(null);
      return;
    }

    const full = (user.displayName || user.email || '').trim();
    /* The circle carries a letter rather than the Google photo: it is always
       there, it cannot fail to load, and it does not pull an image off a
       Google CDN on every page view. */
    const letter = (full || '?').charAt(0).toUpperCase();

    show({ full, email: user.email || '', letter });
    remember({ full, email: user.email || '', letter });
  }

  /* Fill in the signed-in furniture. Split out of paint() because the cached
     profile below needs exactly this and nothing else — notably not the report
     button, which only real auth may grant. */
  function show({ full, email, letter }) {
    for (const el of ui.who) el.textContent = full || 'Signed in';
    for (const el of ui.email) el.textContent = email;
    for (const el of ui.initial) el.textContent = letter;
  }

  /* ------------------------------- profile ------------------------------- */

  function openProfile(open) {
    if (!ui.pop || !ui.profile) return;
    ui.pop.hidden = !open;
    ui.profile.setAttribute('aria-expanded', String(open));
  }

  const profileOpen = () => ui.pop && !ui.pop.hidden;

  function note(msg) {
    if (!ui.note) return;
    ui.note.textContent = msg;
    ui.note.hidden = !msg;
  }

  /* -------------------------------- rows --------------------------------- */

  /**
   * Write the row for whoever just signed in.
   *
   * The welcome mail is fired here, on the sign-in that created the row, rather
   * than from a database trigger. Two tabs racing would still send two, so
   * /api/welcome re-reads the row and stamps it before sending.
   */
  async function recordVisitor(fb, user) {
    const ref = fb.doc(fb.db, 'users', user.uid);
    try {
      const snap = await fb.getDoc(ref);
      if (snap.exists()) {
        await fb.updateDoc(ref, {
          lastSeen: fb.serverTimestamp(),
          name: user.displayName || '',
          photo: user.photoURL || '',
        });
        return;
      }

      await fb.setDoc(ref, {
        uid: user.uid,
        name: user.displayName || '',
        email: user.email || '',
        photo: user.photoURL || '',
        os,                        // the machine they signed up from; not overwritten later
        mac: 0,
        windows: 0,
        lastDownloadTarget: null,
        lastDownloadAt: null,
        welcomeSentAt: null,
        firstSeen: fb.serverTimestamp(),
        lastSeen: fb.serverTimestamp(),
      });
      await sendWelcome(user);
    } catch (err) {
      // Their download must never depend on our bookkeeping succeeding.
      console.warn('[souffleur] could not record the visit:', err);
    }
  }

  async function sendWelcome(user) {
    try {
      const res = await fetch('/api/welcome', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ idToken: await user.getIdToken(), os }),
      });
      if (!res.ok) console.warn('[souffleur] welcome mail:', res.status, await res.text());
    } catch (err) {
      console.warn('[souffleur] welcome mail failed:', err);
    }
  }

  /* Counted on the replayed click, so a blocked click counts nothing. */
  async function countInstall(target) {
    if (!booting) return;
    const fb = await booting;
    const user = fb.auth.currentUser;
    if (!user) return;

    fb.updateDoc(fb.doc(fb.db, 'users', user.uid), {
      [target]: fb.increment(1),
      lastDownloadTarget: target,
      lastDownloadAt: fb.serverTimestamp(),
    }).catch((err) => console.warn('[souffleur] could not record the install:', err));
  }

  document.getElementById('dl-win')?.addEventListener('click', () => countInstall('windows'));
  document.getElementById('brewCmd')?.addEventListener('click', () => countInstall('mac'));

  /* ------------------------------- report -------------------------------- */

  function toggleReport() {
    openProfile(false);
    const showing = !ui.section.hidden;
    ui.section.hidden = showing;
    if (showing) return;
    ui.section.scrollIntoView({ behavior: 'smooth', block: 'start' });
    loadReport();
  }

  async function loadReport() {
    ui.status.textContent = 'Loading…';
    ui.table.replaceChildren();
    ui.stats.replaceChildren();

    try {
      const fb = await firebase();
      const snap = await fb.getDocs(
        fb.query(fb.collection(fb.db, 'users'), fb.orderBy('firstSeen', 'desc'), fb.limit(500)),
      );
      const users = snap.docs.map((d) => d.data());

      drawStats(summarise(users));
      drawTable(users);
      ui.status.textContent = users.length
        ? `${users.length} ${users.length === 1 ? 'person' : 'people'}, newest first.`
        : 'Nobody has signed up yet.';
    } catch (err) {
      ui.status.textContent = err?.code === 'permission-denied'
        ? 'Firestore refused the read. Check that web/firestore.rules is published in the console, and that you are signed in as the owner.'
        : `Could not load the report: ${err?.message || err}`;
    }
  }

  function drawStats(s) {
    for (const [label, value] of [
      ['People signed up', s.total],
      ['Downloaded something', s.downloaders],
      ['macOS installs', s.downloads.mac],
      ['Windows installs', s.downloads.windows],
      ['Signed up from a Mac', s.signups.mac],
      ['Signed up from Windows', s.signups.windows],
    ]) {
      const card = document.createElement('div');
      card.className = 'rep-card';

      const n = document.createElement('div');
      n.className = 'rep-n';
      n.textContent = String(value);

      const l = document.createElement('div');
      l.className = 'rep-l';
      l.textContent = label;

      card.append(n, l);
      ui.stats.append(card);
    }
  }

  function drawTable(users) {
    if (!users.length) return;

    const table = document.createElement('table');
    table.className = 'rep-table';

    const head = table.createTHead().insertRow();
    for (const h of ['Name', 'Email', 'Signed up from', 'macOS', 'Windows', 'First seen', 'Last install']) {
      const th = document.createElement('th');
      th.scope = 'col';
      th.textContent = h;
      head.append(th);
    }

    const body = table.createTBody();
    for (const u of users) {
      const row = body.insertRow();
      // textContent throughout — display names come from Google, not from us.
      for (const value of [
        u.name || '—',
        u.email || '—',
        u.os || 'other',
        String(Number(u.mac) || 0),
        String(Number(u.windows) || 0),
        stamp(u.firstSeen),
        u.lastDownloadTarget ? `${u.lastDownloadTarget} · ${stamp(u.lastDownloadAt)}` : '—',
      ]) row.insertCell().textContent = value;
    }

    ui.table.append(table);
  }
}

/* --------------------------------- odds ---------------------------------- */

/* Firestore hands back a Timestamp, or null for a row written moments ago whose
   server time has not landed yet. */
function stamp(ts) {
  const d = ts?.toDate?.();
  return d ? d.toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' }) : '—';
}

function hasStoredSession() {
  try {
    return Object.keys(localStorage).some((k) => k.startsWith('firebase:authUser:'));
  } catch {
    return false;   // private mode, or site data blocked
  }
}

function remembered() {
  let stored;
  try {
    stored = localStorage.getItem(PROFILE);      // throws only if storage is blocked
  } catch {
    return null;                                 // private mode: the flash comes back, nothing breaks
  }
  try {
    const raw = JSON.parse(stored || 'null');
    return raw && raw.letter ? raw : null;
  } catch {
    return null;                                 // somebody else's malformed value
  }
}

function remember(profile) {
  try {
    if (profile) localStorage.setItem(PROFILE, JSON.stringify(profile));
    else localStorage.removeItem(PROFILE);
  } catch {
    /* private mode, or site data blocked: the flash returns, nothing breaks */
  }
}

function isLocal() {
  return ['localhost', '127.0.0.1', '::1', ''].includes(location.hostname);
}

/* Configured badly rather than not at all is the confusing case, so say why the
   controls are missing — in the console, where it costs the page nothing. */
function explainUnconfigured() {
  console.info(
    '[souffleur] Sign-up is off and the downloads are ungated: web/firebase-config.js '
    + 'still holds its REPLACE_ placeholders. See web/SETUP.md, steps 1 to 6.',
  );
}
