# Migrations

Dated record of changes to how the app is built or run, with the way back.

## 2026-11-06 — hosh-deploy template app (healthz, PORT 8000 compose, release → deploy)

- **Change**: `GET /healthz` (key configured, static files, writable `/tmp`; never calls OpenAI, never shows the
  key), image `HEALTHCHECK` (`node check/healthcheck.js`, on `$PORT`), `check/smoke.js` (POST_DEPLOY). Box files:
  `deploy/hosh-deploy.conf` (BIND 127.0.0.1:9139), `deploy/traefik-route.yml.tmpl`, `docker-compose.example.yml`
  (uid 10001, read-only, tmpfs, `PORT=8000`), `.env.example`, `DEPLOY.md` (incl. the cutover). Workflows:
  `deploy.yml` (name `build-scan-push`) renamed `build-scan-push.yml` unchanged; new `deploy.yml` = hosh-deploy;
  `release.yml` runs tests + all smokes before pushing, adds `:X.Y` and a GitHub release, and deploys stable tags
  (no-op without `HOSH_DEPLOY_KEY`); Trivy from its pinned image instead of `trivy-action`.
- **Unchanged**: default port 3000, user `node`, endpoints, env vars, `:vX.Y.Z` / `:latest` / `:<sha>` tags,
  prerelease tags never move `:latest`, Docker Hub `publish.yml`. The legacy compose works as is (CI:
  `compose-smoke.sh legacy`). Start-up log prints the real port (same text with the default).
- **Box**: nothing until the cutover (DEPLOY.md §1c). The legacy container now shows a health status.
- **Rollback**: redeploy the previous image (`v1.1.1`), or revert the merge commit on `main`.

## 2026-11-06 — Node 26.13.0 base image (CVE-2026-111497), Node 20 dropped from CI

- **Change**: both Dockerfile stages `FROM node:26.13.0-alpine@sha256:8996bb58…` (was the floating `node:26-alpine`,
  Node 26.12.0 in v1.1.0: Brotli RCE in `node:zlib`, fixed in 26.12.1). CI test matrix `[20, 26]` → `[26]` (Node 20
  is EOL). New guardrail `scripts/check-node-version.sh` after every image build, before every push
  (pazka/hosh-management#5).
- **Unchanged**: application code, dependencies, port 3000, env vars, user `node`, read-only rootfs with tmpfs `/tmp`.
- **Box**: nothing to do beyond pinning the new tag; same run options.
- **Rollback**: redeploy the previous image (or revert the merge commit on `main`).

## 2026-10-26 — TypeScript 7: compiled `dist/` replaces ts-node at runtime

- **Change**: `typescript` 5.4.5 → 7.0.2 (supersedes Dependabot #14); `ts-node` removed. The image compiles
  with `tsc` in a build stage and runs `node dist/main.js` (was `node node_modules/ts-node/dist/bin.js main.ts`).
  Runtime image holds production dependencies only. `express` moved to `dependencies` (same 5.3.0).
- **Unchanged**: port 3000, endpoints, `public/`, env vars (`OPENAI_API_KEY`, `OPENAI_BASE_URL`, `OPENAI_*_MODEL`,
  `CHAT_*`, `TRUST_PROXY_HOPS`, `PORT`), `.env` read from `/usr/src/app` by dotenv, user `node`, read-only rootfs
  with tmpfs `/tmp`.
- **Tested**: server tests 10/10 on node 20 and 26, `scripts/smoke.sh` on the hardened image, manual run of the
  image CMD with `.env`-only configuration (see TESTING.md).
- **Box**: nothing to do; same run options, the new image is a drop-in replacement.
- **Rollback**: redeploy the previous image, `ghcr.io/pazka/henryivrevival:711fd99708b7634a0671a563e21a925243ac1053`
  (last `main` build before this change), or revert the merge commit on `main`.
