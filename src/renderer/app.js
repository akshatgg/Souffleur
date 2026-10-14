'use strict';

const $ = (id) => document.getElementById(id);
const logEl = $('log');
const inputEl = $('input');

let settings = null;
let presets = null;
let keyState = {};
let keyStatuses = {};
let modelCache = {};     // provider -> models actually reachable with that key
let freeOn = false;      // the free key's switch, as the main process last read it
let showOwnKey = false;  // "Use my own key" was pressed, so the key fields stay open
let conversation = [];   // [{ role, content }]
let streaming = null;    // { el, text, raf }
let busy = false;

/* ------------------------------ text rendering ----------------------------- */

const esc = (s) =>
  String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

/**
 * Just enough markdown for an answer in a small window: fenced code, inline
 * code, bold. Everything is escaped before any tag is introduced, and fenced
 * blocks are lifted out first so their contents are never re-parsed.
 *
 * The trailing-fence case matters: while a response streams in, the closing
 * ``` has not arrived yet, so an unterminated fence still has to render as code
 * rather than as literal backticks.
 */
function renderText(src) {
  const blocks = [];
  let s = String(src).replace(/```(\w*)\n?([\s\S]*?)(?:```|$)/g, (_m, lang, code) => {
    blocks.push(
      '<pre><code data-lang="' + esc(lang) + '">' + esc(code.replace(/\n$/, '')) + '</code></pre>'
    );
    return '%%SOUFBLOCK' + (blocks.length - 1) + '%%';
  });

  s = esc(s)
    .replace(/`([^`\n]+)`/g, (_m, c) => '<code>' + c + '</code>')
    .replace(/\*\*([^*\n]+)\*\*/g, '<strong>$1</strong>');

  return s.replace(/%%SOUFBLOCK(\d+)%%/g, (_m, i) => blocks[Number(i)] || '');
}

function atBottom() {
  return logEl.scrollHeight - logEl.scrollTop - logEl.clientHeight < 60;
}
function scrollDown() {
  logEl.scrollTop = logEl.scrollHeight;
}

function addTurn(role, html, tag) {
  const placeholder = $('empty');
  if (placeholder) placeholder.remove();
  const el = document.createElement('div');
  el.className = 'turn ' + role;
  el.innerHTML = (tag ? '<span class="shot-tag">' + esc(tag) + '</span><br>' : '') + html;
  logEl.appendChild(el);
  scrollDown();
  return el;
}

/* --------------------------------- status --------------------------------- */

let baseStatusText = '';

function paintStatus(stealth) {
  const bar = $('status');
  const text = $('statusText');
  const safe = stealth.supported && stealth.confidence !== 'degraded';

  bar.dataset.state = safe ? 'hidden' : 'exposed';
  baseStatusText = safe
    ? 'Hidden from screen share'
    : stealth.confidence === 'degraded'
      ? 'Protection degraded on this OS version'
      : 'Not hidden on this platform';
  text.textContent = baseStatusText;
  bar.title = stealth.note;
}

/* ---------------------------------- chat ---------------------------------- */

async function send(withScreenshot) {
  if (busy) return;
  const text = inputEl.value.trim();
  if (!text && !withScreenshot) return;

  const prompt = text || 'What is on my screen?';
  sealHeard();
  conversation.push({ role: 'user', content: prompt });
  const askEl = addTurn('user', renderText(prompt), withScreenshot ? 'capturing screen\u2026' : null);
  if (withScreenshot) pendingShot = askEl;

  inputEl.value = '';
  autofilled = '';
  inputEl.classList.remove('autofilled');
  autoGrow();
  busy = true;

  const el = addTurn('ai', '<span class="caret"></span>');
  streaming = { el: el, text: '', raf: 0 };

  const res = await window.souffleur.send(conversation, Boolean(withScreenshot));

  if (streaming && streaming.raf) cancelAnimationFrame(streaming.raf);
  const final = streaming ? streaming.text : '';
  streaming = null;
  busy = false;

  if (res.ok) {
    el.innerHTML = renderText(final);
    conversation.push({ role: 'assistant', content: final });
  } else {
    el.remove();
    conversation.pop();
    if (!res.aborted) addTurn('error', esc(res.error || 'Request failed.'));
  }
  scrollDown();
  inputEl.focus();
}

let pendingShot = null;

/**
 * Show what was captured, not a promise that something was.
 *
 * A label saying "screen attached" is unfalsifiable: on two monitors it was
 * impossible to tell the wrong display had been sent until the answer made no
 * sense. The thumbnail makes a mistake visible immediately.
 */
window.souffleur.onShot((shot) => {
  const el = pendingShot;
  pendingShot = null;
  if (!el || !shot || !shot.thumb) return;

  const tag = el.querySelector('.shot-tag');
  if (tag) {
    tag.textContent = shot.displayCount > 1
      ? `screen sent \u00b7 ${shot.label} \u00b7 ${shot.displayCount} displays`
      : `screen sent \u00b7 ${shot.label}`;
  }

  const img = document.createElement('img');
  img.className = 'shot-thumb';
  img.src = shot.thumb;
  img.alt = 'what was captured';
  img.title = 'Click to enlarge';
  img.addEventListener('click', () => img.classList.toggle('big'));
  el.insertBefore(img, el.firstChild.nextSibling?.nextSibling || null);
  scrollDown();
});

window.souffleur.onDelta((d) => {
  if (!streaming) return;
  streaming.text += d;
  if (streaming.raf) return;
  streaming.raf = requestAnimationFrame(() => {
    if (!streaming) return;
    const stick = atBottom();
    streaming.el.innerHTML = renderText(streaming.text) + '<span class="caret"></span>';
    streaming.raf = 0;
    if (stick) scrollDown();
  });
});

function clearChat() {
  conversation = [];
  window.souffleur.abort();
  logEl.innerHTML =
    '<div class="empty" id="empty">Cleared. Ask anything, or press ' +
    '<kbd>Cmd</kbd>+<kbd>Shift</kbd>+<kbd>Enter</kbd> to ask about your screen.</div>';
}

/* -------------------------------- settings -------------------------------- */

let saveTimer = null;
function flashSaved(msg) {
  $('saved').textContent = msg || 'Saved';
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => { $('saved').textContent = ''; }, 1600);
}

async function patch(p) {
  settings = await window.souffleur.setSettings(p);
  flashSaved();
}

function paintProvider() {
  const p = settings.provider;
  const buttons = document.querySelectorAll('#segProvider button');
  for (const b of buttons) b.setAttribute('aria-pressed', String(b.dataset.p === p));

  $('rowBaseUrl').hidden = p !== 'custom';

  const preset = presets[p] || {};
  paintModels(modelCache[p] || preset.models || []);

  // Claude cannot take audio; say so where the key is chosen, not mid-call.
  const deaf = preset.hears === false
    ? ' Claude cannot hear audio, so listening to the call uses a Gemini or OpenAI key if you saved one, or the free key.'
    : '';

  $('apiKey').hidden = Boolean(preset.noKey);
  $('keyLabel').textContent = preset.noKey ? preset.label : 'API key';

  if (preset.noKey) {
    const install = ' <a href="' + esc(preset.keyUrl) + '" target="_blank" rel="noreferrer">Get Claude Code</a>';
    $('keyNote').innerHTML = keyState[p]
      ? 'Answers through Claude Code on this computer, signed in to your Claude account. No key needed.' + esc(deaf)
      : 'Claude Code is not set up on this computer yet. Install it, run <code>claude</code> once in a terminal to sign in, ' +
        'then press \u21bb next to Model.' + install;
    $('keyNote').className = keyState[p] ? 'note' : 'note warn';
  } else {
    const link = preset.keyUrl
      ? ' <a href="' + esc(preset.keyUrl) + '" target="_blank" rel="noreferrer">Get a key</a>'
      : '';
    const status = keyStatuses[p] || (keyState[p] ? 'ok' : 'none');
    const said = status === 'ok'
      ? 'A key is saved for this provider.'
      : status === 'unreadable'
        ? 'A saved key exists but can no longer be decrypted \u2014 the app was renamed. Paste it again.'
        : 'No key saved yet.';
    $('keyNote').innerHTML = said + esc(deaf) + link;
    $('keyNote').className = status === 'unreadable' ? 'note warn' : 'note';
  }

  $('apiKey').value = '';
  $('apiKey').placeholder = keyState[p] ? 'Replace saved key' : 'Paste your key';
  paintKeyRows();
}

/**
 * On the free key there is nothing to set up, so provider, key and model fold
 * away behind "Use my own key". A saved key of the user's own always wins, and
 * then the fields show as they always have.
 */
function paintKeyRows() {
  const usingFree = freeOn && !keyState[settings.provider];
  const fold = usingFree && !showOwnKey;
  $('rowFree').hidden = !usingFree;
  $('btnOwnKey').hidden = !fold;
  for (const id of ['rowProvider', 'rowKey', 'rowModel']) $(id).hidden = fold;
  $('rowBaseUrl').hidden = fold || settings.provider !== 'custom';
}

window.souffleur.onFreeKey((on) => {
  freeOn = Boolean(on);
  if (settings) paintKeyRows();
});

const MANUAL = '__manual__';

/**
 * Fill the model dropdown.
 *
 * The saved model is always included even when the fetched list does not
 * contain it, so opening settings can never silently switch the model out from
 * under you. The manual option stays for endpoints that expose no /models
 * route -- plenty of self-hosted OpenAI-compatible servers do not.
 */
function paintModels(list) {
  const sel = $('model');
  const current = settings.model || '';
  const opts = Array.from(new Set([...(list || []), current].filter(Boolean)));

  sel.innerHTML =
    opts.map((m) =>
      '<option value="' + esc(m) + '">' + esc(m) + '</option>').join('') +
    '<option value="' + MANUAL + '">Type a model name\u2026</option>';

  sel.value = current || opts[0] || MANUAL;
  $('modelManual').hidden = true;
}

/**
 * Replace the guessed model list with what this key can actually reach.
 * If the model currently selected is not in that list, switch to the newest
 * one rather than leaving the user on a name that 404s on the next message.
 */
async function refreshModels() {
  const note = $('modelNote');
  const preset = presets[settings.provider] || {};
  const label = preset.label || settings.provider;

  if (!keyState[settings.provider] && !preset.noKey) {
    note.className = 'note';
    note.textContent = 'Add a ' + label + ' key above to load its models.';
    return;
  }

  note.className = 'note';
  note.textContent = 'Loading models\u2026';

  const res = await window.souffleur.listModels();
  // For Claude Code, loading the list is the check that it is installed and
  // signed in, so its result is also what the key row reports.
  if (preset.noKey && Boolean(res.ok) !== Boolean(keyState[settings.provider])) {
    keyState[settings.provider] = Boolean(res.ok);
    paintProvider();
  }
  if (!res.ok) {
    note.className = 'note warn';
    note.textContent = res.error;
    return;
  }

  modelCache[settings.provider] = res.models;

  if (!res.models.includes(settings.model) && res.models.length) {
    await patch({ model: res.models[0] });
    paintModels(res.models);
    note.textContent =
      res.models.length + ' models available. Switched to ' + settings.model + '.';
  } else {
    paintModels(res.models);
    note.textContent = preset.noKey
      ? 'Claude Code is ready.'
      : res.models.length + ' models available to your key.';
  }
}

/** A key is saved, or the provider needs none (Claude Code checks itself). */
function canList() {
  return Boolean(keyState[settings.provider] || (presets[settings.provider] || {}).noKey);
}

function wireSettings() {
  $('btnModels').onclick = refreshModels;

  $('btnOwnKey').onclick = () => {
    showOwnKey = true;
    paintKeyRows();
    $('apiKey').focus();
  };

  $('btnSettings').onclick = () => {
    $('settings').hidden = false;
    if (canList() && !modelCache[settings.provider]) refreshModels();
  };
  const closeSettings = () => {
    $('settings').hidden = true;
    inputEl.focus();
  };
  $('btnCloseSettings').onclick = closeSettings;

  // Clicking Save blurs whatever field is focused first, so a value typed but
  // not yet committed is saved by its own change handler before we close.
  $('btnSave').onclick = () => {
    if (document.activeElement && document.activeElement.blur) document.activeElement.blur();
    flashSaved('Saved');
    closeSettings();
  };

  for (const b of document.querySelectorAll('#segProvider button')) {
    b.onclick = async () => {
      const preset = presets[b.dataset.p] || {};
      await patch({ provider: b.dataset.p, model: preset.defaultModel || '' });
      paintProvider();
      if (canList()) refreshModels();
    };
  }

  $('apiKey').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') { e.preventDefault(); e.target.blur(); }
  });

  $('apiKey').addEventListener('change', async (e) => {
    const key = e.target.value.trim();
    if (!key) return;
    keyState = await window.souffleur.setKey(settings.provider, key);
    keyStatuses[settings.provider] = 'ok';
    e.target.value = '';
    paintProvider();
    flashSaved('Key saved');
    await refreshModels();
  });

  $('model').addEventListener('change', async (e) => {
    if (e.target.value === MANUAL) {
      const manual = $('modelManual');
      manual.hidden = false;
      manual.value = settings.model || '';
      manual.focus();
      return;
    }
    await patch({ model: e.target.value });
  });

  $('modelManual').addEventListener('change', async (e) => {
    const v = e.target.value.trim();
    if (!v) return;
    await patch({ model: v });
    paintModels(modelCache[settings.provider] || []);
  });
  $('baseUrl').addEventListener('change', (e) => patch({ baseUrl: e.target.value.trim() }));
  $('system').addEventListener('change', (e) => patch({ system: e.target.value }));
}

/* --------------------------------- updates --------------------------------- */

let update = null;       // as the main process last reported it
let poppedFor = '';      // the version the popup was last shown for

/**
 * The same state painted twice: a strip above the chat that appears only when
 * there is something to install, and a row in settings that is always there.
 * Both buttons do the same thing.
 */
function paintUpdate(u) {
  update = u;
  const working = u.state === 'downloading' || u.state === 'installing';
  const progress = u.state === 'downloading'
    ? `Downloading ${u.version} \u00b7 ${u.percent}%`
    : 'Installing. Souffleur will reopen in a moment.';

  $('update').hidden = !(u.state === 'available' || working);
  $('updateText').textContent = working ? progress : u.message || `Version ${u.version} is available`;
  $('updateText').classList.toggle('warn', !working && Boolean(u.message));
  $('btnUpdate').disabled = working;
  $('btnUpdate').textContent = u.message && !working ? 'Try again' : 'Update now';

  $('versionText').textContent = `Souffleur ${u.current}`;
  const btn = $('btnVersion');
  btn.disabled = working || u.state === 'checking';
  btn.textContent = u.state === 'checking' ? 'Checking\u2026'
    : working || u.state === 'available' ? `Update now to ${u.version}`
    : 'Check for updates';

  const note = $('versionNote');
  note.className = u.message && !working ? 'note warn' : 'note';
  note.textContent = working ? progress
    : u.message ? u.message
    : u.state === 'current' ? 'You have the latest version.'
    : u.state === 'available' ? 'Downloads the new version, installs it and reopens Souffleur.'
    : '';

  maybePopUpdate();
}

/**
 * Ask once for each release found, so the strip above the chat is not the only
 * sign of it. Held back while listening: a card over the chat in the middle of
 * a call is the wrong moment. It shows when listening stops instead.
 */
function maybePopUpdate() {
  const pop = $('updatePop');
  if (!update || update.state !== 'available' || update.message) {
    pop.hidden = true;
    return;
  }
  if (listening || poppedFor === update.version) return;

  poppedFor = update.version;
  $('updatePopTitle').textContent = `Souffleur ${update.version} is available`;
  $('updatePopNote').textContent =
    `You have ${update.current}. Update now downloads it, installs it and reopens Souffleur.`;
  pop.hidden = false;
  $('btnUpdatePop').focus();
}

function wireUpdate() {
  window.souffleur.onUpdate(paintUpdate);
  $('btnUpdate').onclick = () => window.souffleur.installUpdate();
  $('btnUpdatePop').onclick = () => {
    $('updatePop').hidden = true;
    window.souffleur.installUpdate();
  };
  $('btnUpdateLater').onclick = () => { $('updatePop').hidden = true; };
  $('btnVersion').onclick = () => (update && update.state === 'available'
    ? window.souffleur.installUpdate()
    : window.souffleur.checkUpdate());
}

/* --------------------------- persona documents ---------------------------- */

let docs = [];
let maxDocs = 4;

function paintDocs(suggestedName) {
  const list = $('docList');
  list.innerHTML = docs.map((d) => `
    <div class="doc" data-id="${esc(d.id)}">
      <span class="doc-name" title="${esc(d.name)}">${esc(d.name)}</span>
      <span class="doc-meta">${d.pages}p &middot; ${Math.round((d.chars || 0) / 1000)}k</span>
      <button title="Remove" data-remove="${esc(d.id)}">&times;</button>
    </div>`).join('');

  for (const b of list.querySelectorAll('[data-remove]')) {
    b.onclick = async () => {
      const res = await window.souffleur.removeDoc(b.dataset.remove);
      docs = res.docs || [];
      paintDocs();
    };
  }

  const full = docs.length >= maxDocs;
  $('btnAddDoc').disabled = full;
  $('btnAddDoc').textContent = full ? `${maxDocs} of ${maxDocs} added` : 'Add PDF';

  const note = $('docNote');
  if (!note.classList.contains('warn')) {
    note.textContent = docs.length
      ? `${docs.length} of ${maxDocs}. Your CV first, then a write-up for each project.`
      : `Up to ${maxDocs} PDFs. Interview mode answers questions about you from these, so add your CV first.`;
  }
  if (suggestedName && !$('personaName').value) $('personaName').placeholder = suggestedName;
}

function paintInterview() {
  const on = Boolean(settings.interviewMode);
  $('btnInterview').setAttribute('aria-pressed', String(on));
  $('rowPersonaName').hidden = !on;
}

function wirePersona() {
  $('btnInterview').onclick = async () => {
    await patch({ interviewMode: !settings.interviewMode });
    paintInterview();
    const note = $('docNote');
    if (settings.interviewMode && !docs.length) {
      note.className = 'note warn';
      note.textContent = 'Add at least one PDF, or interview mode has no history to answer from.';
    } else {
      note.className = 'note';
      paintDocs();
    }
  };

  $('personaName').addEventListener('change', (e) => patch({ personaName: e.target.value.trim() }));

  $('btnAddDoc').onclick = async () => {
    const note = $('docNote');
    note.className = 'note';
    note.textContent = 'Reading\u2026';
    const had = docs.length;
    const res = await window.souffleur.addDocs();
    docs = res.docs || docs;
    if (res.error) {
      note.className = 'note warn';
      note.textContent = res.error;
    } else {
      note.className = 'note';
    }
    // Adding the first document is the decision to be answered from it, so it
    // should not also need a second switch that is easy to miss.
    if (!had && docs.length && !settings.interviewMode) {
      await patch({ interviewMode: true });
      paintInterview();
    }
    paintDocs(res.suggestedName);
  };
}

/**
 * One editable field per action.
 *
 * Every one of these is a GLOBAL accelerator: the OS hands the combination to
 * Souffleur before any other app sees it. A bare Shift+letter therefore takes
 * that capital letter away from the whole machine, so the field says which
 * bindings do that and which the OS refused outright.
 */
async function paintHotkey() {
  const st = await window.souffleur.hotkeyStatus();
  const list = $('keyList');
  const wanted = st.wanted || {};

  list.innerHTML = Object.entries(st.actions || {}).map(([key, label]) => `
    <div class="key-row">
      <span>${esc(label)}</span>
      <input type="text" data-action="${esc(key)}" spellcheck="false"
             value="${esc(wanted[key] || '')}" placeholder="none">
    </div>`).join('');

  for (const input of list.querySelectorAll('input[data-action]')) {
    input.addEventListener('change', async (e) => {
      const next = { ...wanted, [e.target.dataset.action]: e.target.value.trim() };
      await patch({ shortcuts: next });
      paintHotkey();
    });
    // Refused by the OS, usually because another app already owns it.
    const action = input.dataset.action;
    if (wanted[action] && !(st.bound || {})[action]) input.classList.add('bad');
  }

  const bare = Object.values(wanted).filter((v) => /^shift\+\S+$/i.test(v || ''));
  const note = $('hotkeyNote');
  const refused = Object.keys(wanted).filter((k) => wanted[k] && !(st.bound || {})[k]);

  if (refused.length) {
    note.className = 'note warn';
    note.textContent = 'Marked shortcuts were refused - another app already owns them.';
  } else if (bare.length) {
    note.className = 'note warn';
    note.textContent =
      `${bare.length} shortcut${bare.length > 1 ? 's use' : ' uses'} Shift and one key. ` +
      'These work everywhere, so those keys stop reaching other apps while Souffleur runs. ' +
      'Add Alt to any that get in the way.';
  } else {
    note.className = 'note';
    note.textContent = 'Global shortcuts. They work even when Souffleur is hidden.';
  }
}

/* -------------------------------- listening ------------------------------- */

let listening = false;
let autofilled = '';   // exact text we last placed in the composer ourselves

/**
 * Drop what was just said into the composer so it can be sent with one Enter.
 *
 * Never overwrites your own typing: the box is only touched while it is empty
 * or still holds exactly what we put there. Consecutive lines from the same
 * speaker accumulate, because a question is often split across two utterances
 * ("so, quick one --" / "how would you handle this?") and replacing would throw
 * the first half away.
 */
function fillComposer(text) {
  if (inputEl.value && inputEl.value !== autofilled) return;
  autofilled = autofilled ? `${autofilled} ${text}` : text;
  inputEl.value = autofilled;
  inputEl.classList.add('autofilled');
  autoGrow();
}

/**
 * Heard speech is rendered as its own kind of turn, not as a chat message.
 * Consecutive lines merge into the running block so a long stretch of talking
 * reads as a paragraph rather than a stack of fragments.
 */
function addHeard(entry) {
  const who = entry.who || 'them';
  const text = entry.text || '';
  const last = logEl.lastElementChild;

  // Merge only within one speaker: two people running together in a single
  // block would read as one person saying both halves.
  if (last && last.classList.contains('heard')
      && last.dataset.who === who && !last.dataset.sealed) {
    last.textContent = last.textContent + ' ' + text;
  } else {
    const el = addTurn('heard', esc(text));
    el.dataset.who = who;
    if (who === 'you') el.classList.add('mine');
  }
  scrollDown();
}

/** Stop merging into the current heard block, so the next line starts fresh. */
function sealHeard() {
  const last = logEl.lastElementChild;
  if (last && last.classList.contains('heard')) last.dataset.sealed = '1';
}

/**
 * Windows capture, done in the renderer.
 *
 * Chromium can hand us the system audio mix on Windows, which macOS cannot do
 * without a native helper. The samples are converted to the same s16le mono
 * 16 kHz the helper produces, so the main process runs one pipeline regardless
 * of where the audio came from.
 */
let rendererCapture = null;

async function startRendererCapture() {
  const stream = await navigator.mediaDevices.getDisplayMedia({ video: true, audio: true });

  // Only the audio is wanted; the video track exists because getDisplayMedia
  // requires it, and leaving it running costs a screen capture for nothing.
  stream.getVideoTracks().forEach((t) => t.stop());

  const tracks = stream.getAudioTracks();
  if (!tracks.length) {
    stream.getTracks().forEach((t) => t.stop());
    throw new Error('Windows returned no system audio. Check that sound is playing through the default output device.');
  }

  const ctx = new AudioContext({ sampleRate: 16000 });
  const src = ctx.createMediaStreamSource(new MediaStream(tracks));
  const node = ctx.createScriptProcessor(4096, 1, 1);

  // A silent sink. ScriptProcessor only runs while connected to the graph, but
  // routing it to the speakers would play the call back into the room.
  const mute = ctx.createGain();
  mute.gain.value = 0;

  node.onaudioprocess = (e) => {
    const f = e.inputBuffer.getChannelData(0);
    const pcm = new Int16Array(f.length);
    for (let i = 0; i < f.length; i++) {
      const v = Math.max(-1, Math.min(1, f[i]));
      pcm[i] = v * 32767;
    }
    window.souffleur.sendPcm(pcm.buffer);
  };

  src.connect(node);
  node.connect(mute);
  mute.connect(ctx.destination);

  rendererCapture = () => {
    node.onaudioprocess = null;
    node.disconnect(); src.disconnect(); mute.disconnect();
    ctx.close().catch(() => {});
    stream.getTracks().forEach((t) => t.stop());
    rendererCapture = null;
  };
}

async function setListening(on) {
  if (!on && rendererCapture) rendererCapture();

  const res = on ? await window.souffleur.startListening() : await window.souffleur.stopListening();

  // The main process says when it wants the renderer to do the capturing.
  if (on && res && res.ok !== false && res.mode === 'renderer') {
    try {
      await startRendererCapture();
    } catch (err) {
      await window.souffleur.stopListening();
      addTurn('error', esc(err.message || 'Could not capture system audio.'));
      paintListening(false);
      return false;
    }
  }
  if (res && res.ok === false) {
    addTurn('error', esc(res.error));
    paintListening(false);
    return false;
  }
  paintListening(on);
  return on;
}

function paintListening(on) {
  listening = Boolean(on);
  $('btnListen').setAttribute('aria-pressed', String(listening));
  $('status').classList.toggle('listening', listening);
  $('statusText').textContent = listening
    ? 'Listening to the call \u2014 hidden from screen share'
    : baseStatusText;
  maybePopUpdate();
}

/** Answer the most recent thing that was said, without typing it out. */
async function answerLast() {
  const heard = await window.souffleur.lastHeard();
  if (!heard) {
    addTurn('error', 'Nothing heard yet. Press Shift+Z to start listening.');
    return;
  }
  sealHeard();
  autofilled = '';
  inputEl.value = heard;
  send(false);
}

window.souffleur.onTranscript((entry) => {
  addHeard(entry);
  if ((entry.who || 'them') !== 'you') fillComposer(entry.text || '');
});
window.souffleur.onListenHint((m) => {
  // Only say it once; a repeating hint is noise.
  if (logEl.dataset.hint === m) return;
  logEl.dataset.hint = m;
  addTurn('error', esc(m));
});
window.souffleur.onListenState((v) => paintListening(v));
window.souffleur.onListenError((m) => addTurn('error', esc(m)));
window.souffleur.onToggleListen(() => setListening(!listening));
window.souffleur.onAnswerLast(() => answerLast());

/* --------------------------------- input ---------------------------------- */

function autoGrow() {
  inputEl.style.height = 'auto';
  inputEl.style.height = Math.min(inputEl.scrollHeight, 108) + 'px';
}

function wireInput() {
  inputEl.addEventListener('input', () => {
    if (inputEl.value !== autofilled) {
      autofilled = '';
      inputEl.classList.remove('autofilled');
    }
    autoGrow();
  });

  inputEl.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      send(e.metaKey || e.ctrlKey);
    }
  });

  document.addEventListener('keydown', (e) => {
    if (e.key !== 'Escape') return;
    if (!$('updatePop').hidden) {
      $('updatePop').hidden = true;     // same as Later
    } else if (!$('settings').hidden) {
      $('settings').hidden = true;
      inputEl.focus();
    } else if (busy) {
      window.souffleur.abort();
    } else {
      window.souffleur.hide();
    }
  });

  $('btnListen').onclick = () => setListening(!listening);
  $('btnShot').onclick = () => send(true);
  $('btnHide').onclick = () => window.souffleur.hide();
}

window.souffleur.onAskWithScreenshot(() => send(true));
window.souffleur.onClear(clearChat);
/* ---------------------------------- boot ---------------------------------- */

(async function boot() {
  const b = await window.souffleur.bootstrap();
  settings = b.settings;
  presets = b.presets;
  keyState = b.keys;
  keyStatuses = b.keyStatuses || {};
  freeOn = Boolean(b.freeKey);

  paintStatus(b.stealth);

  $('baseUrl').value = settings.baseUrl || '';
  $('system').value = settings.system || '';
  paintProvider();

  if (!b.keyStorage.encrypted) {
    const n = document.createElement('div');
    n.className = 'note warn';
    n.textContent = b.keyStorage.note;
    $('keyNote').after(n);
  }

  // Grey out what this platform cannot do, with the reason on the control.
  const caps = b.capabilities || { audio: true, pdf: true };
  if (!caps.audio) {
    const btn = $('btnListen');
    btn.disabled = true;
    btn.title = 'Hearing the call is macOS-only for now';
    btn.style.opacity = '0.35';
  }
  if (!caps.pdf) {
    const add = $('btnAddDoc');
    add.disabled = true;
    add.textContent = 'Reading PDFs is macOS-only for now';
    $('btnInterview').disabled = true;
    $('btnInterview').style.opacity = '0.35';
  }

  docs = b.docs || [];
  maxDocs = b.maxDocs || 4;
  $('personaName').value = settings.personaName || '';
  paintInterview();
  paintDocs(b.suggestedName);

  wireSettings();
  wirePersona();
  wireInput();
  wireUpdate();
  autoGrow();

  paintHotkey();

  const ls = await window.souffleur.listenState();
  for (const line of ls.lines || []) addHeard(line);   // {who, text}
  paintListening(ls.running);
  // After listening is known, so a reload mid-call does not pop the update card.
  paintUpdate(b.update);

  // No key anywhere yet: open settings rather than failing on the first send.
  // With the free key on there is nothing to add, so go straight to the chat.
  // Claude Code being installed counts only once it is the chosen provider.
  const ready = Object.entries(keyState)
    .some(([p, on]) => on && (p !== 'claude-code' || settings.provider === p));
  if (!ready && !freeOn) {
    $('settings').hidden = false;
  } else {
    inputEl.focus();
    if (canList()) refreshModels();  // fill the dropdown up front
  }
})();
