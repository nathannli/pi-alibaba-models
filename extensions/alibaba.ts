import type { ExtensionAPI, ProviderModelConfig, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

// ── Paths ─────────────────────────────────────────────────────────────
const HOME_DIR = path.join(os.homedir(), ".pi", "agent");
const CONFIG_PATH = path.join(HOME_DIR, "alibaba-config.json");
const AUTH_PATH = path.join(HOME_DIR, "auth.json");
const PLAN_CACHE_PATH = path.join(HOME_DIR, "alibaba-plan-models.cache.json");
const CLOUD_CACHE_PATH = path.join(HOME_DIR, "alibaba-cloud-models.cache.json");
const MODELS_DEV_CACHE_PATH = path.join(HOME_DIR, "alibaba-models-dev.cache.json");

const MODELS_CACHE_TTL_MS = 4 * 60 * 60 * 1000;

const DEFAULT_PLAN_OPENAI = "https://token-plan.ap-southeast-1.maas.aliyuncs.com/compatible-mode/v1";
const DEFAULT_PLAN_ANTHROPIC = "https://token-plan.ap-southeast-1.maas.aliyuncs.com/apps/anthropic";
const DEFAULT_CLOUD_DOMAIN = "dashscope-intl.aliyuncs.com";

// ── Config / auth helpers ─────────────────────────────────────────────
interface AlibabaConfig {
  planOpenAI?: string;
  planAnthropic?: string;
  cloudDomain?: string;
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
const loadConfig = (): AlibabaConfig => readJSON<AlibabaConfig>(CONFIG_PATH, {});
const saveConfig = (c: AlibabaConfig) => writeJSON(CONFIG_PATH, c);
const readAuth = (): Record<string, any> => readJSON<Record<string, any>>(AUTH_PATH, {});
const writeAuth = (a: Record<string, any>) => writeJSON(AUTH_PATH, a);

// ── Plan model definitions ────────────────────────────────────────────
// Anthropic-compatible by default; deepseek forced to openai-completions.
interface PlanModelDef {
  id: string; name: string; reasoning: boolean; contextWindow: number; maxTokens: number;
  input: ("text" | "image")[]; cost?: ProviderModelConfig["cost"];
  compat?: { thinkingFormat: "qwen" }; openaiOnly?: boolean;
}

// ── Plan model fetch + parse + cache ──────────────────────────────────
interface PlanCache { fetchedAt: number; source: string; models: PlanModelDef[]; }

// ── models.dev metadata + capability fallbacks ───────────────────────
// Alibaba /models endpoints are the source of truth for account availability,
// but they only return ids/names. models.dev supplies context windows, output
// limits, costs, modalities, and reasoning flags for those live ids.
interface ModelsDevModel {
  id: string;
  name?: string;
  tool_call?: boolean;
  reasoning?: boolean;
  status?: string;
  limit?: { context?: number; output?: number };
  cost?: { input?: number; output?: number; cache_read?: number; cache_write?: number };
  modalities?: { input?: string[]; output?: string[] };
}
interface ModelsDevProvider { id?: string; name?: string; api?: string; models?: Record<string, ModelsDevModel>; }
interface ModelsDevCache { fetchedAt: number; providers: Record<string, ModelsDevProvider>; }

type ModelsDevSource = "live" | "cache" | "unavailable";
let modelsDevCatalog: Record<string, ModelsDevProvider> = {};
let modelsDevSource: ModelsDevSource = "unavailable";
let modelsDevFetchedAt = 0;

const ALIBABA_MODELS_DEV_KEYS = [
  "alibaba", "alibaba-cn", "alibaba-coding-plan", "alibaba-token-plan", "alibaba-coding-plan-cn",
];
const EXCLUDE_NON_CHAT = /(image|audio|video|tts|asr|embed|vector|rerank|wan|omni|livetranslate|realtime)/i;

const isVisionModel = (id: string): boolean =>
  /vl|vision/i.test(id) || /^qwen3\.\d+-plus\b/i.test(id) || /kimi/i.test(id);

const isReasoningModel = (id: string): boolean =>
  /qwq|max|thinking|deepseek|minimax|kimi|glm|3\.[5-9]/i.test(id);

const hasDateSuffix = (id: string) => /-\d{4}-\d{2}-\d{2}(?:-|$)/.test(id);

async function loadModelsDevCatalog(): Promise<void> {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), 5000);
  try {
    const res = await fetch("https://models.dev/api.json", { signal: ctrl.signal });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const json = await res.json() as Record<string, ModelsDevProvider>;
    const providers = Object.fromEntries(
      ALIBABA_MODELS_DEV_KEYS.filter((k) => json[k]?.models).map((k) => [k, json[k]]),
    ) as Record<string, ModelsDevProvider>;
    if (!Object.keys(providers).length) throw new Error("No Alibaba providers in models.dev response");
    modelsDevCatalog = providers;
    modelsDevSource = "live";
    modelsDevFetchedAt = Date.now();
    writeJSON(MODELS_DEV_CACHE_PATH, { fetchedAt: modelsDevFetchedAt, providers } satisfies ModelsDevCache);
  } catch (e: any) {
    const cache = readJSON<ModelsDevCache | null>(MODELS_DEV_CACHE_PATH, null);
    if (cache?.providers && Object.keys(cache.providers).length) {
      modelsDevCatalog = cache.providers;
      modelsDevSource = "cache";
      modelsDevFetchedAt = cache.fetchedAt;
      console.warn(`[alibaba] models.dev fetch failed (${e?.message || e}); using cached metadata (${Math.round((Date.now() - cache.fetchedAt) / 60000)}m old).`);
    } else {
      modelsDevCatalog = {};
      modelsDevSource = "unavailable";
      modelsDevFetchedAt = 0;
      console.warn(`[alibaba] models.dev fetch failed (${e?.message || e}); using local capability fallbacks.`);
    }
  } finally { clearTimeout(t); }
}

