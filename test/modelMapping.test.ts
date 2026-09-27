import { describe, expect, it } from "vitest";
import {
  DEFAULT_MODEL_ID,
  projectModel,
  providerFromRows,
  resolveMuseCodeDynamicModel,
} from "../index.js";
import { museCodeBaselineModels } from "../src/baseline.models.js";
import manifest from "../openclaw.plugin.json";

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
    expect(m?.baseUrl).toBe("https://api.meta.ai/v1");
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
  it("ships the five-model Muse Spark family", () => {
    const ids = museCodeBaselineModels.map((r) => r.id);
    expect(ids).toEqual([
      "muse-spark-1.3",
      "muse-spark-1.3-contributor",
      "muse-spark-1.2",
      "muse-spark-1.2-contributor",
      "muse-spark-1.1",
    ]);
  });

  it("projects the baseline into a provider config", () => {
    const cfg = providerFromRows(museCodeBaselineModels);
    expect(cfg.models.length).toBe(museCodeBaselineModels.length);
    expect(cfg.baseUrl).toBe("https://api.meta.ai/v1");
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
    expect(m?.baseUrl).toBe("https://api.meta.ai/v1");
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

describe("manifest modelCatalog (drift guard)", () => {
  const catalog = manifest.modelCatalog.providers["muse-code"];
  const projected = providerFromRows(museCodeBaselineModels);

  it("mirrors the baseline projection model by model", () => {
    expect(catalog.models.length).toBe(projected.models.length);
    const byId = new Map(projected.models.map((m) => [m.id, m]));
    for (const entry of catalog.models) {
      const expected = byId.get(entry.id);
      expect(expected, `manifest model ${entry.id} missing from baseline projection`).toBeDefined();
      expect(entry.name).toBe(expected?.name);
      expect(entry.api).toBe(expected?.api);
      expect(entry.baseUrl).toBe(expected?.baseUrl);
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

  it("declares static discovery and the provider-level transport", () => {
    expect(manifest.modelCatalog.discovery["muse-code"]).toBe("static");
    expect(catalog.baseUrl).toBe("https://api.meta.ai/v1");
    expect(catalog.api).toBe("openai-responses");
  });
});
