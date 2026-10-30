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
import {
  defineSingleProviderPluginEntry,
} from "openclaw/plugin-sdk/provider-entry";
import type {
  ModelApi,
  ModelDefinitionConfig,
  ModelProviderConfig,
} from "openclaw/plugin-sdk/provider-model-types";
import type { ProviderAuthContext, ProviderAuthMethod, ProviderRuntimeModel } from "openclaw/plugin-sdk/plugin-entry";
import { ENV_VAR, defaultCachePath } from "./src/config.js";
import { deviceAuthorize, pollToken, mintKey, writeCache } from "./src/auth.js";
import { getLiveModelIdsCached, resolveKey } from "./src/catalog.js";
import { syncEnvFromCache } from "./src/key.js";
import { museCodeBaselineModels } from "./src/baseline.models.js";
import { startMuseCodeAdapter, type RunningAdapter } from "./src/adapter.js";

// OpenClaw resolves the provider key from MUSE_CODE_SUB_TOKEN. Keep that env
// value aligned with the login cache without overwriting an explicit value.
syncEnvFromCache();

/** Meta Model API base URL for Responses API traffic. */
export const META_BASE_URL = "https://api.meta.ai/v1";

/**
 * Env switch that keeps the loopback proxy but relays requests unchanged.
 *
 * The provider keeps pointing at the adapter so a base URL observed by the
 * host stays valid when the wire rules are switched off.
 */
export const ADAPTER_ENV_VAR = "MUSE_CODE_ADAPTER";

/** Adapter surface the plugin needs; tests stub it without binding a port. */
export type MuseCodeAdapterHandle = Pick<RunningAdapter, "baseUrl" | "close">;

/**
 * Starts the loopback adapter. `passthrough` keeps the proxy in place while
 * disabling the wire rules (`MUSE_CODE_ADAPTER=off`).
 */
export type MuseCodeAdapterFactory = (options: {
  passthrough: boolean;
  log: (message: string) => void;
}) => Promise<MuseCodeAdapterHandle>;

/** Minimal logger surface used for adapter diagnostics. */
type AdapterLogger = {
  debug?: (message: string) => void;
  warn?: (message: string) => void;
};

const defaultAdapterFactory: MuseCodeAdapterFactory = (options) => startMuseCodeAdapter(options);

let adapterFactory: MuseCodeAdapterFactory = defaultAdapterFactory;
let adapterLogger: AdapterLogger | undefined;
let adapterStart: Promise<MuseCodeAdapterHandle | undefined> | undefined;
let adapterBaseUrl: string | undefined;

function adapterPassthrough(): boolean {
  return (process.env[ADAPTER_ENV_VAR] ?? "").trim().toLowerCase() === "off";
}

/**
 * Start the request adapter once per process.
 *
 * Meta's subscription gate rejects flat client tool declarations that collide
 * with Muse Code's builtin tool names (HTTP 403, `client_attestation_denied`).
 * The adapter aliases exactly those names on the wire and restores them in the
 * answer, so the host keeps its own tools. A bind failure leaves the provider
 * on the direct endpoint, which is the behavior before this plugin version.
 */
export function ensureMuseCodeAdapter(logger?: AdapterLogger): Promise<MuseCodeAdapterHandle | undefined> {
  if (logger !== undefined) adapterLogger = logger;
  adapterStart ??= adapterFactory({
    passthrough: adapterPassthrough(),
    log: (message: string) => adapterLogger?.debug?.(message),
  }).then(
    (adapter) => {
      adapterBaseUrl = adapter.baseUrl;
      return adapter;
    },
    (error: unknown) => {
      const detail = error instanceof Error ? error.message : String(error);
      adapterLogger?.warn?.(`muse-code: local request adapter unavailable; using ${META_BASE_URL} (${detail})`);
      return undefined;
    },
  );
  return adapterStart;
}

/** Base URL every provider and model entry must use: adapter when running, else direct. */
export function museCodeBaseUrl(): string {
  return adapterBaseUrl ?? META_BASE_URL;
}

/** Stop the adapter if it started; safe to call more than once. */
export async function closeMuseCodeAdapter(): Promise<void> {
  const start = adapterStart;
  adapterStart = undefined;
  adapterBaseUrl = undefined;
  if (start === undefined) return;
  const adapter = await start.catch(() => undefined);
  await adapter?.close().catch(() => undefined);
}

/** Test-only: replace the adapter starter and forget the started instance. */
export function __setAdapterFactoryForTests(factory?: MuseCodeAdapterFactory): void {
  adapterFactory = factory ?? defaultAdapterFactory;
  adapterStart = undefined;
  adapterBaseUrl = undefined;
  adapterLogger = undefined;
}

async function currentBaseUrl(): Promise<string> {
  await ensureMuseCodeAdapter();
  return museCodeBaseUrl();
}

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

/** Row shape of the static baseline. */
export type MuseCodeModelRow = {
  id?: unknown;
  name?: unknown;
  context_length?: unknown;
};

