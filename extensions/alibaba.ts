import type { ExtensionAPI, ProviderModelConfig, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

// ── Paths ─────────────────────────────────────────────────────────────
const HOME_DIR = path.join(os.homedir(), ".pi", "agent");
const CONFIG_PATH = path.join(HOME_DIR, "alibaba-config.json");
const AUTH_PATH = path.join(HOME_DIR, "auth.json");
const PLAN_CACHE_PATH = path.join(HOME_DIR, "alibaba-plan-models.cache.json");
const SETTINGS_PATH = path.join(HOME_DIR, "settings.json");

const CLOUD_RICH_FETCH_TIMEOUT_MS = 45_000;
const CLOUD_COMPAT_FETCH_TIMEOUT_MS = 30_000;

const DEFAULT_PLAN_OPENAI = "https://token-plan.ap-southeast-1.maas.aliyuncs.com/compatible-mode/v1";
const DEFAULT_PLAN_ANTHROPIC = "https://token-plan.ap-southeast-1.maas.aliyuncs.com/apps/anthropic";
const ALIBABA_CLOUD_MODEL_STUDIO_INTL_URL = "dashscope-intl.aliyuncs.com";
const ALIBABA_CLOUD_MODEL_STUDIO_CN_URL = "dashscope.aliyuncs.com";
const ALIBABA_CLOUD_MODEL_STUDIO_GLOBAL_URL = "dashscope-us.aliyuncs.com";

const MODELS_DEV_API_URL = "https://models.dev/api.json";
const MODELS_DEV_CACHE_PATH = path.join(HOME_DIR, "alibaba-models-dev.cache.json");
const MODELS_DEV_CACHE_TTL_MS = 24 * 60 * 60 * 1000; // 24 hours

type CloudProviderId = "alibaba" | "alibaba-cn" | "alibaba-global";

interface CloudProviderDef {
  id: CloudProviderId;
  name: string;
  domain: string;
  apiKeyEnv: string;
  modelsUrl: string;
  cachePath: string;
}

const CLOUD_PROVIDERS: readonly CloudProviderDef[] = [
  {
    id: "alibaba",
    name: "Alibaba Cloud International (API Key)",
    domain: ALIBABA_CLOUD_MODEL_STUDIO_INTL_URL,
    apiKeyEnv: "DASHSCOPE_API_KEY",
    modelsUrl: "https://dashscope-intl.aliyuncs.com/api/v1/models",
    cachePath: path.join(HOME_DIR, "alibaba-cloud-models.cache.json"),
  },
  {
    id: "alibaba-cn",
    name: "Alibaba Cloud China (API Key)",
    domain: ALIBABA_CLOUD_MODEL_STUDIO_CN_URL,
    apiKeyEnv: "DASHSCOPE_CN_API_KEY",
    modelsUrl: "https://dashscope.aliyuncs.com/api/v1/models",
    cachePath: path.join(HOME_DIR, "alibaba-cn-models.cache.json"),
  },
  {
    id: "alibaba-global",
    name: "Alibaba Cloud Global (API Key)",
    domain: ALIBABA_CLOUD_MODEL_STUDIO_GLOBAL_URL,
    apiKeyEnv: "DASHSCOPE_GLOBAL_API_KEY",
    modelsUrl: "https://dashscope-us.aliyuncs.com/api/v1/models",
    cachePath: path.join(HOME_DIR, "alibaba-global-models.cache.json"),
  },
];

const CLOUD_PROVIDER_IDS = CLOUD_PROVIDERS.map((provider) => provider.id);

// ── Config / auth helpers ─────────────────────────────────────────────
interface AlibabaConfig {
  planOpenAI?: string;
  planAnthropic?: string;
  cloudApiFormat?: "anthropic-messages" | "openai-completions";
  // Override the context-window shown on a model's card in the picker.
  // Keyed by exact model id (e.g. "qwen3.7-plus"); the special key "*" applies
  // to every model that has no explicit entry. Values are token counts.
  // Useful when the inferred size is wrong for a brand-new model.
  contextWindowOverrides?: Record<string, number>;
}

const readJSON = <T>(p: string, fallback: T): T => {
  try { return JSON.parse(fs.readFileSync(p, "utf8")) as T; } catch { return fallback; }
};
const writeJSON = (p: string, data: unknown) => {
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, JSON.stringify(data, null, 2), { mode: 0o600 });
};

function unlinkIfExists(filePath: string) {
  try {
    fs.unlinkSync(filePath);
  } catch (e: unknown) {
    if (!(e instanceof Error && "code" in e && e.code === "ENOENT")) throw e;
  }
}
const loadConfig = (): AlibabaConfig => readJSON<AlibabaConfig>(CONFIG_PATH, {});
const saveConfig = (c: AlibabaConfig) => writeJSON(CONFIG_PATH, c);
const readAuth = (): Record<string, any> => readJSON<Record<string, any>>(AUTH_PATH, {});
const writeAuth = (a: Record<string, any>) => writeJSON(AUTH_PATH, a);

// ── Plan model definitions ────────────────────────────────────────────
// Anthropic-compatible by default; deepseek forced to openai-completions.
interface PlanModelDef {
  id: string; name: string; reasoning: boolean; contextWindow: number; maxTokens: number;
  input: ("text" | "image")[]; compat?: { thinkingFormat: "qwen" }; openaiOnly?: boolean;
  cost?: { input: number; output: number; cacheRead: number; cacheWrite: number };
}

// ── Models.dev registry cache ───────────────────────────────────────────
interface ModelsDevEntry {
  contextWindow: number;
  maxOutput: number;
  inputPrice: number; // per token
  outputPrice: number; // per token
  reasoning: boolean;
  attachment?: boolean; // vision/image support
}

interface ModelsDevCache { 
  fetchedAt: number; 
  models: Map<string, ModelsDevEntry>; 
}

let modelsDevCache: ModelsDevCache | null = null;

