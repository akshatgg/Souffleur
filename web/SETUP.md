# Sign-up, the report, and the welcome mail

Google sign-up gates both downloads, records a row per person in Firestore,
sends a welcome mail to them and a notice to the owner, and gives the owner a
report behind the profile menu.

## State of play

Already done, from the CLI, against project **`souffleur-web`**:

- [x] Firebase project created — `souffleur-web` ("Souffleur")
- [x] Web app registered, and its config written into `firebase-config.js`
- [x] Firestore database created in `asia-south1` (Mumbai)
- [x] `firestore.rules` compiled and released to the live project

Left to do, and none of it can be done from a terminal:

- [ ] **Enable Google sign-in** — console only, see below
- [ ] **Add `getsouffleur.vercel.app`** to Authorized domains
- [ ] **Gmail app password**, then the Vercel variables

Until Google sign-in is enabled the site reports `auth/configuration-not-found`
on any attempt to sign up, and the downloads stay shut. That is the one thing
standing between here and a working page.

## What talks to what

    browser  ──  Firebase Auth (Google popup)
             ──  Firestore  users/{uid}   name, email, os, install counters
             ──  POST /api/welcome  ──  verifies the sign-in token
                                    ──  SMTP  ──  welcome mail to the new user
                                              ──  notice to ADMIN_EMAIL

The report is read straight from Firestore by the browser. It is owner-only
because `firestore.rules` refuses the read to anyone else — not because the
button is hidden.

## 1. Create the Firebase project — done

Created as `souffleur-web` with `firebase projects:create`.

## 2. Turn on Google sign-in — YOURS TO DO

The Firebase CLI has no command for this, and the REST path needs either
billing enabled or an OAuth client that only the console creates for you. So:

