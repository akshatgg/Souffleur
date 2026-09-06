# Making the warnings go away permanently

Users currently see a warning on first launch — *"Apple could not verify
Souffleur"* on macOS, SmartScreen on Windows. This is not a bug in the app and
no build setting removes it. Both operating systems warn about software that
isn't signed by a certificate they recognise, and both certificates cost money.

There are two ways out. They are independent, and the first is free.

---

## Option A — Homebrew (free, macOS only)

The cask clears the quarantine flag after installing, so the dialog never
appears:

```bash
brew install --cask akshatgg/tap/souffleur
```

This does not make the app notarised. Note that Homebrew *adds* quarantine to
casks by default — the cask's `postflight` is what removes it, which is exactly
what the Settings approval does by hand.

### One-time setup

1. Create a public repository named **`homebrew-tap`** under the `akshatgg`
   account. The name matters: Homebrew derives `akshatgg/tap` from it.

2. Copy [`packaging/souffleur.rb`](../packaging/souffleur.rb) to `Casks/souffleur.rb`
   in that repository.

3. Fill in the two SHA-256 values, which `npm run cask:sha` prints for the
   current release.

After that, `npm run cask:update` regenerates the file whenever you publish,
and you commit it to the tap.

### What it does not fix

Nothing for Windows, and nothing for people who do not use Homebrew. It is a
good default for developers and useless for everyone else, which is why it is
not the whole answer.

---

## Option B — Sign and notarise (99 USD/year, removes every macOS warning)

This is the real fix. Apple scans the build and staples a ticket to it, and the
app then opens on first launch with no dialog at all.

### 1. Enrol

[developer.apple.com/programs](https://developer.apple.com/programs/) — 99 USD
per year. Approval usually takes a day or two.

### 2. Create a Developer ID Application certificate

In Xcode: **Settings → Accounts → Manage Certificates → + → Developer ID
Application**. Or generate a CSR and request it in the developer portal.

### 3. Export it as a .p12

Keychain Access → **My Certificates** → right-click the *Developer ID
Application* certificate → **Export** → `.p12`, and set a password. Then:

```bash
base64 -i certificate.p12 | pbcopy      # the value for CSC_LINK
```

### 4. Create an app-specific password

[appleid.apple.com](https://appleid.apple.com) → Sign-In and Security →
App-Specific Passwords. This is *not* your Apple ID password.

### 5. Find your Team ID

[developer.apple.com/account](https://developer.apple.com/account) → Membership.
Ten characters, something like `A1B2C3D4E5`.

### 6. Add four repository secrets

**Settings → Secrets and variables → Actions → New repository secret**

| Secret | Value |
|---|---|
| `CSC_LINK` | the base64 string from step 3 |
| `CSC_KEY_PASSWORD` | the password you set on the .p12 |
| `APPLE_ID` | your Apple ID email |
| `APPLE_APP_SPECIFIC_PASSWORD` | from step 4 |
| `APPLE_TEAM_ID` | from step 5 |

Then cut a release as usual. **No code changes.** `electron-builder.config.js`
detects the certificate, turns on the hardened runtime, signs, and notarises.
Notarisation adds five to fifteen minutes to the build.

### Verifying it worked

```bash
spctl -a -vv /Applications/Souffleur.app
# accepted
# source=Notarized Developer ID
```

`accepted` and `Notarized Developer ID` mean no user will ever see a warning
again.

---

## Windows

SmartScreen warns until the installer is signed. Certificates come from
DigiCert, Sectigo, SSL.com and others.

| Type | Cost | Behaviour |
|---|---|---|
| **OV** | ~200 USD/yr | Warning persists until enough people download it to build reputation |
| **EV** | ~350 USD/yr | Trusted immediately; ships on a hardware token |

If you buy one, add `WIN_CSC_LINK` (base64 `.pfx`) and `WIN_CSC_KEY_PASSWORD`
as secrets. The build picks them up with no code change.

---

## What each option actually buys

| | macOS first launch | Windows first launch | Cost |
|---|---|---|---|
| Today | Settings → Open Anyway | More info → Run anyway | free |
| Homebrew cask | no warning, Homebrew users only | unchanged | free |
| Developer ID + notarisation | **no warning** | unchanged | 99 USD/yr |
| Both certificates | **no warning** | **no warning** (EV) | ~450 USD/yr |
