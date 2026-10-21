// Credential-source resolution for the OpenClaw provider entry.
//
// OpenClaw resolves api_key providers from the `MUSE_CODE_SUB_TOKEN` env var,
// so the key must live in process.env. Keep that value aligned with the login
// cache without ever overwriting a value the user set explicitly.
import { ENV_VAR, defaultCachePath, explicitToken } from "./config.js";
import { readCacheSync } from "./auth.js";
let envOwned = null;
/**
 * Sync the provider env var with the login cache.
 *
 * A value that was not written here is treated as user-provided and wins.
 * When the cache changes, the previously owned value is replaced; when the
 * cache disappears, only the owned value is removed.
 */
export function syncEnvFromCache() {
    const current = (process.env[ENV_VAR] || "").trim();
    if (current && current !== envOwned) {
        envOwned = null;
        return;
    }
    const cached = readCacheSync(defaultCachePath());
    if (cached) {
        if (cached !== envOwned) {
            process.env[ENV_VAR] = cached;
            envOwned = cached;
        }
        return;
    }
    if (envOwned !== null) {
        delete process.env[ENV_VAR];
        envOwned = null;
    }
}
/** Resolve the subscription key: explicit env wins, else the login cache. */
export function resolveKey() {
    syncEnvFromCache();
    return explicitToken() || readCacheSync(defaultCachePath());
}
/** Test-only reset of the env ownership marker. */
export function __resetKeyStateForTests() {
    envOwned = null;
}
