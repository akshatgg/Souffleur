'use strict';
const { app, BrowserWindow, globalShortcut, ipcMain, screen, shell,
        systemPreferences, desktopCapturer, dialog, session } = require('electron');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const { applyStealth, hideFromDock, stealthStatus } = require('./stealth');
const { streamChat, listModels, transcribe, defaultTranscribeModel, PRESETS } = require('./providers');
const freekey = require('./freekey');
const updater = require('./updater');
const { Listener } = require('./listen');
const persona = require('./persona');
const store = require('./store');
const claudeCode = require('./claudecode');
const copilot = require('./copilot');
const { captureScreen } = require('./capture');

// Providers that answer through a CLI the user signed in to, by provider id.
const CLIS = { 'claude-code': claudeCode, copilot };

// Trying the free key locally (./dev_start.sh --free-key) runs as a brand-new
// user: a profile of its own, with no saved key, so it shows what a first
// launch shows and never touches the keys saved in the real profile.
if (freekey.TEST) {
  app.setPath('userData', path.join(app.getPath('appData'), 'Souffleur Free Test'));
}

let win = null;
let inFlight = null; // AbortController for the active completion
let listener = null;
let lastModelList = {};        // provider -> models, used to pick a transcription model
const transcript = [];         // { t, text } of what was heard, oldest first
const TRANSCRIPT_KEEP = 60;

const DEFAULT_SIZE = { width: 460, height: 560 };

function createWindow() {
  const saved = store.getSettings().bounds;
  const area = screen.getPrimaryDisplay().workArea;

  win = new BrowserWindow({
    width: saved?.width ?? DEFAULT_SIZE.width,
    height: saved?.height ?? DEFAULT_SIZE.height,
    x: saved?.x ?? area.x + area.width - DEFAULT_SIZE.width - 24,
    y: saved?.y ?? area.y + 24,
    minWidth: 320,
    minHeight: 220,
    frame: false,
    transparent: true,
    hasShadow: false,
    resizable: true,
    movable: true,
    fullscreenable: false,
    show: false,
    acceptFirstMouse: true,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  });

  applyStealth(win);
  win.loadFile(path.join(__dirname, '..', 'renderer', 'index.html'));
  win.once('ready-to-show', () => win.show());

  const persist = () => {
    if (win && !win.isDestroyed()) store.setSettings({ bounds: win.getBounds() });
  };
  win.on('moved', persist);
  win.on('resized', persist);
  win.on('closed', () => { win = null; });

  // Clipboard shortcuts, wired by hand.
  //
  // app.dock.hide() puts the app in accessory mode, which means no menu bar --
  // and on macOS the standard Cmd+C/V/X/A accelerators are delivered *by the
  // Edit menu*. With no menu there is no paste, which makes the API key field
  // impossible to fill without retyping the key by hand. Handling the input
  // directly works whether or not a menu exists.
  win.webContents.on('before-input-event', (event, input) => {
    if (input.type !== 'keyDown') return;
    if (!(input.meta || input.control)) return;

    const wc = win.webContents;
    switch (input.key.toLowerCase()) {
      case 'v': wc.paste(); break;
      case 'c': wc.copy(); break;
      case 'x': wc.cut(); break;
      case 'a': wc.selectAll(); break;
      case 'z': input.shift ? wc.redo() : wc.undo(); break;
      default: return;                       // leave every other combo alone
    }
    event.preventDefault();
  });

  // External links open in the real browser, never inside the overlay.
  win.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url);
    return { action: 'deny' };
  });
}

function toggleVisible() {
  if (!win) return createWindow();
  if (win.isVisible()) win.hide();
  else { win.show(); win.focus(); }
}

const ACTIONS = {
  toggle:     { label: 'Show or hide',      run: () => toggleVisible() },
  screenshot: { label: 'Ask about screen',  run: () => win?.webContents.send('hotkey:ask-with-screenshot') },
  listen:     { label: 'Listen to the call', run: () => win?.webContents.send('hotkey:toggle-listen') },
  answer:     { label: 'Answer that',       run: () => win?.webContents.send('hotkey:answer-last') },
  clear:      { label: 'Clear',             run: () => win?.webContents.send('hotkey:clear') },
};

