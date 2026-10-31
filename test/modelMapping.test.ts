import { beforeEach, describe, expect, it } from "vitest";
import {
  DEFAULT_MODEL_ID,
  META_BASE_URL,
  __setAdapterFactoryForTests,
  ensureMuseCodeAdapter,
  museCodeBaseUrl,
  projectModel,
  providerFromRows,
  resolveMuseCodeDynamicModel,
} from "../index.js";
import { museCodeBaselineModels } from "../src/baseline.models.js";
import manifest from "../openclaw.plugin.json";

/** Loopback origin the host would receive while the adapter is running. */
const ADAPTER_BASE_URL = "http://127.0.0.1:43219/v1";

beforeEach(() => {
  __setAdapterFactoryForTests();
});

describe("projectModel", () => {
  it("returns null for invalid rows", () => {
    expect(projectModel({})).toBeNull();
    expect(projectModel({ id: 42 })).toBeNull();
    expect(projectModel({ id: "" })).toBeNull();
  });

  it("routes every model to openai-responses on the Meta base URL", () => {
    const m = projectModel({ id: "muse-spark-1.3", context_length: 1048576 });
    expect(m).not.toBeNull();
    expect(m?.api).toBe("openai-responses");
    expect(m?.baseUrl).toBe(META_BASE_URL);
    expect(m?.input).toEqual(["text", "image"]);
    expect(m?.reasoning).toBe(true);
    expect(m?.cost).toEqual({
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
    });
  });

  it("caps maxTokens conservatively against the full context window", () => {
    const m = projectModel({ id: "muse-spark-1.3", context_length: 1048576 });
    expect(m?.maxTokens).toBe(131072);
  });

  it("falls back to the family context window when context_length is missing", () => {
    const m = projectModel({ id: "muse-spark-1.1" });
    expect(m?.contextWindow).toBe(1048576);
    expect(m?.name).toBe("muse-spark-1.1");
  });

  it("prefers name when present", () => {
    const m = projectModel({ id: "muse-spark-1.2", name: "Muse Spark 1.2" });
    expect(m?.name).toBe("Muse Spark 1.2");
  });
});

describe("static baseline (pre-credential discovery)", () => {
  it("ships the Muse Spark and Wonder families", () => {
    const ids = museCodeBaselineModels.map((r) => r.id);
    expect(ids).toEqual([
      "muse-spark-1.3",
      "muse-spark-1.3-contributor",
      "muse-wonder-1.0",
      "muse-wonder-1.0-contributor",
      "muse-wonder-full-1.0",
      "muse-wonder-full-1.0-contributor",
      "muse-spark-1.2",
      "muse-spark-1.2-contributor",
      "muse-spark-1.1",
    ]);
  });

  it("projects the baseline into a provider config", () => {
    const cfg = providerFromRows(museCodeBaselineModels);
    expect(cfg.models.length).toBe(museCodeBaselineModels.length);
    expect(cfg.baseUrl).toBe(META_BASE_URL);
    expect(cfg.api).toBe("openai-responses");
    expect(cfg.models.every((m) => m.maxTokens <= 131072)).toBe(true);
  });

  it("routes every baseline model to openai-responses", () => {
    const cfg = providerFromRows(museCodeBaselineModels);
    const apis = new Set(cfg.models.map((m) => m.api));
    expect([...apis]).toEqual(["openai-responses"]);
  });
});

describe("resolveMuseCodeDynamicModel", () => {
  it("resolves a baseline model id to a runtime model definition", () => {
    const m = resolveMuseCodeDynamicModel({ provider: "muse-code", modelId: "muse-spark-1.3" });
    expect(m).not.toBeNull();
    expect(m?.id).toBe("muse-spark-1.3");
    expect(m?.name).toBe("Muse Spark 1.3");
    expect(m?.provider).toBe("muse-code");
    expect(m?.api).toBe("openai-responses");
    expect(m?.baseUrl).toBe(META_BASE_URL);
    expect(m?.maxTokens).toBeLessThanOrEqual(131072);
  });

  it("strips a leading provider prefix from the model id", () => {
    const m = resolveMuseCodeDynamicModel({ provider: "muse-code", modelId: "muse-code/muse-spark-1.2" });
    expect(m?.id).toBe("muse-spark-1.2");
    expect(m?.api).toBe("openai-responses");
  });

  it("falls back to conservative defaults for unknown ids", () => {
    const m = resolveMuseCodeDynamicModel({ provider: "muse-code", modelId: "muse-spark-9.9" });
    expect(m?.id).toBe("muse-spark-9.9");
    expect(m?.name).toBe("muse-spark-9.9");
    expect(m?.api).toBe("openai-responses");
    expect(m?.contextWindow).toBe(1048576);
    expect(m?.maxTokens).toBe(131072);
    expect(m?.input).toEqual(["text", "image"]);
  });
});

