'use strict';

/**
 * Provider layer. Three shapes, one interface:
 *
 *   gemini  -> generativelanguage.googleapis.com
 *   openai  -> api.openai.com
 *   custom  -> any OpenAI-compatible base URL (Groq, Together, OpenRouter,
 *              Ollama, LM Studio, vLLM, Azure ...)
 *
 * Every provider streams, and every one takes an optional screenshot.
 * A user's own key never leaves this machine except to the provider they
 * picked. Without one, Gemini calls can go to the free key's server instead
 * (see freekey.js), which adds the owner's key there.
 */

const { FREE_URL } = require('./freekey');

// Set SOUFFLEUR_DEBUG=1 to log response shapes (never keys) to the Electron console.
const DEBUG = process.env.SOUFFLEUR_DEBUG === '1';
function dbg(...a) { if (DEBUG) console.log('[souffleur]', ...a); }

/**
 * Fallback names only. Hardcoded model lists rot -- Google retired
 * gemini-2.5-flash for new keys and this app broke with a raw 404. The real
 * list comes from listModels() against the user's own key; these are just what
 * we try before that call returns.
 */
const PRESETS = {
  gemini: {
    label: 'Google Gemini',
    defaultModel: 'gemini-3.1-flash-lite',
    models: ['gemini-3.5-flash', 'gemini-flash-latest', 'gemini-pro-latest'],
    keyUrl: 'https://aistudio.google.com/apikey',
    vision: true,
  },
  openai: {
    label: 'OpenAI',
    defaultModel: 'gpt-4.1',
    models: ['gpt-4.1', 'gpt-4.1-mini', 'gpt-4o'],
    keyUrl: 'https://platform.openai.com/api-keys',
    vision: true,
  },
  custom: {
    label: 'OpenAI-compatible',
    defaultModel: '',
    models: [],
    keyUrl: '',
    vision: true,
    needsBaseUrl: true,
  },
};

/**
 * Iterate `data:` payloads out of an SSE response body.
 *
 * Two things here are load-bearing and were previously wrong:
 *
 * 1. Events are separated by a BLANK LINE, which is "\r\n\r\n" as often as
 *    "\n\n". Splitting on the literal "\n\n" matches nothing in a CRLF stream
 *    -- "\r\n\r\n" contains no two consecutive newlines -- so the buffer grew
 *    forever and not one event was ever emitted. That produced a successful
 *    HTTP request with no output at all.
 *
 * 2. A stream can end without a trailing blank line. The final event lives in
 *    the leftover buffer and has to be flushed, or the last chunk is dropped.
 */
async function* sseEvents(res) {
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  const SEPARATOR = /\r?\n\r?\n/;
  let buf = '';

  function* emit(block) {
    for (const line of block.split(/\r?\n/)) {
      const t = line.trim();
      if (!t.startsWith('data:')) continue;
      const payload = t.slice(5).trim();
      if (payload && payload !== '[DONE]') yield payload;
    }
  }

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });

      const parts = buf.split(SEPARATOR);
      buf = parts.pop();           // keep the trailing partial event
      for (const part of parts) yield* emit(part);
    }
    buf += decoder.decode();       // flush any multi-byte remainder
    if (buf.trim()) yield* emit(buf);
  } finally {
    reader.cancel().catch(() => {});
  }
}

const FREE = 'Free key';

async function failLoudly(res, provider) {
  let detail = '';
  let code = '';
  try {
    const body = await res.text();
    try {
      const j = JSON.parse(body);
      detail = j?.error?.message || j?.error?.status || body.slice(0, 300);
      code = typeof j?.error?.code === 'string' ? j.error.code : '';
    } catch { detail = body.slice(0, 300); }
  } catch { /* body already consumed or empty */ }

  // The free key's server writes its messages for the user, so they are shown
  // as they are, and the code tells the caller whether to stop using it.
  if (provider === FREE) {
    const err = new Error(detail || `${FREE}: HTTP ${res.status}`);
    err.code = code;
    throw err;
  }

  if (res.status === 401 || res.status === 403) {
    throw new Error(`${provider}: key rejected (${res.status}). ${detail}`);
  }
  if (res.status === 429) {
    throw new Error(`${provider}: rate limited or out of quota (429). ${detail}`);
  }
  throw new Error(`${provider}: HTTP ${res.status}. ${detail}`);
}