let bound = {};   // action -> accelerator actually registered

/**
 * Bind every shortcut from settings.
 *
 * These are global accelerators: the OS routes the key combination here before
 * any other application sees it. A bare Shift+letter therefore removes that
 * capital letter from the entire machine for as long as the app runs, which is
 * why the bindings live in settings and every failure is reported rather than
 * swallowed.
 */
function registerShortcuts() {
  globalShortcut.unregisterAll();
  bound = {};

  const wanted = store.getSettings().shortcuts || {};
  const failed = [];

  for (const [action, spec] of Object.entries(ACTIONS)) {
    const accel = (wanted[action] || '').trim();
    if (!accel) continue;
    try {
      if (globalShortcut.register(accel, spec.run)) {
        bound[action] = accel;
      } else {
        failed.push(`${spec.label}: "${accel}" is already taken by another app`);
      }
    } catch (err) {
      failed.push(`${spec.label}: "${accel}" is not a valid shortcut`);
    }
  }

  if (failed.length) console.warn('[souffleur] ' + failed.join('; '));
  return { bound, failed };
}

/* -------------------------------- free key --------------------------------- */

let freeOn = false;        // the switch as last read
let switchRead = null;     // the read in flight, or the last one to finish

function setFreeOn(on) {
  if (on === freeOn) return;
  freeOn = on;
  store.setSettings({ freeKeyOn: on });
  if (win && !win.isDestroyed()) win.webContents.send('freekey:state', on);
}

/** Ask the website whether the free key is on. Keeps the last answer when offline. */
function refreshSwitch() {
  switchRead = freekey.readSwitch().then((on) => {
    if (on !== null) setFreeOn(on);
    return freeOn;
  });
  return switchRead;
}

function installId() {
  let id = store.getSettings().installId;
  if (!id) {
    id = crypto.randomUUID();
    store.setSettings({ installId: id });
  }
  return id;
}

/**
 * The provider options for whichever key answers, or null when there is none.
 * On the free key the server picks the model, so none is sent.
 */
function routeFor(s) {
  // Claude Code and Copilot sign in through their own CLIs, so being installed
  // is their key.
  if (CLIS[s.provider]?.located()) return { provider: s.provider, model: s.model };
  const apiKey = store.getKey(s.provider);
  const route = freekey.pickRoute({ hasOwnKey: Boolean(apiKey), freeOn });
  if (route === 'own') return { provider: s.provider, apiKey, model: s.model, baseUrl: s.baseUrl };
  if (route === 'free') return { provider: 'gemini', free: { installId: installId() } };
  return null;
}

/**
 * The owner switched the free key off since it was last read: stop offering
 * it, so settings shows the key fields again.
 */
function noteFreeStop(err) {
  if (err?.code === 'free_off') setFreeOn(false);
}

/** Saved keys, plus whether each CLI is installed, which stands in for its key. */
function keyPresence() {
  const installed = Object.entries(CLIS).map(([p, cli]) => [p, Boolean(cli.located())]);
  return { ...store.keyPresence(), ...Object.fromEntries(installed) };
}

/* --------------------------------- updates --------------------------------- */

const UPDATE_EVERY = 6 * 60 * 60 * 1000;

// What the renderer paints. `state` is idle, checking, current, available,
// downloading or installing; `message` is whatever went wrong last.
let update = { state: 'idle', current: app.getVersion(), version: '', percent: 0, message: '' };
let latest = null;         // the newer release the last check found, if any

function setUpdate(patch) {
  update = { ...update, ...patch };
  if (win && !win.isDestroyed()) win.webContents.send('update:state', update);
  return update;
}

// Where an installer is downloaded to. Emptied at launch: by then the update it
// held is either installed or abandoned, and it is 150 MB either way.
const updateDir = () => path.join(app.getPath('temp'), 'souffleur-update');

const updateBusy = () => ['checking', 'downloading', 'installing'].includes(update.state);

/**
 * Look for a newer release. The timer calls this quietly: a laptop that is
 * offline at launch should not open onto an error about updates, so only a
 * check somebody asked for reports that it failed.
 */