describe("contributor-tier safeguard", () => {
  it("ships contributor variants as selectable, never as the default", () => {
    const ids = museCodeBaselineModels.map((r) => r.id);
    expect(ids.some((id) => id.includes("contributor"))).toBe(true);
    expect(DEFAULT_MODEL_ID.includes("contributor")).toBe(false);
    expect(ids).toContain(DEFAULT_MODEL_ID);
  });
});

describe("adapter base URL", () => {
  it("uses the direct endpoint until the adapter is running", () => {
    expect(museCodeBaseUrl()).toBe(META_BASE_URL);
  });

  it("routes the provider, its models and dynamic resolution to the adapter", async () => {
    __setAdapterFactoryForTests(async () => ({
      baseUrl: ADAPTER_BASE_URL,
      close: async () => {},
    }));
    await ensureMuseCodeAdapter();
    expect(museCodeBaseUrl()).toBe(ADAPTER_BASE_URL);

    const cfg = providerFromRows(museCodeBaselineModels);
    expect(cfg.baseUrl).toBe(ADAPTER_BASE_URL);
    expect(cfg.models.every((model) => model.baseUrl === ADAPTER_BASE_URL)).toBe(true);

    expect(projectModel({ id: "muse-spark-1.3" })?.baseUrl).toBe(ADAPTER_BASE_URL);
    expect(
      resolveMuseCodeDynamicModel({ provider: "muse-code", modelId: "muse-spark-1.3" })?.baseUrl,
    ).toBe(ADAPTER_BASE_URL);
  });

  it("falls back to the direct endpoint when the adapter cannot bind", async () => {
    const warnings: string[] = [];
    __setAdapterFactoryForTests(async () => {
      throw new Error("EADDRINUSE");
    });
    expect(
      await ensureMuseCodeAdapter({ warn: (message: string) => warnings.push(message) }),
    ).toBeUndefined();
    expect(museCodeBaseUrl()).toBe(META_BASE_URL);
    expect(providerFromRows(museCodeBaselineModels).baseUrl).toBe(META_BASE_URL);
    expect(warnings.join(" ")).toContain("using https://api.meta.ai/v1");
  });

  it("starts a single adapter instance", async () => {
    let starts = 0;
    __setAdapterFactoryForTests(async () => {
      starts += 1;
      return { baseUrl: ADAPTER_BASE_URL, close: async () => {} };
    });
    const first = await ensureMuseCodeAdapter();
    const second = await ensureMuseCodeAdapter();
    expect(starts).toBe(1);
    expect(second).toBe(first);
  });
});

describe("manifest modelCatalog (drift guard)", () => {
  // The manifest catalog is display metadata: the runtime provider entry is
  // built by catalog.buildProvider(), which carries the adapter origin and is
  // the value the host routes with. The manifest must not pin a static base
  // URL, because that would bypass the loopback adapter.
  const catalog = manifest.modelCatalog.providers["muse-code"];

  it("mirrors the baseline projection model by model", () => {
    const projected = providerFromRows(museCodeBaselineModels);
    expect(catalog.models.length).toBe(projected.models.length);
    const byId = new Map(projected.models.map((m) => [m.id, m]));
    for (const entry of catalog.models) {
      const expected = byId.get(entry.id);
      expect(expected, `manifest model ${entry.id} missing from baseline projection`).toBeDefined();
      expect(entry.name).toBe(expected?.name);
      expect(entry.api).toBe(expected?.api);
      expect(entry.baseUrl).toBeUndefined();
      expect(entry.reasoning).toBe(expected?.reasoning);
      expect(entry.input).toEqual(expected?.input);
      expect(entry.contextWindow).toBe(expected?.contextWindow);
      expect(entry.maxTokens).toBe(expected?.maxTokens);
      expect(entry.cost).toEqual(expected?.cost);
    }
  });

  it("keeps ids in the same order as the baseline", () => {
    expect(catalog.models.map((m) => m.id)).toEqual(
      museCodeBaselineModels.map((r) => r.id),
    );
  });

  it("declares static discovery without pinning a static base URL", () => {
    expect(manifest.modelCatalog.discovery["muse-code"]).toBe("static");
    expect(catalog.baseUrl).toBeUndefined();
    expect(catalog.api).toBe("openai-responses");
  });
});
