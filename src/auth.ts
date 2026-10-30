// Meta device-login transport (no third-party CLI).
// Flow parameters are compatible with the published behavior of oh-my-pi
// (MIT-licensed; see NOTICE).
//
// This module performs network requests but never reads the environment:
// credential sources (env names, cache paths) live in config.ts and are
// passed in explicitly by callers.

import { dirname } from "node:path"
import { readFileSync } from "node:fs"
import { readFile, writeFile, mkdir, chmod } from "node:fs/promises"
import { setTimeout as delay } from "node:timers/promises"

export const CLIENT_ID = "1031625952748946"
export const DEVICE_URL = "https://auth.meta.com/oidc/device/authorization/"
export const TOKEN_URL = "https://auth.meta.com/oidc/device/token/"
export const KEY_URL = "https://api.meta.ai/muse-code/key"
export const AUTH_CONTRACT_VERSION = 1

const HEADERS: Record<string, string> = {
  Accept: "application/json",
  "x-api-version": "1.0.0",
}
const REQUEST_TIMEOUT_MS = 25_000
const MIN_INTERVAL_S = 1
const SLOW_DOWN_STEP_S = 5
const TOKEN_ERRORS = new Set([
  "access_denied", "expired_token", "invalid_grant", "invalid_client",
  "unauthorized_client", "unsupported_grant_type", "invalid_request",
])

export interface DeviceAuthorization {
  device_code: string
  user_code: string
  verification_uri: string
  verification_uri_complete?: string
  interval: number
  expires_in: number
}

export interface MintedCredential {
  // In-memory only: writeCache never persists the OAuth token (see below).
  oauthAccessToken: string
  apiKey: string
  accountId: string
  email?: string
}

/** The only fields ever written to the credential cache. */
export interface CachedCredential {
  apiKey: string
  accountId: string
  email?: string
}

type DeviceResponse = {
  device_code?: unknown
  user_code?: unknown
  verification_uri?: unknown
  verification_uri_complete?: unknown
  interval?: unknown
  expires_in?: unknown
}

type TokenResponse = {
  error?: unknown
  error_description?: unknown
  access_token?: unknown
}

type KeyResponse = {
  api_key?: unknown
  is_subs_active?: unknown
  require_payment?: unknown
  action_url?: unknown
  require_payment_action_url?: unknown
  user_email?: unknown
  user_id?: unknown
}

export async function readCache(path: string): Promise<string> {
  try {
    const blob = (await readFile(path, "utf8").then(JSON.parse)) as Partial<CachedCredential>
    return typeof blob?.apiKey === "string" && blob.apiKey.trim() ? blob.apiKey.trim() : ""
  } catch {
    return ""
  }
}

/** Sync cache read for module-load key resolution (silent miss on any failure). */
export function readCacheSync(path: string): string {
  try {
    const blob = JSON.parse(readFileSync(path, "utf8")) as Partial<CachedCredential>
    return typeof blob?.apiKey === "string" && blob.apiKey.trim() ? blob.apiKey.trim() : ""
  } catch {
    return ""
  }
}

export async function writeCache(credentials: MintedCredential, path: string): Promise<void> {
  // Retention minimization: persist only what inference needs. The OAuth
  // access token has unknown broader scope and nothing reads it back, so it
  // must never touch disk — sanitize at the sink, whatever callers pass in.
  const { apiKey, accountId, email } = credentials
  const cached: CachedCredential = { apiKey, accountId, ...(email ? { email } : {}) }
  await mkdir(dirname(path), { recursive: true })
  await writeFile(path, JSON.stringify(cached, null, 2))
  try {
    await chmod(path, 0o600)
  } catch {
    /* Windows ACLs inherit profile permissions */
  }
}

function requestSignal(signal?: AbortSignal): AbortSignal {
  const timeout = AbortSignal.timeout(REQUEST_TIMEOUT_MS)
  return signal ? AbortSignal.any([signal, timeout]) : timeout
}