/* ------------------------------- OpenAI-shaped ------------------------------ */

function openaiBody({ model, messages, image, system }) {
  const msgs = [];
  if (system) msgs.push({ role: 'system', content: system });

  for (const m of messages) msgs.push({ role: m.role, content: m.content });

  if (image) {
    // Attach the screenshot to the final user turn.
    const last = msgs[msgs.length - 1];
    const text = typeof last?.content === 'string' ? last.content : '';
    msgs[msgs.length - 1] = {
      role: 'user',
      content: [
        { type: 'text', text: text || 'What is on my screen?' },
        { type: 'image_url', image_url: { url: image, detail: 'high' } },
      ],
    };
  }
  return { model, messages: msgs, stream: true };
}

async function* streamOpenAI({ apiKey, model, baseUrl, messages, image, system, signal }, label) {
  const root = (baseUrl || 'https://api.openai.com/v1').replace(/\/+$/, '');
  const res = await fetch(`${root}/chat/completions`, {
    method: 'POST',
    signal,
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify(openaiBody({ model, messages, image, system })),
  });
  if (!res.ok) await failLoudly(res, label);

  for await (const payload of sseEvents(res)) {
    let j;
    try { j = JSON.parse(payload); } catch { continue; }
    const delta = j?.choices?.[0]?.delta?.content;
    if (delta) yield delta;
  }
}

/* --------------------------------- Gemini ---------------------------------- */

/**
 * Where a Gemini call goes. With the user's own key, straight to Google. On
 * the free key, to our server, which chooses the model and adds the key; the
 * request body is the same either way, so is the reply.
 */
function geminiTarget({ apiKey, model, free }, method) {
  if (free) {
    return {
      url: `${FREE_URL}?kind=${method === 'generateContent' ? 'transcribe' : 'chat'}`,
      headers: { 'Content-Type': 'application/json', 'x-souffleur-install': free.installId },
      label: FREE,
    };
  }
  return {
    url: `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}` +
         `:${method}${method === 'streamGenerateContent' ? '?alt=sse' : ''}`,
    headers: { 'Content-Type': 'application/json', 'x-goog-api-key': apiKey },
    label: null,
  };
}

async function* streamGemini({ apiKey, model, messages, image, system, signal, free }) {
  const contents = messages.map((m) => ({
    role: m.role === 'assistant' ? 'model' : 'user',
    parts: [{ text: m.content }],
  }));

  if (image) {
    const base64 = image.replace(/^data:image\/\w+;base64,/, '');
    contents[contents.length - 1].parts.push({
      inline_data: { mime_type: 'image/png', data: base64 },
    });
  }

  const body = { contents };
  if (system) body.systemInstruction = { parts: [{ text: system }] };

  const target = geminiTarget({ apiKey, model, free }, 'streamGenerateContent');
  const res = await fetch(target.url, {
    method: 'POST',
    signal,
    headers: target.headers,
    body: JSON.stringify(body),
  });
  if (!res.ok) await failLoudly(res, target.label || 'Gemini');

  const ctype = res.headers.get('content-type') || '';
  dbg('gemini content-type:', ctype, 'model:', model);

  let sawText = false;
  let lastMeta = null;

  /**
   * Pull text out of one GenerateContentResponse chunk.
   *
   * Thinking models emit reasoning parts flagged `thought: true` alongside the
   * answer. Those are not the answer, so they are skipped -- but they still
   * count as a live response, which matters for the empty-result diagnosis.
   */
  function* textFrom(j) {
    lastMeta = j;
    const parts = j?.candidates?.[0]?.content?.parts;
    if (!Array.isArray(parts)) return;
    for (const p of parts) {
      if (p.thought === true) continue;
      if (typeof p.text === 'string' && p.text) { sawText = true; yield p.text; }
    }
  }

  if (ctype.includes('text/event-stream')) {
    let seen = 0;
    for await (const payload of sseEvents(res)) {
      seen += 1;
      if (seen <= 4) dbg('sse payload', seen + ':', payload.slice(0, 500));
      let j;
      try { j = JSON.parse(payload); } catch { dbg('unparsed SSE payload:', payload.slice(0, 200)); continue; }
      yield* textFrom(j);
    }
    dbg('sse payloads total:', seen, 'sawText:', sawText);
  } else {
    // Some models/endpoints ignore alt=sse and return a plain JSON array of
    // chunks. Reading that as SSE finds no `data:` lines and yields nothing,
    // which is what "Model returned an empty response" was.
    const raw = await res.text();
    dbg('gemini non-SSE body:', raw.slice(0, 600));
    let parsed;
    try {
      parsed = JSON.parse(raw);
    } catch {
      throw new Error(`Gemini: unreadable ${ctype || 'response'}: ${raw.slice(0, 200)}`);
    }
    for (const j of Array.isArray(parsed) ? parsed : [parsed]) yield* textFrom(j);
  }

  if (!sawText) throw new Error(emptyReason(lastMeta, free ? null : model));
}

