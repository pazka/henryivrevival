#!/usr/bin/env bash
# Compose smoke: runs the BUILT image the way the box runs it, through `docker compose`, and proves the
# séance works end to end (no real key, no network: a fake OpenAI runs INSIDE the container).
#
#   bash scripts/compose-smoke.sh legacy   IMAGE  # the box's current compose (/root/hosh-deploy/henryivrevival),
#                                                 # reproduced verbatim below: must keep working unchanged
#   bash scripts/compose-smoke.sh template IMAGE  # docker-compose.example.yml + .env.example as hosh-deploy runs
#                                                 # them (uid 10001, read-only, tmpfs, PORT=8000, 127.0.0.1:9139),
#                                                 # plus `hosh-deploy register`'s validation, the healthcheck and
#                                                 # the POST_DEPLOY command of deploy/hosh-deploy.conf
#
# Checks: image user, page + every file of public/ byte for byte, /chat/init, POST /chat, chat round-trip
# (moderation → completion → TTS → mp3), the /chat/send protections, an OpenAI error without crash, the
# optional OPENAI_* overrides, and the same again after a restart and a re-create of the container.
set -euo pipefail

MODE="${1:?usage: compose-smoke.sh legacy|template IMAGE}"
IMAGE="${2:?usage: compose-smoke.sh legacy|template IMAGE}"
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
DIR="$(mktemp -d)"
SVC=henryivrevival
PROJECT=henryivrevival

dk() { MSYS_NO_PATHCONV=1 docker "$@"; }  # Git Bash on Windows rewrites /paths in args
dc() { dk compose -p "$PROJECT" --project-directory "$DIR" --env-file "$ENV_FILE" -f "$DIR/docker-compose.yml" "$@"; }  # env file = interpolation too (APP_IMAGE, APP_BIND)
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
    WANT_UID=1000   # the image's own user `node`
    RESTART=always
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
  template)
    # Exactly what /srv/henryivrevival holds on the box: the example compose copied as docker-compose.yml and
    # .env.example copied as henryivrevival.env, where the owner sets the key (dummy here). Only the image tag
    # line (as hosh-deploy rewrites it) and OPENAI_BASE_URL (the fake) differ.
    BASE="http://127.0.0.1:9139"
    WANT_UID=10001
    RESTART=unless-stopped
    ENV_FILE="$DIR/henryivrevival.env"
    cp "$ROOT/docker-compose.example.yml" "$DIR/docker-compose.yml"
    cp "$ROOT/.env.example" "$ENV_FILE"
    cp -r "$ROOT/deploy" "$DIR/deploy"
    cp "$ROOT/.env.example" "$DIR/.env.example"
    sed -i -e "s|^APP_IMAGE=.*|APP_IMAGE='${IMAGE}'|" -e "s|^OPENAI_API_KEY=.*|OPENAI_API_KEY=sk-compose-smoke-not-a-key|" "$ENV_FILE"
    printf '%s\n' 'OPENAI_BASE_URL=http://127.0.0.1:9999/v1' >> "$ENV_FILE"
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
  [ "$(dc exec -T "$SVC" id -u | tr -d '\r')" = "$WANT_UID" ] || fail "runs as uid $(dc exec -T "$SVC" id -u), want $WANT_UID"
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

wait_healthy() {  # image HEALTHCHECK (legacy) / compose healthcheck (template): GET /healthz on $PORT
  local cid state
  cid="$(dc ps -q "$SVC")"
  for _ in $(seq 1 60); do
    state="$(dk inspect -f '{{if .State.Health}}{{.State.Health.Status}}{{else}}no-healthcheck{{end}}' "$cid")"
    case "$state" in healthy) return 0 ;; unhealthy|no-healthcheck) fail "container $state" ;; esac
    sleep 2
  done
  fail "not healthy ($state)"
}

