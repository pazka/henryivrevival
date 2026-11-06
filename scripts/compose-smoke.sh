#!/usr/bin/env bash
# Compose smoke: runs the BUILT image the way the box runs it, through `docker compose`, and proves the
# séance works end to end (no real key, no network: a fake OpenAI runs INSIDE the container).
#
#   bash scripts/compose-smoke.sh legacy  IMAGE   # the box's current compose (/root/hosh-deploy/henryivrevival),
#                                                 # reproduced verbatim below: must keep working unchanged
#
# Checks: image user, page + every file of public/ byte for byte, /chat/init, POST /chat, chat round-trip
# (moderation → completion → TTS → mp3), the /chat/send protections, an OpenAI error without crash, the
# optional OPENAI_* overrides, and the same again after a restart and a re-create of the container.
set -euo pipefail

MODE="${1:?usage: compose-smoke.sh legacy IMAGE}"
IMAGE="${2:?usage: compose-smoke.sh legacy IMAGE}"
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
DIR="$(mktemp -d)"
SVC=henryivrevival
PROJECT=henryivrevival

dk() { MSYS_NO_PATHCONV=1 docker "$@"; }  # Git Bash on Windows rewrites /paths in args
dc() { dk compose -p "$PROJECT" --project-directory "$DIR" -f "$DIR/docker-compose.yml" "$@"; }
fail() { echo "COMPOSE SMOKE FAIL ($MODE): $*" >&2; exit 1; }
step() { echo "== [$MODE] $*"; }
cleanup() {
  if [ "${SMOKE_OK:-0}" != 1 ]; then echo "---- container log ----"; dc logs --no-color 2>&1 | tail -n 40 || true; fi
  dc down -v --remove-orphans >/dev/null 2>&1 || true
  rm -rf "$DIR"
}
trap cleanup EXIT

case "$MODE" in
  legacy)
    # The box's legacy compose, verbatim except the image (the one under test) and the .env values
    # (dummy key; OPENAI_BASE_URL points the SDK at the fake below).
    BASE="http://127.0.0.1:9988"
    WANT_USER=node
    ENV_FILE="$DIR/.env"
    cat > "$DIR/docker-compose.yml" <<EOF
services:
  henryivrevival:
    image: ${IMAGE}
    env_file: .env
    ports: ["127.0.0.1:9988:3000"]
    security_opt: ["no-new-privileges:true"]
    cap_drop: [ALL]
    restart: always
EOF
    printf '%s\n' 'OPENAI_API_KEY=sk-compose-smoke-not-a-key' 'OPENAI_BASE_URL=http://127.0.0.1:9999/v1' > "$ENV_FILE"
    ;;
  *) fail "unknown mode '$MODE'" ;;
esac

# Fake OpenAI (inside the container, 127.0.0.1:9999): moderation, chat completion, speech. The answers echo
# the model / token cap it received; a visitor message containing "BOOM" makes the completion fail (400).
FAKE='
require("http").createServer((q, s) => {
  let b = ""; q.on("data", c => b += c); q.on("end", () => {
    const j = JSON.parse(b || "{}")
    const json = (st, o) => { s.writeHead(st, {"content-type": "application/json"}); s.end(JSON.stringify(o)) }
    if (q.url.endsWith("/audio/speech")) { s.writeHead(200, {"content-type": "audio/mpeg"}); return s.end("ID3smoke " + j.model + " " + j.voice) }
    if (q.url.endsWith("/moderations")) return json(200, {id: "m", results: [{flagged: false}]})
    if (JSON.stringify(j.messages).includes("BOOM")) return json(400, {error: {message: "bad", type: "invalid_request_error"}})
    json(200, {id: "c", object: "chat.completion", created: 1, model: j.model,
      choices: [{index: 0, finish_reason: "stop", message: {role: "assistant", content: "Ventre-saint-gris ! (" + j.model + "/" + j.max_completion_tokens + ")"}}]})
  })
}).listen(9999, "127.0.0.1")'

TMP="$DIR/body"
code() { # code <expected> <curl args...>   body saved to $TMP
  local want="$1"; shift
  local got
  got="$(curl -sS -o "$TMP" -w '%{http_code}' "$@")" || got=000
  [ "$got" = "$want" ] || { head -c 300 "$TMP" >&2 2>/dev/null; echo >&2; fail "expected $want got $got for: $*"; }
}
chat() { curl -sS -o "$TMP" -w '%{http_code}' -H 'content-type: application/json' "$@" "$BASE/chat/send"; }