/** Turn a text-free Gemini response into something actionable. */
function emptyReason(meta, model) {
  const cand = meta?.candidates?.[0];
  const finish = cand?.finishReason;
  const block = meta?.promptFeedback?.blockReason;

  if (block) return `Gemini blocked the prompt (${block}).`;
  if (finish === 'MAX_TOKENS') {
    return 'Gemini hit its output limit before producing text. Try a shorter question.';
  }
  if (finish === 'SAFETY' || finish === 'PROHIBITED_CONTENT') {
    return `Gemini stopped on a safety filter (${finish}).`;
  }
  if (cand && !cand.content) {
    return `Gemini returned a candidate with no content (finishReason: ${finish || 'unset'}).`;
  }
  // The free key's model is chosen on the server, so there is nothing to pick.
  if (!model) return 'Gemini returned no text. Try again.';
  return `Gemini returned no text for model "${model}". Open settings and press the refresh button to pick a model your key supports.`;
}

/* ------------------------------- transcription ------------------------------ */

const TRANSCRIBE_PROMPT =
  'Transcribe the speech in this audio verbatim. Return only the transcript text, ' +
  'with no preamble, quotation marks, speaker labels, or commentary. ' +
  'If there is no intelligible speech, return nothing at all.';

/**
 * Turn one WAV utterance into text.
 *
 * Deliberately non-streaming: these are short clips and the caller wants a
 * whole line to append to the transcript, not a trickle of tokens.
 */
async function transcribe({ provider, apiKey, model, baseUrl, wav, signal, free }) {
  if (!apiKey && !free) throw new Error('no API key');

  if (provider === 'gemini' || free) {
    const target = geminiTarget({ apiKey, model, free }, 'generateContent');
    const res = await fetch(target.url, {
      method: 'POST',
      signal,
      headers: target.headers,
      body: JSON.stringify({
        contents: [{
          role: 'user',
          parts: [
            { text: TRANSCRIBE_PROMPT },
            { inline_data: { mime_type: 'audio/wav', data: wav.toString('base64') } },
          ],
        }],
        generationConfig: { temperature: 0 },
      }),
    });
    if (!res.ok) await failLoudly(res, target.label || 'Gemini transcription');
    const j = await res.json();
    const parts = j?.candidates?.[0]?.content?.parts || [];
    return parts.filter((p) => p.thought !== true).map((p) => p.text || '').join('').trim();
  }

  // OpenAI-shaped: multipart upload to the audio endpoint.
  const root = (baseUrl || 'https://api.openai.com/v1').replace(/\/+$/, '');
  const form = new FormData();
  form.append('file', new Blob([wav], { type: 'audio/wav' }), 'audio.wav');
  form.append('model', model);
  form.append('response_format', 'text');

  const res = await fetch(`${root}/audio/transcriptions`, {
    method: 'POST',
    signal,
    headers: { Authorization: `Bearer ${apiKey}` },
    body: form,
  });
  if (!res.ok) await failLoudly(res, 'Transcription');
  return (await res.text()).trim();
}

