// Smoke test: exercises both discovery paths of the compiled plugin.
//   - staticCatalog (baseline) works WITHOUT credentials — this is what makes
//     `models list --provider muse-code` show models before a key resolves.
//   - catalog.run (live) serves the same static family (no public
//     unauthenticated catalog endpoint exists for the Meta Model API).
// Run: node scripts/smoke.discovery.mjs

const registeredProviders = [];
const registeredCatalogs = [];
const api = {
  registerProvider: (p) => registeredProviders.push(p),
  registerModelCatalogProvider: (c) => registeredCatalogs.push(c),
};

const { default: entry } = await import("../dist/index.js");
await entry.register(api);

const provider = registeredProviders[0];
console.log("plugin:", entry.id);
console.log("provider id:", provider.id);
console.log("provider label:", provider.label);
console.log("provider envVars:", provider.envVars?.join(","));
console.log("auth methods:", (provider.auth || []).map((a) => a.methodId).join(","));

for (const [label, catalog, apiKey] of [
  ["static baseline (no credentials)", provider.staticCatalog, undefined],
  // Live discovery requires a resolvable key (fake is fine: the builder
  // serves static data and never calls the network in this path).
  ["live discovery", provider.catalog, "cc_TEST_FAKE_KEY_FOR_DISCOVERY"],
]) {
  console.log(`\n-- ${label} --`);
  if (catalog && typeof catalog.run === "function") {
    const run = await catalog.run({
      resolveProviderApiKey: () => ({ apiKey }),
    });
    const models = run?.provider?.models ?? [];
    const byApi = {};
    for (const m of models) byApi[m.api] = (byApi[m.api] || 0) + 1;
    console.log("models:", models.length, "| by transport:", JSON.stringify(byApi));
    for (const id of ["muse-spark-1.3", "muse-spark-1.2", "muse-spark-1.1"]) {
      const m = models.find((x) => x.id === id);
      console.log(`  [${id}] -> ${m ? m.api + " ctx=" + m.contextWindow : "NOT FOUND"}`);
    }
    console.log("baseUrl:", run?.provider?.baseUrl);
  } else {
    console.log("catalog NOT exposed (check entry normalization)");
  }
}
