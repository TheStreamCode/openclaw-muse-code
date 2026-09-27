# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [0.1.0] - 2026-09-27

### Added

- Initial release: Muse Spark (`api.meta.ai`) model-provider plugin for
  OpenClaw, billed to the Muse Code monthly subscription via Meta
  device-code login (no API key, no third-party CLI).
- Static catalog of the Muse Spark family (`muse-spark-1.1` / `1.2` /
  `1.3`, including `-contributor` tiers), Responses API transport,
  dynamic model resolver, and `scripts/muse-code-login.mjs` one-time
  login (credential cache with owner-only permissions).
