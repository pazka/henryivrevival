# Testing

Safety net for upgrades and for the protections of the one route that spends OpenAI credit. **No test talks
to OpenAI**: a local fake answers through `OPENAI_BASE_URL`, with a dummy key.

## Run it

```bash
# server tests: black-box, compile with tsc then spawn `node dist/main.js` against a fake OpenAI
docker run --rm -v "$PWD":/src:ro node:26-alpine sh -c \
  'mkdir /a && cd /src && tar --exclude=./node_modules -cf - . | tar -xf - -C /a && cd /a \
   && npm ci --ignore-scripts && npx tsc && node --test --test-reporter=spec test/server.test.js'

# container smoke: the built image hardened (non-root, read-only rootfs), fake OpenAI inside the container
docker build -t henryivrevival:smoke . && bash scripts/smoke.sh henryivrevival:smoke

# compose smoke: the same image through `docker compose`, exactly as the box runs it today
bash scripts/compose-smoke.sh legacy henryivrevival:smoke
bash scripts/compose-smoke.sh template henryivrevival:smoke   # hosh-deploy compose (uses 127.0.0.1:9139)
```

(Windows Git Bash: prefix `docker run` with `MSYS_NO_PATHCONV=1`, mount `"$(cygpath -w "$PWD")"`.)

## CI

`ci.yml` (PRs, `main`, `agent/**`, no secret, pushes nothing): `server tests (node 26)` (`npm ci`,
`npm run build`, tests),
`container smoke` (`scripts/smoke.sh`, then `scripts/compose-smoke.sh legacy` and `template`), `visual regression`
(`visual/run.sh`, see "Visual use cases"; shots, diffs and `report.json` uploaded as the artifact `visual-<sha>`). `release.yml`
runs the same tests and smokes before any push, then deploys stable tags through `deploy.yml` (hosh-deploy, a
no-op until the `HOSH_DEPLOY_KEY` secret exists; DEPLOY.md). `publish.yml` (legacy Docker Hub image) now only builds on PRs and pushes on `main`.
Every workflow that builds the image (`ci.yml` smoke, `build-scan-push.yml`, `release.yml`, `publish.yml`) runs
`scripts/check-node-version.sh <image>` right after the build and before any push: it fails if the image's Node
is EOL or below the patched minimum of its line (CVE-2026-111497, pazka/hosh-management#5). `ci.yml` also
asserts it rejects `node:24.21.0-alpine` (the test of the test).

## What is covered (`test/server.test.js`, 14 tests)

Page, `/chat/init` (system prompt), mp3 404 before any answer, `POST /chat` 204; a chat round-trip with the
exact OpenAI requests (moderation of the visitor text, completion with `gpt-5.6-sol`, `reasoning_effort:
none`, `max_completion_tokens: 500`, a hashed `safety_identifier` stable per visitor, then TTS `tts-1` /
`fable`) and the mp3 served; a tampered system prompt from the browser is dropped; empty completion voiced
with the apology; flagged text gets the in-character refusal without a completion; validation (shape, roles,
sizes, last turn, 32 kB body limit) with nothing reaching OpenAI; foreign `Origin` refused; an OpenAI error
answers 502 and the server keeps running; per-visitor and global daily limits; `/healthz` (200 with the
capability fields, key never shown, no OpenAI call); no key ⇒ the server does not start; `check/smoke.js` (the
POST_DEPLOY of hosh-deploy) passes against a running server without calling OpenAI and fails when it is down.

`scripts/smoke.sh` repeats the round-trip and the protections against the built image.

`scripts/compose-smoke.sh legacy` (step of `container smoke`) pins what the move to hosh-deploy must keep: it
runs the image with the box's **current legacy compose** (verbatim: `env_file: .env`, `127.0.0.1:9988:3000`,
`no-new-privileges`, `cap_drop: [ALL]`, `restart: always`, the image's own user `node`, writable rootfs) and
checks the page, every file of `public/` byte for byte, `/chat/init`, `POST /chat`, the chat round-trip
(moderation → completion → TTS → mp3), the `/chat/send` protections (validation, 32 kB limit, foreign
origin, OpenAI error without crash), then the same after `docker compose restart` and after a re-create with
the optional `OPENAI_CHAT_MODEL` / `OPENAI_TTS_MODEL` / `OPENAI_MAX_COMPLETION_TOKENS` overrides; the
container must also turn healthy (image `HEALTHCHECK` on port 3000).

`scripts/compose-smoke.sh template` runs the same checks with what the box will run after the cutover:
`docker-compose.example.yml` + `.env.example` (uid 10001, read-only rootfs, tmpfs `/tmp`, `PORT=8000`,
`127.0.0.1:9139`), after `hosh-deploy register`'s validation (conf fields, `# required: OPENAI_API_KEY`, the
compose hardening check verbatim), and what `hosh-deploy deploy` verifies (healthy, uid 10001, read-only
rootfs, no mounts, `/healthz` body, the `POST_DEPLOY` argv of `deploy/hosh-deploy.conf` inside the container).

