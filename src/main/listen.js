'use strict';
const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');
const { EventEmitter } = require('events');

/**
 * Listening pipeline: speaker audio -> utterances -> text.
 *
 *   bin/audiotap (Swift, ScreenCaptureKit)
 *        | framed PCM on stdout, see FRAME below
 *        v
 *   per-source energy gate splits the stream at pauses
 *        v
 *   each utterance is wrapped as WAV and transcribed
 *
 * Splitting on silence rather than a fixed clock matters: a timer cuts words in
 * half, and it bills you for windows containing nothing but room tone.
 *
 * FRAME (from AudioTap.swift)
 *   0  'V' 'A'              magic
 *   2  source               0 = system/speaker, 1 = mic
 *   3  reserved
 *   4  length (uint32 LE)
 *   8  payload              s16le mono 16 kHz
 */

const SAMPLE_RATE = 16000;
const BYTES_PER_SAMPLE = 2;
const HEADER = 8;
const MAGIC0 = 0x56; // 'V'
const MAGIC1 = 0x41; // 'A'

const SOURCES = { 0: 'them', 1: 'you' };

// Tuning, in milliseconds of audio.
const SILENCE_RMS = 0.012;      // ~-38 dBFS; below this counts as silence
const HANG_MS = 700;            // silence needed to close an utterance
const MIN_UTTERANCE_MS = 900;   // shorter is a click or a cough, not speech
const MAX_UTTERANCE_MS = 20000; // force a cut so monologues still stream
const FRAME_MS = 100;

const frameBytes = (SAMPLE_RATE * FRAME_MS / 1000) * BYTES_PER_SAMPLE;

const DEBUG = process.env.SOUFFLEUR_DEBUG === '1';
function dbg(...a) { if (DEBUG) console.log('[listen]', ...a); }

/** RMS of a signed-16 little-endian frame, normalised to 0..1. */
function frameRms(buf) {
  const n = Math.floor(buf.length / 2);
  if (!n) return 0;
  let sum = 0;
  for (let i = 0; i < n; i++) {
    const s = buf.readInt16LE(i * 2) / 32768;
    sum += s * s;
  }
  return Math.sqrt(sum / n);
}

/** Minimal 16-bit PCM WAV container around raw samples. */
function toWav(pcm, sampleRate = SAMPLE_RATE, channels = 1) {
  const header = Buffer.alloc(44);
  header.write('RIFF', 0);
  header.writeUInt32LE(36 + pcm.length, 4);
  header.write('WAVE', 8);
  header.write('fmt ', 12);
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);                              // PCM
  header.writeUInt16LE(channels, 22);
  header.writeUInt32LE(sampleRate, 24);
  header.writeUInt32LE(sampleRate * channels * BYTES_PER_SAMPLE, 28);
  header.writeUInt16LE(channels * BYTES_PER_SAMPLE, 32);
  header.writeUInt16LE(16, 34);
  header.write('data', 36);
  header.writeUInt32LE(pcm.length, 40);
  return Buffer.concat([header, pcm]);
}

/** Energy gate for one audio source. Emits complete utterances. */
class Segmenter {
  constructor(label, onUtterance) {
    this.label = label;
    this.onUtterance = onUtterance;
    this.reset();
  }

  reset() {
    this.pending = Buffer.alloc(0);
    this.voiced = [];
    this.voicedMs = 0;
    this.silenceMs = 0;
    this.inSpeech = false;
    this.loudestSeen = 0;
    this.bytesSeen = 0;
  }