function planModelsDevKey(credentials?: { access?: string; refresh?: string }): string {
  const ep = resolvePlanEndpoints(credentials).openai;
  if (/coding\.dashscope\.aliyuncs\.com/i.test(ep)) return "alibaba-coding-plan-cn";
  if (/coding/i.test(ep)) return "alibaba-coding-plan";
  return "alibaba-token-plan";
}

function cloudModelsDevKey(domain: string): string {
  return /^dashscope\.aliyuncs\.com$/i.test(domain) ? "alibaba-cn" : "alibaba";
}

function getModelsDevModel(providerKey: string, id: string): ModelsDevModel | undefined {
  const models = modelsDevCatalog[providerKey]?.models;
  if (!models) return undefined;
  if (models[id]) return models[id];
  const lower = id.toLowerCase();
  return Object.entries(models).find(([k]) => k.toLowerCase() === lower)?.[1];
}

function modelInput(meta: ModelsDevModel | undefined, id: string): ("text" | "image")[] {
  if (meta?.modalities?.input) return meta.modalities.input.includes("image") ? ["text", "image"] : ["text"];
  return isVisionModel(id) ? ["text", "image"] : ["text"];
}

function modelCost(meta: ModelsDevModel | undefined): ProviderModelConfig["cost"] {
  return {
    input: meta?.cost?.input || 0,
    output: meta?.cost?.output || 0,
    cacheRead: meta?.cost?.cache_read || 0,
    cacheWrite: meta?.cost?.cache_write || 0,
  };
}

function fallbackContextWindow(id: string): number {
  if (/flash/i.test(id)) return 131072;
  if (/kimi/i.test(id)) return 262144;
  if (/^qwen3\.6-max\b/i.test(id)) return 262144; // 3.6 Max = 256K
  if (/^qwen3\.6-plus\b/i.test(id) || /^qwen3\.([7-9]|\d{2,})-(plus|max)\b/i.test(id)) return 1048576;
  return 131072;
}

const inferContextWindow = (id: string, overrides?: Record<string, number>, meta?: ModelsDevModel): number => {
  // User overrides win: exact id first, then the "*" catch-all.
  const o = overrides?.[id] ?? overrides?.["*"];
  if (typeof o === "number" && o > 0) return o;
  if (typeof meta?.limit?.context === "number" && meta.limit.context > 0) return meta.limit.context;
  return fallbackContextWindow(id);
};

function includeLiveChatModel(id: string, meta?: ModelsDevModel): boolean {
  if (hasDateSuffix(id)) return false;
  if (meta) {
    if (meta.status === "deprecated") return false;
    if (meta.modalities) {
      const input = meta.modalities.input || [];
      const output = meta.modalities.output || [];
      if (!input.includes("text") || !output.includes("text")) return false;
    }
    if (meta.tool_call === false) return false;
  }
  return !EXCLUDE_NON_CHAT.test(id);
}

// Turn a bare live model id into a full PlanModelDef, enriched by models.dev.
function inferPlanDef(id: string, providerKey: string, overrides?: Record<string, number>): PlanModelDef {
  const meta = getModelsDevModel(providerKey, id);
  const openaiOnly = /deepseek/i.test(id);
  const isReasoning = meta?.reasoning === true || (!meta && isReasoningModel(id));
  return {
    id,
    name: meta?.name || prettyName(id),
    reasoning: isReasoning,
    input: modelInput(meta, id),
    contextWindow: inferContextWindow(id, overrides, meta),
    maxTokens: meta?.limit?.output || (openaiOnly ? 16384 : 65536),
    cost: modelCost(meta),
    compat: isReasoning ? { thinkingFormat: "qwen" } : undefined,
    openaiOnly,
  };
}

function enrichPlanDef(m: PlanModelDef, providerKey: string, overrides?: Record<string, number>): PlanModelDef {
  const meta = getModelsDevModel(providerKey, m.id);
  if (!meta) return { ...m, contextWindow: inferContextWindow(m.id, overrides) };
  const reasoning = meta.reasoning === true;
  return {
    ...m,
    name: meta.name || m.name,
    reasoning,
    input: modelInput(meta, m.id),
    contextWindow: inferContextWindow(m.id, overrides, meta),
    maxTokens: meta.limit?.output || m.maxTokens,
    cost: modelCost(meta),
    compat: reasoning ? { thinkingFormat: "qwen" } : undefined,
  };
}