## Visual use cases (visual regression, hosh-management AGENTS.md §3)

`visual/run.sh IMAGE` (CI job `visual regression`): the built image runs as `docker-compose.example.yml` does
(uid 10001, read-only rootfs, tmpfs `/tmp`, cap_drop ALL, no-new-privileges, pids/memory limits, `PORT=8000`) with
a **dummy key** and `OPENAI_BASE_URL` pointing at `visual/fake-openai.mjs`: a fake OpenAI run by the image's own
node in its own hardened container, on an `--internal` docker network of the runner. It answers fixed text
chosen from the visitor's last message and 30 s of silent mp3 for every answer; `run.sh` fails if the app did not
call it (moderation, completion, speech) with the dummy key. The rate limits are raised for the run (every request
comes from one address); they are tested by `test/server.test.js`.
`visual/shoot.mjs` runs with the image's own node (no package): two headless Chromes of the runner (mouse for
1400 / 1024, touch for 390) open `http://henry.test:9877`; every other host resolves to nothing. Chrome treats
that origin as secure (the live site is https: `speech.mjs` needs `navigator.mediaDevices`), uses its fake
microphone, and plays audio muted without a gesture.

The séance is driven by the visitor's **voice** and Henri answers with **audio**: a headless Chrome has neither.
Before the page's scripts, the harness replaces `webkitSpeechRecognition` with a stand-in it makes "hear" a
sentence (`speechstart`, then the recognition `result`, as Chrome fires them) and records the status of each
`POST /chat/send`; to end an answer it seeks Henri's audio to its end (the page's own `ended` handler runs).
Everything else is the page's own code. For stable pictures transitions are cut and the scene's CSS animations
(flashing apparition, moving eyes and mouth, pulsing ear) are **paused at 250 ms** of their 1 s cycle: eyes 20 px
left, mouth 20 px down, ear x1.1, apparition half visible, so the states that only animate still show.
Every case is shot at **1400, 1024 and 390 px** (height 900, phone 844) by a new visitor (new browser context) and
compared with `visual/baseline/<id>-<width>.png` (tolerance: channel 24, 0.1 % of the pixels). A page exception, a
missing picture or an `alert()` fails the shot.

| id | page / state | steps |
|---|---|---|
| V1-welcome | `/`: the séance table (`scene.jpg`) under the popup "Bienvenue sur le site de la séance de spiritisme" + "Commencer" | none |
| V2-started | popup closed, still `scene.jpg` (state INIT, see below) | click / tap "Commencer" |
| V3-apparition | Henri's first answer ("Whouuu... je suis l'esprit d'Henri IV"): the apparition (`scene_apparition.jpg`, flashing) while he speaks | V2, say "Bonjour Henri" |
| V4-listening | his answer over: Henri's face, eyes and mouth on the neutral scene (`scene_neutral_bg.jpg`) | V3, his audio ends |
| V5-hearing | the visitor starts speaking: Henri's ear (pulsing) over his face | V4, `speechstart` |
| V6-thinking | question sent, answer not back yet: the eyes move (ear gone) | V4, say a question the fake never answers ("SUSPENS...") |
| V7-talking | the answer to a question plays: the mouth moves | V4, say "Quelle fut votre plus grande bataille ?" |
| V8-goodbye | the farewell ("Hooo... Adieu, Adieu, Adieu") plays: the apparition flashes again, the neutral scene and eyes are gone | V4, say "Adieu Henri" |
| V9-after-goodbye | farewell over: back to `scene.jpg` (state INIT) | V8, his audio ends |
| V10-openai-error | OpenAI fails (`/chat/send` → 502): the page stays as while thinking (eyes moving), nothing is said | V4, say "BOOM" (the fake answers 400) |

States with the same picture as a case above (not shot again): a question that gets "..." from Henri (ignored by
`openai.mjs`: stays as V6), a refused question (429 rate limit, 400 validation, 403 origin: stays as V6), the
moderated in-character refusal (a normal answer: as V7), an answer without "whouu" before the apparition (stays
as V2: INIT accepts only the apparition).

What the pictures show today, pinned on purpose (not bugs fixed by the harness):
- "Commencer" asks for the state `"APPARITION"`, but `sceance.mjs` names it `STATES.APPARITION = 'APARTION'`, so
  the state stays INIT: the apparition only comes with Henri's first answer (V3), not on the click (V2).
- The mouth picture is never turned off: it stays over the apparition in V8 and floats alone over the table in V9.
- No mobile layout: the scene is as high as the screen and anchored left, so at 390 px Henri (in the middle of
  the scene) is off screen; every phone shot after V1 shows the same candles.
- The debug text box of `index.html` is never shown (the class is removed from the textarea, not its hidden parent).

Not covered, and why:
- Real speech recognition and real audio output: none on a runner (stand-in described above).
- Two visitors at once (they share one mp3, see Known gaps): the same pictures.
- After V9 the page is back in INIT and ignores further speech: same picture as V9.