async function checkForUpdate({ quiet = false } = {}) {
  if (updateBusy()) return update;
  const before = update.state;
  setUpdate({ state: 'checking', message: '' });
  try {
    const found = await updater.check({ current: update.current });
    latest = found.newer ? found : null;
    return setUpdate(latest
      ? { state: 'available', version: found.version }
      : { state: 'current', version: '' });
  } catch (err) {
    // A failed check does not un-find an update that was already found.
    const state = latest ? 'available' : before === 'current' ? 'current' : 'idle';
    return setUpdate({ state, message: quiet ? '' : err.message });
  }
}

/** Send the user to the release page, for a copy that cannot replace itself. */
function updateByHand(why) {
  shell.openExternal(latest?.page || updater.RELEASES_PAGE).catch(() => {});
  return setUpdate({ state: 'available', message: `${why} The download page is open in your browser.` });
}

async function installUpdate() {
  if (updateBusy()) return update;
  // Found through the release page while GitHub was limiting this network:
  // ask again for the checksum, which may be allowed by now.
  if (!latest || latest.limited) await checkForUpdate();
  if (!latest) return update;
  if (latest.limited) {
    return updateByHand('GitHub is limiting downloads from your network right now, so Souffleur cannot verify the download itself.');
  }

  const why = updater.blocker({ packaged: app.isPackaged });
  if (why) return updateByHand(why);
  if (!latest.asset) return updateByHand('This release has no installer for this machine.');

  try {
    setUpdate({ state: 'downloading', percent: 0, message: '' });
    const file = await updater.download(latest.asset, updateDir(), {
      onProgress: (p) => {
        const percent = Math.floor(p * 100);
        if (percent !== update.percent) setUpdate({ percent });
      },
    });

    setUpdate({ state: 'installing' });
    if (process.platform === 'darwin') await updater.installMac({ dmg: file });
    else updater.installWin({ exe: file });

    // The installer takes over from here and reopens the app when it is done.
    setTimeout(() => app.quit(), 400);
    return update;
  } catch (err) {
    return setUpdate({ state: 'available', message: err.message || String(err) });
  }
}

/* -------------------------------- listening -------------------------------- */

function transcribeModelFor(s) {
  return s.transcribeModel || defaultTranscribeModel(s.provider, lastModelList[s.provider]);
}

const HEARS = new Set(['gemini', 'openai', 'custom']);

/**
 * Who transcribes the call. Usually whoever answers -- but Claude cannot take
 * audio, so with Claude answering, the call is heard through a Gemini or OpenAI
 * key the user also saved, or the free key.
 */
function transcribeRouteFor(s) {
  const route = routeFor(s);
  if (route?.free) return route;
  if (route && HEARS.has(route.provider)) return { ...route, model: transcribeModelFor(s) };

  for (const provider of ['gemini', 'openai']) {
    const apiKey = store.getKey(provider);
    if (apiKey) {
      return { provider, apiKey, model: defaultTranscribeModel(provider, lastModelList[provider]) };
    }
  }
  if (freeOn) return { provider: 'gemini', free: { installId: installId() } };
  if (route) {
    const who = route.provider === 'copilot' ? 'GitHub Copilot' : 'Claude';
    throw new Error(`${who} cannot hear audio. Add a Gemini or OpenAI key in settings to listen to the call.`);
  }
  return null;
}

// Once the free key says no (limit reached, or switched off), every clip still
// queued would fail the same way and each would print the same error. The first
// one says it; the rest are dropped until listening is started again.
let freeListenStopped = false;

function ensureListener() {
  if (listener) return listener;

  listener = new Listener(async (wav) => {
    if (freeListenStopped) return '';
    const route = transcribeRouteFor(store.getSettings());
    if (!route) throw new Error('no API key');
    try {
      return await transcribe({ ...route, wav });
    } catch (err) {
      if (route.free && freekey.isFreeStop(err)) {
        freeListenStopped = true;
        noteFreeStop(err);
      }
      throw err;
    }
  });

  const toRenderer = (ch) => (payload) => {
    if (win && !win.isDestroyed()) win.webContents.send(ch, payload);
  };

  listener.on('transcript', ({ who, text }) => {
    transcript.push({ t: Date.now(), who, text });
    while (transcript.length > TRANSCRIPT_KEEP) transcript.shift();
    toRenderer('listen:transcript')({ who, text });
  });
  listener.on('hint', toRenderer('listen:hint'));
  listener.on('state', toRenderer('listen:state'));
  listener.on('speaking', toRenderer('listen:speaking'));
  listener.on('error', toRenderer('listen:error'));
  listener.on('log', (m) => console.log('[audiotap]', m));

  return listener;
}

