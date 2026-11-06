# Deploying henryivrevival.hosh.it

Deployment on the hosh.it box (box standard: owner's `11-BOX-STANDARD.md`; template app like `pazka/plats`
and `pazka/blueprincedraw`). Releases deploy themselves through **hosh-deploy** (§1) once the app is
registered. Until the cutover (§1c) the box runs the **legacy compose** in `/root/hosh-deploy/henryivrevival`,
and every image keeps working with it unchanged (CI proves both: `scripts/compose-smoke.sh legacy|template`).

## 1. How releases go live (hosh-deploy, the only deploy path after the cutover)

Every stable release (`release` workflow: tag `vX.Y.Z`, or Actions → release with a version) ends with the
**`deploy`** job: GitHub connects to the box as `deployer` with this repo's `HOSH_DEPLOY_KEY` (bound to
henryivrevival only) and runs `hosh-deploy deploy henryivrevival vX.Y.Z`. The box pulls the image, swaps the tag
in `henryivrevival.env`, waits healthy, checks non-root + read-only rootfs, `/healthz` on the loopback port and
through Traefik, runs `POST_DEPLOY` inside the container (`deploy/hosh-deploy.conf`) and **rolls back by itself**
if any check fails (the workflow then goes red). Nothing from the repo runs on the host.

- While the repo has no `HOSH_DEPLOY_KEY` secret the deploy job only prints a notice: a release just builds and
  pushes `:vX.Y.Z`, `:X.Y`, `:<sha>`, `:latest` as before (the legacy box pins its tag by hand).
- Prerelease tags (`vX.Y.Z-rc.N`) push `:vX.Y.Z-rc.N` + `:<sha>` only: never `:latest`, never deployed.
- Redeploy / roll forward / back: Actions → **deploy** → `vX.Y.Z`, `rollback` or `status`.
- On the box (owner, or the on-box Claude without a sudo window): `sudo hosh-deploy deploy henryivrevival vX.Y.Z`,
  `sudo hosh-deploy rollback henryivrevival`, `sudo hosh-deploy status henryivrevival`. Log: `/var/log/hosh-deploy.log`.
- Repo variable `HOSH_AUTODEPLOY=false` stops auto-deploy after releases (manual dispatch still works).

## 1c. Cutover from legacy (once; on-box Claude in an owner-opened sudo window)

Box rules: `ACTIONS-LOG.md` intent BEFORE, result + revert AFTER; `/home/pazka/MIGRATION/scripts/smoke.sh` BEFORE
and AFTER. Prerequisites: a release **`v1.2.0` or later** (first image with `/healthz`, `check/`, PORT 8000 in the
template compose) built by Actions; the GHCR package `henryivrevival` **public** (owner, package settings: today it
is private, the box cannot pull anonymously; fallback = 11-BOX-STANDARD §6 export workflow, then deploy
`--pull never` by hand); `127.0.0.1:9139` free (`ss -ltn | grep 9139`). DNS does not change.

