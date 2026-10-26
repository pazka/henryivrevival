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
```

(Windows Git Bash: prefix `docker run` with `MSYS_NO_PATHCONV=1`, mount `"$(cygpath -w "$PWD")"`.)

## CI

`ci.yml` (PRs, `main`, `agent/**`, no secret, pushes nothing): `server tests (node 20|26)` (`npm ci`,
`npm run build`, tests),
`container smoke`. `publish.yml` (legacy Docker Hub image) now only builds on PRs and pushes on `main`.

## What is covered (`test/server.test.js`, 10 tests)

Page, `/chat/init` (system prompt), mp3 404 before any answer, `POST /chat` 204; a chat round-trip with the
exact OpenAI requests (moderation of the visitor text, completion with `gpt-5.6-sol`, `reasoning_effort:
none`, `max_completion_tokens: 500`, a hashed `safety_identifier` stable per visitor, then TTS `tts-1` /
`fable`) and the mp3 served; a tampered system prompt from the browser is dropped; empty completion voiced
with the apology; flagged text gets the in-character refusal without a completion; validation (shape, roles,
sizes, last turn, 32 kB body limit) with nothing reaching OpenAI; foreign `Origin` refused; an OpenAI error
answers 502 and the server keeps running; per-visitor and global daily limits.

`scripts/smoke.sh` repeats the round-trip and the protections against the built image.

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