  push(chunk) {
    this.bytesSeen += chunk.length;
    this.pending = this.pending.length ? Buffer.concat([this.pending, chunk]) : chunk;

    while (this.pending.length >= frameBytes) {
      const frame = this.pending.subarray(0, frameBytes);
      this.pending = this.pending.subarray(frameBytes);

      const rms = frameRms(frame);
      if (rms > this.loudestSeen) this.loudestSeen = rms;

      if (rms >= SILENCE_RMS) {
        this.inSpeech = true;
        this.voiced.push(Buffer.from(frame));
        this.voicedMs += FRAME_MS;
        this.silenceMs = 0;
      } else if (this.inSpeech) {
        // Keep trailing silence: cutting the instant the level drops clips
        // consonants off the end of the last word.
        this.voiced.push(Buffer.from(frame));
        this.silenceMs += FRAME_MS;
        if (this.silenceMs >= HANG_MS) this.flush();
      }

      if (this.voicedMs >= MAX_UTTERANCE_MS) this.flush();
    }
  }

  flush() {
    const speechMs = this.voicedMs;
    const frames = this.voiced;

    this.voiced = [];
    this.voicedMs = 0;
    this.silenceMs = 0;
    this.inSpeech = false;

    if (!frames.length) return;
    if (speechMs < MIN_UTTERANCE_MS) {
      dbg(`${this.label}: dropped ${speechMs}ms (below ${MIN_UTTERANCE_MS}ms floor)`);
      return;
    }
    dbg(`${this.label}: utterance ${speechMs}ms -> transcribing`);
    this.onUtterance(Buffer.concat(frames), speechMs);
  }
}

function helperPath() {
  const candidates = [
    path.join(__dirname, '..', '..', 'bin', 'audiotap'),
    path.join(process.resourcesPath || '', 'bin', 'audiotap'),
  ];
  return candidates.find((p) => p && fs.existsSync(p)) || candidates[0];
}

class Listener extends EventEmitter {
  constructor(transcribe) {
    super();
    this.transcribe = transcribe;    // async (wav) => string
    this.proc = null;
    this.running = false;
    this.raw = Buffer.alloc(0);
    this.queue = Promise.resolve();
    this.totalBytes = 0;
    this.segmenters = new Map();
  }

  segmenterFor(source) {
    const label = SOURCES[source] || `src${source}`;
    if (!this.segmenters.has(source)) {
      this.segmenters.set(source, new Segmenter(label, (pcm, ms) => this.enqueue(label, pcm, ms)));
    }
    return this.segmenters.get(source);
  }

  /**
   * Windows has a real loopback device, so Chromium can capture system audio
   * itself through getDisplayMedia. The renderer does the capture and hands
   * PCM here, which then runs through exactly the same silence gate and
   * transcription queue as the macOS helper's output.
   */
  startExternal() {
    if (this.running) return { ok: true, already: true };
    this.running = true;
    this.raw = Buffer.alloc(0);
    this.totalBytes = 0;
    this.segmenters.clear();
    this.startHeartbeat();
    this.emit('state', true);
    return { ok: true, mode: 'renderer' };
  }

  /** s16le mono 16 kHz from the renderer's capture. */
  pushExternal(pcm) {
    if (!this.running || !pcm || !pcm.length) return;
    this.totalBytes += pcm.length;
    this.segmenterFor(0).push(Buffer.from(pcm));
  }

