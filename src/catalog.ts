// Live model catalog for the Meta Model API, with static fallback.
//
// buildProvider resolves the subscription key on every call (explicit env
// wins, otherwise a fresh cache read, so no gateway restart is needed after
// the first login), fetches GET {baseUrl}/models with a short TTL, filters
// non-chat families, and falls back to the static baseline on any failure:
// missing key, network error, or unexpected shape.

import { createHash } from "node:crypto";

export { resolveKey } from "./key.js";

export const MODELS_PATH = "/models";
export const LIVE_CATALOG_TTL_MS = 60_000;
export const FETCH_TIMEOUT_MS = 8_000;

// Dynamic discovery: admit every model id the live account catalog
// returns, except the endpoint families verified as non-chat
// (segmentation, image, voice). New chat models appear without a
// plugin update; only a brand-new non-chat family needs an entry here.
const NON_CHAT_PREFIXES = ["sam-", "muse-image-", "muse-voice-"];

type ModelsResponse = {
  data?: unknown;
};

type CachedEntry = {
  tokenHash: string;
  ids: string[];
  expiresAt: number;
};

let cache: CachedEntry | null = null;

/** Test-only cache reset. */
export function __clearLiveCatalogCache(): void {
  cache = null;
}

function tokenHash(key: string): string {
  return createHash("sha256").update(key).digest("hex");
}

function parseModelIds(body: unknown): string[] | null {
  if (typeof body !== "object" || body === null) return null;
  const data = (body as ModelsResponse).data;
  if (!Array.isArray(data)) return null;
  const ids = data
    .filter((row): row is { id: string } => {
      return (
        typeof row === "object" &&
        row !== null &&
        typeof (row as { id?: unknown }).id === "string" &&
        ((row as { id: string }).id.length > 0)
      );
    })
    .map((row) => row.id)
    .filter((id) => !NON_CHAT_PREFIXES.some((p) => id.startsWith(p)));
  return ids.length > 0 ? ids : null;
}

/**
 * Fetch the live chat-model id list. Returns null on any failure
 * (network, auth, unexpected shape, empty list) — callers fall back
 * to the static baseline.
 */
export async function fetchLiveModelIds(
  baseUrl: string,
  apiKey: string,
  timeoutMs: number = FETCH_TIMEOUT_MS,
): Promise<string[] | null> {
  if (!apiKey) return null;
  try {
    const res = await fetch(`${baseUrl}${MODELS_PATH}`, {
      headers: {
        Accept: "application/json",
        Authorization: `Bearer ${apiKey}`,
      },
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!res.ok) return null;
    return parseModelIds((await res.json()) as unknown);
  } catch {
    return null;
  }
}

/** TTL-cached live fetch. Returns null on miss/expiry+failure (use static). */
export async function getLiveModelIdsCached(
  baseUrl: string,
  apiKey: string,
  ttlMs: number = LIVE_CATALOG_TTL_MS,
): Promise<string[] | null> {
  const hash = tokenHash(apiKey);
  if (cache && cache.tokenHash === hash && Date.now() < cache.expiresAt) return cache.ids;
  const ids = await fetchLiveModelIds(baseUrl, apiKey);
  if (!ids) {
    cache = null;
    return null;
  }
  cache = { tokenHash: hash, ids, expiresAt: Date.now() + Math.max(0, ttlMs) };
  return ids;
}
