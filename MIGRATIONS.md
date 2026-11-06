# Migrations

Dated record of changes to how the app is built or run, with the way back.

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
