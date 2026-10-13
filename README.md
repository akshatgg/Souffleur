# Souffleur

A *souffleur* is the theatre prompter who sits hidden in a box below the stage
and feeds actors their forgotten lines. The audience never sees them.

**[getsouffleur.vercel.app](https://getsouffleur.vercel.app)** &nbsp;·&nbsp;
[Download](https://github.com/akshatgg/souffleur-releases/releases/latest) &nbsp;·&nbsp;
[Docs](https://getsouffleur.vercel.app/docs)

This is that, for calls. A small always-on-top window that sees your screen,
hears the room, and answers questions — while staying out of the screen-share
stream everyone else is watching.

No API key needed to start: while the free key is on, answers come through
Souffleur's server on our Gemini key, up to a daily limit. Bring your own key
and nothing is sent anywhere except to the provider you pick.

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

- **Chat** with Gemini, OpenAI, Claude, or any OpenAI-compatible endpoint — or
  through Claude Code, if it is installed and signed in, with no key at all
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

### macOS

**1. Install Homebrew** — skip if you already have it (`brew --version` to check):

```bash
/bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)"
```

New to Homebrew? It is the standard package manager for macOS:
[brew.sh](https://brew.sh) · [docs.brew.sh](https://docs.brew.sh) ·
[FAQ](https://docs.brew.sh/FAQ)

**2. Install Souffleur:**

```bash
brew install --cask akshatgg/tap/souffleur
```

The app installs into Applications and opens with nothing to click through.

Afterwards: `brew upgrade --cask souffleur` to update,
`brew uninstall --cask souffleur` to remove.

The disk image on the releases page works too, but the build is not notarised
by Apple, so a manually downloaded copy is refused with *"Apple could not verify
Souffleur"* until you approve it in **System Settings → Privacy & Security →
Open Anyway**. Homebrew clears that flag as it installs, which is why the
command is the recommended route.

### Windows

Download the `.exe` from the
[latest release](https://github.com/akshatgg/souffleur-releases/releases/latest).
SmartScreen warns once: **More info → Run anyway**.

### Updating

Souffleur checks for a newer release when it starts. When there is one, a strip
appears above the chat: press **Update now** and it downloads the release,
installs it over the running copy and reopens. The same button is in
**Settings → Version**, where you can also check by hand.

On macOS the first launch after an update asks for the keychain again, and may
ask for Screen Recording again — the build is not notarised, so macOS sees each
version as a new app ([docs/SIGNING.md](docs/SIGNING.md)).

### After installing

Grant **Screen Recording** on macOS, or the overlay can neither see your screen
nor hear the call.

Everything works on both platforms. Call audio takes a different route on each:
Windows has a real loopback device, so Chromium captures the system mix
directly, while macOS has none and uses a small ScreenCaptureKit helper. Both
feed the same silence gate and transcription. PDF reading is pure JavaScript
and runs anywhere.

Removing the warnings for everyone needs paid certificates on each platform. The
pipeline is already wired for both — see [docs/SIGNING.md](docs/SIGNING.md); it
is credentials, not code.

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

## Running both locally

```bash
./dev_start.sh              # website on :3000, and the app
./dev_start.sh --port 8080  # somewhere else
./dev_start.sh --web-only   # or --app-only
```

Ctrl+C stops whatever it started.

The website is served by `vercel dev`, not a plain static server, because three
things the site needs do not exist without it: clean URLs (so `/docs` and
`/vs-cluely` resolve at all), the `/api/welcome` function behind the sign-up
mail, and the headers and redirects in `web/vercel.json`. Serving `web/` with
`python3 -m http.server` gives a 404 on every page but the homepage.

Development only. The site deploys from a push and the app is built by
electron-builder; neither runs this script.

## Two deployments, and they are not the same thing

**The website** deploys on every push to `master`. No version, no tag, nothing
to run — Vercel builds `web/` and publishes it.

```bash
git push          # site is live in about a minute
```

**The app installers** are a release, and you choose the version.

### From your machine

```bash
npm run release:patch    # 0.1.1 -> 0.1.2, bug fixes
npm run release:minor    # 0.1.1 -> 0.2.0, new features
npm run release:major    # 0.1.1 -> 1.0.0, breaking changes
```

Each bumps `package.json`, commits, tags, and pushes both. The tag triggers CI,
which builds macOS and Windows on their own runners and publishes the
installers.

### From GitHub

**Actions → Release → Run workflow**, then type a version such as `0.1.2`.
CI builds, publishes, tags, and writes the version back to `package.json`.

Leave the version blank to build the installers **without publishing** — useful
for checking a build without spending a version number on it.

### Guard rails

- A tag that disagrees with `package.json` fails before anything is built
- A version that already has a release is refused, rather than overwriting it
- Any job that produces no installer fails, and the release fails if fewer than
  three arrive — an earlier release published with zero assets because that was
  only a warning

## Tests

```bash
npm test
```

Covers the SSE parser (CRLF framing, split chunks, unterminated streams), the
audio frame protocol, the silence gate, and the arithmetic behind the website's
sign-up report.

## License

MIT
