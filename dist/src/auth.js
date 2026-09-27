// Shared Meta device-login logic (no third-party CLI).
// Flow parameters are compatible with the published behavior of oh-my-pi
// (MIT-licensed; see NOTICE).
import { homedir } from "node:os";
import { join, dirname } from "node:path";
import { readFileSync } from "node:fs";
import { readFile, writeFile, mkdir, chmod } from "node:fs/promises";
export const CLIENT_ID = "1031625952748946";
export const DEVICE_URL = "https://auth.meta.com/oidc/device/authorization/";
export const TOKEN_URL = "https://auth.meta.com/oidc/device/token/";
export const KEY_URL = "https://api.meta.ai/muse-code/key";
export const ENV_VAR = "MUSE_CODE_SUB_TOKEN";
export const CREDENTIALS_ENV_VAR = "MUSE_CODE_SUB_CREDENTIALS";
export const CREDENTIALS_FILENAME = "muse-code-sub.json";
const HEADERS = {
    Accept: "application/json",
    "x-api-version": "1.0.0",
};
const REQUEST_TIMEOUT_MS = 25_000;
const MIN_INTERVAL_S = 1;
const SLOW_DOWN_STEP_S = 5;
export function defaultCachePath() {
    const override = (process.env[CREDENTIALS_ENV_VAR] || "").trim();
    if (override)
        return override;
    return join(homedir(), ".openclaw", CREDENTIALS_FILENAME);
}
export async function readCache(path = defaultCachePath()) {
    try {
        const blob = (await readFile(path, "utf8").then(JSON.parse));
        return typeof blob?.apiKey === "string" && blob.apiKey.trim() ? blob.apiKey.trim() : "";
    }
    catch {
        return "";
    }
}
/** Sync cache read for module-load key resolution (silent miss on any failure). */
export function readCacheSync(path = defaultCachePath()) {
    try {
        const blob = JSON.parse(readFileSync(path, "utf8"));
        return typeof blob?.apiKey === "string" && blob.apiKey.trim() ? blob.apiKey.trim() : "";
    }
    catch {
        return "";
    }
}
export async function writeCache(credentials, path = defaultCachePath()) {
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, JSON.stringify(credentials, null, 2));
    try {
        await chmod(path, 0o600);
    }
    catch {
        /* Windows ACLs inherit profile permissions */
    }
}
async function postForm(url, params) {
    const res = await fetch(url, {
        method: "POST",
        headers: { ...HEADERS, "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams(params).toString(),
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    const text = await res.text();
    if (!res.ok)
        throw new Error(`HTTP ${res.status} ${text.slice(0, 200)}`.trim());
    return JSON.parse(text);
}
export async function deviceAuthorize() {
    const body = (await postForm(DEVICE_URL, { client_id: CLIENT_ID }));
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
export async function pollToken(deviceCode, intervalS, expiresInS) {
    let interval = Math.max(MIN_INTERVAL_S, Number(intervalS) || 5);
    const deadline = Date.now() + Number(expiresInS || 600) * 1000;
    let slowDowns = 0;
    while (Date.now() < deadline) {
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
                signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
            });
            try {
                body = (await res.json());
            }
            catch {
                body = null;
            }
        }
        catch {
            body = null;
        }
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
            throw new Error(`login failed: ${body?.error || "unreadable token response"}`);
        }
        const remaining = deadline - Date.now();
        if (remaining <= 0)
            break;
        await new Promise((resolve) => setTimeout(resolve, Math.min(interval, remaining) * 1000));
    }
    throw new Error(slowDowns ? "login timed out after slow_down responses" : "login timed out waiting for approval");
}
export async function mintKey(accessToken) {
    const res = await fetch(KEY_URL, {
        method: "POST",
        headers: { ...HEADERS, "Content-Type": "application/json", Authorization: `Bearer ${accessToken}` },
        body: JSON.stringify({ onboard: true }),
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    const text = await res.text();
    if (!res.ok)
        throw new Error(`key exchange failed: HTTP ${res.status} ${text.slice(0, 200)}`.trim());
    const body = JSON.parse(text);
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
