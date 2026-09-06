'use strict';
const { app, BrowserWindow, globalShortcut, ipcMain, screen, shell,
        systemPreferences, desktopCapturer, dialog } = require('electron');
const path = require('path');

const { applyStealth, hideFromDock, stealthStatus } = require('./stealth');
const { streamChat, listModels, transcribe, defaultTranscribeModel, PRESETS } = require('./providers');
const { Listener } = require('./listen');
const persona = require('./persona');
const store = require('./store');
const { captureScreen } = require('./capture');

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

function nudge(dx, dy) {
  if (!win) return;
  const b = win.getBounds();
  win.setBounds({ ...b, x: b.x + dx, y: b.y + dy });
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

/* ---------------------------------- IPC ----------------------------------- */

ipcMain.handle('bootstrap', () => ({
  settings: store.getSettings(),
  presets: PRESETS,
  keys: store.keyPresence(),
  keyStatuses: store.keyStatuses(),
  docs: persona.list(),
  maxDocs: persona.MAX_DOCS,
  suggestedName: persona.guessName(),
  keyStorage: store.keyStorageMode(),
  stealth: stealthStatus(),
  platform: process.platform,
}));

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
  return store.keyPresence();
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

ipcMain.handle('listen:start', async () => {
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
  const apiKey = store.getKey(s.provider);
  if (!apiKey) {
    return { ok: false, error: `No API key set for ${PRESETS[s.provider]?.label || s.provider}.` };
  }

  let image = null;
  if (withScreenshot) {
    try {
      image = await captureScreen();
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
      provider: s.provider,
      apiKey,
      model: s.model,
      baseUrl: s.baseUrl,
      system: systemPrompt(s) + transcriptContext(),
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
    createWindow();
    registerShortcuts();

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