/**
 * Interview mode answers *as* the person described by the uploaded documents.
 * It falls back to the plain assistant prompt when no document has been added,
 * so turning the toggle on before uploading anything cannot produce a persona
 * with no history to stand on.
 *
 * The prompt depends on the question: the documents are searched for what was
 * asked, and only the matching sections go with it (see persona.js).
 */
function systemPrompt(s, messages, image) {
  if (s.interviewMode) {
    const p = persona.interviewPrompt(s.personaName, messages, { image: Boolean(image) });
    if (p) return p;
  }
  return s.system;
}

/** Recent speech, folded into the system prompt so answers have context. */
function transcriptContext() {
  if (!transcript.length) return '';
  const recent = transcript.slice(-12)
    .map((x) => `${x.who === 'you' ? 'Me' : 'Them'}: ${x.text}`).join('\n');
  return '\n\nLive transcript of the call, oldest first. "Them" is the other ' +
         'party, "Me" is the user. Use it as context; do not repeat it back:\n' + recent;
}

/* ---------------------------------- IPC ----------------------------------- */

ipcMain.handle('bootstrap', async () => {
  // Someone with no key at all is sent to settings to add one -- unless the free
  // key is on. Wait for the launch-time read of the switch, so a first launch
  // does not ask for a key it does not need.
  if (!Object.values(store.keyPresence()).some(Boolean)) await switchRead;
  await Promise.all(Object.values(CLIS).map((cli) => cli.locate()));

  return {
    settings: store.getSettings(),
    freeKey: freeOn,
    update,
    presets: PRESETS,
    keys: keyPresence(),
    keyStatuses: store.keyStatuses(),
    docs: persona.list(),
    maxDocs: persona.MAX_DOCS,
    suggestedName: persona.guessName(),
    keyStorage: store.keyStorageMode(),
    stealth: stealthStatus(),
    platform: process.platform,
    // PDF reading is pure JavaScript and works everywhere. Audio capture still
    // needs a platform helper, so the UI disables it where there is none rather
    // than failing when pressed.
    capabilities: {
      // macOS captures through the ScreenCaptureKit helper; Windows captures in
      // the renderer through Chromium's loopback support. Linux has neither.
      audio: process.platform === 'darwin' || process.platform === 'win32',
      audioMode: process.platform === 'darwin' ? 'helper' : 'renderer',
      pdf: true,
    },
  };
});

ipcMain.handle('settings:set', (_e, patch) => {
  const next = store.setSettings(patch);
  if ('shortcuts' in patch) registerShortcuts();
  return next;
});

ipcMain.handle('hotkey:check', () => {
  const { bound: b, failed } = { bound, failed: [] };
  return {
    wanted: store.getSettings().shortcuts,
    bound: b,
    actions: Object.fromEntries(Object.entries(ACTIONS).map(([k, v]) => [k, v.label])),
    failed,
  };
});
ipcMain.handle('key:set', (_e, { provider, key }) => {
  store.setKey(provider, key);
  return keyPresence();
});

ipcMain.handle('models:list', async () => {
  const s = store.getSettings();
  try {
    const models = await listModels({
      provider: s.provider,
      apiKey: store.getKey(s.provider),
      baseUrl: s.baseUrl,
    });
    lastModelList[s.provider] = models;
    return { ok: true, models };
  } catch (err) {
    return { ok: false, error: err.message || String(err) };
  }
});

/**
 * System-audio capture runs in a child process, so macOS attributes it to
 * Electron. Without the Screen Recording grant, ScreenCaptureKit accepts the
 * stream and then delivers nothing at all -- no error, no callback, no audio.
 * That silent mode is indistinguishable from "the room is quiet", so check the
 * permission before starting rather than leaving the user to guess.
 */
