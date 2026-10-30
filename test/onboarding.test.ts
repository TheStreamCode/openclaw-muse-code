import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import plugin, {
  ADAPTER_ENV_VAR,
  META_BASE_URL,
  __setAdapterFactoryForTests,
} from "../index.js";
import { readCache } from "../src/auth.js";
import { CREDENTIALS_ENV_VAR, ENV_VAR } from "../src/config.js";
import { __resetKeyStateForTests } from "../src/key.js";
import manifest from "../openclaw.plugin.json";

/** Loopback origin the host receives while the adapter is running. */
const ADAPTER_BASE_URL = "http://127.0.0.1:43219/v1";

const dirs: string[] = [];

beforeEach(() => {
  // Plugin tests never bind a real port: the adapter is stubbed per test.
  __setAdapterFactoryForTests(async () => ({
    baseUrl: ADAPTER_BASE_URL,
    close: async () => {},
  }));
});

afterEach(() => {
  vi.unstubAllGlobals();
  delete process.env[CREDENTIALS_ENV_VAR];
  delete process.env[ENV_VAR];
  delete process.env[ADAPTER_ENV_VAR];
  __resetKeyStateForTests();
  __setAdapterFactoryForTests();
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

describe("Muse Code request adapter wiring", () => {
  /** Catalog context the host passes to a single-provider catalog run. */
  function catalogContext(providerId = "muse-code") {
    return {
      providerIds: [providerId],
      resolveProviderApiKey: () => ({ apiKey: "test-key" }),
      config: { models: {} },
    };
  }

  /** Keep key resolution offline: no explicit key and a cache path that does not exist. */
  function withoutCredential(): void {
    delete process.env[ENV_VAR];
    process.env[CREDENTIALS_ENV_VAR] = join(tmpdir(), "muse-adapter-absent.json");
  }

  it("starts the adapter once and points the provider entries at it", async () => {
    withoutCredential();
    const close = vi.fn(async () => {});
    const factory = vi.fn(
      async (_options: { passthrough: boolean; log: (message: string) => void }) => ({
        baseUrl: ADAPTER_BASE_URL,
        close,
      }),
    );
    __setAdapterFactoryForTests(factory);
    const providers: any[] = [];
    const api = {
      registerProvider(value: unknown) { providers.push(value); },
      registerModelCatalogProvider() {},
    };
    plugin.register(api);
    plugin.register(api);

    expect(factory).toHaveBeenCalledTimes(1);
    expect(factory.mock.calls[0]?.[0]).toMatchObject({ passthrough: false });
    const provider = providers[0];
    const live = await provider.catalog.run(catalogContext());
    expect(live.provider.baseUrl).toBe(ADAPTER_BASE_URL);
    expect(live.provider.models.every((model: any) => model.baseUrl === ADAPTER_BASE_URL)).toBe(true);
    const stat = await provider.staticCatalog.run(catalogContext());
    expect(stat.provider.baseUrl).toBe(ADAPTER_BASE_URL);
  });

  it("keeps the proxy in passthrough mode when MUSE_CODE_ADAPTER=off", () => {
    withoutCredential();
    process.env[ADAPTER_ENV_VAR] = "off";
    const factory = vi.fn(
      async (_options: { passthrough: boolean; log: (message: string) => void }) => ({
        baseUrl: ADAPTER_BASE_URL,
        close: async () => {},
      }),
    );
    __setAdapterFactoryForTests(factory);
    plugin.register({ registerProvider() {}, registerModelCatalogProvider() {} });
    expect(factory.mock.calls[0]?.[0]).toMatchObject({ passthrough: true });
  });

  it("keeps the direct endpoint when the adapter cannot bind", async () => {
    withoutCredential();
    const warn = vi.fn();
    __setAdapterFactoryForTests(async () => {
      throw new Error("EADDRINUSE");
    });
    let provider: any;
    plugin.register({
      registerProvider(value: unknown) { provider = value; },
      registerModelCatalogProvider() {},
      logger: { debug: vi.fn(), warn },
    });
    const live = await provider.catalog.run(catalogContext());
    expect(live.provider.baseUrl).toBe(META_BASE_URL);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(String(warn.mock.calls[0]?.[0])).toContain(META_BASE_URL);
  });

  it("releases the adapter through the host lifecycle", async () => {
    withoutCredential();
    const close = vi.fn(async () => {});
    __setAdapterFactoryForTests(async () => ({ baseUrl: ADAPTER_BASE_URL, close }));
    let registration: { id: string; dispose?: () => void | Promise<void> } | undefined;
    plugin.register({
      registerProvider() {},
      registerModelCatalogProvider() {},
      lifecycle: {
        registerRuntimeLifecycle(value: { id: string; dispose?: () => void | Promise<void> }) {
          registration = value;
        },
      },
    });
    expect(registration?.id).toBe("muse-code-request-adapter");
    await registration?.dispose?.();
    expect(close).toHaveBeenCalledTimes(1);
  });
});
