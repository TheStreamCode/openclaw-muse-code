/**
 * Muse model provider plugin for OpenClaw, billed to the Muse Code
 * monthly subscription instead of API credits.
 *
 * Authentication is a Meta device-code login. OpenClaw stores the resulting
 * credential as an auth profile; a copy is cached for existing installations.
 *
 * Wire: Meta Model API (`https://api.meta.ai/v1`) over the Responses API,
 * same as the official `@openclaw/meta-provider` (which is API-key billed).
 * This plugin exists for subscription billing; provider id `muse-code` is
 * intentionally distinct from the official `meta` id so both can coexist.
 */
import { defineSingleProviderPluginEntry, } from "openclaw/plugin-sdk/provider-entry";
import { ENV_VAR, defaultCachePath } from "./src/config.js";
import { deviceAuthorize, pollToken, mintKey, writeCache } from "./src/auth.js";
import { getLiveModelIdsCached, resolveKey } from "./src/catalog.js";
import { syncEnvFromCache } from "./src/key.js";
import { museCodeBaselineModels } from "./src/baseline.models.js";
// OpenClaw resolves the provider key from MUSE_CODE_SUB_TOKEN. Keep that env
// value aligned with the login cache without overwriting an explicit value.
syncEnvFromCache();
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
 * Builds a provider config from model rows (live ids or static baseline).
 * Live rows carry ids only, so names default to the id and the context
 * window to the family default; inference is unaffected.
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
    // Live first (TTL-cached, key re-resolved per call so a cache refresh is
    // picked up), static baseline as fallback.
    const key = resolveKey();
    if (key) {
        const live = await getLiveModelIdsCached(META_BASE_URL, key).catch(() => null);
        if (live && live.length > 0) {
            return providerFromRows(live.map((id) => ({ id })));
        }
    }
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
function checkAuth(ctx) {
    ctx.signal?.throwIfAborted();
    ctx.assertCurrent?.();
}
const deviceLogin = {
    id: "device-code",
    label: "Muse Code browser login",
    hint: "Sign in with your Meta account in a browser",
    kind: "device_code",
    wizard: {
        choiceId: "muse-code-device-code",
        choiceLabel: "Muse Code browser login (unofficial)",
        groupId: "muse-code",
        groupLabel: "Muse Code",
        methodId: "device-code",
    },
    async run(ctx) {
        checkAuth(ctx);
        if (ctx.secretInputMode === "ref") {
            throw new Error("Muse Code login requires a local credential cache and does not support reference-only storage.");
        }
        const device = await deviceAuthorize(ctx.signal);
        const url = device.verification_uri_complete || device.verification_uri;
        checkAuth(ctx);
        if (ctx.prompter.deviceCode) {
            await ctx.prompter.deviceCode({
                title: "Authorize Muse Code",
                code: device.user_code,
                expiresInMinutes: Math.max(1, Math.ceil(device.expires_in / 60)),
                message: `Open ${url} and approve the code.`,
            });
        }
        else {
            await ctx.prompter.note(`Open ${url}\nEnter code: ${device.user_code}`, "Authorize Muse Code");
        }
        checkAuth(ctx);
        try {
            await ctx.openUrl(url);
        }
        catch {
            checkAuth(ctx);
            await ctx.prompter.note("The browser did not open. Use the URL shown above.", "Muse Code");
        }
        checkAuth(ctx);
        const access = await pollToken(device.device_code, device.interval, device.expires_in, ctx.signal);
        checkAuth(ctx);
        const credentials = await mintKey(access, ctx.signal);
        checkAuth(ctx);
        await writeCache(credentials, defaultCachePath());
        syncEnvFromCache();
        checkAuth(ctx);
        return {
            profiles: [{
                    profileId: "muse-code:default",
                    credential: { type: "api_key", provider: "muse-code", key: credentials.apiKey },
                    ...(ctx.secretInputMode === "plaintext" ? {} : {
                        secretStorage: { kind: "store", namePrefix: "MUSE_CODE" },
                    }),
                }],
            ...(!ctx.credentialOnly ? { defaultModel: `muse-code/${DEFAULT_MODEL_ID}` } : {}),
            notes: ["Model access depends on Meta's subscription policy."],
        };
    },
};
export default defineSingleProviderPluginEntry({
    id: "muse-code",
    name: "Muse Code",
    description: "Muse models (api.meta.ai) model provider billed to the Muse Code monthly subscription.",
    provider: {
        label: "Muse Code",
        docsPath: "/providers/muse-code",
        envVars: [ENV_VAR],
        extraAuth: [deviceLogin],
        catalog: {
            buildProvider,
            buildStaticProvider,
        },
        resolveDynamicModel: resolveMuseCodeDynamicModel,
    },
});
