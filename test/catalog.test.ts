import { describe, expect, it, afterEach, vi } from "vitest";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { mkdtempSync, writeFileSync } from "node:fs";
import {
  __clearLiveCatalogCache,
  fetchLiveModelIds,
  getLiveModelIdsCached,
  resolveKey,
} from "../src/catalog.js";
import { CREDENTIALS_ENV_VAR, ENV_VAR } from "../src/config.js";

type Handler = (url: string, options?: unknown) => { status: number; body: unknown };

function stubFetch(handler: Handler): { calls: () => number } {
  let calls = 0;
  globalThis.fetch = (async (input: unknown, init?: unknown) => {
    calls += 1;
    const { status, body } = handler(String(input), init);
    return new Response(JSON.stringify(body), { status });
  }) as typeof fetch;
  return { calls: () => calls };
}

const savedEnv = { ...process.env };

afterEach(() => {
  vi.unstubAllGlobals();
  __clearLiveCatalogCache();
  delete process.env[ENV_VAR];
  delete process.env[CREDENTIALS_ENV_VAR];
  for (const [key, value] of Object.entries(savedEnv)) {
    if (key === ENV_VAR || key === CREDENTIALS_ENV_VAR) process.env[key] = value as string;
  }
});

const LIVE_OK = {
  data: [
    { id: "muse-spark-1.3" },
    { id: "muse-spark-9.9" },
    { id: "sam-3.1" },
    { id: "muse-image-1.0" },
    { id: "muse-voice-2.0" },
  ],
};

describe("fetchLiveModelIds", () => {
  it("admits only the muse-spark chat family", async () => {
    stubFetch(() => ({ status: 200, body: LIVE_OK }));
    expect(await fetchLiveModelIds("https://x.test/v1", "k")).toEqual([
      "muse-spark-1.3",
      "muse-spark-9.9",
    ]);
  });

  it("sends the bearer key to /models", async () => {
    let seen: { url: string; auth: unknown } | null = null;
    stubFetch((url, init) => {
      const headers = (init as { headers?: Record<string, string> })?.headers ?? {};
      seen = { url, auth: headers["Authorization"] };
      return { status: 200, body: { data: [{ id: "muse-spark-1.3" }] } };
    });
    await fetchLiveModelIds("https://x.test/v1", "LLM|k");
    expect(seen?.url).toBe("https://x.test/v1/models");
    expect(seen?.auth).toBe("Bearer LLM|k");
  });

  it("returns null without a key", async () => {
    const counter = stubFetch(() => ({ status: 200, body: LIVE_OK }));
    expect(await fetchLiveModelIds("https://x.test/v1", "")).toBeNull();
    expect(counter.calls()).toBe(0);
  });

  it.each([
    ["http error", 401, { error: "nope" }],
    ["non-object body", 200, []],
    ["missing data array", 200, { data: "nope" }],
    ["empty data", 200, { data: [] }],
    ["no valid ids", 200, { data: [{ id: 42 }, {}] }],
  ])("returns null on %s", async (_label, status, body) => {
    stubFetch(() => ({ status: status as number, body }));
    expect(await fetchLiveModelIds("https://x.test/v1", "k")).toBeNull();
  });

  it("returns null on network failure", async () => {
    globalThis.fetch = (async () => {
      throw new Error("boom");
    }) as typeof fetch;
    expect(await fetchLiveModelIds("https://x.test/v1", "k")).toBeNull();
  });
});

describe("getLiveModelIdsCached", () => {
  it("serves warm entries without refetching", async () => {
    const counter = stubFetch(() => ({ status: 200, body: LIVE_OK }));
    expect(await getLiveModelIdsCached("https://x.test/v1", "k", 60_000)).toHaveLength(2);
    expect(await getLiveModelIdsCached("https://x.test/v1", "k", 60_000)).toHaveLength(2);
    expect(counter.calls()).toBe(1);
  });

  it("refetches after expiry", async () => {
    const counter = stubFetch(() => ({ status: 200, body: LIVE_OK }));
    expect(await getLiveModelIdsCached("https://x.test/v1", "k", 0)).toHaveLength(2);
    expect(await getLiveModelIdsCached("https://x.test/v1", "k", 60_000)).toHaveLength(2);
    expect(counter.calls()).toBe(2);
  });

  it("clears stale entries on failure", async () => {
    stubFetch(() => ({ status: 200, body: LIVE_OK }));
    expect(await getLiveModelIdsCached("https://x.test/v1", "k", 60_000)).toHaveLength(2);
    stubFetch(() => ({ status: 500, body: {} }));
    __clearLiveCatalogCache();
    expect(await getLiveModelIdsCached("https://x.test/v1", "k", 60_000)).toBeNull();
  });
});

describe("resolveKey", () => {
  it("prefers explicit env over cache", () => {
    process.env[ENV_VAR] = "pinned";
    expect(resolveKey()).toBe("pinned");
  });

  it("falls back to the cache file", () => {
    const dir = mkdtempSync(join(tmpdir(), "muse-catalog-"));
    const path = join(dir, "creds.json");
    writeFileSync(path, JSON.stringify({ apiKey: "LLM|cache", accountId: "u" }));
    process.env[CREDENTIALS_ENV_VAR] = path;
    expect(resolveKey()).toBe("LLM|cache");
  });

  it("resolves empty with no env and no cache", () => {
    process.env[CREDENTIALS_ENV_VAR] = join(tmpdir(), "muse-catalog-absent.json");
    expect(resolveKey()).toBe("");
  });
});
