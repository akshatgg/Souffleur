# Contributing to Souffleur

Thanks for wanting to help. Souffleur is MIT-licensed and open to changes of any
size — bug fixes, provider coverage, docs, or a feature you wish existed.

## Before you start

- **Bugs and small fixes** — open a PR directly.
- **New features or big refactors** — open an issue first so we agree on the
  approach before you spend time on it. Souffleur has a narrow job: a prompter
  that follows the conversation and stays invisible to screen share. Features
  that widen that scope get more scrutiny than ones that deepen it.
- **Security issues** — please don't open a public issue. Email
  [akshatg9636@gmail.com](mailto:akshatg9636@gmail.com).

## Getting set up

```sh
git clone https://github.com/akshatgg/Souffleur.git
cd Souffleur
npm install
npm run build:audio   # compiles the ScreenCaptureKit audio helper -> bin/audiotap
npm start
```

Requires macOS 14+ for the audio helper. The app is Electron: the main process
lives in `src/main`, the UI in `src/renderer`, and the single native helper is
`src/native/AudioTap.swift` (ScreenCaptureKit, system audio plus microphone).
`bin/` is gitignored — build it before you expect sound to work.

Providers are separate modules in `src/main`: `claude.js`, `claudecode.js`,
`copilot.js`, `freekey.js`, with `providers.js` holding the shared shape and
`router.js` deciding which one answers. Adding a provider usually means a new
module plus a branch in the router, not a change to the editor.

The website is a second project in `web/` with **its own `package.json`** —
install and run it separately if you're touching the site:

```sh
cd web && npm install
```

It's static pages plus two Vercel functions (welcome mail, free key). Deploys
happen on every push to `master`, so a site change goes live when the PR merges.
`web/SETUP.md` covers Firebase, Vercel, and the mail and free-key functions.

## The one rule that matters

Keys are encrypted with the system keychain and never cross into the renderer.
Anything that touches key handling — `store.js`, `providers.js`, `freekey.js`,
`preload.js` — must keep that true:

- never send a key to the renderer
- never log one, not even truncated
- never write one to disk outside the keychain
- never put one in a workflow, a test, or a screenshot of a PR

A PR that weakens this will be rejected regardless of what else it fixes.

## Checks

```sh
npm test   # eslint + node:test
```

That's the whole suite: the SSE parser, the audio frame protocol, the silence
gate, free-key rules, the updater, and the website report arithmetic. There are
no end-to-end tests yet, so UI changes need a manual check — say in the PR what
you did and on which macOS version.

## Style

- Match the surrounding code — naming, structure, and comment density. Comments
  here explain *why*; keep that.
- No new dependencies unless there's a real reason. Every one is a supply-chain
  and bundle-size cost in a desktop app that ships a keychain.
- No GPL/AGPL dependencies — they can't be shipped under MIT.
- Keep `master` shippable. Unfinished work stays behind a flag or on the branch.

## Commits and PRs

- [Conventional Commits](https://www.conventionalcommits.org/):
  `fix:`, `feat:`, `chore:`, `docs:`, `refactor:`, `test:`.
- One logical change per PR. Unrelated cleanup goes in its own PR.
- Fill in the PR template — especially **how you tested it**. "Ran `npm test`,
  then prompted Claude for two minutes on macOS 15" is a good answer.
- Reference the issue with `Closes #123` when applicable.

## License

By contributing you agree your contribution is licensed under the
[MIT License](LICENSE) and that you have the right to submit it.