function enrichProviderModel(m: ProviderModelConfig, providerKey: string, overrides?: Record<string, number>): ProviderModelConfig {
  const meta = getModelsDevModel(providerKey, m.id);
  if (!meta) return { ...m, contextWindow: inferContextWindow(m.id, overrides) };
  const reasoning = meta.reasoning === true;
  return {
    ...m,
    name: meta.name || m.name,
    reasoning,
    input: modelInput(meta, m.id),
    cost: modelCost(meta),
    contextWindow: inferContextWindow(m.id, overrides, meta),
    maxTokens: meta.limit?.output || m.maxTokens,
    compat: reasoning ? { thinkingFormat: "qwen" as const } : undefined,
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
    const overrides = loadConfig().contextWindowOverrides;
    const providerKey = planModelsDevKey(credentials);
    return json.data
      .filter((m) => includeLiveChatModel(m.id, getModelsDevModel(providerKey, m.id)))
      .map((m) => inferPlanDef(m.id, providerKey, overrides));
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
    } catch {}
  }
  const cfg = loadConfig();
  return {
    openai: cfg.planOpenAI || DEFAULT_PLAN_OPENAI,
    anthropic: cfg.planAnthropic || DEFAULT_PLAN_ANTHROPIC,
  };
}

function buildPlanModels(defs: PlanModelDef[], openaiUrl: string, anthropicUrl: string): ProviderModelConfig[] {
  return defs.filter((m) => !hasDateSuffix(m.id)).map((m) => {
    const useOpenAI = !!m.openaiOnly || /deepseek/i.test(m.id);
    return {
      id: m.id, name: m.name, reasoning: m.reasoning, input: m.input,
      contextWindow: m.contextWindow, maxTokens: m.maxTokens, compat: m.compat,
      thinkingLevelMap: m.reasoning ? { off: null } : undefined,
      cost: m.cost || { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      baseUrl: useOpenAI ? openaiUrl : anthropicUrl,
      api: (useOpenAI ? "openai-completions" : "anthropic-messages") as "anthropic-messages" | "openai-completions",
    };
  });
}

// ── Cloud builders ────────────────────────────────────────────────────
interface CloudCache { fetchedAt: number; domain: string; models: ProviderModelConfig[]; }

async function fetchCloudModels(domain: string, apiKey: string, _force = false): Promise<ProviderModelConfig[]> {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), 4000);
  try {
    const res = await fetch(`https://${domain}/compatible-mode/v1/models`, {
      headers: { Authorization: `Bearer ${apiKey}` },
      signal: ctrl.signal,
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const json = (await res.json()) as { data?: { id: string; name?: string }[] };
    if (!json.data?.length) throw new Error("No models");
    const overrides = loadConfig().contextWindowOverrides;
    const providerKey = cloudModelsDevKey(domain);
    const models = json.data
      .filter((m) => includeLiveChatModel(m.id, getModelsDevModel(providerKey, m.id)))
      .map((m) => {
        const meta = getModelsDevModel(providerKey, m.id);
        const isReasoning = meta?.reasoning === true || (!meta && isReasoningModel(m.id));
        return {
          id: m.id,
          name: meta?.name || m.name || m.id,
          reasoning: isReasoning,
          input: modelInput(meta, m.id),
          cost: modelCost(meta),
          contextWindow: inferContextWindow(m.id, overrides, meta),
          maxTokens: meta?.limit?.output || 8192,
          compat: isReasoning ? { thinkingFormat: "qwen" as const } : undefined,
        };
      });
    const cache: CloudCache = { fetchedAt: Date.now(), domain, models };
    writeJSON(CLOUD_CACHE_PATH, cache);
    return models;
  } finally { clearTimeout(t); }
}

function buildCloudModels(models: ProviderModelConfig[], domain: string, fmt: string): ProviderModelConfig[] {
  const overrides = loadConfig().contextWindowOverrides;
  const providerKey = cloudModelsDevKey(domain);
  return models.filter((m) => includeLiveChatModel(m.id, getModelsDevModel(providerKey, m.id))).map((m) => {
    const enriched = enrichProviderModel(m, providerKey, overrides);
    const useOpenAI = /deepseek/i.test(enriched.id) || fmt === "openai-completions";
    return {
      ...enriched,
      thinkingLevelMap: enriched.reasoning ? { off: null } : undefined,
      baseUrl: useOpenAI ? `https://${domain}/compatible-mode/v1` : `https://${domain}/apps/anthropic`,
      api: (useOpenAI ? "openai-completions" : "anthropic-messages") as "anthropic-messages" | "openai-completions",
    };
  });
}

// ── Cloud credential resolution ──────────────────────────────────────
// The Cloud provider can authenticate either from a key saved via /login
// (auth.json) OR from the DASHSCOPE_API_KEY env var (its apiKey is
// "$DASHSCOPE_API_KEY"). Either one lets us fetch the real catalog — so we
// always prefer the live list and only fall back to the login seed below
// when there is no credential at all.
const readCloudKey = (): string | null => {
  try {
    const c = readAuth()["alibaba-cloud"];
    const k = c?.key || c?.access;
    if (k) return k;
  } catch {}
  return process.env.DASHSCOPE_API_KEY || null;
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
  contextWindow: inferContextWindow("qwen-plus"),
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
      const overrides = loadConfig().contextWindowOverrides;
      const providerKey = planModelsDevKey(credentials);
      const cachedModels = cache.models
        .filter((m) => includeLiveChatModel(m.id, getModelsDevModel(providerKey, m.id)))
        .map((m) => enrichPlanDef(m, providerKey, overrides));
      if (cachedModels.length) {
        console.warn(`[alibaba] Plan catalog fetch failed (${e?.message || e}); using cached models (${cachedModels.length}, ${cacheAgeMin(cache.fetchedAt)}m old).`);
        return cachedModels;
      }
    }
    console.warn(`[alibaba] Plan catalog fetch failed (${e?.message || e}); no cache — Plan models unavailable until reconnected. Other providers still work.`);
    return [];
  }
}

