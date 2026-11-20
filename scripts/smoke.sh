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

step "logs: one JSON object per line on stdout, startup / request_failed / shutdown (hosh-management AGENTS.md section 11)"
dk stop -t 10 "$NAME" >/dev/null
[ "$(dk inspect --format '{{.State.ExitCode}}' "$NAME")" = 0 ] || fail "exit code after docker stop is not 0 (no SIGTERM handler?)"
dk logs "$NAME" 2>"$TMP/stderr.log" >"$TMP/stdout.log"
[ -s "$TMP/stdout.log" ] || fail "nothing on stdout"
[ ! -s "$TMP/stderr.log" ] || { cat "$TMP/stderr.log" >&2; fail "something on stderr"; }
# Parsed by the image's own node: every line a JSON object with the standard fields; the expected events; never
# the conversation ("Bonjour", Henri's answer), the key or an IP.
dk run --rm -i --network none --entrypoint node "$IMAGE" -e '
let t = ""; process.stdin.on("data", d => t += d).on("end", () => {
  const lines = t.split("\n").filter(Boolean), events = []
  for (const l of lines) {
    const o = JSON.parse(l)
    const k = Object.keys(o).slice(0, 6).join(",")
    if (k !== "ts,level,service,version,event,msg" || o.service !== "henryivrevival" || !/^\d{4}-\d\d-\d\dT[\d:]{8}\.\d{3}Z$/.test(o.ts))
      throw new Error("not a standard log line: " + l)
    events.push(o.level + ":" + o.event)
  }
  const want = ["info:startup", "error:request_failed", "info:shutdown"]   // + a request_slow if the runner is slow
  const got = events.filter(e => e !== "warn:request_slow")
  if (got.join(" ") !== want.join(" ")) throw new Error("events: " + events.join(" ") + " (want " + want.join(" ") + ")")
  const failed = lines.map(l => JSON.parse(l)).find(o => o.event === "request_failed")
  if (failed.route !== "/chat/send" || failed.status !== 502 || failed.openai_status !== 400 || !failed.err) throw new Error("request_failed line: " + JSON.stringify(failed))
  if (/Bonjour|BOOM|Ventre-saint-gris|sk-smoke|127\.0\.0\.1|172\.1/.test(t)) throw new Error("conversation, key or IP in the log")
  console.log("log lines OK: " + events.join(" "))
})' <"$TMP/stdout.log" || { cat "$TMP/stdout.log" >&2; fail "logs are not the standard JSON lines"; }

SMOKE_OK=1
echo "SMOKE OK ($IMAGE)"
