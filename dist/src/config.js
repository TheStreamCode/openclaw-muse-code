// Credential-source resolution: env names and cache-path policy.
//
// Deliberately network-free: this module never performs requests and never
// handles secret material beyond reading configuration. Transport lives in
// auth.ts and receives explicit arguments, so each side is easy to audit
// in isolation.
import { homedir } from "node:os";
import { join } from "node:path";
export const ENV_VAR = "MUSE_CODE_SUB_TOKEN";
export const CREDENTIALS_ENV_VAR = "MUSE_CODE_SUB_CREDENTIALS";
export const CREDENTIALS_FILENAME = "muse-code-sub.json";
/** Explicitly configured token (highest priority), or "" when unset. */
export function explicitToken() {
    return (process.env[ENV_VAR] || "").trim();
}
export function defaultCachePath() {
    const override = (process.env[CREDENTIALS_ENV_VAR] || "").trim();
    if (override)
        return override;
    return join(homedir(), ".openclaw", CREDENTIALS_FILENAME);
}
