# Agent instructions

Repository: openclaw-muse-code
Maintainer: Michael Gasperini (Mikesoft)

This repository is an unofficial OpenClaw provider plugin that serves Muse models billed to a Muse
Code subscription. The unofficial-use framing in `DISCLAIMER.md` and the pinned wire values in
`AUTH_CONTRACT.md` are part of the contract: keep them intact and in sync with the sibling Muse
plugins (`dsh-muse-code`, `hermes-muse-code`, `opencode-muse-auth`).

## Layout

- `index.ts` — plugin entry: provider registration, live and static catalogs, dynamic resolution.
- `src/` — provider logic: auth, catalog, config, key handling, login arguments.
- `dist/` — build output, **committed**: OpenClaw git and package installs require the compiled
  runtime. Regenerate with `npm run build`; never edit by hand.
- `test/` — Vitest unit tests; new behavior needs a test.
- `scripts/muse-code-login.mjs` — one-time Meta device-code login.
- `openclaw.plugin.json` — plugin manifest (provider id, auth env var, catalog).
- `.github/workflows/` — CI and npm publish; do not weaken checks, pins, or permissions.

## Commands

```bash
npm install
npm run typecheck
npm run build
npm test
npm run login
```

Use npm and the committed `package-lock.json`; never regenerate the lockfile without a dependency
change. Always rebuild `dist/` before committing a source change; CI fails when it is stale.

## Constraints

- Keep changes focused; no drive-by refactors, no new runtime dependencies without a stated
  reason.
- Public documentation, comments, and commit messages are in English.
- Do not change `LICENSE`, `NOTICE`, `DISCLAIMER.md`, `AUTH_CONTRACT.md`, `SECURITY.md`,
  `CODE_OF_CONDUCT.md`, or release metadata unless the task is about them.
- Never log, print, commit, or describe a subscription key, OAuth token, or account data. The cache
  stores `apiKey`, `accountId`, and `email` only; the OAuth access token is never persisted.
- Never add instructions that bypass Meta's terms or credential rules.
- Releases are tag-driven; publishing runs from the release event through OIDC trusted publishing.
  Do not create tags, releases, or publish packages by hand.
- Run the checks above before proposing a change.
