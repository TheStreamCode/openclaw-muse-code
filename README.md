# openclaw-muse-code

Muse models in OpenClaw billed to the Muse Code subscription

[![CI](https://github.com/TheStreamCode/openclaw-muse-code/actions/workflows/ci.yml/badge.svg)](https://github.com/TheStreamCode/openclaw-muse-code/actions/workflows/ci.yml)
[![License](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
[![ClawHub](https://img.shields.io/badge/ClawHub-%40thestreamcode%2Fopenclaw--muse--code-blue)](https://clawhub.ai/plugins/@thestreamcode/openclaw-muse-code)

Provider plugin for [OpenClaw](https://openclaw.ai): Muse Code device login, no API key, no
third-party CLI.

> **Unofficial and experimental.** This plugin uses a Muse Code subscription credential from
> OpenClaw. Meta's terms limit that credential to Muse Code, so this use may not be supported and
> Meta may suspend or revoke accounts or credentials. Use it at your own risk; the authors cannot
> recover an account. Read [DISCLAIMER.md](DISCLAIMER.md) before installing.

The official `@openclaw/meta-provider` plugin serves the same models but bills per-token API
credits through `MODEL_API_KEY`; this plugin bills a subscription instead.

## Install

From [ClawHub](https://clawhub.ai/plugins/@thestreamcode/openclaw-muse-code) (recommended):

```bash
openclaw plugins install clawhub:@thestreamcode/openclaw-muse-code
```

From GitHub (ships the committed `dist/` runtime):

```bash
openclaw plugins install git:github.com/TheStreamCode/openclaw-muse-code
```

Append `@<release-tag>` to the repository reference to pin a release.

From a local checkout:

```bash
openclaw plugins install --link .
```

## Quick start

1. Run onboarding and choose **Muse Code browser login**, or start the device login directly:

   ```bash
   openclaw models auth login --provider muse-code --method device-code
   ```

   The onboarding choice requires OpenClaw 2026.9.5 or newer. On older gateways, use the
   `models auth login` command above.

   On a multi-agent Gateway, sign in once per agent with
   `openclaw models auth login --provider muse-code --method device-code --agent <id>`:
   credentials do not carry across agents.

2. Approve the code in the browser (or use the displayed URL and code). OpenClaw saves an auth
   profile, and the plugin keeps its local cache at `~/.openclaw/muse-code-sub.json` (override
   with `MUSE_CODE_SUB_CREDENTIALS`). The key is never printed.
3. Select the provider in `~/.openclaw/openclaw.json`:

   ```json5
   {
     agents: {
       defaults: {
         model: { primary: "muse-code/muse-spark-1.3" },
       },
     },
   }
   ```

A saved OpenClaw auth profile takes precedence over `MUSE_CODE_SUB_TOKEN` and the cache for
inference; remove the profile to force the environment credential:

```bash
export MUSE_CODE_SUB_TOKEN=<key>
```

In a source checkout, `npm run login` updates the cache only, not an existing auth profile.

## Features

- **Subscription billing.** Muse models in OpenClaw on the Muse Code subscription: device
  login, no API key.
- **Live model catalog.** Discovery fetches `{baseUrl}/models` on a 60-second TTL; the table below
  is the pre-login fallback.
- **Wire adapter.** A loopback adapter aliases tool names Meta's client gate rejects and normalizes
  validated Responses fields ([ADAPTER_CONTRACT.md](ADAPTER_CONTRACT.md)).
- **Probes that work.** A 1024-token output floor and `none`/`off`-to-`minimal` mapping keep
  small requests and thinking-off turns accepted.
- **Side-by-side installs.** Provider id `muse-code` never clashes with the official `meta`
  provider.
- **Credential hygiene.** Owner-only cache, secrets never printed, OAuth token never written to
  disk.

## Models

| Model | Tier |
| --- | --- |
| `muse-code/muse-spark-1.3` | Standard (default) |
| `muse-code/muse-spark-1.3-contributor` | Contributor |
| `muse-code/muse-wonder-1.0` | Standard |
| `muse-code/muse-wonder-1.0-contributor` | Contributor |
| `muse-code/muse-wonder-full-1.0` | Standard |
| `muse-code/muse-wonder-full-1.0-contributor` | Contributor |
| `muse-code/muse-spark-1.2` | Standard |
| `muse-code/muse-spark-1.2-contributor` | Contributor |
| `muse-code/muse-spark-1.1` | Standard |

All models use a 1,048,576-token context window.

> [!WARNING]
> Meta's [Terms of Service](https://dev.meta.ai/legal/terms-of-service) distinguish Standard
> Services from Contributor and Discounted Services. By using Contributor tiers you permit Meta to
> use submitted and generated content as described in the Terms. Never submit sensitive,
> confidential, or personal information to Contributor tiers; this plugin never selects them
> implicitly and defaults to standard `muse-spark-1.3`.

Discovery excludes the endpoint families verified as non-chat (`sam-*`, `muse-image-*`,
`muse-voice-*`).

## Requirements

- OpenClaw gateway `>= 2026.7.1` (`>= 2026.9.5` for the onboarding browser-login choice).
- An active Muse Code subscription on the Meta account used at login. Pay-per-token API keys are
  the official plugin's path instead.
- A bindable loopback port (`127.0.0.1`, 43219-43222 preferred, else ephemeral); without it
  the plugin stays on the direct endpoint and the tool-name gate applies again.
- The Responses API transport with reasoning-effort mapping and text plus image input.

## Configuration

| Setting | Purpose | Default |
| --- | --- | --- |
| `MUSE_CODE_SUB_TOKEN` | Explicit subscription key; never overwritten by the cache. An OpenClaw auth profile may take precedence for inference. | from the login cache |
| `MUSE_CODE_SUB_CREDENTIALS` | Overrides the credential cache path. | `~/.openclaw/muse-code-sub.json` |
| `MUSE_CODE_ADAPTER` | `off` keeps the loopback proxy but disables the tool-name reshaping and the Responses field normalization. | unset |
| `agents.defaults.model.primary` | Default model id in the OpenClaw configuration. | `muse-code/muse-spark-1.3` |

## Privacy and security

- OpenClaw saves the inference credential in an auth profile (secret store or inline). The
  plugin also maintains its cache, so reference-only storage is not supported.
- The cache stores exactly three fields: the subscription `apiKey`, the `accountId`, and the
  account `email`. The Meta OAuth access token from the login flow is never written to disk; it is
  kept in memory only for the key exchange and then dropped.
- The cache is created with owner-only permissions (`0600` where supported), and the login flow
  never prints secret material.
- The plugin exports the cached key as `MUSE_CODE_SUB_TOKEN` and refreshes it on cache
  changes.
- The plugin talks only to hardcoded `auth.meta.com` (device login) and `api.meta.ai` (key minting,
  inference); inference goes through the loopback adapter on `127.0.0.1` only.
- The adapter forwards `Authorization` unchanged and never reads, stores or logs credentials
  or bodies; its debug line carries only method, path, status and adapted-field count.
- Report vulnerabilities privately per [SECURITY.md](SECURITY.md).

To remove access: delete the cache file, unset `MUSE_CODE_SUB_TOKEN`, remove the saved auth
profile (`models auth logout muse-code:default`; `models auth list` finds others), restart
OpenClaw, and run `muse logout` for the CLI session.

## Troubleshooting

| Symptom | Cause | Fix |
| --- | --- | --- |
| `Muse Code subscription is inactive` (or `required: <url>`) | Subscription lapsed, wrong account, or missing | Renew, check the account, or complete checkout at the printed URL |
| `Login failed: access_denied` | Browser step denied or expired | Re-run login and approve within the expiry window |
| Provider shows as unconfigured | No auth profile, environment key, or usable cache | Run the browser login above |

### Meta rejects subscription requests from this client

Meta may return 403 `client_attestation_denied`: subscriptions cover the Muse Code client only. The
adapter aliases colliding tool names (retrying once with all aliased), so the error should be gone;
if it persists, the adapter could not bind, `MUSE_CODE_ADAPTER=off` is set, or Meta changed the
gate. Use Muse Code or a pay-as-you-go key instead.

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

`dist/` is committed for OpenClaw installs; regenerate it with `npm run build` after any source
change (CI checks freshness).

## Support

Usage questions belong in Discussions, reproducible defects in Issues (bug report form). See
[SUPPORT.md](SUPPORT.md). OpenClaw or Meta problems belong upstream.

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md). Pull requests must pass the required CI checks.

## License

MIT — see [`LICENSE`](./LICENSE). The software is provided "as is"; see
[DISCLAIMER.md](./DISCLAIMER.md) for the risk notice and liability terms. Device-flow parameters
are compatible with the published behavior of oh-my-pi (MIT; see [NOTICE](./NOTICE)).

---

Maintained by Michael Gasperini (Mikesoft).
If this project is useful to you, consider
[sponsoring its maintenance](https://github.com/sponsors/TheStreamCode).
