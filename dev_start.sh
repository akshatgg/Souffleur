#!/usr/bin/env bash
#
# dev_start.sh — the website and the app, together, for development only.
#
# The website is served by `vercel dev` rather than a plain static server,
# because the site depends on things a static server does not do:
#
#   - clean URLs, so /docs and /vs-cluely resolve at all
#   - the /api/welcome function, which sends the welcome mail
#   - the headers and redirects in web/vercel.json
#
# Serving web/ with `python3 -m http.server` gets you 404s on every page but
# the homepage, and a sign-up that can never send mail.
#
# Nothing here is used in production. The site deploys from a push to master
# and the app is built by electron-builder; neither runs this file.
#
#   ./dev_start.sh                  website on :3000, and the app
#   ./dev_start.sh --port 8080      a different port
#   ./dev_start.sh --web-only       just the website
#   ./dev_start.sh --app-only       just the app
#   ./dev_start.sh --free-key       try the free key the way a new user meets it
#
# --free-key (or FREE_KEY_TEST=1 below) starts the app as a brand-new user, in
# a profile of its own with no saved key, against this machine's website. The
# local /api/free answers on the GEMINI_API_KEY in .env.free-test, a git-ignored
# file holding one line: GEMINI_API_KEY=...  Your real profile and its saved
# keys are not touched.
#
# Ctrl+C stops whatever it started.

set -euo pipefail

cd "$(dirname "${BASH_SOURCE[0]}")"

PORT=3000
WANT_WEB=1
WANT_APP=1
FREE_KEY_TEST=0   # 1 = the same as passing --free-key

while [ $# -gt 0 ]; do
  case "$1" in
    --port|-p) PORT="${2:?--port needs a number}"; shift 2 ;;
    --web-only) WANT_APP=0; shift ;;
    --app-only) WANT_WEB=0; shift ;;
    --free-key) FREE_KEY_TEST=1; shift ;;
    # Print the header block above, whatever length it grows to.
    -h|--help) awk 'NR>1 && /^#/ { sub(/^# ?/, ""); print; next } NR>1 { exit }' "$0"; exit 0 ;;
    *) echo "unknown option: $1 — try --help" >&2; exit 2 ;;
  esac
done

say()  { printf '\033[2m[dev]\033[0m %s\n' "$*"; }
warn() { printf '\033[33m[dev]\033[0m %s\n' "$*"; }
die()  { printf '\033[31m[dev]\033[0m %s\n' "$*" >&2; exit 1; }

# Prefix a stream so two programs sharing one terminal stay tellable apart.
# awk rather than `sed -u`, which BSD sed on macOS does not have.
prefix() { awk -v tag="$1" '{ printf "%s %s\n", tag, $0; fflush() }'; }

# ------------------------------- preflight --------------------------------

command -v node >/dev/null || die "node is not installed"

[ -d node_modules ] || { say "installing app dependencies…"; npm install --silent; }

# The free key's function runs inside `vercel dev`, so a test without the
# website has nothing to answer it, and one without a key has nothing to send.
if [ "$FREE_KEY_TEST" = 1 ]; then
  [ "$WANT_WEB" = 1 ] || die "--free-key needs the website too; drop --app-only"
  grep -q '^GEMINI_API_KEY=.' .env.free-test 2>/dev/null \
    || die "--free-key needs .env.free-test with a line GEMINI_API_KEY=... (git-ignored)"
fi

if [ "$WANT_WEB" = 1 ]; then
  command -v vercel >/dev/null || die "vercel CLI missing — npm i -g vercel"
  # The mail function needs its own dependencies; vercel dev will not add them.
  [ -d web/node_modules ] || { say "installing website dependencies…"; npm install --prefix web --silent; }

  if lsof -ti "tcp:$PORT" >/dev/null 2>&1; then
    die "port $PORT is already in use by PID $(lsof -ti "tcp:$PORT" | tr '\n' ' ')— pick another with --port"
  fi

  # Sign-up hides itself when this is unset, which looks like a broken build.
  # Match the placeholder *values* only. Plain REPLACE_ also appears in the
  # isConfigured check just below them, which warned on a good config.
  if grep -q ": 'REPLACE_" web/firebase-config.js 2>/dev/null; then
    warn "web/firebase-config.js still has REPLACE_ placeholders:"
    warn "  sign-up is hidden and the downloads are ungated. See web/SETUP.md."
  fi
fi

# The macOS audio helper is a compiled Swift binary and is not in git, so a
# fresh clone has no bin/audiotap and the app starts unable to hear the call.
if [ "$WANT_APP" = 1 ] && [ "$(uname -s)" = "Darwin" ] && [ ! -x bin/audiotap ]; then
  if command -v swiftc >/dev/null; then
    say "building the audio helper…"
    npm run build:audio --silent
  else
    warn "bin/audiotap is missing and swiftc is not installed — call audio will not work"
  fi
fi

# -------------------------------- cleanup ---------------------------------

PIDS=()

# Depth-first, because the thing holding the port is never the process we
# started. `vercel dev` runs each function in a child of its own, and `npm run`
# puts a shell between itself and electron. Killing a parent orphans those.
kill_tree() {
  local pid=$1 child
  for child in $(pgrep -P "$pid" 2>/dev/null); do kill_tree "$child"; done
  kill -TERM "$pid" 2>/dev/null || true
}

cleanup() {
  trap - EXIT INT TERM
  for pid in "${PIDS[@]:-}"; do
    [ -n "${pid:-}" ] && kill_tree "$pid" || true
  done

  # Give them a moment to go quietly, then insist.
  for _ in 1 2 3 4 5 6; do
    pgrep -P $$ >/dev/null 2>&1 || break
    sleep 0.5
  done
  for pid in "${PIDS[@]:-}"; do
    [ -n "${pid:-}" ] || continue
    pkill -KILL -P "$pid" 2>/dev/null || true
    kill -KILL "$pid" 2>/dev/null || true
  done

  wait 2>/dev/null || true
  say "stopped"
}
trap cleanup EXIT INT TERM

# --------------------------------- start ----------------------------------

if [ "$WANT_WEB" = 1 ]; then
  say "website  → http://localhost:$PORT"
  (
    # Only the website sees the key, and only for this run.
    if [ "$FREE_KEY_TEST" = 1 ]; then
      set -a; . ./.env.free-test; set +a
      export FREE_KEY_TEST=1
    fi
    vercel dev --listen "$PORT" --yes 2>&1 | prefix $'\033[36m[web]\033[0m'
  ) &
  PIDS+=($!)

  # The app is worth starting only once the site answers, so that a first
  # click does not land on a server still booting.
  for _ in $(seq 1 45); do
    curl -sf -o /dev/null --max-time 1 "http://localhost:$PORT/" && break
    sleep 1
  done
fi

if [ "$WANT_APP" = 1 ]; then
  say "app      → electron, with logging"
  (
    if [ "$FREE_KEY_TEST" = 1 ]; then
      say "free key → on, as a new user with no saved key (profile: Souffleur Free Test)"
      export SOUFFLEUR_FREE_TEST=1 SOUFFLEUR_SITE="http://localhost:$PORT"
    fi
    npm run dev 2>&1 | prefix $'\033[35m[app]\033[0m'
  ) &
  PIDS+=($!)
fi

say "Ctrl+C to stop"
wait
