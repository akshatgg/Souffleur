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
    'Answer directly, lead with the answer, skip preamble. Use short code blocks when code helps. ' +
    'The user cannot see a long response without scrolling, so be brief unless asked to expand.',
  listenHotkey: 'Shift+Z',  // global: fires in every app, so beware bare letters
  transcribeModel: '',   // blank = pick automatically from the model list
  autoListen: false,     // start listening as soon as the app launches
  captureMic: false,     // also transcribe your own voice, not just the speakers
  opacity: 0.96,
  bounds: null,
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