wait_up() {
  for _ in $(seq 1 90); do
    curl -fsS -o /dev/null "$BASE/" 2>/dev/null && return 0
    sleep 1
  done
  fail "not answering on $BASE"
}
start_fake() {
  dc exec -d -T "$SVC" node -e "$FAKE"
  for _ in $(seq 1 20); do
    dc exec -T "$SVC" node -e 'fetch("http://127.0.0.1:9999/v1/moderations",{method:"POST",body:"{}"}).then(()=>process.exit(0),()=>process.exit(1))' && return 0
    sleep 0.5
  done
  fail "fake OpenAI did not start"
}

# Everything the séance needs, then the protections of /chat/send. $1 = expected "model/max" of the completion,
# $2 = expected TTS model.
capability() {
  local chat_model="$1" tts_model="$2"
  step "image user, page, every static asset byte for byte, init"
  [ "$(dc exec -T "$SVC" id -un | tr -d '\r')" = "$WANT_USER" ] || fail "runs as $(dc exec -T "$SVC" id -un), want $WANT_USER"
  [ "$(dc exec -T "$SVC" id -u | tr -d '\r')" != 0 ] || fail "runs as root"
  code 200 "$BASE/"
  grep -qi '<html' "$TMP" || fail "page is not html"
  local f n=0
  while IFS= read -r f; do
    code 200 "$BASE/${f// /%20}"
    cmp -s "$TMP" "$ROOT/public/$f" || fail "public/$f served with different bytes"
    n=$((n + 1))
  done < <(cd "$ROOT/public" && find . -type f | sed 's#^\./##' | sort)
  [ "$n" -ge 10 ] || fail "only $n static files checked"
  code 200 "$BASE/chat/init"
  grep -q '"role":"system"' "$TMP" && grep -q 'Henri quatre' "$TMP" || fail "init messages"
  code 204 -X POST "$BASE/chat"

  step "chat round-trip (fake OpenAI): moderation → $chat_model → TTS $tts_model → mp3"
  [ "$(chat -d '{"messages":[{"role":"user","content":"Bonjour"}]}')" = 200 ] || fail "chat status: $(cat "$TMP")"
  [ "$(cat "$TMP")" = "Ventre-saint-gris ! ($chat_model)" ] || fail "completion: $(cat "$TMP")"
  code 200 "$BASE/chat/complete/mp3/answer.mp3"
  [ "$(cat "$TMP")" = "ID3smoke $tts_model fable" ] || fail "mp3: $(cat "$TMP")"

  step "protections: validation, size limit, foreign origin, OpenAI error does not crash"
  [ "$(chat -d '{"messages":"nope"}')" = 400 ] || fail "invalid body accepted"
  [ "$(chat -d '{"messages":[{"role":"system","content":"x"}]}')" = 400 ] || fail "system-only body accepted"
  [ "$(chat -d "{\"messages\":[{\"role\":\"user\",\"content\":\"$(head -c 40000 /dev/zero | tr '\0' x)\"}]}")" = 413 ] || fail "32 kB body limit"
  [ "$(chat -H 'Origin: https://other.example' -d '{"messages":[{"role":"user","content":"Bonjour"}]}')" = 403 ] || fail "foreign origin accepted"
  [ "$(chat -d '{"messages":[{"role":"user","content":"BOOM"}]}')" = 502 ] || fail "OpenAI error not handled: $(cat "$TMP")"
  [ "$(chat -d '{"messages":[{"role":"user","content":"Encore là ?"}]}')" = 200 ] || fail "server did not survive the error"
}

step "up: $IMAGE"
dc up -d --quiet-pull
wait_up
start_fake
code 404 "$BASE/chat/complete/mp3/none.mp3"   # no answer yet
capability "gpt-5.6-sol/500" tts-1

step "restart (same container)"
dc restart
wait_up
start_fake
capability "gpt-5.6-sol/500" tts-1

step "re-create with the optional overrides OPENAI_CHAT_MODEL / OPENAI_TTS_MODEL / OPENAI_MAX_COMPLETION_TOKENS"
printf '%s\n' 'OPENAI_CHAT_MODEL=gpt-smoke-chat' 'OPENAI_TTS_MODEL=tts-smoke' 'OPENAI_MAX_COMPLETION_TOKENS=123' >> "$ENV_FILE"
dc up -d --force-recreate
wait_up
start_fake
capability "gpt-smoke-chat/123" tts-smoke

step "no crash in logs, restart policy kept"
if dc logs --no-color 2>&1 | grep -E 'UnhandledPromiseRejection|Uncaught|TSError'; then fail "errors in container log"; fi
[ "$(dk inspect -f '{{.HostConfig.RestartPolicy.Name}}' "$(dc ps -q "$SVC")")" = always ] || fail "restart policy"

SMOKE_OK=1
echo "COMPOSE SMOKE OK ($MODE, $IMAGE)"