/**
 * Maps a Muse Spark baseline row to an OpenClaw model definition.
 *
 * Every model uses the Responses API transport. Contributor-tier variants
 * keep working when selected explicitly (see README for the training-data
 * disclosure); nothing in this plugin ever selects them implicitly.
 */
export function projectModel(
  row: MuseCodeModelRow,
  baseUrl: string = museCodeBaseUrl(),
): ModelDefinitionConfig | null {
  const id = typeof row.id === "string" && row.id.length > 0 ? row.id : null;
  if (!id) return null;

  const rawName = row.name;
  const name = typeof rawName === "string" && rawName.length > 0 ? rawName : id;

  const rawCtx = row.context_length;
  const contextWindow =
    typeof rawCtx === "number" && rawCtx > 0 ? rawCtx : MUSE_CONTEXT_WINDOW;

  const api: ModelApi = "openai-responses";

  return {
    id,
    name,
    api,
    baseUrl,
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
export function providerFromRows(
  rows: MuseCodeModelRow[],
  baseUrl: string = museCodeBaseUrl(),
): ModelProviderConfig {
  const models = rows
    .map((row) => projectModel(row, baseUrl))
    .filter((m): m is ModelDefinitionConfig => m !== null);

  return {
    baseUrl,
    api: "openai-responses",
    models,
  };
}

async function buildProvider(): Promise<ModelProviderConfig> {
  // The provider entry is what the host routes inference with, so it must
  // carry the adapter origin (or the direct endpoint when binding failed).
  const baseUrl = await currentBaseUrl();
  // Live first (TTL-cached, key re-resolved per call so a cache refresh is
  // picked up), static baseline as fallback. Discovery itself stays direct:
  // the adapter relays every non-inference path untouched anyway.
  const key = resolveKey();
  if (key) {
    const live = await getLiveModelIdsCached(META_BASE_URL, key).catch(() => null);
    if (live && live.length > 0) {
      return providerFromRows(live.map((id) => ({ id })), baseUrl);
    }
  }
  return providerFromRows(museCodeBaselineModels, baseUrl);
}

async function buildStaticProvider(): Promise<ModelProviderConfig> {
  return providerFromRows(museCodeBaselineModels, await currentBaseUrl());
}


/** Strips a leading `<provider>/` prefix from a runtime model id when present. */
function stripProviderModelPrefix(provider: string, modelId: string): string {
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
export function resolveMuseCodeDynamicModel(ctx: {
  provider?: string;
  modelId: string;
}): ProviderRuntimeModel | null {
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
    baseUrl: museCodeBaseUrl(),
    reasoning: true,
    input: ["text", "image"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow,
    maxTokens: Math.min(contextWindow, MAX_OUTPUT_TOKENS),
  };
}

function checkAuth(ctx: ProviderAuthContext): void {
  ctx.signal?.throwIfAborted();
  ctx.assertCurrent?.();
}

const deviceLogin: ProviderAuthMethod = {
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
    } else {
      await ctx.prompter.note(`Open ${url}\nEnter code: ${device.user_code}`, "Authorize Muse Code");
    }
    checkAuth(ctx);
    try {
      await ctx.openUrl(url);
    } catch {
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

/** Host surface touched by the plugin entry; the SDK forwards it as unknown. */
type PluginHostApi = {
  logger?: AdapterLogger;
  lifecycle?: {
    registerRuntimeLifecycle?: (registration: {
      id: string;
      dispose?: () => void | Promise<void>;
    }) => void;
    onDispose?: (dispose: () => void | Promise<void>) => unknown;
  };
  /** Deprecated flat form kept as a fallback for older hosts. */
  registerRuntimeLifecycle?: (registration: {
    id: string;
    dispose?: () => void | Promise<void>;
  }) => void;
};

/**
 * Register the adapter lifecycle on the host API.
 *
 * Prefers the grouped `lifecycle` facade, then the deprecated flat method and
 * the instance `onDispose` hook, so the loopback listener is released with the
 * plugin on every host generation that exposes at least one of them.
 */
function registerAdapterDisposal(host: PluginHostApi): void {
  const dispose = () => closeMuseCodeAdapter();
  const registration = { id: "muse-code-request-adapter", dispose };
  const lifecycle = host.lifecycle;
  if (typeof lifecycle?.registerRuntimeLifecycle === "function") {
    lifecycle.registerRuntimeLifecycle(registration);
    return;
  }
  if (typeof host.registerRuntimeLifecycle === "function") {
    host.registerRuntimeLifecycle(registration);
    return;
  }
  lifecycle?.onDispose?.(dispose);
}

export default defineSingleProviderPluginEntry({
  id: "muse-code",
  name: "Muse Code",
  description:
    "Muse models (api.meta.ai) model provider billed to the Muse Code monthly subscription.",
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
  register(api: unknown) {
    const host = (api ?? {}) as PluginHostApi;
    // Start while the provider is registered: the catalog callbacks await the
    // same promise, so the entry they publish already carries the loopback
    // origin (or the direct one when the port cannot be bound).
    void ensureMuseCodeAdapter(host.logger);
    registerAdapterDisposal(host);
  },
});