New or changed baselines (a wanted visual change, said in the PR): CI prints every failing shot in the log
(`VISUAL-PNG` lines); `node visual/from-log.mjs <job log> visual/baseline --chrome` writes them back with their
sha256 checked. Look at every picture before committing it. Baselines are only meaningful for the runner's Chrome
(`visual/baseline/chrome.txt`); a local run with another Chrome may differ.
Local run: `docker build -t henryivrevival:smoke . && CHROME=/path/to/chrome bash visual/run.sh`
(`ONLY=V7 bash visual/run.sh` shoots only the cases whose id starts with V7).

## How `/chat/send` is protected (and why)

This follows OpenAI's "Safety best practices" for apps built on the API
(https://developers.openai.com/api/docs/guides/safety-best-practices), adapted to a public page without
accounts:

| practice | here |
|---|---|
| Constrain inputs; server-side prompt engineering | the system prompt is always the server's (browser `system` turns are dropped); only `user`/`assistant` text, ≤ 20 turns, ≤ 500 chars each, ≤ 32 kB body |
| Limit output tokens | `max_completion_tokens: 500` |
| Moderation API (free) | every visitor message goes through `omni-moderation-latest`; flagged → in-character refusal, no completion |
| `safety_identifier` | sha256 of a per-process salt + client IP (OpenAI asks for a hash, never raw identifying data); lets OpenAI attribute abuse to one visitor instead of the whole account |
| Abuse and cost control | 6 requests/min and 60/hour per visitor, 500/day in total (env `CHAT_RATE_PER_MINUTE`, `CHAT_RATE_PER_HOUR`, `CHAT_DAILY_BUDGET`); `Origin` must be this site |
| Resilience | OpenAI errors → 502 with the apology; before, an unhandled rejection killed the process |

Not done in code (owner side): set a **monthly budget / usage limit on the OpenAI project** of this key (the
hard cost cap), and keep this key in its own project so it can be revoked alone. KYC / login (OpenAI's
strongest recommendation) does not fit a one-off séance page; an access code could be added if the page
is ever abused.

## Changes and upgrades (2026-10-19)

- **Model**: `gpt-4o-2024-05-13` is shut down by OpenAI on **2026-10-23**; replaced by its official
  successor `gpt-5.6-sol` (`OPENAI_CHAT_MODEL` env to override). `tts-1` is retired on **2027-01-06**
  (replacement `gpt-realtime-2.1-mini`, a different API): to migrate before then.
- **Node 26** image (supersedes Dependabot #6), `npm ci` from the lockfile, runs as `node`, read-only rootfs
  possible (mp3 in `/tmp`), no npm at runtime.
- `npm audit fix` (no `--force`): 9 advisories → 0 (Express 4.22.3 etc.); unused `body-parser` removed.
  `openai` SDK stays 4.49.1 (7.x is three majors away, Node ≥ 22: a separate, tested step).
- `publish.yml`: PR builds no longer log in or push (Dependabot runs failed with "Username and password
  required", and a PR could have overwritten `:latest`); actions pinned by SHA (supersedes #1, #4, #8, #9).

## TypeScript 7: compiled build instead of ts-node (2026-10-26)

- **Why**: TypeScript 7.0.2 (Dependabot #14) is the native compiler; its npm package no longer exposes the JS
  compiler API, so `ts-node` crashed at start (`Cannot read properties of undefined (reading 'fileExists')`).
- **What**: `ts-node` removed. `tsc` (TS 7, `npm run build`) compiles `*.ts` to `dist/` in a build stage of the
  `Dockerfile`; the runtime stage has production dependencies only (`npm ci --omit=dev`: no typescript,
  no `@types`) and runs `node dist/main.js` (`npm start`). `express` moved from devDependencies to
  dependencies (it is needed at runtime; same version). `tsconfig.json`: only `outDir: ./dist` added; TS 7
  compiles the code as is. The working directory stays `/usr/src/app`, so `express.static('public')` and
  dotenv's `.env` resolve exactly as before; nothing is compiled or cached at start (read-only rootfs, ~1 s
  faster start).
- TS 7's `tsc` runs on `node:*-alpine` (musl): the npm package installs a static per-platform binary
  (`@typescript/typescript-linux-x64`), no glibc needed. It works under Node 20 and 26, and the emitted
  CommonJS (target es2016) runs on both, so the test matrix stays `[20, 26]`.
- **Tests**: the server tests now spawn `node dist/main.js` (build first); assertions unchanged. Verified:
  10/10 on node 20 and 26, `scripts/smoke.sh` green on the hardened image, and by hand the image's CMD with
  the key and `OPENAI_BASE_URL` coming only from a mounted `.env` (page, `/openai.mjs`, `/chat/init`, chat
  round-trip with that key, mp3 under a nested `/chat/complete/mp3/a/b.mp3`, `POST /chat` 204). Rollback in
  `MIGRATIONS.md`.

## Known gaps (kept)

- The mp3 is one shared file: two simultaneous visitors can hear each other's answer.
