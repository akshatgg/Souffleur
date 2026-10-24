## What

<!-- One or two sentences. What changes for someone using Souffleur? -->

## Why

<!-- The problem this solves, or the issue it closes. -->

Closes #

## How

<!-- The approach, and anything a reviewer would trip over. Provider changes
should say which module moved and whether the router changed. -->

## Key handling

<!-- If this touches store.js, providers.js, freekey.js or preload.js, confirm
keys still never reach the renderer and are never logged. Delete this section
if not applicable. -->

## Testing

<!-- How you verified it. Which suites ran? Which provider and macOS version
did you try by hand? -->

- [ ] `npm test`
- [ ] Checked by hand on: <!-- macOS version / Windows version -->
- [ ] Checked with provider: <!-- API key / Claude Code / Copilot / free key -->

## Checklist

- [ ] Focused on one change; unrelated cleanup split out
- [ ] Tests added or updated for behaviour changes
- [ ] Comments explain *why*, matching the surrounding code
- [ ] No API key, token, or keychain content in the diff, tests, or screenshots
- [ ] No new dependency without a stated reason, and none copyleft
- [ ] README or `web/SETUP.md` updated if setup or behaviour changed