function screenPermission() {
  if (process.platform !== 'darwin') return 'granted';
  try { return systemPreferences.getMediaAccessStatus('screen'); } catch { return 'unknown'; }
}

/* ---------------------------- persona documents ---------------------------- */

ipcMain.handle('docs:list', () => ({
  docs: persona.list(),
  max: persona.MAX_DOCS,
  suggestedName: persona.guessName(),
}));

ipcMain.handle('docs:add', async () => {
  const res = await dialog.showOpenDialog(win, {
    title: 'Add a document about you',
    buttonLabel: 'Add',
    properties: ['openFile', 'multiSelections'],
    filters: [{ name: 'PDF', extensions: ['pdf'] }],
  });
  if (res.canceled || !res.filePaths.length) return { ok: true, docs: persona.list() };

  const errors = [];
  for (const f of res.filePaths) {
    const r = await persona.add(f);
    if (!r.ok) errors.push(`${require('path').basename(f)}: ${r.error}`);
  }
  return { ok: !errors.length, error: errors.join('\n'), docs: persona.list(),
           suggestedName: persona.guessName() };
});

ipcMain.handle('docs:remove', (_e, id) => persona.remove(id));

/* -------------------------------- listening -------------------------------- */

/**
 * Windows: let the renderer capture system audio itself.
 *
 * getDisplayMedia normally shows a picker and returns whatever the user chose.
 * Answering the request here with 'loopback' audio gives the renderer the
 * system mix with no picker, which is what a call assistant needs. Chromium
 * supports this on Windows; macOS has no loopback device, which is why that
 * platform goes through the ScreenCaptureKit helper instead.
 */
function grantLoopbackAudio() {
  session.defaultSession.setDisplayMediaRequestHandler(async (request, callback) => {
    try {
      const sources = await desktopCapturer.getSources({ types: ['screen'] });
      callback({ video: sources[0], audio: 'loopback' });
    } catch {
      callback({});
    }
  }, { useSystemPicker: false });
}

ipcMain.handle('listen:pcm', (_e, buf) => {
  if (buf && buf.byteLength) ensureListener().pushExternal(Buffer.from(buf));
  return true;
});

ipcMain.handle('listen:start', async () => {
  freeListenStopped = false;
  // Windows captures in the renderer; there is no helper to spawn.
  if (process.platform !== 'darwin') return ensureListener().startExternal();

  const status = screenPermission();
  if (status !== 'granted' && status !== 'unknown') {
    // Touching desktopCapturer is what makes macOS list Electron in the pane;
    // until something asks, there is no row for the user to switch on.
    desktopCapturer.getSources({ types: ['screen'], thumbnailSize: { width: 1, height: 1 } })
      .catch(() => {});
    shell.openExternal(
      'x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture'
    ).catch(() => {});
    return {
      ok: false,
      error: 'Souffleur needs Screen Recording permission to hear call audio. ' +
             'Switch on "Electron" in System Settings \u2192 Privacy & Security \u2192 ' +
             'Screen & System Audio Recording, then press the listen shortcut again.',
    };
  }
  return ensureListener().start({ mic: store.getSettings().captureMic });
});

ipcMain.handle('listen:permission', () => ({ screen: screenPermission() }));
ipcMain.handle('listen:stop', () => (listener ? listener.stop() : { ok: true }));
ipcMain.handle('listen:state', () => ({
  running: Boolean(listener && listener.running),
  lines: transcript.map((x) => ({ who: x.who, text: x.text })),
}));
ipcMain.handle('listen:clear', () => { transcript.length = 0; return true; });
// "Answer that" means the last thing the OTHER party said, not your own voice.
ipcMain.handle('listen:last', () => {
  for (let i = transcript.length - 1; i >= 0; i--) {
    if (transcript[i].who !== 'you') return transcript[i].text;
  }
  return transcript.length ? transcript[transcript.length - 1].text : '';
});

ipcMain.handle('window:close', () => { win?.hide(); });

ipcMain.handle('update:check', () => checkForUpdate());
ipcMain.handle('update:install', () => installUpdate());

