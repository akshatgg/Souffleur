# Does the invisibility actually work?

Short answer: yes, on macOS 26.6.2, verified by measurement rather than by
reading documentation.

## Why this needed testing

Apple's developer forums and the Tauri issue tracker both report that
`NSWindow.sharingType = .none` stopped working on macOS 15.4+, with an Apple
engineer stating:

> At this time there are no public APIs for preventing screen capture.

- https://developer.apple.com/forums/thread/792152
- https://github.com/tauri-apps/tauri/issues/14200

If that were still true on current macOS, this project would not work, and
neither would any of the comparable open-source tools. So it was worth ten
minutes to check instead of assuming either way.

## Method

Three borderless windows at `.screenSaver` level, each a solid colour:

| window  | treatment                        | expectation if the API works |
|---------|----------------------------------|------------------------------|
| magenta | `sharingType = .none`            | absent from capture          |
| cyan    | passed to `excludingWindows:`    | absent from capture          |
| yellow  | no protection at all (control)   | present in capture           |

The control is what makes a negative result meaningful. Without it, "nothing was
captured" could just mean the capture was broken.

Each window's own screen rect is then measured inside the captured frame, so a
match is counted only where that window actually sits. An earlier version
counted colours across the whole screen and produced a false reading off a teal
desktop wallpaper.

Two capture paths were tested:

1. `SCScreenshotManager.captureImage` — one-shot.
2. `SCStream` at 30fps for 5 seconds — **this is the path Zoom, Meet, Teams and
   OBS actually use.** The streaming test matters because of an Apple forum
   thread reporting that ScreenCaptureKit *initially* omits protected windows,
   implying it might leak on later frames.

## Result

```
frames analysed = 151

yellow  [control, unprotected]   100.00%   captured in every frame
magenta [sharingType = .none]      0.00%   hidden in every frame
cyan    [excludingWindows:]        0.00%   hidden in every frame
```

Control at 100% confirms the capture worked. Neither protected window appeared
in any of 151 frames.

**Conclusion:** `setContentProtection(true)` — Electron's wrapper around
`NSWindowSharingNone` — reliably excludes a window from ScreenCaptureKit on
macOS 26.6.2, including continuous whole-display capture. The reported 15.4-era
regression appears to have been fixed.

## Consequence for the design

Because the overlay is excluded from *every* ScreenCaptureKit consumer, it is
also excluded from this app's own `desktopCapturer` screenshot. So the model
sees your screen without seeing itself, and there is no hide/capture/show
flicker to implement.

## What this does not protect against

- A phone camera pointed at the screen.
- Anyone sitting next to you.
- macOS versions where Apple changes this behaviour again. The status strip
  reads the platform at runtime rather than trusting a build-time assumption.
- Linux: no compositor implements capture exclusion. The overlay will be visible.
- Windows before build 19041, where the window becomes a black box rather than
  being excluded.

## Reproducing

The probe sources are kept out of the app bundle, in `tools/`:

```
swiftc -O -swift-version 5 tools/sck_stream_probe.swift -o /tmp/streamtest
/tmp/streamtest      # writes /tmp/souffleur_stream_result.txt
```

The running process needs Screen Recording permission. Running it from a
terminal attributes that permission to the terminal app.
