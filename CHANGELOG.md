# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [0.6.0] - 2026-10-30

### Added

- Local wire adapter in front of `api.meta.ai`: it aliases client tool names that collide with
  the 40-name Muse builtin set pinned in `ADAPTER_CONTRACT.md` (goal, cron, session and patch
  families included), restores them in the response and
  normalizes `tool_choice`, the reasoning effort, the output-token floor and the
  encrypted-reasoning include. The provider entry points at the adapter's loopback origin, so
  subscription requests keep working now that Meta refuses the colliding declarations with HTTP
  403 `client_attestation_denied`. If the gate still refuses, the adapter retries once with every
  tool aliased.
- `ADAPTER_CONTRACT.md` pins the wire rules and the measured gate trigger; `ADAPTER_VERSION` is
  the matching constant.

### Changed

- `MUSE_CODE_ADAPTER=off` disables the reshaping while keeping the loopback proxy, so a base URL
  already observed by OpenClaw stays valid.
- If the adapter cannot bind, the plugin logs it and keeps the direct `https://api.meta.ai/v1`
  endpoint instead of failing the provider.

## [0.5.1] - 2026-10-30

### Changed

- Documented that the onboarding browser-login choice requires OpenClaw 2026.9.5 or newer; older
  gateways use the device login command.

## [0.5.0] - 2026-10-30

### Added

- Onboarding runs the Meta device-code login and saves an OpenClaw auth profile; the provider no
  longer asks for an API key.

### Fixed

- The login honours cancellation, offers the URL when the browser cannot open, and no longer echoes
  token or key endpoint response bodies in errors.

### Changed

- The existing credential cache is still written for older installations; an explicit
  `MUSE_CODE_SUB_TOKEN` is never overwritten.
- Documented that Meta can reject subscription requests from clients other than Muse Code.

## [0.4.0] - 2026-10-21

### Fixed

- The provider env var is now kept in sync with the login cache without
  overwriting an explicit `MUSE_CODE_SUB_TOKEN`; re-login no longer leaves a
  stale key in a long-lived process.
- The live catalog cache is keyed by the subscription key, so switching
  accounts cannot serve the previous account's model list.
- Login argument parsing moved to `src/login-args.ts` and is covered by tests.

### Changed

- Added `AUTH_CONTRACT.md`; `src/auth.ts` pins the device-flow contract.
- Documented that OpenClaw resolves the provider key from the process
  environment and that an explicit value wins over the cache.

## [0.3.0] - 2026-10-14

### Added

- Live discovery now serves every model id returned by the account catalog except
  the endpoint families verified as non-chat (`sam-*`, `muse-image-*`,
  `muse-voice-*`), so newly published chat models appear with no plugin update.

## [0.2.0] - 2026-09-27

### Added

- Live model discovery: the catalog is fetched from `GET {baseUrl}/models`
  (60s in-memory TTL, only `muse-spark-*` admitted — the endpoint also
  serves non-chat families such as `sam-*`), so newly published models
  appear automatically. The static baseline remains as pre-credential
  discovery and as fallback whenever the live fetch fails.
  The subscription key is re-resolved on every discovery call, so no
  gateway restart is needed after the first login.

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
