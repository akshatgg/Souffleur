'use strict';

/**
 * Claude on the user's own Anthropic API key, through the official SDK.
 *
 * Same contract as every other provider: streamClaude() yields text deltas,
 * listClaudeModels() returns the model ids this key can use. Claude cannot take
 * audio, so there is no transcription here; main.js hears the call through
 * another key instead.
 */

const { Anthropic } = require('@anthropic-ai/sdk');

const DEFAULT_MODEL = 'claude-opus-5-5';
const MAX_OUTPUT = 64000;

// Output caps as the Models API reports them, so an older model with a smaller
// cap is not sent a max_tokens it rejects.
const outputCap = new Map();

// The answer is read mid-call, so it should start quickly: low effort keeps
// thinking short. Older models reject the field, so it goes only where it works.
const TAKES_EFFORT = /^claude-(fable-5|mythos-5|opus-5|sonnet-5|opus-4-[5-8]|sonnet-4-6)/;

// These can decline a request on a safety classifier. With fallbacks on, the API
// reruns a declined request on another model instead of returning nothing.
const TAKES_FALLBACK = /^claude-(fable-5-1|opus-5-5|opus-5|sonnet-5-5)$/;
const FALLBACK_BETA = 'server-side-fallback-2026-07-01';

function client(apiKey) {
  return new Anthropic({ apiKey, maxRetries: 1 });
}

/** A screenshot data URL as a Claude image block. */
function imageBlock(dataUrl) {
  const m = /^data:(image\/[\w.+-]+);base64,(.*)$/s.exec(dataUrl);
  return {
    type: 'image',
    source: { type: 'base64', media_type: m ? m[1] : 'image/png', data: m ? m[2] : dataUrl },
  };
}

/**
 * The conversation in Claude's shape. Empty turns are dropped -- an answer that
 * was stopped before any text arrived would be rejected as an empty block --
 * and the screenshot goes in front of the question it belongs to.
 */
function toClaudeMessages(messages, image) {
  const out = (messages || [])
    .filter((m) => typeof m.content === 'string' && m.content.trim())
    .map((m) => ({ role: m.role === 'assistant' ? 'assistant' : 'user', content: m.content }));

  if (image) {
    const last = out[out.length - 1];
    const text = last?.role === 'user' ? last.content : 'What is on my screen?';
    const turn = { role: 'user', content: [imageBlock(image), { type: 'text', text }] };
    if (last?.role === 'user') out[out.length - 1] = turn;
    else out.push(turn);
  }
  return out;
}

function abortError() {
  const err = new Error('aborted');
  err.name = 'AbortError';
  return err;
}

/** Turn an SDK error into the one-line message the chat shows. */
function explain(err, signal) {
  if (signal?.aborted || err instanceof Anthropic.APIUserAbortError) return abortError();
  if (!(err instanceof Anthropic.APIError)) return err;

  const detail = err.error?.error?.message || err.message;
  if (err instanceof Anthropic.AuthenticationError || err instanceof Anthropic.PermissionDeniedError) {
    return new Error(`Claude: key rejected (${err.status}). ${detail}`);
  }
  if (err instanceof Anthropic.RateLimitError) {
    return new Error(`Claude: rate limited or out of quota (429). ${detail}`);
  }
  if (err instanceof Anthropic.NotFoundError) {
    return new Error(`Claude: ${detail} Open settings and press the refresh button to pick a model your key supports.`);
  }
  if (err instanceof Anthropic.APIConnectionError) {
    return new Error(`Claude: could not reach the API. ${detail}`);
  }
  return new Error(`Claude: HTTP ${err.status ?? '?'}. ${detail}`);
}

async function* streamClaude({ apiKey, model, messages, image, system, signal }) {
  model = model || DEFAULT_MODEL;
  const params = {
    model,
    max_tokens: Math.min(MAX_OUTPUT, outputCap.get(model) || MAX_OUTPUT),
    messages: toClaudeMessages(messages, image),
  };
  if (system) params.system = system;
  if (TAKES_EFFORT.test(model)) params.output_config = { effort: 'low' };

  const fallback = TAKES_FALLBACK.test(model);
  if (fallback) {
    params.betas = [FALLBACK_BETA];
    params.fallbacks = 'default';
  }

  const c = client(apiKey);
  try {
    const stream = (fallback ? c.beta.messages : c.messages).stream(params, { signal });
    for await (const ev of stream) {
      if (ev.type === 'content_block_delta' && ev.delta.type === 'text_delta' && ev.delta.text) {
        yield ev.delta.text;
      }
    }
    const final = await stream.finalMessage();
    if (final.stop_reason === 'refusal') {
      const why = final.stop_details?.category;
      throw new Error(`Claude declined to answer this${why ? ` (${why})` : ''}.`);
    }
  } catch (err) {
    throw explain(err, signal);
  }
}

/** Every model this key can use, newest first, as the API lists them. */
async function listClaudeModels({ apiKey, signal }) {
  if (!apiKey) throw new Error('Set an API key first.');
  const ids = [];
  try {
    for await (const m of client(apiKey).models.list({ limit: 100 }, { signal })) {
      ids.push(m.id);
      if (m.max_tokens) outputCap.set(m.id, m.max_tokens);
    }
  } catch (err) {
    throw explain(err, signal);
  }
  return ids;
}

module.exports = { streamClaude, listClaudeModels, imageBlock, abortError, DEFAULT_MODEL };
