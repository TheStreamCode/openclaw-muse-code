# openclaw-muse-code

Muse Spark in OpenClaw, billed to the **Muse Code monthly subscription**
instead of API credits. Meta device-code login, no API key, no
third-party CLI.

## Why this exists

The official [`@openclaw/meta-provider`](https://clawhub.ai) plugin serves
the same models over the same Meta Model API — but it bills **per-token
API credits** via `MODEL_API_KEY`. This plugin serves the identical wire
(`https://api.meta.ai/v1`, Responses API) billed to your **Muse Code
monthly subscription** through a one-time Meta device login. Provider id
`muse-code` is intentionally distinct from the official `meta` id, so both
plugins can be installed side by side.

## Models

| Model | Tier | Context |
|---|---|---|
| `muse-code/muse-spark-1.3` | Standard (default) | 1,048,576 |
| `muse-code/muse-spark-1.3-contributor` | Contributor | 1,048,576 |
| `muse-code/muse-spark-1.2` | Standard | 1,048,576 |
| `muse-code/muse-spark-1.2-contributor` | Contributor | 1,048,576 |
| `muse-code/muse-spark-1.1` | Standard | 1,048,576 |

> [!WARNING]
> Meta's [Terms of Service](https://dev.meta.ai/legal/terms-of-service)
> distinguish Standard Services from Contributor/Discounted Services. By
> using Contributor tiers you permit Meta to use submitted and generated
> content as described in the Terms. Do not submit sensitive, confidential,
> or personal information to Contributor tiers. This plugin ships
> contributor variants as **selectable** models but never selects them
> implicitly: the setup default is the standard `muse-spark-1.3`.

Model discovery is **live**: the catalog is fetched from
`GET {baseUrl}/models` (60s in-memory TTL, only `muse-spark-*` ids
admitted — other endpoint families such as `sam-*`, `muse-image-*` or
`muse-voice-*` are not chat models), so newly published models appear
automatically with no plugin update. The static table above is the
fallback used before login and whenever the live fetch fails.

## Install

From ClawHub:

```bash
openclaw plugins install clawhub:@thestreamcode/openclaw-muse-code
```

From GitHub (requires the committed `dist/` runtime in the repo):

```bash
openclaw plugins install git:github.com/TheStreamCode/openclaw-muse-code
# or pinned to a release
openclaw plugins install git:github.com/TheStreamCode/openclaw-muse-code@v0.1.0
```

From a local checkout:

```bash
# with a local path (developing/testing)
openclaw plugins install ./openclaw-muse-code
# or a symlinked dev checkout
openclaw plugins install --link ./openclaw-muse-code
```

## Login once

```bash
npm run login
# Open the printed URL, enter the code, approve in the browser.
```

This mints a stable account-bound key cached at
`~/.openclaw/muse-code-sub.json` (owner-only permissions; override with
`MUSE_CODE_SUB_CREDENTIALS`). The key is never printed. An explicitly
configured `MUSE_CODE_SUB_TOKEN` always wins over the cache.

## Configure auth

Set the key explicitly (alternative to the login cache):

```bash
export MUSE_CODE_SUB_TOKEN=<key>
```

```json5
// ~/.openclaw/openclaw.json
{
  agents: {
    defaults: {
      model: { primary: "muse-code/muse-spark-1.3" },
    },
  },
}
```

Or run onboarding and choose **Muse Code**.

## Security & credentials

- The cache file (`~/.openclaw/muse-code-sub.json`, override with
  `MUSE_CODE_SUB_CREDENTIALS`) stores exactly three fields: the
  subscription `apiKey`, the `accountId`, and the account `email`.
  The Meta OAuth access token from the login flow is **never written
  to disk** (kept in memory only for the key exchange, then dropped).
- The cache file is created with owner-only permissions (`0600` where
  supported). The login script never prints secret material.
- Network allowlist: this plugin talks only to `auth.meta.com`
  (device-code login) and `api.meta.ai` (key minting + inference),
  both hardcoded — no configurable endpoints, no third parties.
- Report vulnerabilities privately per [SECURITY.md](./SECURITY.md).

## Compatibility

- OpenClaw gateway `>=2026.7.1` (built and tested against `2026.9.5`).
- Requires an **active Muse Code subscription** on the Meta account used
  at login; pay-per-token API keys are the official plugin's path instead.
- Responses API transport with reasoning effort mapping; text + image
  input (other upstream modalities are not OpenClaw manifest values).

## Troubleshooting

| Symptom | Cause | Fix |
|---|---|---|
| `Muse Code subscription is inactive for this account` | Subscription lapsed or wrong account | Renew, or log in with the subscribed account |
| `Muse Code subscription is required: <url>` | No subscription on the account | Complete checkout at the printed URL |
| `Login failed: access_denied` | Browser step denied/expired | Re-run login, approve within the expiry window |
| `login timed out after slow_down responses` | Polling throttled (often VM clock drift) | Check system clock, retry |
| Provider shows as unconfigured | No env key and no usable cache | Run `npm run login` or set `MUSE_CODE_SUB_TOKEN` |

## Development

```bash
npm install
npm run build      # tsc -> dist/index.js
npm test           # vitest: projection, dynamic resolution, manifest drift guard, auth flow
node scripts/smoke.discovery.mjs   # static (pre-credential) + live discovery smoke
```

`dist/` is **committed** because OpenClaw git/package installs require the
compiled runtime — the TypeScript-source fallback only applies to local dev
paths. Regenerate it with `npm run build` after any source change (CI fails
when the committed `dist/` drifts).

A GitHub Actions workflow (`.github/workflows/ci.yml`) runs type-check,
build, unit tests, and a freshness check that fails when the committed
`dist/` does not match a fresh build.

## License

MIT — see [LICENSE](./LICENSE). Device-flow parameters are compatible with
the published behavior of oh-my-pi (MIT; see [NOTICE](./NOTICE)).
