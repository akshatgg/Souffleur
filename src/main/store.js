'use strict';
const { app, safeStorage } = require('electron');
const fs = require('fs');
const path = require('path');

/**
 * Settings + API keys on disk.
 *
 * Keys go through Electron safeStorage, which on macOS is the Keychain. If
 * encryption is unavailable we store the key in plaintext but say so out loud
 * via keyStorageMode(), so the UI can warn instead of quietly pretending.
 */

const DEFAULTS = {
  provider: 'gemini',
  model: 'gemini-3.1-flash-lite',
  baseUrl: '',
  system:
    'You are a terse, high-signal assistant running in a small always-on-top overlay. ' +
    'Answer directly, lead with the answer, skip preamble. ' +
    'The user cannot see a long response without scrolling, so be brief unless asked to expand.\n\n' +
    'The answer is read at a glance, so lay it out to be scanned, not read as prose. ' +
    'Break it into short blocks, one idea each, separated by a blank line -- never one long ' +
    'paragraph. Open each block with a **bold label** so the eye lands on it. Comparing two ' +
    'things? Give each its own labelled block, then close with a single **In short:** line. ' +
    'Bold the few words in a block that carry the answer. A one-line answer stays one line; ' +
    'do not label a single sentence, and do not pad an answer just to fill blocks.\n\n' +
    'Only **bold**, `inline code` and fenced code blocks render here. Markdown headings (#), ' +
    'tables and numbered lists arrive as raw characters, so never use them.',
  interviewMode: false,  // answer in first person as the person in the documents
  personaName: '',       // blank = inferred from the first document
  // Every shortcut is global: it fires in EVERY app, not just this one. A bare
  // Shift+letter therefore takes that capital letter away from the whole
  // machine, which is why each one is editable rather than baked in.
  shortcuts: {
    toggle:     'Shift+Space',
    screenshot: 'Shift+S',
    listen:     'Shift+Z',
    answer:     'Shift+A',
    clear:      'Shift+K',
  },
  listenHotkey: '',        // legacy single-key setting, migrated into shortcuts
  transcribeModel: '',   // blank = pick automatically from the model list
  autoListen: false,     // start listening as soon as the app launches
  captureMic: false,     // also transcribe your own voice, not just the speakers
  opacity: 0.96,
  bounds: null,
  freeKeyOn: false,      // the free key's switch as last read, for offline launches
  installId: '',         // random, made once; the free key counts its daily limit by it
};

let filePath = null;
function file() {
  if (!filePath) filePath = path.join(app.getPath('userData'), 'settings.json');
  return filePath;
}

function readRaw() {
  try {
    return JSON.parse(fs.readFileSync(file(), 'utf8'));
  } catch {
    return {};
  }
}

function writeRaw(obj) {
  fs.mkdirSync(path.dirname(file()), { recursive: true });
  fs.writeFileSync(file(), JSON.stringify(obj, null, 2), { mode: 0o600 });
}

function canEncrypt() {
  try { return safeStorage.isEncryptionAvailable(); } catch { return false; }
}

function keyStorageMode() {
  return canEncrypt()
    ? { encrypted: true, note: 'API keys are encrypted with the system keychain.' }
    : { encrypted: false, note: 'Keychain unavailable - API keys are stored in plaintext on disk.' };
}

/** Settings minus secrets. */
function getSettings() {
  const raw = readRaw();
  const out = { ...DEFAULTS };
  for (const k of Object.keys(DEFAULTS)) if (raw[k] !== undefined) out[k] = raw[k];

  // Merge rather than replace, so a settings file written before a new action
  // existed still gets a binding for it instead of leaving it unregistered.
  out.shortcuts = { ...DEFAULTS.shortcuts, ...(raw.shortcuts || {}) };
  if (raw.listenHotkey && !raw.shortcuts?.listen) out.shortcuts.listen = raw.listenHotkey;
  return out;
}

function setSettings(patch) {
  const raw = readRaw();
  for (const [k, v] of Object.entries(patch)) {
    if (k in DEFAULTS) raw[k] = v;
  }
  writeRaw(raw);
  return getSettings();
}

/** Per-provider key, so switching providers does not wipe the other key. */
function setKey(provider, key) {
  const raw = readRaw();
  raw.keys = raw.keys || {};
  if (!key) {
    delete raw.keys[provider];
  } else if (canEncrypt()) {
    raw.keys[provider] = { enc: true, v: safeStorage.encryptString(key).toString('base64') };
  } else {
    raw.keys[provider] = { enc: false, v: key };
  }
  writeRaw(raw);
}

function getKey(provider) {
  const rec = readRaw().keys?.[provider];
  if (!rec) return '';
  if (!rec.enc) return rec.v || '';
  try {
    return safeStorage.decryptString(Buffer.from(rec.v, 'base64'));
  } catch {
    return ''; // keychain entry no longer decryptable (e.g. restored to a new machine)
  }
}

/**
 * Which providers have a *usable* key, without revealing any of them.
 *
 * A stored key that no longer decrypts is not the same as no key at all, and
 * conflating them produces a baffling "no key set" for a key you can see in the
 * file. safeStorage is bound to the app's keychain identity, so renaming the
 * app orphans everything it previously encrypted.
 */
function keyStatus(provider) {
  const rec = readRaw().keys?.[provider];
  if (!rec) return 'none';
  if (!rec.enc) return rec.v ? 'ok' : 'none';
  try {
    return safeStorage.decryptString(Buffer.from(rec.v, 'base64')) ? 'ok' : 'none';
  } catch {
    return 'unreadable';
  }
}

function keyPresence() {
  return Object.fromEntries(
    ['gemini', 'openai', 'custom'].map((p) => [p, keyStatus(p) === 'ok'])
  );
}

function keyStatuses() {
  return Object.fromEntries(['gemini', 'openai', 'custom'].map((p) => [p, keyStatus(p)]));
}

module.exports = { getSettings, setSettings, setKey, getKey, keyPresence, keyStatuses, keyStorageMode, DEFAULTS };
