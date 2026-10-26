# Migrations

Dated record of changes to how the app is built or run, with the way back.

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
