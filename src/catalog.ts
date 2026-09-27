// Live model catalog for the Meta Model API, with static fallback.
//
// buildProvider resolves the subscription key on every call (explicit env
// wins, otherwise a fresh cache read, so no gateway restart is needed after
// the first login), fetches GET {baseUrl}/models with a short TTL, filters
// non-chat families, and falls back to the static baseline on any failure:
// missing key, network error, or unexpected shape.

import { defaultCachePath, explicitToken } from "./config.js";
import { readCacheSync } from "./auth.js";

export const MODELS_PATH = "/models";
export const LIVE_CATALOG_TTL_MS = 60_000;
export const FETCH_TIMEOUT_MS = 8_000;

// Allowlist: this provider serves the Muse Spark chat family. The live
// endpoint also returns other families (sam-*, muse-image-*, muse-voice-*)
// that are not usable as chat/completions models — a denylist would leak
// the next such family, so only muse-spark-* is admitted. Anything else
// still resolves through the dynamic resolver if requested explicitly.
const CHAT_FAMILY_PREFIX = "muse-spark-";

type ModelsResponse = {
  data?: unknown;
};

type CachedEntry = {
  ids: string[];
  expiresAt: number;
};

let cache: CachedEntry | null = null;

/** Test-only cache reset. */
export function __clearLiveCatalogCache(): void {
  cache = null;
}

/** Resolve the subscription key: explicit env wins, else a fresh cache read. */
export function resolveKey(): string {
  return explicitToken() || readCacheSync(defaultCachePath());
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
    .filter((id) => id.startsWith(CHAT_FAMILY_PREFIX));
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
  if (cache && Date.now() < cache.expiresAt) return cache.ids;
  const ids = await fetchLiveModelIds(baseUrl, apiKey);
  if (!ids) {
    cache = null;
    return null;
  }
  cache = { ids, expiresAt: Date.now() + Math.max(0, ttlMs) };
  return ids;
}