  start(opts = {}) {
    if (this.running) return { ok: true, already: true };

    const bin = helperPath();
    if (!fs.existsSync(bin)) {
      return {
        ok: false,
        error: process.platform === 'darwin'
          ? `Audio helper missing from this build. Reinstall, or run: npm run build:audio`
          : 'Hearing the call is macOS-only for now. Everything else works here.',
      };
    }

    const args = [];
    if (opts.mic) args.push('--mic');
    dbg('starting helper', bin, args.join(' ') || '(speaker audio only)');

    try {
      this.proc = spawn(bin, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    } catch (err) {
      return { ok: false, error: `Could not start audio helper: ${err.message}` };
    }

    this.running = true;
    this.raw = Buffer.alloc(0);
    this.totalBytes = 0;
    this.segmenters.clear();

    this.proc.stdout.on('data', (chunk) => this.ingest(chunk));

    this.proc.stderr.on('data', (d) => {
      const msg = String(d).trim();
      if (!msg) return;
      this.emit('log', msg);
      if (/denied|failed|no audio source|unavailable/i.test(msg)) this.emit('error', msg);
    });

    this.proc.on('exit', (code) => {
      dbg(`helper exited code=${code} bytes=${this.totalBytes}`);
      this.running = false;
      this.proc = null;
      if (code) {
        this.emit('error',
          code === 1 || code === 3
            ? 'Audio capture could not start. Grant Screen Recording permission to Electron, then try again.'
            : `Audio helper exited with code ${code}.`);
      }
      this.emit('state', false);
    });

    this.startHeartbeat();

    this.emit('state', true);
    return { ok: true };
  }

  // A periodic heartbeat turns "nothing happened" into a diagnosis: it
  // distinguishes no audio arriving at all from audio arriving that is simply
  // too quiet to cross the speech threshold.
  startHeartbeat() {
    clearInterval(this.heartbeat);
    this.heartbeat = setInterval(() => {
      const parts = [...this.segmenters.values()]
        .map((s) => `${s.label} loudest=${s.loudestSeen.toFixed(4)}`)
        .join(' ');
      dbg(`heartbeat bytes=${this.totalBytes} ${parts || '(no frames yet)'} threshold=${SILENCE_RMS}`);
      if (this.totalBytes === 0) {
        // ScreenCaptureKit delivers buffers continuously once it is really
        // running -- silent ones included. Zero bytes therefore means the
        // stream is not running at all, which in practice means permission.
        this.emit('hint',
          'No audio at all is arriving, which means the capture stream is not really running. ' +
          'Grant Screen Recording to Electron in System Settings, then toggle listening again.');
      } else if (parts && [...this.segmenters.values()].every((s) => s.loudestSeen < SILENCE_RMS)) {
        this.emit('hint', 'Audio is arriving but it is below the speech threshold. Turn the volume up.');
      }
    }, 10000);

    // A diagnostic timer must never be the reason the process stays alive.
    this.heartbeat.unref?.();
  }

  stop() {
    clearInterval(this.heartbeat);
    for (const s of this.segmenters.values()) s.flush();  // keep the last sentence
    if (this.proc) this.proc.kill('SIGTERM');
    this.proc = null;
    this.running = false;
    this.emit('state', false);
    return { ok: true };
  }

  /** Split the byte stream into frames and route each to its source. */
  ingest(chunk) {
    this.totalBytes += chunk.length;
    this.raw = this.raw.length ? Buffer.concat([this.raw, chunk]) : chunk;

    while (this.raw.length >= HEADER) {
      if (this.raw[0] !== MAGIC0 || this.raw[1] !== MAGIC1) {
        // Should never happen; resynchronise rather than emit garbage audio.
        const at = this.raw.indexOf(Buffer.from([MAGIC0, MAGIC1]), 1);
        dbg('lost frame sync, resynchronising');
        if (at < 0) { this.raw = Buffer.alloc(0); return; }
        this.raw = this.raw.subarray(at);
        continue;
      }
      const source = this.raw[2];
      const len = this.raw.readUInt32LE(4);
      if (this.raw.length < HEADER + len) return;   // wait for the rest

      const payload = this.raw.subarray(HEADER, HEADER + len);
      this.raw = this.raw.subarray(HEADER + len);
      this.segmenterFor(source).push(Buffer.from(payload));
    }
  }

  /** One transcription at a time, in order, so lines cannot interleave. */
  enqueue(who, pcm, ms) {
    const wav = toWav(pcm);
    this.queue = this.queue.then(async () => {
      try {
        const text = ((await this.transcribe(wav)) || '').trim();
        dbg(`${who}: ${ms}ms -> ${text ? JSON.stringify(text.slice(0, 80)) : '(no speech found)'}`);
        if (text) this.emit('transcript', { who, text });
      } catch (err) {
        this.emit('error', `Transcription failed: ${err.message}`);
      }
    });
  }
}

module.exports = { Listener, Segmenter, toWav, frameRms, helperPath, SAMPLE_RATE, SILENCE_RMS };
