# Souffleur

A *souffleur* is the theatre prompter who sits hidden in a box below the stage
and feeds actors their forgotten lines. The audience never sees them.

**[getsouffleur.vercel.app](https://getsouffleur.vercel.app)** &nbsp;·&nbsp;
[Download](https://github.com/akshatgg/Souffleur/releases/latest) &nbsp;·&nbsp;
[Docs](https://getsouffleur.vercel.app/docs)

This is that, for calls. A small always-on-top window that sees your screen,
hears the room, and answers questions — while staying out of the screen-share
stream everyone else is watching.

Bring your own API key. Nothing is sent anywhere except to the provider you pick.

```
   YOUR SCREEN                        WHAT THEY SEE
   ┌─────────────────────┐            ┌─────────────────────┐
   │  your work          │            │  your work          │
   │      ┌───────────┐  │            │                     │
   │      │ souffleur │  │            │                     │
   │      └───────────┘  │            │                     │
   └─────────────────────┘            └─────────────────────┘
```

## What it does

- **Chat** with Gemini, OpenAI, or any OpenAI-compatible endpoint
- **Ask about your screen** — one hotkey captures it and sends it with your question
- **Hears the call** — transcribes what the other party says, straight into the
  chat box so you can send it with one Enter
- **Hidden from screen capture** — Zoom, Meet, Teams, OBS, QuickTime

## Does the invisibility actually work?

Apple's developer forums and the Tauri issue tracker both report that
`NSWindow.sharingType = .none` stopped working on macOS 15.4+, with an Apple
engineer stating *"there are no public APIs for preventing screen capture."*

That turned out to be **false on current macOS**, verified by measurement rather
than by reading. Three windows were placed on screen — one protected with the
flag, one excluded via `SCContentFilter`, and one unprotected control — then
captured through a live 30fps `SCStream`, the same ScreenCaptureKit path Zoom
and Meet use:

```
frames analysed = 151

yellow  [control, unprotected]   100.00%   captured in every frame
magenta [sharingType = .none]      0.00%   hidden in every frame
cyan    [excludingWindows:]        0.00%   hidden in every frame
```

The control at 100% is what makes the zeros mean something. Method, caveats and
reproduction steps are in [docs/VERIFICATION.md](docs/VERIFICATION.md); the
probes themselves are in [tools/](tools/).

A useful consequence: the overlay is invisible to *every* ScreenCaptureKit
consumer, including this app's own screenshot capture. The model never sees
itself, and there is no hide/capture/show flicker.

## Install

Download the [latest release](https://github.com/akshatgg/Souffleur/releases/latest):
a `.dmg` for macOS (`arm64` for Apple Silicon, the other for Intel) or the `.exe`
installer for Windows.

Neither build is signed by a certificate the vendor recognises, so each warns
once. On macOS, **right-click the app and choose Open** (or System Settings →
Privacy & Security → Open Anyway). On Windows, **More info → Run anyway**.

Then grant Screen Recording on macOS, or the overlay can neither see your screen
nor hear the call.

If macOS says the app is *damaged* rather than unverified, you have a build from
before 0.1.1; download a newer one, or clear the flag with
`xattr -dr com.apple.quarantine /Applications/Souffleur.app`.

Audio capture is macOS-only for now.

## Requirements

- macOS 13+ (tested on 26.6). Windows works for the overlay; audio capture is
  macOS-only for now.
- Node 20+
- Xcode command line tools, to build the audio helper

## Setup

```bash
npm install
npm run build:audio     # compiles the ScreenCaptureKit audio helper
npm start
```

Open settings, choose a provider, paste your key. The model dropdown is
populated by asking your provider what your key can actually reach, so it does
not go stale when a model is retired.

Keys are encrypted with the system keychain and never cross into the renderer.

## Shortcuts

| Does | Keys |
|---|---|
| Show or hide the overlay | `Shift + Space` |
| Capture your screen and ask about it | `Shift + S` |
| Start or stop listening to the call | `Shift + Z` |
| Answer the last thing they said | `Shift + A` |
| Clear the conversation | `Shift + K` |
| Close settings, stop a reply, or hide | `Esc` |

Identical on macOS and Windows. Drag the title bar to move the window.

Every shortcut is editable under Settings. They are **global**: the system routes
them to Souffleur before any other app, so `Shift` + those keys stop producing
capital letters elsewhere while it runs. Adding `Alt` — `Alt + Shift + A` — keeps
them one-handed without taking a letter from the rest of the machine.

## How the listening works

```
audiotap (Swift, ScreenCaptureKit)
     │  framed PCM, s16le mono 16 kHz
     ▼
energy gate splits the stream at pauses
     ▼
one WAV per utterance → transcribed → chat box
```

macOS has no loopback audio device, so ScreenCaptureKit is the only supported
way to hear the far side of a call. Utterances are cut at **pauses rather than
on a fixed clock**: a timer slices words in half and bills you for windows
containing nothing but room tone. Anything under 900 ms is discarded as noise.

Your microphone is **off by default** — the point is hearing them, not you. It
can be enabled, and the two sources stay on separate channels so the transcript
knows who spoke.

## What this does not protect against

- A phone camera pointed at your screen, or anyone sitting beside you
- Linux: no compositor implements capture exclusion, so the overlay is visible
- Windows before build 19041, where the window becomes a black box rather than
  being excluded
- A future macOS release changing this behaviour. The status bar reads the
  platform at runtime rather than trusting a build-time assumption, and turns
  amber when protection is not actually in force.

## Releasing

The **git tag decides the version**. Nothing picks it automatically.

```bash
npm run release:patch    # 0.1.1 -> 0.1.2, bug fixes
npm run release:minor    # 0.1.1 -> 0.2.0, new features
npm run release:major    # 0.1.1 -> 1.0.0, breaking changes
```

Each bumps `package.json`, commits, tags, and pushes both. Pushing the tag
triggers CI, which builds macOS and Windows on their own runners and publishes
the installers to a GitHub release.

CI refuses to build if the tag and `package.json` disagree, so a release cannot
end up containing files named after a different version. The **Run workflow**
button builds artifacts without publishing — the release step only runs for tags.

## Tests

```bash
npm test
```

Covers the SSE parser (CRLF framing, split chunks, unterminated streams), the
audio frame protocol, and the silence gate.

## License

MIT