**No data to move**: the app is stateless (conversation in the visitor's browser, answer mp3 in `/tmp`). There
is no volume, neither in the legacy compose nor in the new one. Only the env values move.

Legacy today: `/root/hosh-deploy/henryivrevival/{docker-compose.yml,.env}`, `127.0.0.1:9988:3000`, router for
`henryivrevival.hosh.it` in `/root/hosh-deploy/edge/traefik/dynamic/routes.yml`.

```sh
# A — release checkout (docker-compose.example.yml, .env.example, deploy/*)
sudo mkdir -p /srv/henryivrevival && sudo chmod 750 /srv/henryivrevival && cd /srv/henryivrevival
[ -d .git ] || { sudo git init -q && sudo git remote add origin https://github.com/pazka/henryivrevival; }
sudo git fetch -q --depth 1 origin tag v1.2.0 && sudo git checkout -q v1.2.0
# B — env file from the template (no secret in it yet)
[ -e henryivrevival.env ] || sudo install -m 600 .env.example henryivrevival.env
```
**C — env values from the legacy `.env`** (names only, values never printed; run by the owner, or by the agent
since nothing is displayed). Moves `OPENAI_API_KEY` (required) and, if the legacy file sets them, the optional
`OPENAI_CHAT_MODEL`, `OPENAI_TTS_MODEL`, `OPENAI_MAX_COMPLETION_TOKENS`, `CHAT_RATE_PER_MINUTE`,
`CHAT_RATE_PER_HOUR`, `CHAT_DAILY_BUDGET`, `TRUST_PROXY_HOPS`, `SAFETY_ID_SALT`. Not moved: `PORT` (the new compose
sets 8000) and `OPENAI_BASE_URL` (tests only).
```sh
sudo bash -c 'set -e; L=/root/hosh-deploy/henryivrevival/.env; N=/srv/henryivrevival/henryivrevival.env
for k in OPENAI_API_KEY OPENAI_CHAT_MODEL OPENAI_TTS_MODEL OPENAI_MAX_COMPLETION_TOKENS CHAT_RATE_PER_MINUTE \
         CHAT_RATE_PER_HOUR CHAT_DAILY_BUDGET TRUST_PROXY_HOPS SAFETY_ID_SALT; do
  line="$(grep -m1 "^$k=" "$L" || true)"; [ -n "$line" ] || continue
  sed -i "/^$k=/d" "$N"; printf "%s\n" "$line" >> "$N"; echo "moved: $k"
done; chmod 600 "$N"'
```
```sh
# D — pin the box config (checks OPENAI_API_KEY is set, validates the compose hardening). NO deploy from the box.
sudo hosh-deploy register henryivrevival
# E — GitHub key (claude_agent: keygen; root: bind; gh: secret; private key shredded). If the agent is
#     blocked here, the owner runs these lines with `!`.
ssh-keygen -q -t ed25519 -N '' -C hosh-deploy:henryivrevival -f /tmp/henryivrevival-deploy
sudo /home/pazka/MIGRATION/scripts/setup-hosh-deploy.sh key henryivrevival /tmp/henryivrevival-deploy.pub
gh secret set HOSH_DEPLOY_KEY -R pazka/henryivrevival < /tmp/henryivrevival-deploy && shred -u /tmp/henryivrevival-deploy /tmp/henryivrevival-deploy.pub
# F — remove the legacy router + service for henryivrevival.hosh.it from routes.yml (coordinator, by hand: two
#     routers with the same Host rule would conflict once hosh-deploy writes henryivrevival.yml). The legacy
#     container keeps running (stateless, its port 9988 does not clash with 9139). Downtime starts here (~1-2 min).
sudo cp /root/hosh-deploy/edge/traefik/dynamic/routes.yml /root/routes.yml.pre-henryivrevival
sudoedit /root/hosh-deploy/edge/traefik/dynamic/routes.yml
# G — first deploy = CI: writes the Traefik route henryivrevival.yml, POST_DEPLOY, auto-rollback
gh workflow run deploy -R pazka/henryivrevival -f version=v1.2.0
#     If it fails (red run, route removed by hosh-deploy): restore routes.yml from the copy → legacy is live again.
# H — once G is green and §3 passes: stop the legacy compose (keep its files: they are the rollback)
cd /root/hosh-deploy/henryivrevival && sudo docker compose down
```
Then: Actions → deploy → `status`; replace `svc_henryivrevival` in the box smoke harness (`scripts/smoke.sh`)
with the checks of §3 against `127.0.0.1:9139` + `https://henryivrevival.hosh.it`; `scripts/smoke.sh all` (AFTER);
commit the route + routes.yml in `/root/hosh-deploy`; port registry: 9139 `live`, 9988 freed.

**Rollback of the cutover** (nothing to restore: no data):
`cd /srv/henryivrevival && sudo docker compose --env-file henryivrevival.env down` →
`sudo rm /root/hosh-deploy/edge/traefik/dynamic/henryivrevival.yml` →
`sudo cp /root/routes.yml.pre-henryivrevival /root/hosh-deploy/edge/traefik/dynamic/routes.yml` →
`cd /root/hosh-deploy/henryivrevival && sudo docker compose up -d` (legacy compose and `.env` were left untouched)
→ smoke. To retire hosh-deploy for the app as well: `sudo rm /etc/hosh-deploy/apps/henryivrevival.conf` +
`sudo .../setup-hosh-deploy.sh unkey henryivrevival` + delete the `HOSH_DEPLOY_KEY` secret.

## 2. Variables (`henryivrevival.env`, mode 600)

| Variable | Default | Who | Meaning |
|---|---|---|---|
| `APP_IMAGE` | `ghcr.io/pazka/henryivrevival:v1.2.0` | hosh-deploy | image tag (the only line hosh-deploy rewrites) |
| `APP_BIND` | `127.0.0.1:9139` | box | loopback publish address (must equal `BIND` of `deploy/hosh-deploy.conf`) |
| `OPENAI_API_KEY` | (empty) | **owner** (required) | OpenAI key of its own project, with a monthly budget; without it the app does not start |
| `OPENAI_CHAT_MODEL` | `gpt-5.6-sol` | optional | chat model |
| `OPENAI_TTS_MODEL` | `tts-1` | optional | TTS model (`tts-1` retires 2027-01-06) |
| `OPENAI_MAX_COMPLETION_TOKENS` | `500` | optional | output cap per answer |
| `CHAT_RATE_PER_MINUTE` / `CHAT_RATE_PER_HOUR` / `CHAT_DAILY_BUDGET` | `6` / `60` / `500` | optional | `/chat/send` limits (per visitor; all visitors per day) |
| `TRUST_PROXY_HOPS` | `1` | optional | proxy hops before the app (Traefik via docker-proxy) |
| `SAFETY_ID_SALT` | random per process | optional | salt of the hashed `safety_identifier` |
| `PORT` | `3000` in the image | compose | the hosh-deploy compose sets `8000`; the legacy compose keeps 3000 |

## 3. Capability checks (what "works" means: never calls OpenAI, it costs money)

`POST_DEPLOY` (`node /usr/src/app/check/smoke.js http://127.0.0.1:8000`, inside the container) runs all of these:
- `GET /healthz` → 200 `{"status":"ok","openai_key":true,"static_files":true,"tmp_writable":true,"chat_model":…,"tts_model":…}`
  (the key is reported as present, never shown; 503 `status:error` otherwise). `HEAD` answers too.
- `GET /` → 200 HTML; `/sceance.mjs`, `/speech.mjs`, `/openai.mjs` (javascript), `/henry.jpg`, `/scene.jpg` (jpeg) → 200.
- `GET /chat/init` → JSON array, `[0].role == "system"`, contains "Henri quatre".
- `POST /chat` → 204. `GET /chat/complete/mp3/x.mp3` → 200 or 404 (no answer yet), never 5xx.
- `POST /chat/send` guards, refused before OpenAI: `{"messages":"nope"}` → 400 `messages must be an array`;
  `Origin: https://other.example` → 403; 40 kB body → 413. `GET /.env` → 404.

Box smoke (`svc_henryivrevival`): the same against `https://henryivrevival.hosh.it` (the 400 check without an
`Origin` header). A real chat round-trip costs OpenAI credit: only by hand, by the owner. CI covers it with a fake
OpenAI (`scripts/smoke.sh`, `scripts/compose-smoke.sh`).

## 4. What runs

| Item | Value |
|---|---|
| Image | `ghcr.io/pazka/henryivrevival:vX.Y.Z` (node:26.13.0-alpine, pinned digest) |
| Upstream | container :8000 → `127.0.0.1:9139` (legacy: :3000 → `127.0.0.1:9988`) |
| Edge | `/root/hosh-deploy/edge/traefik/dynamic/henryivrevival.yml` (router `henryivrevival@file`, resolver `le`, HSTS) |
| Volume | none (stateless); `/tmp` tmpfs 16 MB for the answer mp3 |
| User / fs | uid 10001, read-only rootfs, cap_drop ALL, no-new-privileges, pids 128, mem 512m |
| Health | `GET /healthz` → `{"status":"ok", …}` (compose healthcheck + image `HEALTHCHECK`: `node check/healthcheck.js`) |
| Outbound | `api.openai.com` only (moderation, chat completion, TTS), from `/chat/send` |

## 5. Decisions / known limits
- Stateless ⇒ no `henryivrevival-data` volume and no data move (box standard rule 3 does not apply).
- Backward compatible: the image still defaults to port 3000 and user `node`, so the legacy compose works
  unchanged until the cutover; the hosh-deploy compose sets `PORT=8000` and `user: 10001:10001`.
- `/healthz` proves configuration, not OpenAI reachability (a real call costs money); a wrong or revoked key
  shows as 502 apologies on `/chat/send`, logged as `chat/send failed: 401 …`.
- `X-Forwarded-For`: trusted for `TRUST_PROXY_HOPS` (1) hop, i.e. the docker-proxy peer; the port is
  loopback-only so that peer is always Traefik.
- Logs are plain text lines (`console.log`), not JSON (unchanged from legacy).
- `publish.yml` (Docker Hub `pazka/henryivrevival:latest`, push to `main`) and `build-scan-push.yml` (ghcr `:ci` +
  `:<sha>`, push to `main`) are unchanged.