ipcMain.handle('chat:abort', () => {
  inFlight?.abort();
  inFlight = null;
  return true;
});

/**
 * Run one completion, streaming deltas to the renderer.
 * Returns only when the stream is finished, so the renderer can await it.
 */
ipcMain.handle('chat:send', async (event, { messages, withScreenshot }) => {
  const s = store.getSettings();
  let route = routeFor(s);
  // The free key may have been switched on since launch; ask before refusing.
  if (!route) {
    await refreshSwitch();
    route = routeFor(s);
  }
  if (!route && CLIS[s.provider]) {
    await CLIS[s.provider].locate({ fresh: true });
    route = routeFor(s);
  }
  if (!route) {
    if (CLIS[s.provider]) {
      const { label, keyUrl } = PRESETS[s.provider];
      return { ok: false, error: `${label} was not found on this computer. Install it from ${keyUrl.replace(/^https:\/\//, '')}, then try again.` };
    }
    return { ok: false, error: `No API key set for ${PRESETS[s.provider]?.label || s.provider}.` };
  }

  let image = null;
  if (withScreenshot) {
    try {
      // Capture whichever display the overlay is on, so a second monitor does
      // not silently get captured instead of the one you are looking at.
      const shot = await captureScreen(win && !win.isDestroyed() ? win.getBounds() : null);
      image = shot.dataUrl;
      // Show the user what was actually sent, rather than a label claiming a
      // screenshot was attached.
      if (!event.sender.isDestroyed()) {
        event.sender.send('chat:shot', {
          thumb: shot.thumb,
          label: shot.label,
          displayCount: shot.displayCount,
        });
      }
    } catch (err) {
      return { ok: false, error: `Screenshot failed: ${err.message}` };
    }
  }

  inFlight?.abort();
  const ctrl = new AbortController();
  inFlight = ctrl;

  const send = (ch, payload) => {
    if (!event.sender.isDestroyed()) event.sender.send(ch, payload);
  };

  try {
    let any = false;
    const stream = streamChat({
      ...route,
      system: systemPrompt(s, messages, image) + transcriptContext(),
      messages,
      image,
      signal: ctrl.signal,
    });

    for await (const delta of stream) {
      any = true;
      send('chat:delta', delta);
    }
    if (!any) return { ok: false, error: 'Model returned an empty response.' };
    return { ok: true, hadImage: Boolean(image) };
  } catch (err) {
    if (err.name === 'AbortError') return { ok: false, aborted: true };
    if (route.free) noteFreeStop(err);
    return { ok: false, error: err.message || String(err) };
  } finally {
    if (inFlight === ctrl) inFlight = null;
  }
});

/* -------------------------------- Lifecycle -------------------------------- */

// A second copy would fight over the global hotkeys.
if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', () => { win?.show(); win?.focus(); });

  app.whenReady().then(() => {
    hideFromDock();
    if (process.platform !== 'darwin') grantLoopbackAudio();
    // Started before the window so the answer is usually in by the time the
    // page asks for it.
    freeOn = store.getSettings().freeKeyOn;
    refreshSwitch();
    for (const cli of Object.values(CLIS)) cli.locate();
    createWindow();
    registerShortcuts();

    fs.promises.rm(updateDir(), { recursive: true, force: true }).catch(() => {});
    checkForUpdate({ quiet: true });
    setInterval(() => checkForUpdate({ quiet: true }), UPDATE_EVERY).unref();

    if (process.env.SOUFFLEUR_DEBUG === '1') {
      const s = store.getSettings();
      listModels({ provider: s.provider, apiKey: store.getKey(s.provider), baseUrl: s.baseUrl })
        .then((ms) => console.log('[souffleur] models available to this key:\n  ' + ms.join('\n  ')))
        .catch((e) => console.log('[souffleur] model list failed:', e.message));
    }

    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) createWindow();
    });
  });

  app.on('will-quit', () => {
    globalShortcut.unregisterAll();
    listener?.stop();     // never leave the capture helper running
  });
  // Overlay lives in the background; closing the window must not quit the app.
  app.on('window-all-closed', () => {});
}