/** Sensible transcription model when the user has not picked one. */
function defaultTranscribeModel(provider, available) {
  const list = available || [];
  if (provider === 'gemini') {
    return list.find((m) => /transcribe/i.test(m))
        || list.find((m) => /flash/i.test(m))
        || 'gemini-flash-latest';
  }
  return list.find((m) => /transcribe/i.test(m)) || 'whisper-1';
}

/* ------------------------------- model listing ------------------------------ */

/**
 * Ask the provider which models this key can actually use.
 *
 * Worth the extra call: a hardcoded list is wrong the moment a provider retires
 * a name, and the failure lands on the user as an opaque 404 mid-conversation.
 * Newest-looking names are sorted first so the default pick stays current.
 */
async function listModels({ provider, apiKey, baseUrl, signal }) {
  if (!apiKey) throw new Error('Set an API key first.');

  if (provider === 'gemini') {
    const res = await fetch(
      'https://generativelanguage.googleapis.com/v1beta/models?pageSize=200',
      { headers: { 'x-goog-api-key': apiKey }, signal }
    );
    if (!res.ok) await failLoudly(res, 'Gemini');
    const j = await res.json();
    return (j.models || [])
      .filter((m) => (m.supportedGenerationMethods || []).some(
        (x) => x === 'generateContent' || x === 'streamGenerateContent'))
      .map((m) => String(m.name).replace(/^models\//, ''))
      .filter(isChatModel)
      .sort(byFreshness);
  }

  const root = (baseUrl || 'https://api.openai.com/v1').replace(/\/+$/, '');
  const res = await fetch(`${root}/models`, {
    headers: { Authorization: `Bearer ${apiKey}` },
    signal,
  });
  if (!res.ok) await failLoudly(res, provider === 'openai' ? 'OpenAI' : 'Custom endpoint');
  const j = await res.json();
  const ids = (Array.isArray(j.data) ? j.data : j.models || []).map((m) => m.id || m.name);
  return ids.filter(Boolean).filter(isChatModel).sort(byFreshness);
}

/**
 * Keep only models that can answer a chat message.
 *
 * Provider catalogues are mixed bags: a Gemini key also lists music (lyria),
 * image generation (nano-banana, *-image), speech, robotics and embeddings.
 * Offering those in a model picker just produces confusing failures.
 */
const NOT_CHAT = new RegExp([
  'embedding', 'embed', 'aqa', 'imagen', 'veo', 'lyria', 'nano-banana',
  'image', 'tts', 'transcribe', 'whisper', 'audio', 'realtime', 'robotics',
  'computer-use', 'dall-e', 'moderation', 'babbage', 'davinci', 'rerank',
  'guard', 'similarity', 'edit',
  // Deep-research models run a long-lived job rather than a chat completion,
  // so they do not work through streamGenerateContent. Excluded on purpose --
  // an earlier 'search-' pattern was catching them by accident via "research".
  'deep-research',
].join('|'), 'i');

function isChatModel(name) {
  return !NOT_CHAT.test(String(name));
}

/** Higher version numbers first, then alphabetical. */
function byFreshness(a, b) {
  const ver = (s) => {
    const m = String(s).match(/(\d+)(?:[.-](\d+))?/);
    return m ? Number(m[1]) * 1000 + Number(m[2] || 0) : 0;
  };
  return ver(b) - ver(a) || String(a).localeCompare(String(b));
}

/* --------------------------------- Facade ---------------------------------- */

function streamChat(opts) {
  const { provider } = opts;
  if (provider === 'gemini' || opts.free) return streamGemini(opts);
  if (provider === 'openai') return streamOpenAI(opts, 'OpenAI');
  if (provider === 'custom') {
    if (!opts.baseUrl) throw new Error('Custom provider needs a base URL.');
    return streamOpenAI(opts, 'Custom endpoint');
  }
  throw new Error(`Unknown provider: ${provider}`);
}

module.exports = { streamChat, listModels, transcribe, defaultTranscribeModel, PRESETS };