# `hosh-deploy register` (scripts/hosh-deploy in hosh-migration): conf fields, `# required:` secrets set, and
# the compose hardening check, verbatim.
register_check() {
  step "hosh-deploy register validation (conf, required secrets, compose hardening)"
  local conf="$DIR/deploy/hosh-deploy.conf" k v
  conf_get() { sed -n "s/^$1=//p" "$conf" | tail -n1; }
  for k in SERVICE IMAGE_VAR IMAGE_REPO ENV_FILE HOST BIND HEALTH; do [ -n "$(conf_get $k)" ] || fail "conf: $k missing"; done
  [[ "$(conf_get IMAGE_REPO)" =~ ^ghcr\.io/pazka/[a-z0-9._-]+$ ]] || fail "conf: IMAGE_REPO"
  [[ "$(conf_get BIND)" =~ ^127\.0\.0\.1:[0-9]{2,5}$ ]] || fail "conf: BIND"
  [[ "$(conf_get HOST)" =~ ^[a-z0-9.-]+$ ]] && [[ "$(conf_get HEALTH)" =~ ^/[A-Za-z0-9/_.-]*$ ]] && [[ "$(conf_get IMAGE_VAR)" =~ ^[A-Z][A-Z0-9_]*$ ]] || fail "conf: HOST/HEALTH/IMAGE_VAR"
  [ "$(conf_get SERVICE)" = "$SVC" ] && [ "$(conf_get ENV_FILE)" = "$(basename "$ENV_FILE")" ] && [ "$(conf_get BIND)" = 127.0.0.1:9139 ] \
    && [ "$(conf_get HOST)" = henryivrevival.hosh.it ] && [ "$(conf_get IMAGE_VAR)" = APP_IMAGE ] || fail "conf values"
  local req; req="$(sed -n 's/^# required:[[:space:]]*//p' "$DIR/.env.example" | head -n1)"
  [ "$req" = OPENAI_API_KEY ] || fail "# required: line is '$req'"
  for k in $req; do
    v="$(sed -n "s/^$k=//p" "$ENV_FILE" | tail -n1 | sed -e "s/^'\(.*\)'$/\1/" -e 's/^"\(.*\)"$/\1/')"
    [ -n "$v" ] || fail "$k empty"
    [ -z "$(sed -n "s/^$k=//p" "$DIR/.env.example")" ] || fail ".env.example must not hold a value for $k"
  done
  grep -q 'Host(`@@HOST@@`)' "$DIR/deploy/traefik-route.yml.tmpl" || fail "route template has no Host(@@HOST@@) rule"
  dk compose --project-directory "$DIR" --env-file "$ENV_FILE" -f "$DIR/docker-compose.yml" config --format json \
    | python3 -c '
import json, sys
svc, bind = sys.argv[1], sys.argv[2]
d = json.load(sys.stdin); bad = []
if svc not in d.get("services", {}): bad.append("service %s not in compose" % svc)
for name, s in d.get("services", {}).items():
    p = name + ": "
    u = str(s.get("user", "")).split(":")[0]
    if u in ("", "0", "root"): bad.append(p + "user must be non-root")
    if not s.get("read_only"): bad.append(p + "read_only: true required")
    if "ALL" not in (s.get("cap_drop") or []): bad.append(p + "cap_drop: [ALL] required")
    if s.get("cap_add"): bad.append(p + "cap_add not allowed")
    if not any(o.replace(" ", "") in ("no-new-privileges:true", "no-new-privileges") for o in (s.get("security_opt") or [])): bad.append(p + "no-new-privileges required")
    if s.get("privileged"): bad.append(p + "privileged not allowed")
    for k in ("network_mode", "pid", "ipc", "userns_mode", "uts"):
        if str(s.get(k, "")).startswith("host"): bad.append(p + k + ": host not allowed")
    if s.get("devices"): bad.append(p + "devices not allowed")
    for v in s.get("volumes") or []:
        if v.get("type") not in ("volume", "tmpfs"): bad.append(p + "only named volumes/tmpfs (got %s %s)" % (v.get("type"), v.get("source")))
    for pt in s.get("ports") or []:
        if pt.get("host_ip") not in ("127.0.0.1", "::1"): bad.append(p + "ports must bind 127.0.0.1")
        elif "%s:%s" % (pt.get("host_ip"), pt.get("published")) != bind: bad.append(p + "published %s:%s != BIND %s" % (pt.get("host_ip"), pt.get("published"), bind))
    if not s.get("healthcheck") or s["healthcheck"].get("disable"): bad.append(p + "healthcheck required")
print("\n".join("  ✗ " + b for b in bad) if bad else "  ✓ hardened (non-root, read-only, cap_drop ALL, no-new-privileges, no host access, loopback port, healthcheck)")
sys.exit(1 if bad else 0)' "$SVC" "$(conf_get BIND)" || fail "compose does not pass hosh-deploy register"
}

# What `hosh-deploy deploy` verifies after `compose up`: healthy, non-root + read-only rootfs, loopback
# /healthz status ok, then POST_DEPLOY inside the container (plain argv).
deploy_check() {
  step "hosh-deploy verify: healthy, non-root, read-only rootfs, /healthz, POST_DEPLOY"
  local cid uid
  cid="$(dc ps -q "$SVC")"
  wait_healthy
  uid="$(dk inspect -f '{{.Config.User}}' "$cid")"; [ "${uid%%:*}" = 10001 ] || fail "user $uid"
  [ "$(dk inspect -f '{{.HostConfig.ReadonlyRootfs}}' "$cid")" = true ] || fail "rootfs writable"
  if dc exec -T "$SVC" touch /usr/src/app/x 2>/dev/null; then fail "wrote to the rootfs"; fi
  code 200 "$BASE/healthz"
  python3 -c 'import json,sys; j=json.load(open(sys.argv[1])); assert j=={"status":"ok","openai_key":True,"static_files":True,"tmp_writable":True,"chat_model":"gpt-5.6-sol","tts_model":"tts-1"}, j' "$TMP" || fail "/healthz: $(cat "$TMP")"
  ! grep -q 'sk-compose-smoke' "$TMP" || fail "/healthz shows the key"
  [ "$(dk inspect -f '{{json .Mounts}}' "$cid")" = '[]' ] || fail "unexpected mounts: $(dk inspect -f '{{json .Mounts}}' "$cid")"
  local -a pd
  read -r -a pd <<< "$(sed -n 's/^POST_DEPLOY=//p' "$DIR/deploy/hosh-deploy.conf")"
  [ "${#pd[@]}" -gt 0 ] || fail "POST_DEPLOY empty"
  dc exec -T "$SVC" "${pd[@]}" || fail "POST_DEPLOY failed"
}

[ "$MODE" = template ] && register_check

step "up: $IMAGE"
dc up -d --quiet-pull
wait_up
if [ "$MODE" = template ]; then deploy_check; else step "healthy (image HEALTHCHECK on port 3000)"; wait_healthy; fi
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
[ "$(dk inspect -f '{{.HostConfig.RestartPolicy.Name}}' "$(dc ps -q "$SVC")")" = "$RESTART" ] || fail "restart policy"

SMOKE_OK=1
echo "COMPOSE SMOKE OK ($MODE, $IMAGE)"
