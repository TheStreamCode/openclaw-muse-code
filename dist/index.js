/**
 * Muse Spark model provider plugin for OpenClaw, billed to the Muse Code
 * monthly subscription instead of API credits.
 *
 * Authentication is a Meta device-code login performed once via
 * `scripts/muse-code-login.mjs` (or `npm run login`): the flow mints a
 * stable, account-bound inference key cached at
 * `~/.openclaw/muse-code-sub.json`. Resolution order: an explicitly
 * configured `MUSE_CODE_SUB_TOKEN` wins, otherwise the cached key. Any
 * failure is a silent miss (provider simply shows as unconfigured).
 *
 * Wire: Meta Model API (`https://api.meta.ai/v1`) over the Responses API,
 * same as the official `@openclaw/meta-provider` (which is API-key billed).
 * This plugin exists for subscription billing; provider id `muse-code` is
 * intentionally distinct from the official `meta` id so both can coexist.
 */
import { defineSingleProviderPluginEntry, } from "openclaw/plugin-sdk/provider-entry";
import { ENV_VAR, defaultCachePath, explicitToken } from "./src/config.js";
import { readCacheSync } from "./src/auth.js";
import { museCodeBaselineModels } from "./src/baseline.models.js";
// Resolution order: explicit env wins, else the login cache. Silent miss.
if (!explicitToken()) {
    const cached = readCacheSync(defaultCachePath());
    if (cached)
        process.env[ENV_VAR] = cached;
}
/** Meta Model API base URL for Responses API traffic. */
const META_BASE_URL = "https://api.meta.ai/v1";
/**
 * Known Muse Spark context window (official catalog: input + output share
 * the budget). Used as the default when a row omits context_length.
 */
const MUSE_CONTEXT_WINDOW = 1_048_576;
/**
 * Conservative output cap: Meta publishes no exact max-output figure, so
 * stay within a sane ceiling instead of advertising the full window.
 */
const MAX_OUTPUT_TOKENS = 131_072;
/** Default model for setup flows: standard tier, never contributor. */
export const DEFAULT_MODEL_ID = "muse-spark-1.3";
/**
 * Maps a Muse Spark baseline row to an OpenClaw model definition.
 *
 * Every model uses the Responses API transport. Contributor-tier variants
 * keep working when selected explicitly (see README for the training-data
 * disclosure); nothing in this plugin ever selects them implicitly.
 */
export function projectModel(row) {
    const id = typeof row.id === "string" && row.id.length > 0 ? row.id : null;
    if (!id)
        return null;
    const rawName = row.name;
    const name = typeof rawName === "string" && rawName.length > 0 ? rawName : id;
    const rawCtx = row.context_length;
    const contextWindow = typeof rawCtx === "number" && rawCtx > 0 ? rawCtx : MUSE_CONTEXT_WINDOW;
    const api = "openai-responses";
    return {
        id,
        name,
        api,
        baseUrl: META_BASE_URL,
        reasoning: true,
        // Matches the official Meta provider: text + image input. Other upstream
        // modalities are not OpenClaw model-manifest input values.
        input: ["text", "image"],
        // Subscription billing has no per-token price; set to zero to avoid
        // fabricating prices.
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        contextWindow,
        maxTokens: Math.min(contextWindow, MAX_OUTPUT_TOKENS),
    };
}
/**
 * Builds the provider config from the static Muse Spark baseline.
 * Used for both live and static discovery (the family has no public
 * unauthenticated catalog endpoint, so both surfaces share one builder —
 * same approach as the official Meta provider).
 */
export function providerFromRows(rows) {
    const models = rows
        .map((row) => projectModel(row))
        .filter((m) => m !== null);
    return {
        baseUrl: META_BASE_URL,
        api: "openai-responses",
        models,
    };
}
async function buildProvider() {
    return providerFromRows(museCodeBaselineModels);
}
async function buildStaticProvider() {
    return providerFromRows(museCodeBaselineModels);
}
/** Strips a leading `<provider>/` prefix from a runtime model id when present. */
function stripProviderModelPrefix(provider, modelId) {
    const prefix = `${provider}/`;
    return modelId.startsWith(prefix) ? modelId.slice(prefix.length) : modelId;
}
/**
 * Resolves muse-code models missing from the static baseline.
 *
 * Ids in the snapshot resolve with baseline fidelity; unknown ids receive
 * a conservative provider-neutral definition so newly published models keep
 * working without a baseline refresh.
 */
export function resolveMuseCodeDynamicModel(ctx) {
    const provider = ctx.provider ?? "muse-code";
    const modelId = stripProviderModelPrefix(provider, ctx.modelId);
    const row = museCodeBaselineModels.find((entry) => entry.id === modelId);
    const projected = row ? projectModel(row) : null;
    const contextWindow = projected?.contextWindow ?? MUSE_CONTEXT_WINDOW;
    return {
        id: modelId,
        name: projected?.name ?? modelId,
        api: "openai-responses",
        provider,
        baseUrl: META_BASE_URL,
        reasoning: true,
        input: ["text", "image"],
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        contextWindow,
        maxTokens: Math.min(contextWindow, MAX_OUTPUT_TOKENS),
    };
}
export default defineSingleProviderPluginEntry({
    id: "muse-code",
    name: "Muse Code",
    description: "Muse Spark (api.meta.ai) model provider billed to the Muse Code monthly subscription.",
    provider: {
        label: "Muse Code",
        docsPath: "/providers/muse-code",
        auth: [
            {
                methodId: "api-key",
                label: "Muse Code subscription key",
                hint: "Subscription key from Meta device login (scripts/muse-code-login.mjs)",
                optionKey: "museCodeSubToken",
                flagName: "--muse-code-sub-token",
                envVar: ENV_VAR,
                promptMessage: "Enter your Muse Code subscription key (or run scripts/muse-code-login.mjs)",
                defaultModel: `muse-code/${DEFAULT_MODEL_ID}`,
            },
        ],
        catalog: {
            buildProvider,
            buildStaticProvider,
        },
        resolveDynamicModel: resolveMuseCodeDynamicModel,
    },
});
