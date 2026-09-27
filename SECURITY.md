# Security Policy

## Supported versions

Security fixes target the latest published release and the current `main` branch.

## Reporting a vulnerability

This plugin handles API keys at inference time. Report security issues privately:
use GitHub's **private vulnerability reporting** (Security Advisories) on this
repository. If that route is unavailable, email `info@mikesoft.it` with the
subject `openclaw-muse-code Security Report`. Do not open a public issue for
sensitive findings.

## Credential handling

The Muse Code subscription key belongs in the environment
(`MUSE_CODE_SUB_TOKEN`), your auth profile, or the owner-only credential
cache written by `scripts/muse-code-login.mjs`
(`~/.openclaw/muse-code-sub.json`, override with
`MUSE_CODE_SUB_CREDENTIALS`). Never commit keys, tokens, or account data
to this repository, and never paste real credentials into issues, pull
requests, or test fixtures. The login script never prints secret
material.

