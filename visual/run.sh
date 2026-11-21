#!/usr/bin/env bash
# Visual regression of the built image (hosh-management AGENTS.md §3, use cases in TESTING.md
# "Visual use cases"). Pattern of pazka/DrawTogether visual/:
#   visual/run.sh [IMAGE]                (default henryivrevival:smoke)
# Starts the image as docker-compose.example.yml runs it (uid 10001, read-only rootfs, tmpfs /tmp, cap_drop ALL,
# no-new-privileges, PORT 8000, pids/memory limits) with a DUMMY key and OPENAI_BASE_URL pointing at a fake
# OpenAI (visual/fake-openai.mjs, run by the image's own node in its own hardened container, on a docker network
# of this runner only: fixed text, fixed silent mp3). Starts two headless Chromes on the runner (mouse / touch)
# that open http://henry.test:9877 (mapped to 127.0.0.1; every other host name resolves to nothing), then runs
# visual/shoot.mjs with the image's own node (built-in fetch + WebSocket, no package installed): every use case at
# 1400 / 1024 / 390 is compared with visual/baseline/. Shots, diffs and report.json: $OUT.
#   CHROME=/path/to/chrome (default google-chrome)   OUT=visual/out   VISUAL_PRINT_NEW=1 (CI: failing
#   shots printed in the log, visual/from-log.mjs writes them back as files).   ONLY=V3 (cases starting with V3)
# New baselines (QA, in a PR that says the change is wanted): take them from the CI log of the runner's
# Chrome with visual/from-log.mjs, look at every picture, commit them.
set -euo pipefail
cd "$(dirname "$0")/.."
ROOT="$PWD"
IMAGE="${1:-henryivrevival:smoke}"
[ $# -gt 0 ] && shift
OUT="${OUT:-visual/out}"
NAME="henry-visual-$$"
FAKE="henry-visual-openai-$$"
NET="henry-visual-$$"
PORT=9877
CDP_DESKTOP=9361
CDP_PHONE=9362
P1="$(mktemp -d)"; P2="$(mktemp -d)"
LOGS="$(mktemp -d)"
PIDS=()
dk() { MSYS_NO_PATHCONV=1 docker "$@"; }
cleanup() {
  for p in "${PIDS[@]}"; do kill "$p" 2>/dev/null || true; done
  # wait for the Chromes to exit: a profile still being written makes rm -rf fail ("Directory not empty")
  # and, under set -e, that turned a green run red after "0 failure(s)" (fix of pazka/StoraAlex#31)
  for p in "${PIDS[@]}"; do wait "$p" 2>/dev/null || true; done
  dk rm -f "$NAME" "$FAKE" >/dev/null 2>&1 || true
  dk network rm "$NET" >/dev/null 2>&1 || true
  rm -rf "$P1" "$P2" "$P1.log" "$P2.log" "$LOGS" 2>/dev/null ||
    { sleep 2; rm -rf "$P1" "$P2" "$P1.log" "$P2.log" "$LOGS" || true; }
  return 0
}
trap cleanup EXIT
fail() { echo "VISUAL FAIL: $*" >&2; exit 1; }
HARDEN=(--user 10001:10001 --read-only --cap-drop ALL --security-opt no-new-privileges:true --pids-limit 128 --memory 512m)

# A network of this runner only (--internal: no route out): the app reaches the fake as fake-openai:9999.
dk network create --internal "$NET" >/dev/null
dk run -d --name "$FAKE" --network "$NET" --network-alias fake-openai "${HARDEN[@]}" \
  -v "$ROOT/visual:/v:ro" --entrypoint node "$IMAGE" /v/fake-openai.mjs 9999 >/dev/null

# The app as docker-compose.example.yml runs it, its port published on loopback (default bridge), then joined to
# the fake's network. The rate limits are raised: every request of the harness comes from one address (27 shots,
# up to 3 questions each); the limits themselves are tested by test/server.test.js and scripts/smoke.sh.
dk run -d --name "$NAME" "${HARDEN[@]}" --tmpfs /tmp:size=16m,mode=1777 \
  -e PORT=8000 -e OPENAI_API_KEY=sk-visual-not-a-key -e OPENAI_BASE_URL=http://fake-openai:9999/v1 \
  -e CHAT_RATE_PER_MINUTE=10000 -e CHAT_RATE_PER_HOUR=10000 -e CHAT_DAILY_BUDGET=10000 \
  -p "127.0.0.1:$PORT:8000" "$IMAGE" >/dev/null
dk network connect "$NET" "$NAME"
for _ in $(seq 1 60); do
  curl -fsS "http://127.0.0.1:$PORT/healthz" >/dev/null 2>&1 && break
  sleep 0.5
done
curl -fsS "http://127.0.0.1:$PORT/healthz" >/dev/null || { dk logs "$NAME" 2>&1 | tail -40; fail "app not healthy"; }
test "$(dk exec "$NAME" id -u)" = 10001 || fail "app does not run as 10001"

RULES="MAP henry.test 127.0.0.1, MAP * ~NOTFOUND"  # = visual/cdp.mjs RESOLVER_RULES
COMMON=(--headless=new --no-sandbox --disable-gpu --mute-audio --no-first-run --hide-scrollbars
  --force-color-profile=srgb --font-render-hinting=none --disable-features=Translate,MediaRouter
  --disable-background-networking "--host-resolver-rules=$RULES"
  --unsafely-treat-insecure-origin-as-secure=http://henry.test:$PORT  # https on the live site: a secure context
  --use-fake-ui-for-media-stream --use-fake-device-for-media-stream --autoplay-policy=no-user-gesture-required)  # = MEDIA_FLAGS
"${CHROME:-google-chrome}" "${COMMON[@]}" \
  --blink-settings=primaryHoverType=2,availableHoverTypes=2,primaryPointerType=4,availablePointerTypes=4 \
  --remote-debugging-port=$CDP_DESKTOP --user-data-dir="$P1" about:blank >"$P1.log" 2>&1 &
PIDS+=($!)
"${CHROME:-google-chrome}" "${COMMON[@]}" \
  --remote-debugging-port=$CDP_PHONE --user-data-dir="$P2" about:blank >"$P2.log" 2>&1 &
PIDS+=($!)
# both DevTools endpoints up before the harness connects (Chrome's own output shown if one never comes)
for port in $CDP_DESKTOP $CDP_PHONE; do
  for _ in $(seq 1 120); do curl -fsS "http://127.0.0.1:$port/json/version" >/dev/null 2>&1 && break; sleep 0.5; done
  curl -fsS "http://127.0.0.1:$port/json/version" >/dev/null 2>&1 || {
    echo "VISUAL FAIL: Chrome (${CHROME:-google-chrome}) has no DevTools endpoint on 127.0.0.1:$port" >&2
    tail -30 "$P1.log" "$P2.log" >&2; exit 1; }
done

rm -rf "$OUT"; mkdir -p "$OUT"; chmod 777 "$OUT"
set +e
dk run --rm --network host "${HARDEN[@]}" \
  -e CDP_DESKTOP=$CDP_DESKTOP -e CDP_PHONE=$CDP_PHONE -e OUT=/out -e BASELINE=/v/baseline/ \
  -e ONLY="${ONLY:-}" \
  -v "$ROOT/visual:/v:ro" -v "$ROOT/$OUT:/out" --entrypoint node "$IMAGE" \
  /v/shoot.mjs "http://henry.test:$PORT" "$@"
rc=$?
set -e

# VISUAL_PRINT_NEW=1: every failing shot is printed in the log as VISUAL-PNG lines (visual/from-log.mjs). Printed
# here from the files in $OUT: ~1 MB per shot, and the end of a long output of `docker run` was lost in CI.
if [ -n "${VISUAL_PRINT_NEW:-}" ] && [ -f "$OUT/report.json" ]; then
  dk run --rm "${HARDEN[@]}" --network none -v "$ROOT/$OUT:/out:ro" --entrypoint node "$IMAGE" \
    -e 'for (const f of require("/out/report.json").failures) console.log(f.name)' >"$LOGS/failed.txt"
  while read -r name; do
    [[ "$name" =~ ^[A-Za-z0-9._-]+\.png$ ]] && [ -f "$OUT/$name" ] || continue
    sum="$(sha256sum "$OUT/$name" | cut -d' ' -f1)"
    base64 -w 8000 "$OUT/$name" >"$LOGS/b64"
    n="$(wc -l <"$LOGS/b64")"; i=0
    while read -r chunk; do i=$((i + 1)); echo "VISUAL-PNG $name $i/$n $sum $chunk"; done <"$LOGS/b64"
  done <"$LOGS/failed.txt"
fi

# Logs go to files first, then grep the files (a `docker logs | grep -q` pipe under pipefail can fail on SIGPIPE).
dk logs "$NAME" >"$LOGS/app.log" 2>&1 || true
dk logs "$FAKE" >"$LOGS/fake.log" 2>&1 || true
cp "$LOGS/app.log" "$OUT/app.log"; cp "$LOGS/fake.log" "$OUT/fake-openai.log"
if grep -qiE 'unhandled|uncaught|TypeError|ReferenceError' "$LOGS/app.log"; then
  echo "VISUAL FAIL: server logged an error" >&2
  grep -iE -B2 -A5 'unhandled|uncaught|TypeError|ReferenceError' "$LOGS/app.log" | head -40 >&2
  rc=1
fi
# The answers came from the fake, with the dummy key.
if [ -z "${ONLY:-}" ]; then
  for what in '/v1/moderations key=dummy' '/v1/chat/completions key=dummy' '/v1/audio/speech key=dummy'; do
    grep -qF "$what" "$LOGS/fake.log" || { echo "VISUAL FAIL: the fake OpenAI never got $what" >&2; rc=1; }
  done
fi
if grep -qF 'key=UNEXPECTED' "$LOGS/fake.log"; then echo "VISUAL FAIL: the app sent another key than the dummy one" >&2; rc=1; fi
exit $rc
