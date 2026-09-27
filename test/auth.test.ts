import { describe, expect, it, afterEach, vi } from "vitest";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { mkdtempSync, readFileSync } from "node:fs";
import { CREDENTIALS_ENV_VAR, defaultCachePath } from "../src/config.js";
import {
  readCache,
  writeCache,
  deviceAuthorize,
  pollToken,
  mintKey,
} from "../src/auth.js";

type Handler = (url: string) => { status: number; body: unknown };

function stubFetch(handler: Handler): void {
  globalThis.fetch = (async (input: unknown) => {
    const url = String(input);
    const { status, body } = handler(url);
    return new Response(JSON.stringify(body), { status });
  }) as typeof fetch;
}

afterEach(() => {
  vi.unstubAllGlobals();
  delete process.env[CREDENTIALS_ENV_VAR];
});

const DEVICE_OK = {
  device_code: "dc",
  user_code: "ABCD-EFGH",
  verification_uri: "https://auth.meta.com/device",
  verification_uri_complete: "https://auth.meta.com/device?user_code=ABCD-EFGH",
  interval: 0,
  expires_in: 600,
};

const KEY_OK = {
  api_key: "LLM|fresh",
  user_email: "User@Example.com",
  user_id: "uid-1",
  is_subs_active: true,
};

describe("credential cache", () => {
  it("roundtrips credentials", async () => {
    const dir = mkdtempSync(join(tmpdir(), "muse-auth-"));
    const path = join(dir, "creds.json");
    await writeCache({ oauthAccessToken: "dca-x", apiKey: "LLM|k", accountId: "uid-1" }, path);
    expect(await readCache(path)).toBe("LLM|k");
  });

  it("miss resolves empty", async () => {
    expect(await readCache(join(tmpdir(), "muse-auth-absent.json"))).toBe("");
  });

  it("never persists the OAuth access token", async () => {
    const dir = mkdtempSync(join(tmpdir(), "muse-auth-"));
    const path = join(dir, "creds.json");
    await writeCache(
      { oauthAccessToken: "dca-secret", apiKey: "LLM|k", accountId: "uid-1", email: "u@e.c" },
      path,
    );
    const raw = readFileSync(path, "utf8");
    expect(raw).not.toContain("dca-secret");
    expect(raw).not.toContain("oauthAccessToken");
    expect(JSON.parse(raw)).toStrictEqual({ apiKey: "LLM|k", accountId: "uid-1", email: "u@e.c" });
  });

  it("honors the MUSE_CODE_SUB_CREDENTIALS override", () => {
    const custom = join(tmpdir(), "custom-creds.json");
    process.env[CREDENTIALS_ENV_VAR] = custom;
    expect(defaultCachePath()).toBe(custom);
  });
});

describe("device authorize", () => {
  it("validates fields", async () => {
    stubFetch(() => ({ status: 200, body: DEVICE_OK }));
    const device = await deviceAuthorize();
    expect(device.user_code).toBe("ABCD-EFGH");
    stubFetch(() => ({ status: 200, body: { user_code: "x" } }));
    await expect(deviceAuthorize()).rejects.toThrow(/missing fields/);
  });
});

describe("poll token", () => {
  it("completes after pending", async () => {
    let calls = 0;
    stubFetch(() => {
      calls += 1;
      return calls === 1
        ? { status: 400, body: { error: "authorization_pending" } }
        : { status: 200, body: { access_token: "dca-new" } };
    });
    expect(await pollToken("dc", 1, 600)).toBe("dca-new");
  });

  it("rejects terminal errors", async () => {
    stubFetch(() => ({ status: 400, body: { error: "access_denied" } }));
    await expect(pollToken("dc", 0, 600)).rejects.toThrow(/access_denied/);
  });
});

describe("mint key", () => {
  it("validates subscription", async () => {
    stubFetch(() => ({ status: 200, body: KEY_OK }));
    const minted = await mintKey("dca-x");
    expect(minted).toStrictEqual({
      oauthAccessToken: "dca-x",
      apiKey: "LLM|fresh",
      accountId: "uid-1",
      email: "user@example.com",
    });
    stubFetch(() => ({ status: 200, body: { ...KEY_OK, is_subs_active: false } }));
    await expect(mintKey("dca-x")).rejects.toThrow(/inactive/);
  });

  it("surfaces payment requirement with action url", async () => {
    stubFetch(() => ({
      status: 200,
      body: { require_payment: true, action_url: "https://example.test/pay" },
    }));
    await expect(mintKey("dca-x")).rejects.toThrow(/required.*https:\/\/example\.test\/pay/);
  });
});