function parseModelsDevJSON(json: any): Map<string, ModelsDevEntry> {
  const models = new Map<string, ModelsDevEntry>();
  
  const alibabaProvider = json?.alibaba;
  if (!alibabaProvider?.models) {
    return models;
  }
  
  for (const [modelId, modelData] of Object.entries(alibabaProvider.models) as [string, any][]) {
    models.set(modelId, {
      contextWindow: modelData?.limit?.context || 131072,
      maxOutput: modelData?.limit?.output || 8192,
      inputPrice: modelData?.cost?.input || 0,
      outputPrice: modelData?.cost?.output || 0,
      reasoning: modelData?.reasoning || false,
      attachment: modelData?.attachment || false,
    });
  }
  
  return models;
}

async function fetchModelsDevRegistry(): Promise<Map<string, ModelsDevEntry>> {
  // Return cached version if fresh
  if (modelsDevCache && Date.now() - modelsDevCache.fetchedAt < MODELS_DEV_CACHE_TTL_MS) {
    return modelsDevCache.models;
  }

  // Try to load from disk cache
  const diskCache = readJSON<{ fetchedAt: number; models: Array<[string, ModelsDevEntry]> } | null>(MODELS_DEV_CACHE_PATH, null);
  if (diskCache && Date.now() - diskCache.fetchedAt < MODELS_DEV_CACHE_TTL_MS) {
    modelsDevCache = { 
      fetchedAt: diskCache.fetchedAt, 
      models: new Map(diskCache.models) 
    };
    return modelsDevCache.models;
  }

  // Fetch from models.dev
  try {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), 5000);
    const res = await fetch(MODELS_DEV_API_URL, { signal: ctrl.signal });
    clearTimeout(t);
    
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const json = await res.json();
    
    // Parse the JSON to extract model data
    const models = parseModelsDevJSON(json);
    
    if (models.size === 0) {
      throw new Error("No models found in models.dev response");
    }
    
    // Cache to memory and disk
    modelsDevCache = { fetchedAt: Date.now(), models };
    writeJSON(MODELS_DEV_CACHE_PATH, {
      fetchedAt: modelsDevCache.fetchedAt,
      models: Array.from(models.entries()),
    });
    
    return models;
  } catch (e: any) {
    console.warn(`[alibaba] Failed to fetch models.dev registry (${e?.message || e}); skipping enrichment.`);
    return new Map();
  }
}

// ── Plan model fetch + parse + cache ──────────────────────────────────
interface PlanCache { fetchedAt: number; source: string; models: PlanModelDef[]; }

// ── Capability heuristics (shared by Plan + Cloud) ───────────────────
// Filter out dated model variants (e.g., qwen3.7-max-20250125)
const isDateSuffixed = (id: string): boolean =>
  /-\d{8}$/.test(id) || /-\d{4}-\d{2}-\d{2}$/.test(id);

// The /models API only returns ids/names, not capabilities — so context
// window, reasoning, and vision are inferred from the id. Both the Plan
// and Cloud code paths route through these helpers so they never drift
// apart. Context windows are corrected here as new models ship.
const isVisionModel = (id: string): boolean =>
  /vl|vision/i.test(id) || /^qwen3\.\d+-plus\b/i.test(id) || /kimi/i.test(id);

const isReasoningModel = (id: string): boolean =>
  /qwq|max|thinking|deepseek|minimax|kimi|glm|3\.[5-9]/i.test(id);

// Infer context window (tokens) from model id. Sources:
// https://www.alibabacloud.com/help/en/model-studio/models
// https://www.alibabacloud.com/help/en/model-studio/glm
const inferContextWindow = (id: string, overrides?: Record<string, number>): number => {
  const o = overrides?.[id] ?? overrides?.["*"];
  if (typeof o === "number" && o > 0) return o;

  // Third-party models
  if (/^glm-?5\.2\b/i.test(id)) return 1048576;
  if (/^glm/i.test(id)) return 202752;
  if (/deepseek-?v4/i.test(id)) return 1048576;
  if (/^deepseek/i.test(id)) return 131072;
  if (/kimi/i.test(id)) return 262144;
  if (/minimax-?m2\.5/i.test(id)) return 196608;
  if (/minimax-?m2\.1/i.test(id)) return 204800;
  if (/minimax/i.test(id)) return 196608;

  // Qwen 3.7+: all 1M. Qwen 3.5/3.6: plus/flash = 1M, max/open-weight = 256K.
  if (/^qwen3\.([7-9]|\d{2,})\b/i.test(id)) return 1048576;
  if (/^qwen3\.[56]\b/i.test(id)) return /(plus|flash)/i.test(id) ? 1048576 : 262144;

  return 131072;
};

