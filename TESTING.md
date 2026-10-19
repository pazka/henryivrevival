# Testing

Safety net for upgrades (Node base image, ts-node / TypeScript, Express, openai SDK, Actions): it pins what
the séance app does today so a Dependabot PR is judged on its CI run. **No test talks to OpenAI**: a local
fake answers through `OPENAI_BASE_URL`, with a dummy key.

## Run it

```bash
# server tests: black-box, spawn `ts-node main.ts` against a fake OpenAI
docker run --rm -v "$PWD":/src:ro node:20-alpine sh -c \
  'mkdir /a && cd /src && tar --exclude=./node_modules -cf - . | tar -xf - -C /a && cd /a \
   && npm ci && node --test --test-reporter=spec test/server.test.js'

# container smoke: the built image, fake OpenAI started inside the container
docker build -t henryivrevival:smoke . && bash scripts/smoke.sh henryivrevival:smoke
```

(Windows Git Bash: prefix `docker run` with `MSYS_NO_PATHCONV=1`, mount `"$(cygpath -w "$PWD")"`.)

## CI (`.github/workflows/ci.yml`)

PRs, `main`, `agent/**`: `server tests (node 20|26)` and `container smoke`. Uses no secret, pushes nothing,
so it also works on Dependabot PRs.

## What is covered

`test/server.test.js` (2 tests, Node built-ins): page, `/chat/init` (system prompt), `/chat/send` → exactly
one chat completion (`gpt-4o-2024-05-13`, the client's messages) then one TTS call (`tts-1`, voice `fable`,
the answer or the built-in apology) → mp3 served at `/chat/complete/mp3/*`; and the crash below.

`scripts/smoke.sh`: the built image boots with a dummy key, serves the page and init, and does a full chat
round-trip against a fake OpenAI inside the container.

## Upgrades checked (2026-10-19)

- **Node 20 → 26** (Dependabot #6): tests 2/2 on 26.12 (ts-node still runs `main.ts`), image smoke OK on
  `node:26-alpine` → **go**.

## Dependabot builds fail: "Username and password required"

`.github/workflows/publish.yml` runs on `pull_request` and logs into Docker Hub with
`secrets.DOCKERHUB_TOKEN`. Runs triggered by Dependabot receive no Actions secrets, so the login step fails.
It is also unsafe: on any PR it would build and **push `pazka/henryivrevival:latest`**. Proposed fix (NOT
applied, owner to approve): PRs build only, a push to `main` logs in and pushes.

```diff
--- a/.github/workflows/publish.yml
+++ b/.github/workflows/publish.yml
@@ -6,11 +6,13 @@
   pull_request:
     branches: [ "main" ]
 
+# PRs (incl. Dependabot, which gets no Actions secrets) only build; only a push to main logs in and pushes.
 jobs:
   buildnpublish:
     runs-on: ubuntu-latest
     steps:
       - name: Log in to Docker Hub
+        if: github.event_name == 'push'
         uses: docker/login-action@f4ef78c080cd8ba55a85445d5b36e214a81df20a
         with:
           username: ${{ vars.DOCKERHUB_LOGIN }}
@@ -24,6 +26,5 @@
         with:
           context: .
           file: ./Dockerfile
-          push: true 
-          tags: pazka/henryivrevival:latest     
-      
\ No newline at end of file
+          push: ${{ github.event_name == 'push' }}
+          tags: pazka/henryivrevival:latest
```

`GITHUB_TOKEN` + `packages: write` does not apply here (it targets ghcr, not Docker Hub); `deploy.yml` /
`release.yml` already publish to ghcr with `GITHUB_TOKEN`. If the box only uses ghcr, deleting
`publish.yml` (the Docker Hub path) is the simpler alternative. Its open action bumps (#1, #4, #8, #9) only
touch that legacy workflow.

## Known gaps (pinned, not changed)

- **An OpenAI error kills the server** (no error handling in the async routes → unhandled rejection).
- `POST /chat/send` is an unauthenticated proxy to the owner's OpenAI key with client-controlled messages
  (cost abuse; the system prompt can be replaced).
- The model id `gpt-4o-2024-05-13` is hard-coded: when OpenAI retires it, the app stops answering.
- The app does not boot without `OPENAI_API_KEY`.
- `POST /chat` never answers; the mp3 is one shared `./tmp.mp3` (concurrent users overwrite each other, and
  the rootfs cannot be read-only); `ts-node` compiles at every start; image runs as root.
