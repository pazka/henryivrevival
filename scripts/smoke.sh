#!/usr/bin/env bash
# Container smoke test (upgrade safety net, see TESTING.md).
# Runs the BUILT image hardened (its own non-root user, read-only rootfs, cap_drop ALL, no-new-privileges)
# with a dummy key, starts a throwaway fake OpenAI INSIDE the container (no network, no real key), and
# drives the séance: page, init, chat -> moderation -> completion -> TTS -> mp3 served, plus the
# protections of /chat/send (validation, foreign origin, OpenAI error without crash).
#
#   docker build -t henryivrevival:smoke . && bash scripts/smoke.sh henryivrevival:smoke
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
chat() { curl -sS -o "$TMP/body" -w '%{http_code}' -H 'content-type: application/json' "$@" "$BASE/chat/send"; }

step "start $IMAGE (image user, read-only rootfs, cap_drop ALL, no-new-privileges, dummy key)"
dk run -d --name "$NAME" --read-only --tmpfs /tmp --cap-drop ALL --security-opt no-new-privileges:true \
  -e OPENAI_API_KEY=sk-smoke-not-a-key -e OPENAI_BASE_URL=http://127.0.0.1:9999/v1 \
  -p "127.0.0.1:${PORT}:3000" "$IMAGE" >/dev/null
for _ in $(seq 1 90); do
  dk logs "$NAME" 2>&1 | grep -q 'Server started' && break
  [ "$(dk inspect --format '{{.State.Running}}' "$NAME")" = true ] || fail "container exited"
  sleep 1
done
[ "$(dk exec "$NAME" id -u)" != 0 ] || fail "runs as root"

# Fake OpenAI inside the container: moderation, chat completion and speech; nothing leaves the container.
# A visitor message containing "BOOM" makes the completion fail (400), to check the server survives.
dk exec -d "$NAME" node -e '
require("http").createServer((q, s) => {
  let b = ""; q.on("data", c => b += c); q.on("end", () => {
    const j = JSON.parse(b || "{}")
    const json = (st, o) => { s.writeHead(st, {"content-type": "application/json"}); s.end(JSON.stringify(o)) }
    if (q.url.endsWith("/audio/speech")) { s.writeHead(200, {"content-type": "audio/mpeg"}); return s.end("ID3smoke") }
    if (q.url.endsWith("/moderations")) return json(200, {id: "m", results: [{flagged: false}]})
    if (JSON.stringify(j.messages).includes("BOOM")) return json(400, {error: {message: "bad", type: "invalid_request_error"}})
    json(200, {id: "c", object: "chat.completion", created: 1, model: j.model,
      choices: [{index: 0, finish_reason: "stop", message: {role: "assistant", content: "Ventre-saint-gris ! (" + j.model + ")"}}]})
  })
}).listen(9999, "127.0.0.1")'
sleep 1

step "page and init"
code 200 "$BASE/"
grep -qi '<html' "$TMP/body" || fail "page"
code 200 "$BASE/openai.mjs"
code 200 "$BASE/chat/init"
grep -q '"role":"system"' "$TMP/body" || fail "init messages"
code 404 "$BASE/chat/complete/mp3/none.mp3"

step "chat round-trip (fake OpenAI): moderation, gpt-5.6-sol, TTS, mp3"
[ "$(chat -d '{"messages":[{"role":"user","content":"Bonjour"}]}')" = 200 ] || fail "chat status: $(cat "$TMP/body")"
[ "$(cat "$TMP/body")" = 'Ventre-saint-gris ! (gpt-5.6-sol)' ] || fail "completion: $(cat "$TMP/body")"
code 200 "$BASE/chat/complete/mp3/x.mp3"
[ "$(cat "$TMP/body")" = ID3smoke ] || fail "mp3 not served"

step "protections: validation, foreign origin, OpenAI error does not crash"
[ "$(chat -d '{"messages":"nope"}')" = 400 ] || fail "invalid body accepted"
[ "$(chat -H 'Origin: https://other.example' -d '{"messages":[{"role":"user","content":"Bonjour"}]}')" = 403 ] || fail "foreign origin accepted"
[ "$(chat -d '{"messages":[{"role":"user","content":"BOOM"}]}')" = 502 ] || fail "OpenAI error not handled: $(cat "$TMP/body")"
[ "$(chat -d '{"messages":[{"role":"user","content":"Encore là ?"}]}')" = 200 ] || fail "server did not survive the error"

step "no crash in logs"
if dk logs "$NAME" 2>&1 | grep -E 'UnhandledPromiseRejection|Uncaught|TSError'; then fail "errors in container log"; fi

SMOKE_OK=1
echo "SMOKE OK ($IMAGE)"
