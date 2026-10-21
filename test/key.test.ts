import { describe, expect, it, afterEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  __resetKeyStateForTests,
  resolveKey,
  syncEnvFromCache,
} from "../src/key.js";
import { CREDENTIALS_ENV_VAR, ENV_VAR } from "../src/config.js";

const dirs: string[] = [];

function cacheFile(apiKey: string): string {
  const dir = mkdtempSync(join(tmpdir(), "muse-key-"));
  dirs.push(dir);
  const path = join(dir, "creds.json");
  writeFileSync(path, JSON.stringify({ apiKey, accountId: "u" }));
  process.env[CREDENTIALS_ENV_VAR] = path;
  return path;
}

afterEach(() => {
  __resetKeyStateForTests();
  delete process.env[CREDENTIALS_ENV_VAR];
  delete process.env[ENV_VAR];
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("syncEnvFromCache", () => {
  it("exports the cached key", () => {
    cacheFile("LLM|first");
    syncEnvFromCache();
    expect(process.env[ENV_VAR]).toBe("LLM|first");
  });

  it("refreshes the owned value when the cache changes", () => {
    const path = cacheFile("LLM|first");
    syncEnvFromCache();
    writeFileSync(path, JSON.stringify({ apiKey: "LLM|second", accountId: "u" }));
    syncEnvFromCache();
    expect(process.env[ENV_VAR]).toBe("LLM|second");
  });

  it("never overwrites an explicit env value", () => {
    process.env[ENV_VAR] = "pinned";
    cacheFile("LLM|cache");
    syncEnvFromCache();
    expect(process.env[ENV_VAR]).toBe("pinned");
  });

  it("removes only the value it owned when the cache disappears", () => {
    const path = cacheFile("LLM|gone");
    syncEnvFromCache();
    expect(process.env[ENV_VAR]).toBe("LLM|gone");
    rmSync(path, { force: true });
    syncEnvFromCache();
    expect(process.env[ENV_VAR]).toBeUndefined();
  });
});

describe("resolveKey", () => {
  it("prefers an explicit env value", () => {
    process.env[ENV_VAR] = "pinned";
    cacheFile("LLM|cache");
    expect(resolveKey()).toBe("pinned");
  });

  it("falls back to the cache", () => {
    cacheFile("LLM|cache");
    expect(resolveKey()).toBe("LLM|cache");
  });

  it("resolves empty with no env and no cache", () => {
    process.env[CREDENTIALS_ENV_VAR] = join(tmpdir(), "muse-key-absent.json");
    expect(resolveKey()).toBe("");
  });
});