1. [Authentication → Sign-in method](https://console.firebase.google.com/project/souffleur-web/authentication/providers)
2. **Get started**, then **Google**, then toggle **Enable**
3. Pick a support email, then **Save**

Then, on the **Settings** tab of the same page, under **Authorized domains**,
**Add domain** → `getsouffleur.vercel.app`. `localhost` is already listed. Any
Vercel preview domain you want to sign in from needs adding too — sign-in fails
on domains that are not listed.

## 3-6. Database, rules, and the web config — done

The database exists in `asia-south1`, `web/firestore.rules` is released to it,
and `web/firebase-config.js` holds the real values. To re-release the rules
after editing them:

    firebase deploy --only firestore:rules

The rules hard-code the owner address. Change it there as well as in
`firebase-config.js` if it is ever not `akshatg9636@gmail.com`.

## 7. Get an SMTP password — YOURS TO DO

For a Gmail sender, an ordinary account password will not work. You need an
**App Password**, which requires 2-Step Verification on the account:

1. [myaccount.google.com/security](https://myaccount.google.com/security) →
   turn on **2-Step Verification** if it is off.
2. [myaccount.google.com/apppasswords](https://myaccount.google.com/apppasswords)
   → create one named `souffleur-site`.
3. Copy the 16-character password. Google shows it once.

Any other SMTP provider works too — only the four `SMTP_*` values change.

## 8. Set the Vercel variables — YOURS TO DO

**Vercel → the `souffleur` project → Settings → Environment Variables.** Add
these for Production and Preview:

| Variable | Value |
| --- | --- |
| `FIREBASE_PROJECT_ID` | `souffleur-web` |
| `SMTP_HOST` | `smtp.gmail.com` |
| `SMTP_PORT` | `465` |
| `SMTP_USER` | the sending address, e.g. `akshatg9636@gmail.com` |
| `SMTP_PASS` | the app password from step 7 |
| `MAIL_FROM` | optional display form, e.g. `Souffleur <akshatg9636@gmail.com>` |
| `ADMIN_EMAIL` | `akshatg9636@gmail.com` — where the new-signup notice goes |

`FIREBASE_PROJECT_ID` is not decoration: the function refuses any sign-in token
that was not issued for `souffleur-web`, which is what stops the route being
an open mail relay.

Or from the terminal:

    vercel env add SMTP_PASS production

## 9. Deploy and check

    vercel deploy --prod

Then on the live site:

- **Continue with Google** on the download section signs you in.
- A welcome mail arrives at the address you used, and a notice at `ADMIN_EMAIL`.
- Signed in as the owner, a **Report** button appears next to Sign out.
- Take the Windows installer or copy the macOS command, then **Refresh** the
  report — the count moves.

If the mail does not arrive, the reason is in **Vercel → Deployments → the
deployment → Functions → `api/welcome`**. A `token rejected` line means
`FIREBASE_PROJECT_ID` does not match the project in `firebase-config.js`; an
`Invalid login` from SMTP means the app password is wrong or 2-Step
Verification is off.

## What the report can and cannot tell you

It counts people who chose to sign in, and installs they started from this
site while signed in.

It cannot count everyone. The installers also sit on a public GitHub releases
page that this site links to in four places, and that page needs no account.
Nothing here closes that gap — and closing it would mean taking the binaries
off GitHub, which is a bigger decision than a sign-in button.

The macOS number is also softer than the Windows one. Windows is a real
download link. macOS is a `brew` command that gets copied, so it counts the
copy, not the install that may or may not follow.

# The free key

Lets the app answer with no setup: anyone who has not added a key of their own
gets answers on the owner's Gemini key, up to a daily limit, while the switch
is on.

## What talks to what

    app  ──  GET  /free-key.json          is the switch on?
         ──  POST /api/free?kind=chat       ──  switch on?  under today's limit?
         ──  POST /api/free?kind=transcribe ──  Gemini, with GEMINI_API_KEY

The key lives only in the Vercel project. It is never in this repository and
never in the app: a key shipped inside an Electron app can be unpacked and
read by anyone, and a key in a public repository is found by bots in minutes.

A user who has saved a key of their own always uses it, whatever the switch
says. Turning the switch off stops the spending at once, even for copies of the
app that are already open, because the function checks it on every request.

## 1. The Gemini key — YOURS TO DO

1. [aistudio.google.com/apikey](https://aistudio.google.com/apikey) → create a
   key in a Google Cloud project that has **billing turned on**. On the unpaid
   tier Google may use what is sent — your users' screenshots and call audio —
   to improve its products.
2. Cap it. In [Google Cloud Console → IAM & Admin → Quotas](https://console.cloud.google.com/iam-admin/quotas),
   filter for the **Generative Language API** and lower the per-day request
   quota to what you are willing to pay for. This is the hard ceiling; the
   per-user limits below only share it out fairly. Google resets per-day
   quotas at midnight Pacific time.
3. Add a budget alert under **Billing → Budgets & alerts** so a spike reaches
   your inbox.

## 2. The Vercel variables

Paste the key from a terminal, so it never lands in a chat or a file:

    vercel env add GEMINI_API_KEY production

The counter store is Upstash for Redis from the Vercel Marketplace (free tier).
Accept its terms once in the browser when the CLI asks, then:

    vercel integration add upstash/upstash-kv --name souffleur-limits -m primaryRegion=iad1

That adds `KV_REST_API_URL` and `KV_REST_API_TOKEN` to the project by itself.

Everything else is optional and has a default:

| Variable | Default | Means |
| --- | --- | --- |
| `FREE_MODEL` | `gemini-3.1-flash-lite` | the model that answers |
| `FREE_TRANSCRIBE_MODEL` | same as `FREE_MODEL` | the model that transcribes calls |
| `FREE_DAILY_ANSWERS` | `100` | answers per install per day |
| `FREE_DAILY_CLIPS` | `600` | listening clips per install per day |
| `FREE_IP_FACTOR` | `3` | one connection gets this many installs' worth |
| `FREE_SALT` | none | mixed into the hashed counter names |

All limits reset at 00:00 UTC (05:30 in India). Changing a variable needs a
redeploy to take effect, not an app update.

## 3. Turn it on

**GitHub → Actions → Free key → Run workflow**, leave **Turn the free key on**
ticked, **Run**. It commits `web/free-key.json`, and the run goes green only
once the live site is serving the new value. Untick the box to turn it off.

## 4. Check it

    curl -s https://getsouffleur.vercel.app/free-key.json
    curl -s -X POST 'https://getsouffleur.vercel.app/api/free?kind=chat' \
      -H 'content-type: application/json' \
      -H 'x-souffleur-install: 00000000-0000-4000-8000-000000000000' \
      -d '{"contents":[{"role":"user","parts":[{"text":"Say hi"}]}]}'

The second prints a few `data:` lines with an answer in them. An error names
the cause: `free_off` means the switch is off or a variable is missing (the
function log in Vercel says which), and `upstream` carries Google's own
message, such as a model name the key cannot reach.

People on app versions before the free key keep being asked for a key until
they update.