// Heuristic: turn a bare model id (from /v1/models API) into a full PlanModelDef.
function inferPlanDef(id: string, overrides?: Record<string, number>, devEntry?: ModelsDevEntry): PlanModelDef {
  const openaiOnly = /deepseek/i.test(id);
  // Use models.dev attachment field if available, fall back to heuristic
  const isVision = devEntry?.attachment === true || isVisionModel(id);
  // Prefer models.dev reasoning flag if available, fall back to heuristic
  const isReasoning = devEntry ? devEntry.reasoning : isReasoningModel(id);
  
  // Prefer models.dev data, fall back to heuristics and overrides
  const contextWindow = devEntry ? devEntry.contextWindow : inferContextWindow(id, overrides);
  const maxTokens = devEntry ? devEntry.maxOutput : (openaiOnly ? 16384 : 65536);
  const cost = devEntry ? {
    input: devEntry.inputPrice,
    output: devEntry.outputPrice,
    cacheRead: 0,
    cacheWrite: 0,
  } : { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
  
  return {
    id,
    name: prettyName(id),
    reasoning: isReasoning,
    input: isVision ? ["text", "image"] : ["text"],
    contextWindow,
    maxTokens,
    cost,
    compat: isReasoning ? { thinkingFormat: "qwen" } : undefined,
    openaiOnly,
  };
}

// Primary source: the Plan endpoint's own /compatible-mode/v1/models.
async function fetchPlanModelsFromAPI(credentials?: { access?: string; refresh?: string }): Promise<PlanModelDef[]> {
  const key = credentials?.access;
  if (!key) return [];
  const ep = resolvePlanEndpoints(credentials);
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), 5000);
  try {
    const res = await fetch(`${ep.openai}/models`, {
      headers: { Authorization: `Bearer ${key}` },
      signal: ctrl.signal,
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const json = (await res.json()) as { data?: { id: string }[] };
    if (!json.data?.length) throw new Error("No models in response");
    // Filter out image/audio/etc — only keep chat-capable models.
    const exclude = /(image|audio|video|tts|asr|embed|vector|rerank|wan|omni|livetranslate|realtime)/i;
    const overrides = loadConfig().contextWindowOverrides;
    
    // Filter against models.dev registry and enrich with its data
    const registry = await fetchModelsDevRegistry();
    const filteredModels = json.data
      .filter((m) => !exclude.test(m.id))
      .filter((m) => !isDateSuffixed(m.id)) // Always filter date-suffixed variants
      .filter((m) => registry.size === 0 || registry.has(m.id)); // Allowlist when registry available
    
    return filteredModels.map((m) => inferPlanDef(m.id, overrides, registry.get(m.id)));
  } finally { clearTimeout(t); }
}

function prettyName(id: string): string {
  // qwen3.6-plus → "Qwen 3.6 Plus", glm-5 → "GLM-5", MiniMax-M2.5 → "MiniMax M2.5"
  if (/^qwen/i.test(id)) {
    return id.replace(/^qwen/i, "Qwen ").replace(/-/g, " ").replace(/\b([a-z])/g, (s) => s.toUpperCase());
  }
  if (/^glm/i.test(id)) return id.toUpperCase();
  if (/^kimi/i.test(id)) return id.replace(/^kimi/i, "Kimi").replace(/-/g, " ");
  if (/^minimax/i.test(id)) return id.replace(/-/g, " ");
  if (/^deepseek/i.test(id)) return id.replace(/^deepseek/i, "DeepSeek").replace(/-/g, " ");
  return id;
}

async function fetchPlanModels(_force = false, credentials?: { access?: string; refresh?: string }): Promise<PlanModelDef[]> {
  if (!credentials?.access) return [];
  const apiModels = await fetchPlanModelsFromAPI(credentials);
  if (!apiModels.length) throw new Error("Plan model fetch returned no chat models");
  const ep = resolvePlanEndpoints(credentials);
  const cache: PlanCache = { fetchedAt: Date.now(), source: `${ep.openai}/models`, models: apiModels };
  writeJSON(PLAN_CACHE_PATH, cache);
  return apiModels;
}

// ── Plan endpoint resolution ──────────────────────────────────────────
function resolvePlanEndpoints(credentials?: { access?: string; refresh?: string }): { openai: string; anthropic: string } {
  if (credentials?.refresh) {
    try {
      const parsed = JSON.parse(credentials.refresh);
      if (parsed.openai && parsed.anthropic) return { openai: parsed.openai, anthropic: parsed.anthropic };
    } catch (e: unknown) {
      const message = e instanceof Error ? e.message : String(e);
      console.warn(`[alibaba] Ignoring invalid Plan endpoint metadata (${message}).`);
    }
  }
  const cfg = loadConfig();
  return {
    openai: cfg.planOpenAI || DEFAULT_PLAN_OPENAI,
    anthropic: cfg.planAnthropic || DEFAULT_PLAN_ANTHROPIC,
  };
}

function buildPlanModels(defs: PlanModelDef[], openaiUrl: string, anthropicUrl: string): ProviderModelConfig[] {
  return defs.map((m) => {
    const useOpenAI = !!m.openaiOnly || /deepseek/i.test(m.id);
    return {
      id: m.id, name: m.name, reasoning: m.reasoning, input: m.input,
      contextWindow: m.contextWindow, maxTokens: m.maxTokens, compat: m.compat,
      thinkingLevelMap: m.reasoning ? { off: null } : undefined,
      cost: m.cost ?? { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      baseUrl: useOpenAI ? openaiUrl : anthropicUrl,
      api: (useOpenAI ? "openai-completions" : "anthropic-messages") as "anthropic-messages" | "openai-completions",
    };
  });
}

// ── Cloud builders ────────────────────────────────────────────────────
interface CloudCache { fetchedAt: number; domain: string; models: ProviderModelConfig[]; }

interface CloudModelRow {
  id: string;
  name?: string;
  requestModalities?: string[];
  responseModalities?: string[];
  capabilities?: string[];
  contextWindow?: number;
  maxTokens?: number;
  cost?: ProviderModelConfig["cost"];
}

interface RichPrice { type?: string; price?: string; }
interface RichPriceRange { range_name?: string; prices?: RichPrice[]; }
interface CompatibleModelsResponse { data?: { id: string; name?: string }[]; }
interface RichModelsResponse {
  success?: boolean;
  message?: string | null;
  output?: {
    total?: number;
    page_no?: number;
    page_size?: number;
    models?: {
      model?: string;
      name?: string;
      capabilities?: string[];
      inference_metadata?: {
        request_modality?: string[];
        response_modality?: string[];
      };
      model_info?: {
        context_window?: number | null;
        max_output_tokens?: number | null;
      };
      prices?: RichPriceRange[];
    }[];
  };
}

const ZERO_COST: ProviderModelConfig["cost"] = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
const COST_DECIMAL_PLACES = 12;

function normalizeCost(value: number | undefined): number {
  return value === undefined ? 0 : Number(value.toFixed(COST_DECIMAL_PLACES));
}

function pricePerMillionTokens(price: string | undefined): number | undefined {
  if (!price) return undefined;
  const value = Number(price);
  return Number.isFinite(value) && value >= 0 ? normalizeCost(value) : undefined;
}

function priceByType(prices: RichPrice[], predicate: (type: string) => boolean): number | undefined {
  const found = prices.find((price) => price.type && predicate(price.type));
  return pricePerMillionTokens(found?.price);
}

function richPricesToCost(ranges: RichPriceRange[] | undefined): ProviderModelConfig["cost"] | undefined {
  if (!ranges?.length) return undefined;
  const range = ranges.find((candidate) => /default/i.test(candidate.range_name || "")) ?? ranges[0];
  const prices = range.prices ?? [];
  const input =
    priceByType(prices, (type) => type === "input_token") ??
    priceByType(prices, (type) => type === "thinking_input_token");
  const output =
    priceByType(prices, (type) => type === "output_token") ??
    priceByType(prices, (type) => type === "thinking_output_token");
  const cacheRead =
    priceByType(prices, (type) => type === "input_token_cache_read") ??
    priceByType(prices, (type) => type === "thinking_input_token_cache_read") ??
    priceByType(prices, (type) => type === "input_token_cache") ??
    priceByType(prices, (type) => type === "thinking_input_token_cache");
  const cacheWrite =
    priceByType(prices, (type) => type.startsWith("input_token_cache_creation")) ??
    priceByType(prices, (type) => type.startsWith("thinking_input_token_cache_creation"));
  if (input === undefined && output === undefined && cacheRead === undefined && cacheWrite === undefined) return undefined;
  return {
    input: normalizeCost(input),
    output: normalizeCost(output),
    cacheRead: normalizeCost(cacheRead),
    cacheWrite: normalizeCost(cacheWrite),
  };
}

async function fetchCompatibleCloudModelRows(
  provider: CloudProviderDef,
  apiKey: string,
  signal: AbortSignal,
): Promise<CloudModelRow[]> {
  const res = await fetch(`https://${provider.domain}/compatible-mode/v1/models`, {
    headers: { Authorization: `Bearer ${apiKey}` },
    signal,
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const json = (await res.json()) as CompatibleModelsResponse;
  if (!json.data?.length) throw new Error("No models");
  return json.data.map((model) => ({ id: model.id, name: model.name }));
}

async function fetchRichCloudModelRows(
  provider: CloudProviderDef,
  apiKey: string,
  signal: AbortSignal,
): Promise<CloudModelRow[]> {
  const rows: CloudModelRow[] = [];
  let pageNo = 1;
  while (true) {
    let url: URL;
    try {
      url = new URL(provider.modelsUrl);
    } catch (e: unknown) {
      const message = e instanceof Error ? e.message : String(e);
      throw new Error(`Invalid rich catalog URL for ${provider.name}: ${message}`);
    }
    url.searchParams.set("page_no", String(pageNo));
    const res = await fetch(url, {
      headers: { Authorization: `Bearer ${apiKey}` },
      signal,
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const json = (await res.json()) as RichModelsResponse;
    if (json.success === false) throw new Error(json.message || "Rich model fetch failed");
    const output = json.output;
    const models = output?.models ?? [];
    if (!models.length) break;
    for (const model of models) {
      if (!model.model) continue;
      const info = model.model_info;
      rows.push({
        id: model.model,
        name: model.name,
        requestModalities: model.inference_metadata?.request_modality,
        responseModalities: model.inference_metadata?.response_modality,
        capabilities: model.capabilities,
        contextWindow: info?.context_window ?? undefined,
        maxTokens: info?.max_output_tokens ?? undefined,
        cost: richPricesToCost(model.prices),
      });
    }
    const pageSize = output?.page_size ?? models.length;
    if ((output?.total !== undefined && rows.length >= output.total) || models.length < pageSize) break;
    const nextPage = (output?.page_no ?? pageNo) + 1;
    if (nextPage <= pageNo) break;
    pageNo = nextPage;
  }
  return rows;
}

async function fetchWithTimeout<T>(
  fetcher: (signal: AbortSignal) => Promise<T>,
  timeoutMs: number,
): Promise<T> {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    return await fetcher(ctrl.signal);
  } finally {
    clearTimeout(t);
  }
}

async function fetchCloudModelRows(provider: CloudProviderDef, apiKey: string): Promise<CloudModelRow[]> {
  try {
    const rows = await fetchWithTimeout(
      (signal) => fetchRichCloudModelRows(provider, apiKey, signal),
      CLOUD_RICH_FETCH_TIMEOUT_MS,
    );
    if (!rows.length) throw new Error("Rich catalog returned no models");
    return rows;
  } catch (e: unknown) {
    const message = e instanceof Error ? e.message : String(e);
    console.warn(`[alibaba] ${provider.name} rich catalog failed (${message}); trying compatible-mode /v1/models.`);
  }
  return fetchWithTimeout(
    (signal) => fetchCompatibleCloudModelRows(provider, apiKey, signal),
    CLOUD_COMPAT_FETCH_TIMEOUT_MS,
  );
}

async function fetchCloudModels(
  provider: CloudProviderDef,
  apiKey: string,
  _force = false,
): Promise<ProviderModelConfig[]> {
  const rows = await fetchCloudModelRows(provider, apiKey);
  if (!rows.length) throw new Error("No models");
  const exclude = /(image|audio|video|tts|asr|embed|vector|rerank|wan|omni|livetranslate|realtime)/i;
  const overrides = loadConfig().contextWindowOverrides;
  const registry = await fetchModelsDevRegistry();

  const models = rows
    .filter((model) => !exclude.test(model.id))
    .filter((model) => !isDateSuffixed(model.id))
    .filter((model) => registry.size === 0 || registry.has(model.id))
    .filter((model) => !model.responseModalities?.length || model.responseModalities.some((modality) => /text/i.test(modality)))
    .map((model) => {
      const devEntry = registry.get(model.id);
      const override = overrides?.[model.id] ?? overrides?.["*"];
      const isVision =
        devEntry?.attachment === true ||
        isVisionModel(model.id) ||
        model.requestModalities?.some((modality) => /image|video/i.test(modality)) === true;
      const isReasoning =
        devEntry?.reasoning === true ||
        isReasoningModel(model.id) ||
        model.capabilities?.some((capability) => /reasoning/i.test(capability)) === true;
      const contextWindow =
        typeof override === "number" && override > 0
          ? override
          : model.contextWindow && model.contextWindow > 0
            ? model.contextWindow
            : devEntry?.contextWindow ?? inferContextWindow(model.id, overrides);
      const maxTokens =
        model.maxTokens && model.maxTokens > 0
          ? model.maxTokens
          : devEntry?.maxOutput ?? 8192;
      const cost = model.cost ?? (devEntry ? {
        input: devEntry.inputPrice,
        output: devEntry.outputPrice,
        cacheRead: 0,
        cacheWrite: 0,
      } : ZERO_COST);
      return {
        id: model.id,
        name: model.name || model.id,
        reasoning: isReasoning,
        input: isVision ? (["text", "image"] as ("text" | "image")[]) : (["text"] as ("text" | "image")[]),
        cost,
        contextWindow,
        maxTokens,
        compat: isReasoning ? { thinkingFormat: "qwen" as const } : undefined,
      };
    });
  if (!models.length) throw new Error("Cloud catalog returned no supported chat models");
  const cache: CloudCache = { fetchedAt: Date.now(), domain: provider.domain, models };
  writeJSON(provider.cachePath, cache);
  return models;
}

function buildCloudModels(
  models: ProviderModelConfig[],
  provider: CloudProviderDef,
  fmt: string,
): ProviderModelConfig[] {
  return models.map((model) => {
    const useOpenAI = /deepseek/i.test(model.id) || fmt === "openai-completions";
    return {
      ...model,
      thinkingLevelMap: model.reasoning ? { off: null } : undefined,
      baseUrl: useOpenAI
        ? `https://${provider.domain}/compatible-mode/v1`
        : `https://${provider.domain}/apps/anthropic`,
      api: (useOpenAI ? "openai-completions" : "anthropic-messages") as "anthropic-messages" | "openai-completions",
    };
  });
}

function registerCloudProviders(
  pi: ExtensionAPI,
  defsByProvider: Record<CloudProviderId, ProviderModelConfig[]>,
  fmt: string,
) {
  for (const provider of CLOUD_PROVIDERS) {
    pi.registerProvider(provider.id, {
      name: provider.name,
      baseUrl: `https://${provider.domain}/apps/anthropic`,
      apiKey: `$${provider.apiKeyEnv}`,
      api: "anthropic-messages",
      authHeader: true,
      models: buildCloudModels(defsByProvider[provider.id], provider, fmt),
    });
  }
}

// ── Cloud credential resolution ──────────────────────────────────────
// Each Cloud provider can authenticate either from a key saved via /login
// (auth.json) OR from its matching DASHSCOPE_* env var.
const readCloudKey = (provider: CloudProviderDef): string | null => {
  const credential = readAuth()[provider.id];
  const key = credential?.key || credential?.access;
  return key || process.env[provider.apiKeyEnv] || null;
};

// ── Cloud login seed ─────────────────────────────────────────────────
// pi hides any provider that has zero registered models, so with no
// credential at all the Cloud provider would vanish from /login → "Use an
// API key" (issue #1). To stay visible we register ONE placeholder model
// when — and only when — the live catalog is empty AND no key exists. In
// that state no model is usable anyway (there's no key), so this is purely a
// "click here to log in" entry, not a model-catalog fallback: as soon as a
// key is present (via /login or $DASHSCOPE_API_KEY) the live catalog is
// fetched and replaces it. We use a real, region-agnostic id (`qwen-plus`,
// present on every DashScope account) so it also works for an env-var user
// before the first refresh, and never lingers as an orphan after login.
const CLOUD_LOGIN_SEED: ProviderModelConfig[] = [{
  id: "qwen-plus",
  name: "Qwen Plus",
  reasoning: false,
  input: ["text"],
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  contextWindow: 131072,
  maxTokens: 8192,
}];

// ── Offline-resilient catalog loaders ────────────────────────────────
// Live API is the source of truth. But a network failure must never take
// the whole extension (and therefore pi, and the user's local models) down
// with it. So: try live, fall back to the last-known-good on-disk cache,
// warn, and never throw. Cache is an offline fallback only — when the API
// is reachable, its response always wins and overwrites the cache.
const cacheAgeMin = (fetchedAt: number) => Math.round((Date.now() - fetchedAt) / 60000);

async function loadPlanDefs(force: boolean, credentials?: { access?: string; refresh?: string }): Promise<PlanModelDef[]> {
  if (!credentials?.access) return [];
  try {
    return await fetchPlanModels(force, credentials);
  } catch (e: any) {
    const cache = readJSON<PlanCache | null>(PLAN_CACHE_PATH, null);
    if (cache?.models?.length) {
      console.warn(`[alibaba] Plan catalog fetch failed (${e?.message || e}); using cached models (${cache.models.length}, ${cacheAgeMin(cache.fetchedAt)}m old).`);
      // Recompute context windows to apply the latest inferContextWindow logic
      const overrides = loadConfig().contextWindowOverrides;
      return cache.models.map(m => ({
        ...m,
        contextWindow: inferContextWindow(m.id, overrides),
      }));
    }
    console.warn(`[alibaba] Plan catalog fetch failed (${e?.message || e}); no cache — Plan models unavailable until reconnected. Other providers still work.`);
    return [];
  }
}

async function loadCloudDefs(
  provider: CloudProviderDef,
  apiKey: string,
  force: boolean,
): Promise<{ models: ProviderModelConfig[]; source: "live" | "cache" | "unavailable" }> {
  try {
    const models = await fetchCloudModels(provider, apiKey, force);
    return { models, source: "live" };
  } catch (e: unknown) {
    const cache = readJSON<CloudCache | null>(provider.cachePath, null);
    const message = e instanceof Error ? e.message : String(e);
    if (cache?.models?.length && cache.domain === provider.domain) {
      console.warn(`[alibaba] ${provider.name} catalog fetch failed (${message}); using cached models (${cache.models.length}, ${cacheAgeMin(cache.fetchedAt)}m old).`);
      return { models: cache.models, source: "cache" };
    }
    console.warn(`[alibaba] ${provider.name} catalog fetch failed (${message}); no cache — Cloud models unavailable until reconnected. Other providers still work.`);
    return { models: [], source: "unavailable" };
  }
}

function createEmptyCloudDefs(): Record<CloudProviderId, ProviderModelConfig[]> {
  return { alibaba: [], "alibaba-cn": [], "alibaba-global": [] };
}

async function refreshCloudProvider(provider: CloudProviderDef, force: boolean) {
  const key = readCloudKey(provider);
  if (!key) {
    cloudDefsByProvider[provider.id] = CLOUD_LOGIN_SEED;
    return { provider, keyPresent: false, count: 0, source: "skipped" as const };
  }
  const previousModels = cloudDefsByProvider[provider.id];
  const result = await loadCloudDefs(provider, key, force);
  if (result.models.length) {
    cloudDefsByProvider[provider.id] = result.models;
    return { provider, keyPresent: true, count: result.models.length, source: result.source };
  }
  if (previousModels.length && previousModels !== CLOUD_LOGIN_SEED) {
    return { provider, keyPresent: true, count: previousModels.length, source: "retained" as const };
  }
  cloudDefsByProvider[provider.id] = CLOUD_LOGIN_SEED;
  return { provider, keyPresent: true, count: 0, source: "unavailable" as const };
}

async function refreshCloudProviders(force: boolean) {
  return Promise.all(CLOUD_PROVIDERS.map((provider) => refreshCloudProvider(provider, force)));
}

function allCloudModelIds(): string[] {
  return CLOUD_PROVIDERS.flatMap((provider) => cloudDefsByProvider[provider.id].map((model) => model.id));
}

// ── Module-level mutable model lists ─────────────────────────────────
// Populated by the async extension factory before provider registration.
let planDefs: PlanModelDef[] = [];
const cloudDefsByProvider = createEmptyCloudDefs();

// ── Migration ─────────────────────────────────────────────────────────
const isPlanKey = (key: string) => key.startsWith("sk-sp-") || key.startsWith("sk-tok-");

function extractKey(entry: any): string | undefined {
  if (!entry || typeof entry !== "object") return undefined;
  return entry.key || entry.access || undefined;
}

function setPlanAuth(auth: Record<string, any>, key: string) {
  auth["alibaba-plan"] = auth["alibaba-plan"] ?? {
    type: "oauth",
    access: key,
    refresh: "",
    expires: Date.now() + 365 * 86400_000,
  };
}

function migrateLegacyAuth() {
  try {
    const auth = readAuth();
    let dirty = false;

    const current = auth["alibaba"];
    const currentKey = extractKey(current);
    if (current) {
      if (!currentKey) {
        delete auth["alibaba"];
        dirty = true;
      } else if (isPlanKey(currentKey)) {
        setPlanAuth(auth, currentKey);
        delete auth["alibaba"];
        dirty = true;
      } else if (current.type !== "api_key" || current.key !== currentKey) {
        auth["alibaba"] = { type: "api_key", key: currentKey };
        dirty = true;
      }
    }

    for (const legacyId of ["alibaba-cloud", "alibaba-studio", "alibaba-token", "dashscope"]) {
      const legacy = auth[legacyId];
      if (!legacy) continue;
      const key = extractKey(legacy);
      if (key) {
        if (isPlanKey(key)) setPlanAuth(auth, key);
        else if (!auth["alibaba"]) auth["alibaba"] = { type: "api_key", key };
      }
      delete auth[legacyId];
      dirty = true;
    }

    for (const provider of CLOUD_PROVIDERS) {
      const cloud = auth[provider.id];
      if (!cloud) continue;
      const key = extractKey(cloud);
      if (!key) {
        delete auth[provider.id];
        dirty = true;
      } else if (isPlanKey(key)) {
        setPlanAuth(auth, key);
        delete auth[provider.id];
        dirty = true;
      } else if (cloud.type !== "api_key" || cloud.key !== key) {
        auth[provider.id] = { type: "api_key", key };
        dirty = true;
      }
    }

    if (dirty) writeAuth(auth);
  } catch (e: unknown) {
    const message = e instanceof Error ? e.message : String(e);
    console.warn(`[alibaba] Credential migration failed (${message}).`);
  }
}

function registerPlanProvider(
  pi: ExtensionAPI,
  planEndpoints: { openai: string; anthropic: string },
) {
  pi.registerProvider("alibaba-plan", {
    name: "Alibaba Model Studio Plan",
    baseUrl: planEndpoints.anthropic,
    api: "anthropic-messages",
    authHeader: true,
    models: buildPlanModels(planDefs, planEndpoints.openai, planEndpoints.anthropic),
    oauth: {
      name: "Alibaba Model Studio Coding Plan",
      async login(callbacks) {
        const key = await callbacks.onPrompt({
          message: "Coding Plan token (sk-sp-… or sk-tok-…). Run /alibaba afterwards if you need a non-Singapore region:",
        });
        if (!isPlanKey(key)) {
          throw new Error(
            "This doesn't look like a Coding Plan token (expected sk-sp-… or sk-tok-…). " +
            "If it's a Cloud API key, run /login and pick the matching Alibaba Cloud region instead.",
          );
        }
        const config = loadConfig();
        const openaiUrl = config.planOpenAI || DEFAULT_PLAN_OPENAI;
        const anthropicUrl = config.planAnthropic || DEFAULT_PLAN_ANTHROPIC;
        config.planOpenAI = openaiUrl;
        config.planAnthropic = anthropicUrl;
        saveConfig(config);
        return {
          access: key,
          refresh: JSON.stringify({ openai: openaiUrl, anthropic: anthropicUrl }),
          expires: Date.now() + 365 * 86400_000,
        };
      },
      async refreshToken(credentials) { return credentials; },
      getApiKey(credentials) { return credentials.access; },
      modifyModels(models, credentials) {
        const endpoints = resolvePlanEndpoints(credentials);
        const updated = buildPlanModels(planDefs, endpoints.openai, endpoints.anthropic);
        return models.map((model) => {
          if (model.provider !== "alibaba-plan") return model;
          const found = updated.find((candidate) => candidate.id === model.id);
          if (!found?.api) return model;
          return { ...model, baseUrl: found.baseUrl ?? model.baseUrl, api: found.api };
        });
      },
    },
  });
}

// ── Main ──────────────────────────────────────────────────────────────
export default async function (pi: ExtensionAPI) {
  migrateLegacyAuth();
  const config = loadConfig();

  const planCreds = readAuth()["alibaba-plan"];

  const planEndpoints = resolvePlanEndpoints(planCreds);
  const cloudFmt = config.cloudApiFormat || "anthropic-messages";
  await Promise.all([
    planCreds?.access ? loadPlanDefs(true, planCreds).then((models) => { planDefs = models; }) : Promise.resolve(),
    refreshCloudProviders(true),
  ]);

  registerPlanProvider(pi, planEndpoints);
  registerCloudProviders(pi, cloudDefsByProvider, cloudFmt);

  pi.on("session_start", async () => {
    try {
      const planCred = readAuth()["alibaba-plan"];
      await Promise.all([
        loadPlanDefs(false, planCred).then((models) => { planDefs = models; }),
        refreshCloudProviders(false),
      ]);

      const currentConfig = loadConfig();
      const currentPlanCreds = readAuth()["alibaba-plan"];
      registerPlanProvider(pi, resolvePlanEndpoints(currentPlanCreds));
      registerCloudProviders(
        pi,
        cloudDefsByProvider,
        currentConfig.cloudApiFormat || "anthropic-messages",
      );
    } catch (e: unknown) {
      const message = e instanceof Error ? e.message : String(e);
      console.warn(`[alibaba] session_start catalog refresh failed (${message}); keeping previously loaded models.`);
    }
  });

  pi.registerCommand("alibaba", {
    description: "Manage Alibaba (Plan + Cloud) configuration",
    handler: async (_args, ctx: ExtensionCommandContext) => {
      const choice = await ctx.ui.select("Alibaba:", [
        "Status",
        "Refresh model lists",
        "Re-login Plan",
        "Re-login Cloud",
        "Plan — Change Endpoints",
        "Cloud — Change API Format",
        "Context Window — Override",
        "Reset all",
      ]);
      if (!choice) return;

      const config = loadConfig();
      const auth = readAuth();
      const planCred = auth["alibaba-plan"];

      if (choice === "Status") {
        const endpoints = resolvePlanEndpoints(planCred);
        const ageMin = (cache: { fetchedAt: number } | null) =>
          cache ? Math.round((Date.now() - cache.fetchedAt) / 60000) : null;
        const planCache = readJSON<PlanCache | null>(PLAN_CACHE_PATH, null);
        const planAge = ageMin(planCache);
        const planLive = planCache && planAge !== null && planCache.models.length === planDefs.length;
        const planState = planLive
          ? `live, ${planAge}m old`
          : planDefs.length ? "live, not cached" : "not fetched";
        const lines = [
          `Plan:  ${planCred ? "logged in" : "not logged in"}`,
          `       Anthropic: ${endpoints.anthropic}`,
          `       OpenAI:    ${endpoints.openai}`,
          `       Models:    ${planDefs.length} (${planState})`,
        ];

        for (const provider of CLOUD_PROVIDERS) {
          const cache = readJSON<CloudCache | null>(provider.cachePath, null);
          const age = ageMin(cache);
          const models = cloudDefsByProvider[provider.id];
          const keyPresent = Boolean(readCloudKey(provider));
          const modelCount = keyPresent && cache ? models.length : 0;
          const live = keyPresent && cache && age !== null && cache.models.length === models.length;
          const state = live ? `live, ${age}m old` : "not fetched";
          const authState = auth[provider.id]
            ? "logged in"
            : process.env[provider.apiKeyEnv]
              ? `via $${provider.apiKeyEnv}`
              : "not logged in";
          lines.push(
            "",
            `${provider.name}: ${authState}`,
            `       Domain:    ${provider.domain}`,
            `       Env:       $${provider.apiKeyEnv}`,
            `       Format:    ${config.cloudApiFormat || "anthropic-messages"}`,
            `       Models:    ${modelCount} (${state})`,
          );
        }

        const overrides = config.contextWindowOverrides;
        if (overrides && Object.keys(overrides).length) {
          lines.push("", "Context window overrides:");
          for (const [id, count] of Object.entries(overrides)) {
            lines.push(`       ${id}: ${count.toLocaleString()} tokens`);
          }
        }
        ctx.ui.notify(lines.join("\n"), "info");
        return;
      }

      if (choice === "Refresh model lists") {
        try {
          const currentPlanCred = readAuth()["alibaba-plan"];
          const [, cloudResults] = await Promise.all([
            loadPlanDefs(true, currentPlanCred).then((models) => { planDefs = models; }),
            refreshCloudProviders(true),
          ]);
          const cloudSummary = cloudResults
            .map((result) => {
              if (!result.keyPresent) return `${result.provider.id}: skipped`;
              if (result.source === "cache") return `${result.provider.id}: ${result.count} cached models`;
              if (result.source === "retained") return `${result.provider.id}: ${result.count} retained models`;
              if (result.source === "unavailable") return `${result.provider.id}: unavailable`;
              return `${result.provider.id}: ${result.count} models`;
            })
            .join(", ");
          ctx.ui.notify(`Plan: ${planDefs.length} models. Cloud: ${cloudSummary}.`, "info");
          await ctx.reload();
        } catch (e: unknown) {
          const message = e instanceof Error ? e.message : String(e);
          console.error(`[alibaba] Refresh model lists failed: ${message}`);
          ctx.ui.notify(`Refresh failed: ${message}. Full error was logged to the terminal.`, "error");
        }
        return;
      }

      if (choice === "Re-login Plan") {
        if (!await ctx.ui.confirm("Wipe Plan credentials and re-login?", "Removes alibaba-plan from auth.json")) return;
        ctx.modelRegistry.authStorage.remove("alibaba-plan");
        ctx.ui.notify("Plan credentials wiped. Run /login → Alibaba Model Studio Coding Plan.", "info");
        await ctx.reload();
        return;
      }

      if (choice === "Re-login Cloud") {
        const providerName = await ctx.ui.select(
          "Cloud provider:",
          CLOUD_PROVIDERS.map((provider) => provider.name),
        );
        if (!providerName) return;
        const provider = CLOUD_PROVIDERS.find((candidate) => candidate.name === providerName);
        if (!provider) return;
        if (!await ctx.ui.confirm(
          `Wipe ${provider.name} credentials and re-login?`,
          `Removes ${provider.id} from auth.json`,
        )) return;
        ctx.modelRegistry.authStorage.remove(provider.id);
        ctx.ui.notify(
          `${provider.name} credentials wiped. Run /login → Use an API key → ${provider.name}.`,
          "info",
        );
        await ctx.reload();
        return;
      }

      if (choice === "Plan — Change Endpoints") {
        const openaiUrl = (await ctx.ui.input("OpenAI-compat base URL:")) || "";
        const anthropicUrl = (await ctx.ui.input("Anthropic-compat base URL:")) || "";
        if (openaiUrl && anthropicUrl) {
          config.planOpenAI = openaiUrl;
          config.planAnthropic = anthropicUrl;
          saveConfig(config);
          const currentPlan = ctx.modelRegistry.authStorage.get("alibaba-plan");
          if (currentPlan?.type === "oauth") {
            ctx.modelRegistry.authStorage.set("alibaba-plan", {
              ...currentPlan,
              refresh: JSON.stringify({ openai: openaiUrl, anthropic: anthropicUrl }),
            });
          }
          ctx.ui.notify("Plan endpoints updated.", "info");
          await ctx.reload();
        }
        return;
      }

      if (choice === "Cloud — Change API Format") {
        const selected = await ctx.ui.select("Cloud API format:", ["Anthropic (recommended)", "OpenAI"]);
        if (!selected) return;
        config.cloudApiFormat = selected.startsWith("OpenAI") ? "openai-completions" : "anthropic-messages";
        saveConfig(config);
        ctx.ui.notify(`Cloud format: ${config.cloudApiFormat}`, "info");
        await ctx.reload();
        return;
      }

      if (choice === "Context Window — Override") {
        const overrides = config.contextWindowOverrides || {};
        const format = (count: number) => count.toLocaleString();
        const ids = Array.from(new Set([...planDefs.map((model) => model.id), ...allCloudModelIds()])).sort();
        const labelToId = new Map<string, string>();
        const options: string[] = [];
        for (const id of ids) {
          const label = overrides[id] ? `${id}  (override: ${format(overrides[id])})` : id;
          labelToId.set(label, id);
          options.push(label);
        }
        const allLabel = overrides["*"]
          ? `* every other model  (override: ${format(overrides["*"])})`
          : "* every other model";
        labelToId.set(allLabel, "*");
        options.push(allLabel);
        const clear = "Clear all overrides";
        options.push(clear);

        const selected = await ctx.ui.select("Override context window for:", options);
        if (!selected) return;
        if (selected === clear) {
          delete config.contextWindowOverrides;
          saveConfig(config);
          ctx.ui.notify("Cleared all context-window overrides.", "info");
          await ctx.reload();
          return;
        }
        const id = labelToId.get(selected) ?? selected;
        const current = overrides[id];
        const value = (await ctx.ui.input(
          `Context window for ${id} in tokens — e.g. 1048576 (0 to remove)${current ? `; currently ${format(current)}` : ""}:`,
        ))?.trim();
        if (!value) return;
        const count = Number(value.replace(/[_,\s]/g, ""));
        if (!Number.isSafeInteger(count) || count < 0) {
          ctx.ui.notify("Enter a non-negative whole number of tokens (0 removes the override).", "error");
          return;
        }
        config.contextWindowOverrides = config.contextWindowOverrides || {};
        if (count === 0) {
          delete config.contextWindowOverrides[id];
          ctx.ui.notify(`Removed context-window override for ${id}.`, "info");
        } else {
          config.contextWindowOverrides[id] = count;
          ctx.ui.notify(`Context window for ${id} set to ${format(count)} tokens.`, "info");
        }
        if (Object.keys(config.contextWindowOverrides).length === 0) delete config.contextWindowOverrides;
        saveConfig(config);
        await ctx.reload();
        return;
      }

      if (choice === "Reset all") {
        if (!await ctx.ui.confirm(
          "Reset all Alibaba settings?",
          "Wipes config, Plan auth, regional Cloud auth entries, all model caches, and Alibaba entries in settings.json.",
        )) return;
        for (const cachePath of [
          CONFIG_PATH,
          PLAN_CACHE_PATH,
          MODELS_DEV_CACHE_PATH,
          ...CLOUD_PROVIDERS.map((provider) => provider.cachePath),
        ]) {
          unlinkIfExists(cachePath);
        }
        for (const key of [
          ...CLOUD_PROVIDER_IDS,
          "alibaba-plan",
          "alibaba-cloud",
          "alibaba-studio",
          "alibaba-token",
          "dashscope",
        ]) {
          ctx.modelRegistry.authStorage.remove(key);
        }
        let settingsCleanupFailed = false;
        try {
          const settings = readJSON<Record<string, unknown>>(SETTINGS_PATH, {});
          let touched = false;
          if (Array.isArray(settings.enabledModels)) {
            const before = settings.enabledModels.length;
            const enabledModels = settings.enabledModels.filter(
              (id) => typeof id === "string" && !/^(alibaba(-plan|-cloud|-cn|-global|-studio|-token)?|dashscope)\//.test(id),
            );
            settings.enabledModels = enabledModels;
            if (enabledModels.length !== before) touched = true;
          }
          if (
            typeof settings.defaultProvider === "string" &&
            /^(alibaba(-plan|-cloud|-cn|-global|-studio|-token)?|dashscope)$/.test(settings.defaultProvider)
          ) {
            delete settings.defaultProvider;
            delete settings.defaultModel;
            touched = true;
          }
          if (touched) writeJSON(SETTINGS_PATH, settings);
        } catch (e: unknown) {
          settingsCleanupFailed = true;
          const message = e instanceof Error ? e.message : String(e);
          console.warn(`[alibaba] Settings cleanup failed (${message}).`);
        }
        ctx.ui.notify(
          settingsCleanupFailed
            ? "Auth and caches reset, but settings cleanup failed. Repair settings.json before removing extension."
            : "All Alibaba settings wiped. Now safe to `pi remove`.",
          settingsCleanupFailed ? "error" : "info",
        );
        await ctx.reload();
      }
    },
  });
}
