# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [0.1.1] - 2026-09-27

### Security

- The credential cache no longer persists the Meta OAuth access token
  (only `apiKey`, `accountId`, `email`); nothing ever read it back.
  Existing caches are harmless but can be refreshed with `npm run login`.
- Credential-source resolution (env names, cache path) moved to a
  network-free `src/config.ts`; `src/auth.ts` is transport-only with
  explicit arguments.

### Fixed

- `scripts/muse-code-login.mjs` imported `../dist/auth.js` instead of
  `../dist/src/auth.js` and crashed at startup; fixed and covered by
  running `--help` in verification.

## [0.1.0] - 2026-09-27

### Added

- Initial release: Muse Spark (`api.meta.ai`) model-provider plugin for
  OpenClaw, billed to the Muse Code monthly subscription via Meta
  device-code login (no API key, no third-party CLI).
- Static catalog of the Muse Spark family (`muse-spark-1.1` / `1.2` /
  `1.3`, including `-contributor` tiers), Responses API transport,
  dynamic model resolver, and `scripts/muse-code-login.mjs` one-time
  login (credential cache with owner-only permissions).
