# CLAUDE.md — pazka/henryivrevival

Séance web app: the browser talks to "Henri IV" (OpenAI chat + TTS) through `main.ts` (Express; compiled by
`tsc` (TypeScript 7) to `dist/`, run with `node dist/main.js`), static UI in `public/`. `chatGuard.ts` protects `/chat/send`. Owner: Alexandre (pazka).
Read **TESTING.md** first (it explains each protection). Deployment: **DEPLOY.md** (hosh-deploy template app,
host henryivrevival.hosh.it, `127.0.0.1:9139`; the legacy box compose must keep working until the cutover).

## Maintenance (autonomous agent)
Goal: keep the base image, dependencies, OpenAI models and Actions current **without changing behaviour**.
- **Gate = `ci` green**: `server tests (node 26)` + `container smoke` (incl. the Node runtime guardrail `scripts/check-node-version.sh`
  and `scripts/compose-smoke.sh legacy|template`). Tests never call OpenAI.
- **Branches**: work on `agent/<topic>`; CI runs without a PR. Never push to `main` (`build-scan-push.yml`,
  `release.yml`, `publish.yml` publish images from it), never tag (a stable tag deploys to the box). **The owner merges.**
- **Dependabot PRs**: green → summarise risk in a PR comment. Red → reproduce per TESTING.md, smallest fix on
  an `agent/` branch. Never weaken or delete a test, and never loosen a `/chat/send` protection to make one pass.
- Watch OpenAI's deprecations page (https://developers.openai.com/api/docs/deprecations) for the chat and TTS
  models in `myOpenAi.ts`; `tts-1` retires 2027-01-06.

## Rules
- Never use, print or commit a real `OPENAI_API_KEY` (or any `.env`); tests use a dummy key and a fake API.
- No new dependency without the owner's yes (tests use Node built-ins only).
- Run installs and tests in containers (TESTING.md), not on the owner's machine.

## Agent system: QA gate, journal, "what happened to X"
Canonical rules: `AGENTS.md` in the private hub `pazka/hosh-management`
(`gh api repos/pazka/hosh-management/contents/AGENTS.md -H "Accept: application/vnd.github.raw"`).
Summary, binding for every agent that works in this repo:
- **Nothing is merged without the independent QA agent.** Work on `agent/<topic>-<yyyymmdd>`, get CI
  green, write in the PR body what changed, which use cases it touches and how it was tested, then add
  the label `qa:requested`. Merge only when the PR has `qa:approved` AND a comment
  `QA-VERDICT: APPROVED sha=<current head sha>`. On `qa:changes-requested`: fix on the same branch,
  answer each finding, ask again; QA re-tests the whole PR. Never approve your own PR. After QA's
  approval the agent that opened the PR merges it: this replaces "the owner merges" and "merge when
  CI is green" wherever this file still says so.
- **QA owns the tests and the visual regression**: every use case a user can reach (listed in
  `TESTING.md`), screenshots at 1400 / 1024 / 390 px, baselines in the repo. A wanted visual change
  must be announced in the PR. Never weaken a test or a gate to get green.
- A NEW third-party dependency always needs the owner: open an issue in `pazka/hosh-management`
  labelled `ready-for-human` (that label is the list of places where the owner is needed).
- Release = Actions → release with `version=vX.Y.Z` on the default branch. Never push a git tag.
- **Journal**: after each event (PR ready, QA verdict, merge, release, deploy, rollback, incident,
  blocker) add one comment to this project's journal, `pazka/hosh-management#15`.
- **When the owner asks "what happened to X"** (this app, another one, or the server): open the index
  in `pazka/hosh-management` `README.md`, read the last comments of X's journal issue
  (`gh issue view <n> -R pazka/hosh-management --comments`), then the open `ready-for-human` issues,
  then PRs / Actions runs if needed. Server facts you cannot see: ask the Box agent (mailbox from a
  laptop session, or an issue labelled `box-question`). Answer with: what happened (dated), the state
  now, where the owner is needed.
- Online checks use only the URLs in `pazka/hosh-management` `uptime/checks.json`.
