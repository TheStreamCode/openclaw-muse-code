# openclaw-muse-code

Muse models in OpenClaw billed to the Muse Code subscription

[![CI](https://github.com/TheStreamCode/openclaw-muse-code/actions/workflows/ci.yml/badge.svg)](https://github.com/TheStreamCode/openclaw-muse-code/actions/workflows/ci.yml)
[![License](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
[![ClawHub](https://img.shields.io/badge/ClawHub-%40thestreamcode%2Fopenclaw--muse--code-blue)](https://clawhub.ai/plugins/@thestreamcode/openclaw-muse-code)

Provider plugin that serves Meta Muse models in [OpenClaw](https://openclaw.ai) through a one-time
Meta device login, billed to the Muse Code monthly subscription instead of per-token API credits.
No API key to copy and no third-party CLI to install.

> **Unofficial and experimental.** This plugin uses a Muse Code subscription credential from
> OpenClaw. Meta's terms limit that credential to Muse Code, so this use may not be supported and
> Meta may suspend or revoke accounts or credentials. Use it at your own risk; the authors cannot
> recover an account. Read [DISCLAIMER.md](DISCLAIMER.md) before installing.

The official [`@openclaw/meta-provider`](https://clawhub.ai) plugin serves the same models over
the same Meta Model API but bills per-token API credits through `MODEL_API_KEY`. This plugin
serves the identical wire (`https://api.meta.ai/v1`, Responses API) billed to the subscription.
Provider id `muse-code` is intentionally distinct from the official `meta` id, so both plugins
can be installed side by side.

## Install

From [ClawHub](https://clawhub.ai/plugins/@thestreamcode/openclaw-muse-code) (recommended):

```bash
openclaw plugins install clawhub:@thestreamcode/openclaw-muse-code
```

From GitHub (requires the committed `dist/` runtime in the repository):

```bash
openclaw plugins install git:github.com/TheStreamCode/openclaw-muse-code
```

Append `@<release-tag>` to the repository reference to pin a release.

From a local checkout:

```bash
openclaw plugins install --link .
```

## Quick start

1. Log in once. The script prints a Meta URL and a code, and waits for the key exchange:

   ```bash
   npm run login
   ```

2. Open the printed URL, enter the code, and approve the login in your browser. The plugin mints a
   stable, account-bound key and caches it at `~/.openclaw/muse-code-sub.json` (owner-only
   permissions; override with `MUSE_CODE_SUB_CREDENTIALS`). The key is never printed.
3. Select the provider in `~/.openclaw/openclaw.json`, or run onboarding and choose **Muse Code**:

   ```json5
   {
     agents: {
       defaults: {
         model: { primary: "muse-code/muse-spark-1.3" },
       },
     },
   }
   ```

An explicitly configured `MUSE_CODE_SUB_TOKEN` always wins over the cache:

```bash
export MUSE_CODE_SUB_TOKEN=<key>
```

## Models

| Model | Tier | Context |
| --- | --- | --- |
| `muse-code/muse-spark-1.3` | Standard (default) | 1,048,576 |
| `muse-code/muse-spark-1.3-contributor` | Contributor | 1,048,576 |
| `muse-code/muse-spark-1.2` | Standard | 1,048,576 |
| `muse-code/muse-spark-1.2-contributor` | Contributor | 1,048,576 |
| `muse-code/muse-spark-1.1` | Standard | 1,048,576 |

> [!WARNING]
> Meta's [Terms of Service](https://dev.meta.ai/legal/terms-of-service) distinguish Standard
> Services from Contributor and Discounted Services. By using Contributor tiers you permit Meta to
> use submitted and generated content as described in the Terms. Do not submit sensitive,
> confidential, or personal information to Contributor tiers. This plugin ships contributor
> variants as selectable models but never selects them implicitly: the setup default is the
> standard `muse-spark-1.3`.

Model discovery is live: the catalog is fetched from `GET {baseUrl}/models` with a 60-second
in-memory TTL, and every returned model id is served except the endpoint families verified as
non-chat (`sam-*`, `muse-image-*`, `muse-voice-*`). Newly published models appear automatically
with no plugin update. The table above is the fallback used before login and whenever the live
fetch fails.

## Requirements

- OpenClaw gateway `>= 2026.7.1`; CI builds and tests against OpenClaw 2026.9.x on Node.js 24.
- An active Muse Code subscription on the Meta account used at login. Pay-per-token API keys are
  the official plugin's path instead.
- The Responses API transport with reasoning-effort mapping and text plus image input.

## Configuration

| Setting | Purpose | Default |
| --- | --- | --- |
| `MUSE_CODE_SUB_TOKEN` | Explicit subscription key; never overwritten and always wins over the cache. | from the login cache |
| `MUSE_CODE_SUB_CREDENTIALS` | Overrides the credential cache path. | `~/.openclaw/muse-code-sub.json` |
| `agents.defaults.model.primary` | Default model id in the OpenClaw configuration. | `muse-code/muse-spark-1.3` |

## Privacy and security

- The cache stores exactly three fields: the subscription `apiKey`, the `accountId`, and the
  account `email`. The Meta OAuth access token from the login flow is never written to disk; it is
  kept in memory only for the key exchange and then dropped.
- The cache is created with owner-only permissions (`0600` where supported), and the login script
  never prints secret material.
- OpenClaw resolves API-key providers from the process environment, so the plugin exports the
  cached key as `MUSE_CODE_SUB_TOKEN` and refreshes it when the cache changes.
- The plugin talks only to `auth.meta.com` for the device login and `api.meta.ai` for key minting
  and inference; both endpoints are hardcoded and there is no configurable endpoint.
- Report vulnerabilities privately per [SECURITY.md](SECURITY.md).

To remove access, delete `~/.openclaw/muse-code-sub.json` (or the path in
`MUSE_CODE_SUB_CREDENTIALS`) and restart OpenClaw. Run `muse logout` if you also want to clear the
Muse Code CLI session.

## Troubleshooting

| Symptom | Cause | Fix |
| --- | --- | --- |
| `Muse Code subscription is inactive for this account` | Subscription lapsed or wrong account | Renew, or log in with the subscribed account |
| `Muse Code subscription is required: <url>` | No subscription on the account | Complete checkout at the printed URL |
| `Login failed: access_denied` | Browser step denied or expired | Re-run login and approve within the expiry window |
| `login timed out after slow_down responses` | Polling throttled, often VM clock drift | Check the system clock and retry |
| Provider shows as unconfigured | No environment key and no usable cache | Run `npm run login` or set `MUSE_CODE_SUB_TOKEN` |

## Development

Requirements: Node.js 24 and npm.

```bash
git clone https://github.com/TheStreamCode/openclaw-muse-code.git
cd openclaw-muse-code
npm install
npm run build
npm test
node scripts/smoke.discovery.mjs   # static (pre-credential) and live discovery smoke
```

`dist/` is committed because OpenClaw git and package installs require the compiled runtime;
regenerate it with `npm run build` after any source change. CI runs type-check, build, unit tests,
and a freshness check that fails when the committed `dist/` does not match a fresh build.

## Support

Usage questions and workflows belong in GitHub Discussions; reproducible defects belong in GitHub
Issues using the bug report form. See [SUPPORT.md](SUPPORT.md). Problems in OpenClaw or Meta
themselves belong to their respective projects.

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md). Pull requests must pass the required CI checks.

## License

MIT — see [`LICENSE`](./LICENSE). The software is provided "as is"; see
[DISCLAIMER.md](./DISCLAIMER.md) for the risk notice and liability terms. Device-flow parameters
are compatible with the published behavior of oh-my-pi (MIT; see [NOTICE](./NOTICE)).

---

Maintained by [Michael Gasperini (Mikesoft)](https://mikesoft.it).
If this project is useful to you, consider
[sponsoring its maintenance](https://github.com/sponsors/TheStreamCode).
