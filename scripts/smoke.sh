#!/usr/bin/env bash
# Container smoke test (upgrade safety net, see TESTING.md).
# Runs the BUILT image (ts-node at runtime) with a dummy key, starts a throwaway fake OpenAI INSIDE the
# container (no network, no real key), and drives a full chat round-trip: page, init, chat -> completion
# -> TTS -> mp3 served. Fails on crashes in the logs.
#
#   docker build -t henryivrevival:smoke . && bash scripts/smoke.sh henryivrevival:smoke
#
# Hardening: cap_drop ALL + no-new-privileges. Not --read-only: the app writes ./tmp.mp3 next to its
# code on every answer (see TESTING.md, "Known gaps").
set -euo pipefail

IMAGE="${1:-henryivrevival:smoke}"
NAME="henry-smoke-$$"
PORT="${SMOKE_PORT:-18300}"
BASE="http://127.0.0.1:${PORT}"
TMP="$(mktemp -d)"

dk() { MSYS_NO_PATHCONV=1 docker "$@"; }  # Git Bash on Windows rewrites /paths in args
cleanup() {
  cd /
  if [ "${SMOKE_OK:-0}" != 1 ]; then echo "---- container log ----"; dk logs "$NAME" 2>&1 | tail -n 40 || true; fi
  dk rm -f "$NAME" >/dev/null 2>&1 || true
  rm -rf "$TMP"
}
trap cleanup EXIT
fail() { echo "SMOKE FAIL: $*" >&2; exit 1; }
step() { echo "== $*"; }
code() { # code <expected> <curl args...>   body saved to $TMP/body
  local want="$1"; shift
  local got
  got="$(curl -sS -o "$TMP/body" -w '%{http_code}' "$@")"
  [ "$got" = "$want" ] || { head -c 300 "$TMP/body" >&2; echo >&2; fail "expected $want got $got for: $*"; }
}

step "start $IMAGE (cap_drop ALL, no-new-privileges, dummy key, fake OpenAI on 127.0.0.1:9999)"
dk run -d --name "$NAME" --cap-drop ALL --security-opt no-new-privileges:true \
  -e OPENAI_API_KEY=sk-smoke-not-a-key -e OPENAI_BASE_URL=http://127.0.0.1:9999/v1 \
  -p "127.0.0.1:${PORT}:3000" "$IMAGE" >/dev/null
for _ in $(seq 1 90); do
  dk logs "$NAME" 2>&1 | grep -q 'Server started' && break
  [ "$(dk inspect --format '{{.State.Running}}' "$NAME")" = true ] || fail "container exited"
  sleep 1
done

# Fake OpenAI inside the container: chat completion + speech, nothing leaves the container.
dk exec -d "$NAME" node -e '
require("http").createServer((q, s) => {
  let b = ""; q.on("data", c => b += c); q.on("end", () => {
    if (q.url.endsWith("/audio/speech")) { s.writeHead(200, {"content-type": "audio/mpeg"}); return s.end("ID3smoke") }
    s.writeHead(200, {"content-type": "application/json"})
    s.end(JSON.stringify({id: "c", object: "chat.completion", created: 1, model: "m",
      choices: [{index: 0, finish_reason: "stop", message: {role: "assistant", content: "Ventre-saint-gris !"}}]}))
  })
}).listen(9999, "127.0.0.1")'
sleep 1

step "page and init"
code 200 "$BASE/"
grep -qi '<html' "$TMP/body" || fail "page"
code 200 "$BASE/openai.mjs"
code 200 "$BASE/chat/init"
grep -q '"role":"system"' "$TMP/body" || fail "init messages"

step "chat round-trip (fake OpenAI)"
code 200 -H 'content-type: application/json' \
  -d '{"messages":[{"role":"user","content":"Bonjour"}]}' "$BASE/chat/send"
[ "$(cat "$TMP/body")" = 'Ventre-saint-gris !' ] || fail "completion: $(cat "$TMP/body")"
code 200 "$BASE/chat/complete/mp3/x"
[ "$(cat "$TMP/body")" = ID3smoke ] || fail "mp3 not served"

step "no crash in logs"
if dk logs "$NAME" 2>&1 | grep -E 'Error:|UnhandledPromiseRejection'; then fail "errors in container log"; fi

SMOKE_OK=1
echo "SMOKE OK ($IMAGE)"
