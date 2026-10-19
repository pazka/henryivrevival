# CLAUDE.md — pazka/henryivrevival

Séance web app: the browser talks to "Henri IV" (OpenAI chat + TTS) through `main.ts` (Express, run with
ts-node), static UI in `public/`. Owner: Alexandre (pazka). Read **TESTING.md** first.

## Maintenance (autonomous agent)
Goal: keep the base image, dependencies and Actions current **without changing behaviour**.
- **Gate = `ci` green**: `server tests (node 20|26)` + `container smoke`. Tests never call OpenAI.
- **Branches**: work on `agent/<topic>`; CI runs without a PR. Never push to `main` (`deploy.yml`,
  `release.yml`, `publish.yml` publish images from it), never tag. **The owner merges.**
- **Dependabot PRs**: green → summarise risk in a PR comment. Red → reproduce per TESTING.md, smallest fix on
  an `agent/` branch. Never weaken or delete a test.
- `publish.yml` fails on Dependabot runs; the fix is in TESTING.md and waits for the owner's approval.

## Rules
- Never use, print or commit a real `OPENAI_API_KEY` (or any `.env`); tests use a dummy key and a fake API.
- No new dependency without the owner's yes (tests use Node built-ins only).
- Run installs and tests in containers (TESTING.md), not on the owner's machine.
