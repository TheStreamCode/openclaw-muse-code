// One-time Meta device-code login for the muse-code subscription plugin.
//
// Performs the login, mints the stable account-bound inference key, and
// writes the credential cache the provider reads. Never prints secret
// material. Run: `npm run login` (or `node scripts/muse-code-login.mjs`)
// after `npm run build`.
//
// The flow parameters are compatible with the published behavior of oh-my-pi
// (MIT-licensed; see NOTICE). No third-party CLI is required.

import {
  deviceAuthorize,
  pollToken,
  mintKey,
  writeCache,
  defaultCachePath,
} from "../dist/auth.js";

const args = process.argv.slice(2);
let cache = null;
for (let i = 0; i < args.length; i += 1) {
  if (args[i] === "--cache" && args[i + 1]) {
    cache = args[i + 1];
    i += 1;
  } else if (args[i] === "--help" || args[i] === "-h") {
    console.log("Usage: node scripts/muse-code-login.mjs [--cache <path>]");
    console.log(`Default cache: ${defaultCachePath()}`);
    process.exit(0);
  }
}

try {
  const device = await deviceAuthorize();
  console.log(`Open ${device.verification_uri_complete || device.verification_uri}`);
  console.log(`Enter code: ${device.user_code}`);
  const access = await pollToken(device.device_code, device.interval, device.expires_in);
  const credentials = await mintKey(access);
  await writeCache(credentials, cache || defaultCachePath());
  console.log(
    `Logged in as ${credentials.email || credentials.accountId} (key cached, never printed)`,
  );
} catch (err) {
  console.error(`Login failed: ${err instanceof Error ? err.message : err}`);
  process.exit(1);
}