async function loadCloudDefs(domain: string, apiKey: string, force: boolean): Promise<ProviderModelConfig[]> {
  try {
    return await fetchCloudModels(domain, apiKey, force);
  } catch (e: any) {
    const cache = readJSON<CloudCache | null>(CLOUD_CACHE_PATH, null);
    if (cache?.models?.length && cache.domain === domain) {
      const overrides = loadConfig().contextWindowOverrides;
      const providerKey = cloudModelsDevKey(domain);
      const cachedModels = cache.models
        .filter((m) => includeLiveChatModel(m.id, getModelsDevModel(providerKey, m.id)))
        .map((m) => enrichProviderModel(m, providerKey, overrides));
      if (cachedModels.length) {
        console.warn(`[alibaba] Cloud catalog fetch failed (${e?.message || e}); using cached models (${cachedModels.length}, ${cacheAgeMin(cache.fetchedAt)}m old).`);
        return cachedModels;
      }
    }
    console.warn(`[alibaba] Cloud catalog fetch failed (${e?.message || e}); no cache — Cloud models unavailable until reconnected. Other providers still work.`);
    return [];
  }
}

// ── Module-level mutable model lists ─────────────────────────────────
// Populated by the async extension factory before provider registration.
let planDefs: PlanModelDef[] = [];
let cloudDefs: ProviderModelConfig[] = [];

// ── Migration ─────────────────────────────────────────────────────────
const isPlanKey = (k: string) => k.startsWith("sk-sp-") || k.startsWith("sk-tok-");

function extractKey(entry: any): string | undefined {
  if (!entry || typeof entry !== "object") return undefined;
  return entry.key || entry.access || undefined;
}

function migrateLegacyAuth() {
  try {
    const auth = readAuth();
    let dirty = false;

    // 1) Legacy single-key "alibaba" → split by prefix.
    const old = auth["alibaba"];
    if (old) {
      const key = extractKey(old);
      for (const k of ["alibaba-studio", "alibaba-token", "dashscope"]) {
        if (k in auth) { delete auth[k]; dirty = true; }
      }
      if (!key) {
        delete auth["alibaba"]; dirty = true;
      } else {
        const target = isPlanKey(key) ? "alibaba-plan" : "alibaba-cloud";
        // Plan stays in oauth shape (it's still oauth-registered);
        // Cloud must be api_key shape (now api-key-only registered).
        auth[target] = target === "alibaba-plan"
          ? { type: "oauth", access: key, refresh: "", expires: Date.now() + 365 * 86400_000 }
          : { type: "api_key", key };
        delete auth["alibaba"];
        dirty = true;
      }
    }

    // 2) Cloud was previously registered with `oauth` block — credentials were
    //    saved as {type:"oauth", access:"sk-..."}. Now that cloud is api-key-only,
    //    pi can't read those credentials. Migrate them in place.
    const cloud = auth["alibaba-cloud"];
    if (cloud && cloud.type !== "api_key") {
      const key = extractKey(cloud);
      if (key) {
        // Defensive: if the cloud slot somehow contains a Plan token, route it.
        if (isPlanKey(key)) {
          auth["alibaba-plan"] = auth["alibaba-plan"] ?? {
            type: "oauth", access: key, refresh: "", expires: Date.now() + 365 * 86400_000,
          };
          delete auth["alibaba-cloud"];
        } else {
          auth["alibaba-cloud"] = { type: "api_key", key };
        }
        dirty = true;
      } else {
        delete auth["alibaba-cloud"];
        dirty = true;
      }
    }

    // 3) Defensive: a misrouted Plan token sitting in alibaba-cloud (api_key shape).
    //    Plan tokens won't authenticate against the cloud endpoint. Move it.
    const cloud2 = auth["alibaba-cloud"];
    if (cloud2?.type === "api_key" && typeof cloud2.key === "string" && isPlanKey(cloud2.key)) {
      if (!auth["alibaba-plan"]) {
        auth["alibaba-plan"] = {
          type: "oauth", access: cloud2.key, refresh: "", expires: Date.now() + 365 * 86400_000,
        };
      }
      delete auth["alibaba-cloud"];
      dirty = true;
    }

    if (dirty) writeAuth(auth);
  } catch {}
}

