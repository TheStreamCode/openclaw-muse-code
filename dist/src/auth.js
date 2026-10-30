// Meta device-login transport (no third-party CLI).
// Flow parameters are compatible with the published behavior of oh-my-pi
// (MIT-licensed; see NOTICE).
//
// This module performs network requests but never reads the environment:
// credential sources (env names, cache paths) live in config.ts and are
// passed in explicitly by callers.
import { dirname } from "node:path";
import { readFileSync } from "node:fs";
import { readFile, writeFile, mkdir, chmod } from "node:fs/promises";
import { setTimeout as delay } from "node:timers/promises";
export const CLIENT_ID = "1031625952748946";
export const DEVICE_URL = "https://auth.meta.com/oidc/device/authorization/";
export const TOKEN_URL = "https://auth.meta.com/oidc/device/token/";
export const KEY_URL = "https://api.meta.ai/muse-code/key";
export const AUTH_CONTRACT_VERSION = 1;
const HEADERS = {
    Accept: "application/json",
    "x-api-version": "1.0.0",
};
const REQUEST_TIMEOUT_MS = 25_000;
const MIN_INTERVAL_S = 1;
const SLOW_DOWN_STEP_S = 5;
const TOKEN_ERRORS = new Set([
    "access_denied", "expired_token", "invalid_grant", "invalid_client",
    "unauthorized_client", "unsupported_grant_type", "invalid_request",
]);
export async function readCache(path) {
    try {
        const blob = (await readFile(path, "utf8").then(JSON.parse));
        return typeof blob?.apiKey === "string" && blob.apiKey.trim() ? blob.apiKey.trim() : "";
    }
    catch {
        return "";
    }
}
/** Sync cache read for module-load key resolution (silent miss on any failure). */
export function readCacheSync(path) {
    try {
        const blob = JSON.parse(readFileSync(path, "utf8"));
        return typeof blob?.apiKey === "string" && blob.apiKey.trim() ? blob.apiKey.trim() : "";
    }
    catch {
        return "";
    }
}
export async function writeCache(credentials, path) {
    // Retention minimization: persist only what inference needs. The OAuth
    // access token has unknown broader scope and nothing reads it back, so it
    // must never touch disk — sanitize at the sink, whatever callers pass in.
    const { apiKey, accountId, email } = credentials;
    const cached = { apiKey, accountId, ...(email ? { email } : {}) };
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, JSON.stringify(cached, null, 2));
    try {
        await chmod(path, 0o600);
    }
    catch {
        /* Windows ACLs inherit profile permissions */
    }
}
function requestSignal(signal) {
    const timeout = AbortSignal.timeout(REQUEST_TIMEOUT_MS);
    return signal ? AbortSignal.any([signal, timeout]) : timeout;
}
async function postForm(url, params, signal) {
    const res = await fetch(url, {
        method: "POST",
        headers: { ...HEADERS, "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams(params).toString(),
        signal: requestSignal(signal),
    });
    if (!res.ok)
        throw new Error(`device authorization failed: HTTP ${res.status}`);
    return res.json();
}
export async function deviceAuthorize(signal) {
    const body = (await postForm(DEVICE_URL, { client_id: CLIENT_ID }, signal));
    const { device_code, user_code, verification_uri, interval, expires_in } = body;
    if (typeof device_code !== "string" ||
        !device_code ||
        typeof user_code !== "string" ||
        !user_code ||
        typeof verification_uri !== "string" ||
        !verification_uri ||
        typeof interval !== "number" ||
        typeof expires_in !== "number") {
        throw new Error("device authorization response is missing fields");
    }
    const complete = body.verification_uri_complete;
    return {
        device_code,
        user_code,
        verification_uri,
        ...(typeof complete === "string" && complete ? { verification_uri_complete: complete } : {}),
        interval,
        expires_in,
    };
}
export async function pollToken(deviceCode, intervalS, expiresInS, signal) {
    let interval = Math.max(MIN_INTERVAL_S, Number(intervalS) || 5);
    const deadline = Date.now() + Number(expiresInS || 600) * 1000;
    let slowDowns = 0;
    while (Date.now() < deadline) {
        signal?.throwIfAborted();
        // The token endpoint answers HTTP errors (e.g. 400 authorization_pending)
        // as part of the normal flow: never throw here, classify instead.
        let body = null;
        try {
            const res = await fetch(TOKEN_URL, {
                method: "POST",
                headers: { ...HEADERS, "Content-Type": "application/x-www-form-urlencoded" },
                body: new URLSearchParams({
                    grant_type: "urn:ietf:params:oauth:grant-type:device_code",
                    client_id: CLIENT_ID,
                    device_code: deviceCode,
                }).toString(),
                signal: requestSignal(signal),
            });
            try {
                body = (await res.json());
            }
            catch {
                body = null;
            }
        }
        catch {
            signal?.throwIfAborted();
            body = null;
        }
        signal?.throwIfAborted();
        if (body && !body.error) {
            if (typeof body.access_token !== "string" || !body.access_token) {
                throw new Error("token response has no access_token");
            }
            return body.access_token;
        }
        if (body?.error === "slow_down") {
            slowDowns += 1;
            interval = Math.max(MIN_INTERVAL_S, interval + SLOW_DOWN_STEP_S);
        }
        else if (body?.error !== "authorization_pending") {
            const detail = typeof body?.error === "string" && TOKEN_ERRORS.has(body.error)
                ? body.error
                : body?.error ? "unknown token error" : "unreadable token response";
            throw new Error(`login failed: ${detail}`);
        }
        const remaining = deadline - Date.now();
        if (remaining <= 0)
            break;
        await delay(Math.min(interval * 1000, remaining), undefined, { signal });
    }
    throw new Error(slowDowns ? "login timed out after slow_down responses" : "login timed out waiting for approval");
}
export async function mintKey(accessToken, signal) {
    const res = await fetch(KEY_URL, {
        method: "POST",
        headers: { ...HEADERS, "Content-Type": "application/json", Authorization: `Bearer ${accessToken}` },
        body: JSON.stringify({ onboard: true }),
        signal: requestSignal(signal),
    });
    if (!res.ok)
        throw new Error(`key exchange failed: HTTP ${res.status}`);
    const body = (await res.json());
    if (body.is_subs_active === false)
        throw new Error("Muse Code subscription is inactive for this account");
    if (typeof body.api_key !== "string" || !body.api_key.trim()) {
        const action = String(body.action_url || body.require_payment_action_url || "").trim();
        if (body.require_payment === true || action) {
            throw new Error(`Muse Code subscription is required${action ? ": " + action : ""}`);
        }
        throw new Error("key response is missing api_key");
    }
    const email = String(body.user_email || "").trim().toLowerCase() || undefined;
    const accountId = String(body.user_id || "").trim() || email;
    if (!accountId)
        throw new Error("key response is missing account identity");
    return { oauthAccessToken: accessToken, apiKey: body.api_key.trim(), accountId, email };
}
