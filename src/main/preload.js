'use strict';
const { contextBridge, ipcRenderer } = require('electron');

/**
 * The only surface the renderer gets. No node, no fs, no direct network.
 * API keys never cross this bridge outbound -- the renderer can set a key and
 * ask whether one exists, but can never read one back.
 */
contextBridge.exposeInMainWorld('souffleur', {
  bootstrap: () => ipcRenderer.invoke('bootstrap'),
  setSettings: (patch) => ipcRenderer.invoke('settings:set', patch),
  setKey: (provider, key) => ipcRenderer.invoke('key:set', { provider, key }),
  listModels: () => ipcRenderer.invoke('models:list'),

  send: (messages, withScreenshot) =>
    ipcRenderer.invoke('chat:send', { messages, withScreenshot }),
  abort: () => ipcRenderer.invoke('chat:abort'),

  listDocs: () => ipcRenderer.invoke('docs:list'),
  addDocs: () => ipcRenderer.invoke('docs:add'),
  removeDoc: (id) => ipcRenderer.invoke('docs:remove', id),

  hotkeyStatus: () => ipcRenderer.invoke('hotkey:check'),
  startListening: () => ipcRenderer.invoke('listen:start'),
  sendPcm: (buf) => ipcRenderer.invoke('listen:pcm', buf),
  stopListening: () => ipcRenderer.invoke('listen:stop'),
  listenState: () => ipcRenderer.invoke('listen:state'),
  clearTranscript: () => ipcRenderer.invoke('listen:clear'),
  lastHeard: () => ipcRenderer.invoke('listen:last'),

  hide: () => ipcRenderer.invoke('window:close'),

  onDelta: (fn) => ipcRenderer.on('chat:delta', (_e, d) => fn(d)),
  onAskWithScreenshot: (fn) => ipcRenderer.on('hotkey:ask-with-screenshot', () => fn()),
  onClear: (fn) => ipcRenderer.on('hotkey:clear', () => fn()),

  onTranscript: (fn) => ipcRenderer.on('listen:transcript', (_e, t) => fn(t)),
  onListenState: (fn) => ipcRenderer.on('listen:state', (_e, v) => fn(v)),
  onSpeaking: (fn) => ipcRenderer.on('listen:speaking', (_e, v) => fn(v)),
  onListenError: (fn) => ipcRenderer.on('listen:error', (_e, m) => fn(m)),
  onListenHint: (fn) => ipcRenderer.on('listen:hint', (_e, m) => fn(m)),
  onToggleListen: (fn) => ipcRenderer.on('hotkey:toggle-listen', () => fn()),
  onAnswerLast: (fn) => ipcRenderer.on('hotkey:answer-last', () => fn()),
});