// ── Main ──────────────────────────────────────────────────────────────
// Async factory: pi awaits this before provider registrations are flushed.
// Fetch live model catalogs before registerProvider() so enabledModels
// validation sees the real catalog immediately. No fallbacks.
export default async function (pi: ExtensionAPI) {
  migrateLegacyAuth();
  const config = loadConfig();

  let planKey: string | null = null;
  try {
    const auth = readAuth();
    planKey = auth["alibaba-plan"]?.access || auth["alibaba-plan"]?.key || null;
  } catch {}
  const cloudKey = readCloudKey();

  // ── Live catalog fetch (before provider registration) ───────────────
  let planCreds: { access?: string; refresh?: string } | undefined;
  if (planKey) { try { planCreds = readAuth()["alibaba-plan"]; } catch {} }
  const planEndpoints = resolvePlanEndpoints(planCreds);
  const cloudDomain = config.cloudDomain || DEFAULT_CLOUD_DOMAIN;
  const cloudFmt = config.cloudApiFormat || "anthropic-messages";

  await loadModelsDevCatalog();
  if (planCreds?.access) planDefs = await loadPlanDefs(true, planCreds);
  if (cloudKey) cloudDefs = await loadCloudDefs(cloudDomain, cloudKey, true);
  // Keep the Cloud provider visible in /login even with no models yet (issue #1).
  if (!cloudDefs.length) cloudDefs = CLOUD_LOGIN_SEED;

  // ── Plan provider ───────────────────────────────────────────────────
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
            "If it's a Cloud API key, run /login → 'Alibaba Cloud (API Key)' instead.",
          );
        }
        const cfg = loadConfig();
        const openaiUrl = cfg.planOpenAI || DEFAULT_PLAN_OPENAI;
        const anthropicUrl = cfg.planAnthropic || DEFAULT_PLAN_ANTHROPIC;
        cfg.planOpenAI = openaiUrl;
        cfg.planAnthropic = anthropicUrl;
        saveConfig(cfg);
        return {
          access: key,
          refresh: JSON.stringify({ openai: openaiUrl, anthropic: anthropicUrl }),
          expires: Date.now() + 365 * 86400_000,
        };
      },
      async refreshToken(c) { return c; },
      getApiKey(c) { return c.access; },
      modifyModels(models, credentials) {
        const ep = resolvePlanEndpoints(credentials);
        // Always reads the latest planDefs (startup fetch → session_start refresh)
        const updated = buildPlanModels(planDefs, ep.openai, ep.anthropic);
        return models.map((m) => {
          if (m.provider !== "alibaba-plan") return m;
          const found = updated.find((u) => u.id === m.id);
          if (!found || !found.api) return m;
          return { ...m, baseUrl: found.baseUrl ?? m.baseUrl, api: found.api };
        });
      },
    },
  });

  // ── Cloud provider ─────────────────────────────────────────────────
  pi.registerProvider("alibaba-cloud", {
    name: "Alibaba Cloud (API Key)",
    baseUrl: `https://${cloudDomain}/apps/anthropic`,
    apiKey: "$DASHSCOPE_API_KEY",
    api: "anthropic-messages",
    authHeader: true,
    models: buildCloudModels(cloudDefs, cloudDomain, cloudFmt),
  });

  // ── Lazy refresh: fetch live catalogs and re-register ───────────────
  pi.on("session_start", async () => {
   try {
    await loadModelsDevCatalog();
    const planCred = readAuth()["alibaba-plan"];
    planDefs = await loadPlanDefs(false, planCred);

    const key = readCloudKey();
    if (key) {
      const cfg = loadConfig();
      const domain = cfg.cloudDomain || DEFAULT_CLOUD_DOMAIN;
      cloudDefs = await loadCloudDefs(domain, key, false);
    }
    // Keep the Cloud provider visible in /login even with no models yet (issue #1).
    if (!cloudDefs.length) cloudDefs = CLOUD_LOGIN_SEED;

    // Re-register both providers with the expanded model lists
    const currentConfig = loadConfig();
    const currentPlanCreds = readAuth()["alibaba-plan"];
    const ep = resolvePlanEndpoints(currentPlanCreds);
    const currentDomain = currentConfig.cloudDomain || DEFAULT_CLOUD_DOMAIN;
    const currentFmt = currentConfig.cloudApiFormat || "anthropic-messages";

    pi.registerProvider("alibaba-plan", {
      name: "Alibaba Model Studio Plan",
      baseUrl: ep.anthropic,
      api: "anthropic-messages",
      authHeader: true,
      models: buildPlanModels(planDefs, ep.openai, ep.anthropic),
      oauth: {
        name: "Alibaba Model Studio Coding Plan",
        async login(callbacks) {
          const key = await callbacks.onPrompt({
            message: "Coding Plan token (sk-sp-… or sk-tok-…). Run /alibaba afterwards if you need a non-Singapore region:",
          });
          if (!isPlanKey(key)) {
            throw new Error(
              "This doesn't look like a Coding Plan token (expected sk-sp-… or sk-tok-…). " +
              "If it's a Cloud API key, run /login → 'Alibaba Cloud (API Key)' instead.",
            );
          }
          const cfg = loadConfig();
          const openaiUrl = cfg.planOpenAI || DEFAULT_PLAN_OPENAI;
          const anthropicUrl = cfg.planAnthropic || DEFAULT_PLAN_ANTHROPIC;
          cfg.planOpenAI = openaiUrl;
          cfg.planAnthropic = anthropicUrl;
          saveConfig(cfg);
          return {
            access: key,
            refresh: JSON.stringify({ openai: openaiUrl, anthropic: anthropicUrl }),
            expires: Date.now() + 365 * 86400_000,
          };
        },
        async refreshToken(c) { return c; },
        getApiKey(c) { return c.access; },
        modifyModels(models, credentials) {
          const ep2 = resolvePlanEndpoints(credentials);
          const updated = buildPlanModels(planDefs, ep2.openai, ep2.anthropic);
          return models.map((m) => {
            if (m.provider !== "alibaba-plan") return m;
            const found = updated.find((u) => u.id === m.id);
            if (!found || !found.api) return m;
            return { ...m, baseUrl: found.baseUrl ?? m.baseUrl, api: found.api };
          });
        },
      },
    });

    pi.registerProvider("alibaba-cloud", {
      name: "Alibaba Cloud (API Key)",
      baseUrl: `https://${currentDomain}/apps/anthropic`,
      apiKey: "$DASHSCOPE_API_KEY",
      api: "anthropic-messages",
      authHeader: true,
      models: buildCloudModels(cloudDefs, currentDomain, currentFmt),
    });
   } catch (e: any) {
    console.warn(`[alibaba] session_start catalog refresh failed (${e?.message || e}); keeping previously loaded models.`);
   }
  });

  // ── Command: /alibaba ──────────────────────────────────────────────
  pi.registerCommand("alibaba", {
    description: "Manage Alibaba (Plan + Cloud) configuration",
    handler: async (_args, ctx: ExtensionCommandContext) => {
      const choice = await ctx.ui.select("Alibaba:", [
        "Status",
        "Refresh model lists",
        "Re-login Plan",
        "Re-login Cloud",
        "Plan — Change Endpoints",
        "Cloud — Change Domain",
        "Cloud — Change API Format",
        "Context Window — Override",
        "Reset all",
      ]);
      if (!choice) return;

      const cfg = loadConfig();
      const auth = readAuth();
      const planCred = auth["alibaba-plan"];
      const cloudCred = auth["alibaba-cloud"];

      if (choice === "Status") {
        const ep = resolvePlanEndpoints(planCred);
        const planCache = readJSON<PlanCache | null>(PLAN_CACHE_PATH, null);
        const cloudCache = readJSON<CloudCache | null>(CLOUD_CACHE_PATH, null);
        const ageMin = (c: { fetchedAt: number } | null) => c ? Math.round((Date.now() - c.fetchedAt) / 60000) : null;
        const planAge = ageMin(planCache);
        const cloudAge = ageMin(cloudCache);
        const metadataState = modelsDevSource === "unavailable"
          ? "unavailable, using fallbacks"
          : `models.dev ${modelsDevSource}, ${Math.round((Date.now() - modelsDevFetchedAt) / 60000)}m old`;
        const isPlanLive = planCache && planAge !== null && planCache.models.length === planDefs.length;
        const isCloudLive = cloudCache && cloudAge !== null && cloudCache.models.length === cloudDefs.length;
        const planState = isPlanLive ? `live, ${planAge}m old` : (planDefs.length ? "live, not cached" : "not fetched");
        const cloudState = isCloudLive ? `live, ${cloudAge}m old` : (cloudDefs.length ? "live, not cached" : "not fetched");
        const lines = [
          `Plan:  ${planCred ? "logged in" : "not logged in"}`,
          `       Anthropic: ${ep.anthropic}`,
          `       OpenAI:    ${ep.openai}`,
          `       Models:    ${planDefs.length} (${planState})`,
          ``,
          `Cloud: ${cloudCred ? "logged in" : (process.env.DASHSCOPE_API_KEY ? "via $DASHSCOPE_API_KEY" : "not logged in")}`,
          `       Domain:    ${cfg.cloudDomain || DEFAULT_CLOUD_DOMAIN}`,
          `       Format:    ${cfg.cloudApiFormat || "anthropic-messages"}`,
          `       Models:    ${cloudDefs.length} (${cloudState})`,
          ``,
          `Metadata: ${metadataState}`,
        ];
        const overrides = cfg.contextWindowOverrides;
        if (overrides && Object.keys(overrides).length) {
          lines.push("", "Context window overrides:");
          for (const [id, n] of Object.entries(overrides)) {
            lines.push(`       ${id}: ${n.toLocaleString()} tokens`);
          }
        }
        ctx.ui.notify(lines.join("\n"), "info");
        return;
      }

      if (choice === "Refresh model lists") {
        try {
          await loadModelsDevCatalog();
          const planCred = readAuth()["alibaba-plan"];
          planDefs = await fetchPlanModels(true, planCred);
          let cloudCount = 0;
          if (cloudCred?.key || cloudCred?.access) {
            const domain = cfg.cloudDomain || DEFAULT_CLOUD_DOMAIN;
            const key = cloudCred.key || cloudCred.access;
            cloudDefs = await fetchCloudModels(domain, key, true);
            cloudCount = cloudDefs.length;
          }
          ctx.ui.notify(`Plan: ${planDefs.length} models. Cloud: ${cloudCount > 0 ? `${cloudCount} models` : "skipped (not logged in)"}.`, "info");
          await ctx.reload();
        } catch (e: any) {
          ctx.ui.notify(`Failed: ${e?.message || e}`, "error");
        }
        return;
      }

      if (choice === "Re-login Plan") {
        if (!await ctx.ui.confirm("Wipe Plan credentials and re-login?", "Removes alibaba-plan from auth.json")) return;
        // Use authStorage.remove() rather than fs.write — it persists AND updates pi's
        // in-memory credential map, so /login's `• configured` label refreshes without restart.
        ctx.modelRegistry.authStorage.remove("alibaba-plan");
        ctx.ui.notify("Plan credentials wiped. Run /login → Alibaba Model Studio Coding Plan.", "info");
        await ctx.reload();
        return;
      }

      if (choice === "Re-login Cloud") {
        if (!await ctx.ui.confirm("Wipe Cloud credentials and re-login?", "Removes alibaba-cloud from auth.json")) return;
        ctx.modelRegistry.authStorage.remove("alibaba-cloud");
        ctx.ui.notify("Cloud credentials wiped. Run /login → Use an API key → Alibaba Cloud (API Key).", "info");
        await ctx.reload();
        return;
      }

      if (choice === "Plan — Change Endpoints") {
        const o = (await ctx.ui.input("OpenAI-compat base URL:")) || "";
        const a = (await ctx.ui.input("Anthropic-compat base URL:")) || "";
        if (o && a) {
          cfg.planOpenAI = o; cfg.planAnthropic = a; saveConfig(cfg);
          // Also rewrite the active credential's refresh-blob so resolvePlanEndpoints
          // (which prefers credentials.refresh over config) picks up the new endpoints
          // for the existing logged-in session — otherwise the change only takes effect
          // after the user logs out + back in.
          const currentPlan = ctx.modelRegistry.authStorage.get("alibaba-plan");
          if (currentPlan?.type === "oauth") {
            ctx.modelRegistry.authStorage.set("alibaba-plan", {
              ...currentPlan,
              refresh: JSON.stringify({ openai: o, anthropic: a }),
            });
          }
          ctx.ui.notify("Plan endpoints updated.", "info");
          await ctx.reload();
        }
        return;
      }

      if (choice === "Cloud — Change Domain") {
        const endpoints = [
          { label: "Singapore: https://{WorkspaceId}.ap-southeast-1.maas.aliyuncs.com/compatible-mode/v1", domain: "{WorkspaceId}.ap-southeast-1.maas.aliyuncs.com" },
          { label: "US (Virginia): https://dashscope-us.aliyuncs.com/compatible-mode/v1", domain: "dashscope-us.aliyuncs.com" },
          { label: "China (Beijing): https://dashscope.aliyuncs.com/compatible-mode/v1", domain: "dashscope.aliyuncs.com" },
          { label: "China (Hong Kong): https://{WorkspaceId}.cn-hongkong.maas.aliyuncs.com/compatible-mode/v1", domain: "{WorkspaceId}.cn-hongkong.maas.aliyuncs.com" },
          { label: "Germany (Frankfurt): https://{WorkspaceId}.eu-central-1.maas.aliyuncs.com/compatible-mode/v1", domain: "{WorkspaceId}.eu-central-1.maas.aliyuncs.com" },
          { label: "Custom…", domain: "" },
        ];
        const sel = await ctx.ui.select("Cloud endpoint:", endpoints.map((e) => e.label));
        if (!sel) return;
        const endpoint = endpoints.find((e) => e.label === sel);
        let domain = endpoint?.domain || "";
        if (sel.startsWith("Custom")) domain = (await ctx.ui.input("Cloud domain:")) || "";
        if (domain.includes("{WorkspaceId}")) {
          const workspaceId = (await ctx.ui.input("Workspace ID:")) || "";
          if (!workspaceId) return;
          domain = domain.replace("{WorkspaceId}", workspaceId);
        }
        if (domain) {
          cfg.cloudDomain = domain; saveConfig(cfg);
          ctx.ui.notify(`Cloud domain: ${domain}`, "info");
          await ctx.reload();
        }
        return;
      }

      if (choice === "Cloud — Change API Format") {
        const sel = await ctx.ui.select("Cloud API format:", ["Anthropic (recommended)", "OpenAI"]);
        if (!sel) return;
        cfg.cloudApiFormat = sel.startsWith("OpenAI") ? "openai-completions" : "anthropic-messages";
        saveConfig(cfg);
        ctx.ui.notify(`Cloud format: ${cfg.cloudApiFormat}`, "info");
        await ctx.reload();
        return;
      }

      if (choice === "Context Window — Override") {
        // Override the context-window shown on a model's card (e.g. when the
        // inferred size is wrong for a brand-new model). Pick a model id, or
        // "*" to set a default for every model without its own override.
        const ov = cfg.contextWindowOverrides || {};
        const fmt = (n: number) => n.toLocaleString();
        const ids = Array.from(new Set([...planDefs.map((m) => m.id), ...cloudDefs.map((m) => m.id)])).sort();
        const labelToId = new Map<string, string>();
        const opts: string[] = [];
        for (const id of ids) {
          const label = ov[id] ? `${id}  (override: ${fmt(ov[id])})` : id;
          labelToId.set(label, id);
          opts.push(label);
        }
        const allLabel = ov["*"] ? `* every other model  (override: ${fmt(ov["*"])})` : "* every other model";
        labelToId.set(allLabel, "*");
        opts.push(allLabel);
        const CLEAR = "Clear all overrides";
        opts.push(CLEAR);

        const sel = await ctx.ui.select("Override context window for:", opts);
        if (!sel) return;
        if (sel === CLEAR) {
          delete cfg.contextWindowOverrides;
          saveConfig(cfg);
          ctx.ui.notify("Cleared all context-window overrides.", "info");
          await ctx.reload();
          return;
        }
        const id = labelToId.get(sel) ?? sel;
        const current = ov[id];
        const val = (await ctx.ui.input(
          `Context window for ${id} in tokens — e.g. 1048576 (0 to remove)${current ? `; currently ${fmt(current)}` : ""}:`,
        ))?.trim();
        if (!val) return; // cancelled / left blank → no change
        const n = Number(val.replace(/[_,\s]/g, ""));
        if (!Number.isFinite(n) || n < 0) {
          ctx.ui.notify("Enter a non-negative number of tokens (0 removes the override).", "error");
          return;
        }
        cfg.contextWindowOverrides = cfg.contextWindowOverrides || {};
        if (n === 0) {
          delete cfg.contextWindowOverrides[id];
          ctx.ui.notify(`Removed context-window override for ${id}.`, "info");
        } else {
          cfg.contextWindowOverrides[id] = Math.floor(n);
          ctx.ui.notify(`Context window for ${id} set to ${fmt(Math.floor(n))} tokens.`, "info");
        }
        if (Object.keys(cfg.contextWindowOverrides).length === 0) delete cfg.contextWindowOverrides;
        saveConfig(cfg);
        await ctx.reload();
        return;
      }

      if (choice === "Reset all") {
        if (!await ctx.ui.confirm(
          "Reset all Alibaba settings?",
          "Wipes config, both auth entries, model caches, and any alibaba-* entries in settings.json (enabledModels + defaultProvider/defaultModel if alibaba). Run before `pi remove` for a clean uninstall.",
        )) return;
        for (const p of [CONFIG_PATH, PLAN_CACHE_PATH, CLOUD_CACHE_PATH, MODELS_DEV_CACHE_PATH]) { try { fs.unlinkSync(p); } catch {} }
        // Use authStorage.remove() so pi's in-memory credential cache stays in sync —
        // otherwise /login's "• configured" label persists until pi is restarted.
        for (const k of ["alibaba", "alibaba-plan", "alibaba-cloud", "alibaba-studio", "alibaba-token", "dashscope"]) {
          ctx.modelRegistry.authStorage.remove(k);
        }
        // Also strip stale alibaba-* / dashscope-* model ids from settings.json enabledModels,
        // and clear defaultProvider/defaultModel if they reference alibaba (otherwise pi would
        // try to default-launch into a now-missing provider).
        try {
          const SETTINGS_PATH = path.join(HOME_DIR, "settings.json");
          const s = readJSON<Record<string, any>>(SETTINGS_PATH, {});
          let touched = false;
          if (Array.isArray(s.enabledModels)) {
            const before = s.enabledModels.length;
            s.enabledModels = s.enabledModels.filter((id: string) =>
              typeof id === "string" && !/^(alibaba(-plan|-cloud|-studio|-token)?|dashscope)\//.test(id),
            );
            if (s.enabledModels.length !== before) touched = true;
          }
          if (typeof s.defaultProvider === "string" && /^(alibaba(-plan|-cloud|-studio|-token)?|dashscope)$/.test(s.defaultProvider)) {
            delete s.defaultProvider;
            delete s.defaultModel;
            touched = true;
          }
          if (touched) writeJSON(SETTINGS_PATH, s);
        } catch {}
        ctx.ui.notify("All Alibaba settings wiped. Now safe to `pi remove`.", "info");
        await ctx.reload();
        return;
      }
    },
  });
}
