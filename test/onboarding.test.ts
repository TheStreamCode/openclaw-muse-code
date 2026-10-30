import { afterEach, describe, expect, it, vi } from "vitest";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import plugin from "../index.js";
import { readCache } from "../src/auth.js";
import { CREDENTIALS_ENV_VAR, ENV_VAR } from "../src/config.js";
import { __resetKeyStateForTests } from "../src/key.js";
import manifest from "../openclaw.plugin.json";

const dirs: string[] = [];

afterEach(() => {
  vi.unstubAllGlobals();
  delete process.env[CREDENTIALS_ENV_VAR];
  delete process.env[ENV_VAR];
  __resetKeyStateForTests();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("Muse Code onboarding", () => {
  it("registers browser device login instead of an API-key prompt", async () => {
    const dir = mkdtempSync(join(tmpdir(), "muse-onboarding-"));
    dirs.push(dir);
    const cache = join(dir, "credentials.json");
    process.env[CREDENTIALS_ENV_VAR] = cache;
    process.env[ENV_VAR] = "explicit-user-key";
    const opened: string[] = [];
    const notes: string[] = [];
    vi.stubGlobal("fetch", vi.fn(async (input: string | URL | Request) => {
      const url = String(input);
      const body = url.includes("authorization")
        ? { device_code: "device", user_code: "TEST-CODE", verification_uri: "https://auth.meta.com/device", interval: 1, expires_in: 600 }
        : url.includes("token")
          ? { access_token: "temporary-token" }
          : { api_key: "inference-key", user_id: "account", is_subs_active: true };
      return new Response(JSON.stringify(body));
    }));
    let provider: any;
    plugin.register({
      registerProvider(value: unknown) { provider = value; },
      registerModelCatalogProvider() {},
    });
    expect(provider.auth.map((method: any) => method.kind)).toEqual(["device_code"]);
    const result = await provider.auth[0].run({
      prompter: { note: async (text: string) => { notes.push(text); } },
      openUrl: async (url: string) => { opened.push(url); },
      isRemote: false,
    });
    expect(opened).toEqual(["https://auth.meta.com/device"]);
    expect(notes.join(" ")).toContain("TEST-CODE");
    expect(result.profiles[0].credential).toEqual({ type: "api_key", provider: "muse-code", key: "inference-key" });
    expect(result.profiles[0].secretStorage).toEqual({ kind: "store", namePrefix: "MUSE_CODE" });
    expect(await readCache(cache)).toBe("inference-key");
    expect(process.env[ENV_VAR]).toBe("explicit-user-key");
    expect(notes.join(" ")).not.toContain("inference-key");
    expect(notes.join(" ")).not.toContain("temporary-token");
    expect(manifest.providerAuthChoices[0].method).toBe(provider.auth[0].id);
    expect(manifest.providerAuthChoices[0].appGuidedAuth).toBe("device-code");
    expect(manifest.providerAuthChoices[0].credentialOnly).toBe(true);
  });

  it("does not create credentials when the device flow is cancelled", async () => {
    const dir = mkdtempSync(join(tmpdir(), "muse-onboarding-"));
    dirs.push(dir);
    const cache = join(dir, "credentials.json");
    process.env[CREDENTIALS_ENV_VAR] = cache;
    const controller = new AbortController();
    const fetch = vi.fn(async (input: string | URL | Request) => {
      const url = String(input);
      if (url.includes("authorization")) return new Response(JSON.stringify({
        device_code: "device", user_code: "TEST-CODE", verification_uri: "https://auth.meta.com/device", interval: 1, expires_in: 600,
      }));
      if (url.includes("token")) {
        controller.abort();
        return new Response(JSON.stringify({ error: "authorization_pending" }), { status: 400 });
      }
      throw new Error("unexpected key exchange");
    });
    vi.stubGlobal("fetch", fetch);
    let provider: any;
    plugin.register({ registerProvider(value: unknown) { provider = value; }, registerModelCatalogProvider() {} });
    await expect(provider.auth[0].run({
      prompter: { note: async () => {} }, openUrl: async () => {}, isRemote: false, signal: controller.signal,
    })).rejects.toThrow();
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(existsSync(cache)).toBe(false);
  });

  it("rejects reference-only storage before starting a login", async () => {
    const fetch = vi.fn();
    vi.stubGlobal("fetch", fetch);
    let provider: any;
    plugin.register({ registerProvider(value: unknown) { provider = value; }, registerModelCatalogProvider() {} });
    await expect(provider.auth[0].run({
      prompter: { note: async () => {} }, openUrl: async () => {}, isRemote: false, secretInputMode: "ref",
    })).rejects.toThrow(/reference-only storage/i);
    expect(fetch).not.toHaveBeenCalled();
  });

  it("offers a manual link if opening the browser fails", async () => {
    const dir = mkdtempSync(join(tmpdir(), "muse-onboarding-"));
    dirs.push(dir);
    process.env[CREDENTIALS_ENV_VAR] = join(dir, "credentials.json");
    vi.stubGlobal("fetch", vi.fn(async (input: string | URL | Request) => {
      const url = String(input);
      const body = url.includes("authorization")
        ? { device_code: "device", user_code: "TEST-CODE", verification_uri: "https://auth.meta.com/device", interval: 1, expires_in: 600 }
        : url.includes("token")
          ? { access_token: "temporary-token" }
          : { api_key: "inference-key", user_id: "account", is_subs_active: true };
      return new Response(JSON.stringify(body));
    }));
    let provider: any;
    plugin.register({ registerProvider(value: unknown) { provider = value; }, registerModelCatalogProvider() {} });
    const notes: string[] = [];
    const result = await provider.auth[0].run({
      prompter: { note: async (message: string) => { notes.push(message); } },
      openUrl: async () => { throw new Error("browser unavailable"); },
      credentialOnly: true,
      isRemote: true,
    });
    expect(notes.join(" ")).toContain("https://auth.meta.com/device");
    expect(notes.join(" ")).toMatch(/browser did not open/i);
    expect(result.profiles).toHaveLength(1);
    expect(result.defaultModel).toBeUndefined();
  });
});