async function postForm(url: string, params: Record<string, string>, signal?: AbortSignal): Promise<unknown> {
  const res = await fetch(url, {
    method: "POST",
    headers: { ...HEADERS, "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams(params).toString(),
    signal: requestSignal(signal),
  })
  if (!res.ok) throw new Error(`device authorization failed: HTTP ${res.status}`)
  return res.json()
}

export async function deviceAuthorize(signal?: AbortSignal): Promise<DeviceAuthorization> {
  const body = (await postForm(DEVICE_URL, { client_id: CLIENT_ID }, signal)) as DeviceResponse
  const { device_code, user_code, verification_uri, interval, expires_in } = body
  if (
    typeof device_code !== "string" ||
    !device_code ||
    typeof user_code !== "string" ||
    !user_code ||
    typeof verification_uri !== "string" ||
    !verification_uri ||
    typeof interval !== "number" ||
    typeof expires_in !== "number"
  ) {
    throw new Error("device authorization response is missing fields")
  }
  const complete = body.verification_uri_complete
  return {
    device_code,
    user_code,
    verification_uri,
    ...(typeof complete === "string" && complete ? { verification_uri_complete: complete } : {}),
    interval,
    expires_in,
  }
}

export async function pollToken(deviceCode: string, intervalS: number, expiresInS: number, signal?: AbortSignal): Promise<string> {
  let interval = Math.max(MIN_INTERVAL_S, Number(intervalS) || 5)
  const deadline = Date.now() + Number(expiresInS || 600) * 1000
  let slowDowns = 0
  while (Date.now() < deadline) {
    signal?.throwIfAborted()
    // The token endpoint answers HTTP errors (e.g. 400 authorization_pending)
    // as part of the normal flow: never throw here, classify instead.
    let body: TokenResponse | null = null
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
      })
      try {
        body = (await res.json()) as TokenResponse
      } catch {
        body = null
      }
    } catch {
      signal?.throwIfAborted()
      body = null
    }
    signal?.throwIfAborted()
    if (body && !body.error) {
      if (typeof body.access_token !== "string" || !body.access_token) {
        throw new Error("token response has no access_token")
      }
      return body.access_token
    }
    if (body?.error === "slow_down") {
      slowDowns += 1
      interval = Math.max(MIN_INTERVAL_S, interval + SLOW_DOWN_STEP_S)
    } else if (body?.error !== "authorization_pending") {
      const detail = typeof body?.error === "string" && TOKEN_ERRORS.has(body.error)
        ? body.error
        : body?.error ? "unknown token error" : "unreadable token response"
      throw new Error(`login failed: ${detail}`)
    }
    const remaining = deadline - Date.now()
    if (remaining <= 0) break
    await delay(Math.min(interval * 1000, remaining), undefined, { signal })
  }
  throw new Error(
    slowDowns ? "login timed out after slow_down responses" : "login timed out waiting for approval",
  )
}

export async function mintKey(accessToken: string, signal?: AbortSignal): Promise<MintedCredential> {
  const res = await fetch(KEY_URL, {
    method: "POST",
    headers: { ...HEADERS, "Content-Type": "application/json", Authorization: `Bearer ${accessToken}` },
    body: JSON.stringify({ onboard: true }),
    signal: requestSignal(signal),
  })
  if (!res.ok) throw new Error(`key exchange failed: HTTP ${res.status}`)
  const body = (await res.json()) as KeyResponse
  if (body.is_subs_active === false) throw new Error("Muse Code subscription is inactive for this account")
  if (typeof body.api_key !== "string" || !body.api_key.trim()) {
    const action = String(body.action_url || body.require_payment_action_url || "").trim()
    if (body.require_payment === true || action) {
      throw new Error(`Muse Code subscription is required${action ? ": " + action : ""}`)
    }
    throw new Error("key response is missing api_key")
  }
  const email = String(body.user_email || "").trim().toLowerCase() || undefined
  const accountId = String(body.user_id || "").trim() || email
  if (!accountId) throw new Error("key response is missing account identity")
  return { oauthAccessToken: accessToken, apiKey: body.api_key.trim(), accountId, email }
}
