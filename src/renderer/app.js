'use strict';

const $ = (id) => document.getElementById(id);
const logEl = $('log');
const inputEl = $('input');

let settings = null;
let presets = null;
let keyState = {};
let keyStatuses = {};
let modelCache = {};     // provider -> models actually reachable with that key
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
  addTurn('user', renderText(prompt), withScreenshot ? 'screen attached' : null);

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

  const link = preset.keyUrl
    ? ' <a href="' + esc(preset.keyUrl) + '" target="_blank" rel="noreferrer">Get a key</a>'
    : '';
  const status = keyStatuses[p] || (keyState[p] ? 'ok' : 'none');
  const said = status === 'ok'
    ? 'A key is saved for this provider.'
    : status === 'unreadable'
      ? 'A saved key exists but can no longer be decrypted \u2014 the app was renamed. Paste it again.'
      : 'No key saved yet.';
  $('keyNote').innerHTML = said + link;
  $('keyNote').className = status === 'unreadable' ? 'note warn' : 'note';

  $('apiKey').value = '';
  $('apiKey').placeholder = keyState[p] ? 'Replace saved key' : 'Paste your key';
}

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
  const label = (presets[settings.provider] || {}).label || settings.provider;

  if (!keyState[settings.provider]) {
    note.className = 'note';
    note.textContent = 'Add a ' + label + ' key above to load its models.';
    return;
  }

  note.className = 'note';
  note.textContent = 'Loading models\u2026';

  const res = await window.souffleur.listModels();
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
    note.textContent = res.models.length + ' models available to your key.';
  }
}

function wireSettings() {
  $('btnModels').onclick = refreshModels;

  $('btnSettings').onclick = () => {
    $('settings').hidden = false;
    if (keyState[settings.provider] && !modelCache[settings.provider]) refreshModels();
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
      if (keyState[settings.provider]) refreshModels();
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
      ? `${docs.length} of ${maxDocs}. Your CV, portfolio and anything describing your work.`
      : `Up to ${maxDocs} PDFs. Interview mode answers from these, so add your CV first.`;
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
    const res = await window.souffleur.addDocs();
    docs = res.docs || docs;
    if (res.error) {
      note.className = 'note warn';
      note.textContent = res.error;
    } else {
      note.className = 'note';
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

async function setListening(on) {
  const res = on ? await window.souffleur.startListening() : await window.souffleur.stopListening();
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
    if (!$('settings').hidden) {
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

  docs = b.docs || [];
  maxDocs = b.maxDocs || 4;
  $('personaName').value = settings.personaName || '';
  paintInterview();
  paintDocs(b.suggestedName);

  wireSettings();
  wirePersona();
  wireInput();
  autoGrow();

  paintHotkey();

  const ls = await window.souffleur.listenState();
  for (const line of ls.lines || []) addHeard(line);   // {who, text}
  paintListening(ls.running);

  // No key anywhere yet: open settings rather than failing on the first send.
  if (!Object.values(keyState).some(Boolean)) {
    $('settings').hidden = false;
  } else {
    inputEl.focus();
    if (keyState[settings.provider]) refreshModels();  // fill the dropdown up front
  }
})();
