import type {
	ExtensionAPI,
	ProviderModelConfig,
	ExtensionCommandContext,
} from "@earendil-works/pi-coding-agent";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

// oh-my-pi adds fetchDynamicModels to ProviderConfig; pi does not.
type OmpProviderConfig = Parameters<ExtensionAPI["registerProvider"]>[1] & {
	fetchDynamicModels?: (
		apiKey: string | undefined,
	) => Promise<readonly ProviderModelConfig[]>;
};

// ── Paths / runtime ───────────────────────────────────────────────────
// pi uses ~/.pi/agent + auth.json; oh-my-pi uses ~/.omp/agent + agent.db.
// PI_CODING_AGENT_DIR overrides both. Detect oh-my-pi via ExtensionAPI shape.
let agentDir = path.join(os.homedir(), ".pi", "agent");
let isOmpRuntime = false;

const isOhMyPi = (pi: ExtensionAPI): boolean => "pi" in pi && "logger" in pi;

const configureAgentDir = (pi: ExtensionAPI) => {
	isOmpRuntime = isOhMyPi(pi);
	agentDir =
		process.env.PI_CODING_AGENT_DIR ??
		path.join(os.homedir(), isOmpRuntime ? ".omp" : ".pi", "agent");
};

const getConfigPath = () => path.join(agentDir, "alibaba-config.json");
const getAuthPath = () => path.join(agentDir, "auth.json");
const getPlanCachePath = () => path.join(agentDir, "alibaba-plan-models.cache.json");
const getSettingsPath = () => path.join(agentDir, "settings.json");

const CLOUD_RICH_FETCH_TIMEOUT_MS = 45_000;
const CLOUD_COMPAT_FETCH_TIMEOUT_MS = 30_000;

const DEFAULT_PLAN_OPENAI =
	"https://token-plan.ap-southeast-1.maas.aliyuncs.com/compatible-mode/v1";
const DEFAULT_PLAN_ANTHROPIC =
	"https://token-plan.ap-southeast-1.maas.aliyuncs.com/apps/anthropic";
const ALIBABA_CLOUD_MODEL_STUDIO_INTL_URL = "dashscope-intl.aliyuncs.com";
const ALIBABA_CLOUD_MODEL_STUDIO_CN_URL = "dashscope.aliyuncs.com";
const ALIBABA_CLOUD_MODEL_STUDIO_GLOBAL_URL = "dashscope-us.aliyuncs.com";

const MODELS_DEV_API_URL = "https://models.dev/api.json";
const getModelsDevCachePath = () =>
	path.join(agentDir, "alibaba-models-dev.cache.json");
const MODELS_DEV_CACHE_TTL_MS = 24 * 60 * 60 * 1000; // 24 hours

type CloudProviderId = "alibaba" | "alibaba-cn" | "alibaba-global";

interface CloudProviderDef {
	id: CloudProviderId;
	name: string;
	domain: string;
	apiKeyEnv: string;
	modelsUrl?: string;
	cachePath: string;
}

const getCloudProviders = (): readonly CloudProviderDef[] => {
	const home = agentDir;
	return [
		{
			id: "alibaba",
			name: "Alibaba Cloud International (API Key)",
			domain: ALIBABA_CLOUD_MODEL_STUDIO_INTL_URL,
			apiKeyEnv: "DASHSCOPE_API_KEY",
			modelsUrl: "https://dashscope-intl.aliyuncs.com/api/v1/models",
			cachePath: path.join(home, "alibaba-cloud-models.cache.json"),
		},
		{
			id: "alibaba-cn",
			name: "Alibaba Cloud China (API Key)",
			domain: ALIBABA_CLOUD_MODEL_STUDIO_CN_URL,
			apiKeyEnv: "DASHSCOPE_CN_API_KEY",
			modelsUrl: "https://dashscope.aliyuncs.com/api/v1/models",
			cachePath: path.join(home, "alibaba-cn-models.cache.json"),
		},
		{
			id: "alibaba-global",
			name: "Alibaba Cloud Global (API Key)",
			domain: ALIBABA_CLOUD_MODEL_STUDIO_GLOBAL_URL,
			apiKeyEnv: "DASHSCOPE_GLOBAL_API_KEY",
			modelsUrl: "https://dashscope-us.aliyuncs.com/api/v1/models",
			cachePath: path.join(home, "alibaba-global-models.cache.json"),
		},
	];
};

const CLOUD_PROVIDER_IDS = ["alibaba", "alibaba-cn", "alibaba-global"] as const;

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

type AuthEntry = {
	type?: "api_key" | "oauth" | string;
	key?: string;
	access?: string;
	refresh?: string;
	expires?: number;
};

type CredentialResolver = {
	get?: (provider: string) => AuthEntry | undefined;
	peekApiKey?: (provider: string) => Promise<string | undefined>;
};

// pi resolves "$ENV_VAR"; oh-my-pi expects bare "ENV_VAR" (see ProviderConfig docs).
const formatProviderApiKeyConfig = (envName: string, omp: boolean): string =>
	omp ? envName : `$${envName}`;

const DASHSCOPE_CONSOLE_URL: Record<CloudProviderId, string> = {
	alibaba: "https://dashscope.console.aliyun.com/apiKey",
	"alibaba-cn": "https://dashscope.console.aliyun.com/apiKey",
	"alibaba-global":
		"https://modelstudio.console.aliyun.com/us-east-1/?tab=globalkey#/api-key",
};


const credentialResolver = (authStorage?: {
	get: (provider: string) => AuthEntry | undefined;
	peekApiKey?: (provider: string) => Promise<string | undefined>;
}): CredentialResolver => ({
	get: authStorage ? (provider) => authStorage.get(provider) : undefined,
	peekApiKey: authStorage?.peekApiKey?.bind(authStorage),
});
const getPlanCreds = (
	resolver?: CredentialResolver,
): { access?: string; refresh?: string } | undefined => {
	if (resolver?.get) {
		const cred = resolver.get("alibaba-plan");
		if (!cred) return undefined;
		if (cred.key) return { access: cred.key, refresh: cred.refresh };
		if (cred.access) return { access: cred.access, refresh: cred.refresh };
		return undefined;
	}
	try {
		return readAuth()["alibaba-plan"];
	} catch {
		return undefined;
	}
};

const readJSON = <T>(p: string, fallback: T): T => {
	try {
		return JSON.parse(fs.readFileSync(p, "utf8")) as T;
	} catch {
		return fallback;
	}
};

function expandExponentialNumber(raw: string): string {
	const [coefficient, exponentText] = raw.toLowerCase().split("e");
	const exponent = Number(exponentText);
	if (!Number.isInteger(exponent)) return raw;
	const negative = coefficient.startsWith("-");
	const unsigned = negative ? coefficient.slice(1) : coefficient;
	const [whole, fraction = ""] = unsigned.split(".");
	const digits = `${whole}${fraction}`;
	const decimalIndex = whole.length + exponent;
	let expanded: string;
	if (decimalIndex <= 0) {
		expanded = `0.${"0".repeat(-decimalIndex)}${digits}`;
	} else if (decimalIndex >= digits.length) {
		expanded = `${digits}${"0".repeat(decimalIndex - digits.length)}`;
	} else {
		expanded = `${digits.slice(0, decimalIndex)}.${digits.slice(decimalIndex)}`;
	}
	expanded = expanded.replace(/(\.\d*?)0+$/, "$1").replace(/\.$/, "");
	return `${negative ? "-" : ""}${expanded}`;
}

function stringifyJSON(data: unknown): string {
	return JSON.stringify(data, null, 2).replace(
		/-?\d+(?:\.\d+)?e[+-]?\d+/gi,
		expandExponentialNumber,
	);
}
const writeJSON = (p: string, data: unknown) => {
	fs.mkdirSync(path.dirname(p), { recursive: true });
	fs.writeFileSync(p, stringifyJSON(data), { mode: 0o600 });
};
const loadConfig = (): AlibabaConfig =>
	readJSON<AlibabaConfig>(getConfigPath(), {});
const saveConfig = (c: AlibabaConfig) => writeJSON(getConfigPath(), c);
const readAuth = (): Record<string, AuthEntry | undefined> =>
	readJSON<Record<string, AuthEntry | undefined>>(getAuthPath(), {});
const writeAuth = (a: Record<string, AuthEntry | undefined>) => writeJSON(getAuthPath(), a);

// ── Plan model definitions ────────────────────────────────────────────
// Anthropic-compatible by default; deepseek forced to openai-completions.
interface PlanModelDef {
	id: string;
	name: string;
	reasoning: boolean;
	contextWindow: number;
	maxTokens: number;
	input: ("text" | "image")[];
	compat?: { thinkingFormat: "qwen" };
	openaiOnly?: boolean;
	cost?: {
		input: number;
		output: number;
		cacheRead: number;
		cacheWrite: number;
	};
}

// ── Plan model fetch + parse + cache ──────────────────────────────────
interface PlanCache {
	fetchedAt: number;
	source: string;
	models: PlanModelDef[];
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
	if (!alibabaProvider?.models) return models;

	for (const [modelId, modelData] of Object.entries(
		alibabaProvider.models,
	) as [string, any][]) {
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
	if (modelsDevCache && Date.now() - modelsDevCache.fetchedAt < MODELS_DEV_CACHE_TTL_MS) {
		return modelsDevCache.models;
	}

	const diskCache = readJSON<{
		fetchedAt: number;
		models: Array<[string, ModelsDevEntry]>;
	} | null>(getModelsDevCachePath(), null);
	if (diskCache && Date.now() - diskCache.fetchedAt < MODELS_DEV_CACHE_TTL_MS) {
		modelsDevCache = {
			fetchedAt: diskCache.fetchedAt,
			models: new Map(diskCache.models),
		};
		return modelsDevCache.models;
	}

	try {
		const ctrl = new AbortController();
		const t = setTimeout(() => ctrl.abort(), 5000);
		const res = await fetch(MODELS_DEV_API_URL, { signal: ctrl.signal });
		clearTimeout(t);

		if (!res.ok) throw new Error(`HTTP ${res.status}`);
		const json = await res.json();
		const models = parseModelsDevJSON(json);
		if (models.size === 0) {
			throw new Error("No models found in models.dev response");
		}

		modelsDevCache = { fetchedAt: Date.now(), models };
		writeJSON(getModelsDevCachePath(), {
			fetchedAt: modelsDevCache.fetchedAt,
			models: Array.from(models.entries()),
		});
		return models;
	} catch (e: unknown) {
		const message = e instanceof Error ? e.message : String(e);
		console.warn(
			`[alibaba] Failed to fetch models.dev registry (${message}); skipping enrichment.`,
		);
		return new Map();
	}
}

// ── Capability heuristics (shared by Plan + Cloud) ───────────────────
// Filter out dated model variants (e.g., qwen3.7-max-20250125)
const isDateSuffixed = (id: string): boolean =>
	/-\d{8}$/.test(id) || /-\d{4}-\d{2}-\d{2}$/.test(id);

// The /models API only returns ids/names, not capabilities — so context
// window, reasoning, and vision are inferred from the id. Both the Plan
// and Cloud code paths route through these helpers so they never drift
// apart. Context windows reflect Alibaba's published specs as of June 2026
// and are corrected here as new models ship.
const isVisionModel = (id: string): boolean =>
	/vl|vision/i.test(id) || /^qwen3\.\d+-plus\b/i.test(id) || /kimi/i.test(id);

const isReasoningModel = (id: string): boolean =>
	/qwq|max|thinking|deepseek|minimax|kimi|glm|3\.[5-9]/i.test(id);

const inferContextWindow = (
	id: string,
	overrides?: Record<string, number>,
): number => {
	// User overrides win: exact id first, then the "*" catch-all.
	const o = overrides?.[id] ?? overrides?.["*"];
	if (typeof o === "number" && o > 0) return o;
	if (/flash/i.test(id)) return 131072;
	if (/kimi/i.test(id)) return 262144;
	if (/^qwen3\.6-max\b/i.test(id)) return 262144; // 3.6 Max = 256K
	// 3.6 Plus and every 3.7+ Plus/Max ship a 1M context window.
	if (
		/^qwen3\.6-plus\b/i.test(id) ||
		/^qwen3\.([7-9]|\d{2,})-(plus|max)\b/i.test(id)
	)
		return 1048576;
	return 131072;
};

// Heuristic: turn a bare model id (from /v1/models API) into a full PlanModelDef.
function inferPlanDef(
	id: string,
	overrides?: Record<string, number>,
	devEntry?: ModelsDevEntry,
): PlanModelDef {
	const openaiOnly = /deepseek/i.test(id);
	const isVision = devEntry?.attachment === true || isVisionModel(id);
	const isReasoning = devEntry ? devEntry.reasoning : isReasoningModel(id);
	const contextWindow = devEntry
		? devEntry.contextWindow
		: inferContextWindow(id, overrides);
	const maxTokens = devEntry
		? devEntry.maxOutput
		: openaiOnly
			? 16384
			: 65536;
	const cost = devEntry
		? {
				input: devEntry.inputPrice,
				output: devEntry.outputPrice,
				cacheRead: 0,
				cacheWrite: 0,
			}
		: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };

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
async function fetchPlanModelsFromAPI(credentials?: {
	access?: string;
	refresh?: string;
}): Promise<PlanModelDef[]> {
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
		const exclude =
			/(image|audio|video|tts|asr|embed|vector|rerank|wan|omni|livetranslate|realtime)/i;
		const overrides = loadConfig().contextWindowOverrides;

		const registry = await fetchModelsDevRegistry();
		const filteredModels = json.data
			.filter((m) => !exclude.test(m.id))
			.filter((m) => !isDateSuffixed(m.id)) // Always filter date-suffixed variants
			.filter((m) => registry.size === 0 || registry.has(m.id));

		return filteredModels.map((m) =>
			inferPlanDef(m.id, overrides, registry.get(m.id)),
		);
	} finally {
		clearTimeout(t);
	}
}

function prettyName(id: string): string {
	// qwen3.6-plus → "Qwen 3.6 Plus", glm-5 → "GLM-5", MiniMax-M2.5 → "MiniMax M2.5"
	if (/^qwen/i.test(id)) {
		return id
			.replace(/^qwen/i, "Qwen ")
			.replace(/-/g, " ")
			.replace(/\b([a-z])/g, (s) => s.toUpperCase());
	}
	if (/^glm/i.test(id)) return id.toUpperCase();
	if (/^kimi/i.test(id)) return id.replace(/^kimi/i, "Kimi").replace(/-/g, " ");
	if (/^minimax/i.test(id)) return id.replace(/-/g, " ");
	if (/^deepseek/i.test(id))
		return id.replace(/^deepseek/i, "DeepSeek").replace(/-/g, " ");
	return id;
}

async function fetchPlanModels(
	_force = false,
	credentials?: { access?: string; refresh?: string },
): Promise<PlanModelDef[]> {
	if (!credentials?.access) return [];
	const apiModels = await fetchPlanModelsFromAPI(credentials);
	if (!apiModels.length)
		throw new Error("Plan model fetch returned no chat models");
	const ep = resolvePlanEndpoints(credentials);
	const cache: PlanCache = {
		fetchedAt: Date.now(),
		source: `${ep.openai}/models`,
		models: apiModels,
	};
	writeJSON(getPlanCachePath(), cache);
	return apiModels;
}

// ── Plan endpoint resolution ──────────────────────────────────────────
function resolvePlanEndpoints(credentials?: {
	access?: string;
	refresh?: string;
}): { openai: string; anthropic: string } {
	if (credentials?.refresh) {
		try {
			const parsed = JSON.parse(credentials.refresh);
			if (parsed.openai && parsed.anthropic)
				return { openai: parsed.openai, anthropic: parsed.anthropic };
		} catch {
			// credentials.refresh is not valid JSON; fall back to config defaults
		}
	}
	const cfg = loadConfig();
	return {
		openai: cfg.planOpenAI || DEFAULT_PLAN_OPENAI,
		anthropic: cfg.planAnthropic || DEFAULT_PLAN_ANTHROPIC,
	};
}

function buildPlanModels(
	defs: PlanModelDef[],
	openaiUrl: string,
	anthropicUrl: string,
): ProviderModelConfig[] {
	return defs.map((m) => {
		const useOpenAI = !!m.openaiOnly || /deepseek/i.test(m.id);
		return {
			id: m.id,
			name: m.name,
			reasoning: m.reasoning,
			input: m.input,
			contextWindow: m.contextWindow,
			maxTokens: m.maxTokens,
			compat: m.compat,
			thinkingLevelMap: m.reasoning ? { off: null } : undefined,
			cost: m.cost ?? { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			baseUrl: useOpenAI ? openaiUrl : anthropicUrl,
			api: (useOpenAI ? "openai-completions" : "anthropic-messages") as
				| "anthropic-messages"
				| "openai-completions",
		};
	});
}

// ── Cloud builders ────────────────────────────────────────────────────
interface CloudCache {
	fetchedAt: number;
	domain: string;
	models: ProviderModelConfig[];
}

interface CloudModelRow {
	id: string;
	name?: string;
	requestModalities?: string[];
	responseModalities?: string[];
	capabilities?: string[];
	contextWindow?: number;
	maxTokens?: number;
	cost?: ModelCost;
}

type ModelCost = ProviderModelConfig["cost"];

interface RichPrice {
	type?: string;
	price?: string;
}

interface RichPriceRange {
	range_name?: string;
	prices?: RichPrice[];
}

interface CompatibleModelsResponse {
	data?: { id: string; name?: string }[];
}

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

const ZERO_COST: ModelCost = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
const COST_DECIMAL_PLACES = 12;

function normalizeCost(value: number | undefined): number {
	return value === undefined ? 0 : Number(value.toFixed(COST_DECIMAL_PLACES));
}

function pricePerToken(price: string | undefined): number | undefined {
	if (!price) return undefined;
	const n = Number(price);
	return Number.isFinite(n) && n >= 0
		? normalizeCost(n / 1_000_000)
		: undefined;
}

function priceByType(
	prices: RichPrice[],
	predicate: (type: string) => boolean,
): number | undefined {
	const found = prices.find((price) => price.type && predicate(price.type));
	return pricePerToken(found?.price);
}

function richPricesToCost(ranges: RichPriceRange[] | undefined): ModelCost | undefined {
	if (!ranges?.length) return undefined;
	const range =
		ranges.find((candidate) => /default/i.test(candidate.range_name || "")) ??
		ranges[0];
	const prices = range.prices ?? [];
	const input = priceByType(prices, (type) => type === "input_token");
	const output = priceByType(prices, (type) => type === "output_token");
	const cacheRead =
		priceByType(prices, (type) => type === "input_token_cache_read") ??
		priceByType(prices, (type) => type === "input_token_cache");
	const cacheWrite = priceByType(prices, (type) =>
		type.startsWith("input_token_cache_creation"),
	);
	if (
		input === undefined &&
		output === undefined &&
		cacheRead === undefined &&
		cacheWrite === undefined
	)
		return undefined;
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
	return json.data.map((m) => ({ id: m.id, name: m.name }));
}

async function fetchRichCloudModelRows(
	provider: CloudProviderDef,
	apiKey: string,
	signal: AbortSignal,
): Promise<CloudModelRow[]> {
	if (!provider.modelsUrl) return [];
	const rows: CloudModelRow[] = [];
	let pageNo = 1;
	let total = Number.POSITIVE_INFINITY;
	while (rows.length < total) {
		let url: URL;
		try {
			url = new URL(provider.modelsUrl);
		} catch (err) {
			throw new Error(`Invalid modelsUrl for ${provider.id}: ${(err as Error).message}`);
		}
		url.searchParams.set("page_no", String(pageNo));
		const res = await fetch(url, {
			headers: { Authorization: `Bearer ${apiKey}` },
			signal,
		});
		if (!res.ok) throw new Error(`HTTP ${res.status}`);
		const json = (await res.json()) as RichModelsResponse;
		if (json.success === false)
			throw new Error(json.message || "Rich model fetch failed");
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
		total = output?.total ?? rows.length;
		const pageSize = output?.page_size ?? models.length;
		if (models.length < pageSize) break;
		pageNo = (output?.page_no ?? pageNo) + 1;
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

async function fetchCloudModelRows(
	provider: CloudProviderDef,
	apiKey: string,
): Promise<CloudModelRow[]> {
	if (provider.modelsUrl) {
		try {
			return await fetchWithTimeout(
				(signal) => fetchRichCloudModelRows(provider, apiKey, signal),
				CLOUD_RICH_FETCH_TIMEOUT_MS,
			);
		} catch (e: unknown) {
			const message = e instanceof Error ? e.message : String(e);
			console.warn(
				`[alibaba] ${provider.name} rich catalog failed (${message}); trying compatible-mode /v1/models.`,
			);
		}
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
	// Filter out non-LLMs (image, audio, video, embedding, etc.) — we only want chat models.
	const exclude =
		/(image|audio|video|tts|asr|embed|vector|rerank|wan|omni|livetranslate|realtime)/i;
	const overrides = loadConfig().contextWindowOverrides;
	const registry = await fetchModelsDevRegistry();

	const models = rows
		.filter((m) => !exclude.test(m.id))
		.filter((m) => !isDateSuffixed(m.id)) // Always filter date-suffixed variants
		.filter((m) => registry.size === 0 || registry.has(m.id))
		.filter((m) => {
			if (!m.responseModalities?.length) return true;
			return m.responseModalities.some((modality) => /text/i.test(modality));
		})
		.map((m) => {
			const devEntry = registry.get(m.id);
			const isVision =
				devEntry?.attachment === true ||
				isVisionModel(m.id) ||
				m.requestModalities?.some((modality) => /image|video/i.test(modality)) ===
					true;
			const isReasoning = devEntry
				? devEntry.reasoning
				: isReasoningModel(m.id) ||
					m.capabilities?.some((capability) => /reasoning/i.test(capability)) ===
						true;
			const contextWindow =
				m.contextWindow && m.contextWindow > 0
					? m.contextWindow
					: devEntry
						? devEntry.contextWindow
						: inferContextWindow(m.id, overrides);
			const maxTokens =
				m.maxTokens && m.maxTokens > 0
					? m.maxTokens
					: devEntry
						? devEntry.maxOutput
						: 8192;
			const cost = devEntry
				? {
						input: devEntry.inputPrice,
						output: devEntry.outputPrice,
						cacheRead: 0,
						cacheWrite: 0,
					}
				: m.cost ?? ZERO_COST;
			return {
				id: m.id,
				name: m.name || m.id,
				reasoning: isReasoning,
				input: isVision
					? (["text", "image"] as ("text" | "image")[])
					: (["text"] as ("text" | "image")[]),
				cost,
				contextWindow,
				maxTokens,
				compat: isReasoning ? { thinkingFormat: "qwen" as const } : undefined,
			};
		});
	const cache: CloudCache = {
		fetchedAt: Date.now(),
		domain: provider.domain,
		models,
	};
	writeJSON(provider.cachePath, cache);
	return models;
}

function buildCloudModels(
	models: ProviderModelConfig[],
	provider: CloudProviderDef,
	fmt: string,
): ProviderModelConfig[] {
	return models.map((m) => {
		const useOpenAI = /deepseek/i.test(m.id) || fmt === "openai-completions";
		return {
			...m,
			thinkingLevelMap: m.reasoning ? { off: null } : undefined,
			baseUrl: useOpenAI
				? `https://${provider.domain}/compatible-mode/v1`
				: `https://${provider.domain}/apps/anthropic`,
			api: (useOpenAI ? "openai-completions" : "anthropic-messages") as
				| "anthropic-messages"
				| "openai-completions",
		};
	});
}

const createCloudOAuth = (provider: CloudProviderDef, omp: boolean) => ({
	name: provider.name,
	async login(callbacks: {
		onAuth?: (info: { url: string; instructions?: string }) => void;
		onPrompt: (prompt: { message: string; placeholder?: string }) => Promise<string>;
	}) {
		callbacks.onAuth?.({
			url: DASHSCOPE_CONSOLE_URL[provider.id],
			instructions: `Create or copy a DashScope API key for ${provider.name}.`,
		});
		const key = (
			await callbacks.onPrompt({
				message: `DashScope API key for ${provider.name} (sk-…). Not a Coding Plan token (sk-sp-… / sk-tok-…).`,
				placeholder: "sk-...",
			})
		).trim();
		if (!key) throw new Error("API key required");
		if (isPlanKey(key)) {
			throw new Error(
				"This looks like a Coding Plan token. Run /login → Alibaba Model Studio Coding Plan instead.",
			);
		}
		if (omp) return key;
		return {
			access: key,
			refresh: key,
			expires: Date.now() + 365 * 86400_000,
		};
	},
	...(omp
		? {}
		: {
				async refreshToken(c: {
					access: string;
					refresh?: string;
					expires?: number;
				}) {
					return {
						...c,
						refresh: c.refresh ?? c.access,
						expires: c.expires ?? Date.now() + 365 * 86400_000,
					};
				},
				getApiKey(c: { access: string }) {
					return c.access;
				},
			}),
});

const fetchCloudCatalogFromCache = (
	provider: CloudProviderDef,
	apiKey: string | undefined,
	fmt: string,
): ProviderModelConfig[] => {
	if (!apiKey) return CLOUD_LOGIN_SEED;
	const cached = loadCloudDefsFromCache(provider);
	if (cached.length) {
		return buildCloudModels(cached, provider, fmt);
	}
	return CLOUD_LOGIN_SEED;
};

function registerCloudProviders(
	pi: ExtensionAPI,
	defsByProvider: Record<CloudProviderId, ProviderModelConfig[]>,
	fmt: string,
) {
	const omp = isOhMyPi(pi);
	for (const provider of getCloudProviders()) {
		const base = {
			name: provider.name,
			baseUrl: `https://${provider.domain}/apps/anthropic`,
			apiKey: formatProviderApiKeyConfig(provider.apiKeyEnv, omp),
			api: "anthropic-messages" as const,
			authHeader: true,
		};
		if (omp) {
			pi.registerProvider(provider.id, {
				...base,
				oauth: createCloudOAuth(provider, omp),
				fetchDynamicModels: async (apiKey: string | undefined) =>
					fetchCloudCatalogFromCache(provider, apiKey, fmt),
			} as unknown as OmpProviderConfig);
		} else {
			pi.registerProvider(provider.id, {
				...base,
				models: buildCloudModels(defsByProvider[provider.id], provider, fmt),
			});
		}
	}
}

// ── Cloud credential resolution ──────────────────────────────────────
// Each Cloud provider can authenticate either from a key saved via /login
// (auth.json) OR from its matching DASHSCOPE_* env var. Either one lets us
// fetch the real catalog — so we always prefer the live list and only fall
// back to the login seed below when there is no credential at all.
async function resolveCloudKey(
	provider: CloudProviderDef,
	resolver?: CredentialResolver,
): Promise<string | null> {
	if (resolver?.peekApiKey) {
		try {
			const key = await resolver.peekApiKey(provider.id);
			if (key && key !== "N/A") return key;
		} catch {
			// peekApiKey failed; continue to fallback resolution methods
		}
	}
	if (resolver?.get) {
		const cred = resolver.get?.(provider.id);
		const k = cred?.key || cred?.access;
		if (k) return k;
	}
	if (!resolver) {
		try {
			const c = readAuth()[provider.id];
			const k = c?.key || c?.access;
			if (k) return k;
		} catch {
			// readAuth() failed or provider not in auth store; continue to env var fallback
		}
	}
	return process.env[provider.apiKeyEnv] || null;
}

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
const CLOUD_LOGIN_SEED: ProviderModelConfig[] = [
	{
		id: "qwen-plus",
		name: "Qwen Plus",
		reasoning: false,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 131072,
		maxTokens: 8192,
	},
];

// ── Offline-resilient catalog loaders ────────────────────────────────
// Live API is the source of truth. But a network failure must never take
// the whole extension (and therefore pi, and the user's local models) down
// with it. So: try live, fall back to the last-known-good on-disk cache,
// warn, and never throw. Cache is an offline fallback only — when the API
// is reachable, its response always wins and overwrites the cache.
const cacheAgeMin = (fetchedAt: number) =>
	Math.round((Date.now() - fetchedAt) / 60000);

function loadPlanDefsFromCache(): PlanModelDef[] {
	const cache = readJSON<PlanCache | null>(getPlanCachePath(), null);
	return cache?.models ?? [];
}

function loadCloudDefsFromCache(provider: CloudProviderDef): ProviderModelConfig[] {
	const cache = readJSON<CloudCache | null>(provider.cachePath, null);
	if (cache?.models?.length && cache.domain === provider.domain) {
		return cache.models;
	}
	return [];
}

function hasCloudCredentialSync(provider: CloudProviderDef): boolean {
	try {
		const c = readAuth()[provider.id];
		if (c?.key || c?.access) return true;
	} catch {
		// readAuth() failed; fall through to env var check
	}
	return Boolean(process.env[provider.apiKeyEnv]);
}

function seedCloudDefsFromCache() {
	for (const provider of getCloudProviders()) {
		const key = hasCloudCredentialSync(provider);
		const cached = loadCloudDefsFromCache(provider);
		cloudDefsByProvider[provider.id] = key
			? ensureCloudLoginSeed(cached)
			: CLOUD_LOGIN_SEED;
	}
}

async function loadPlanDefs(
	force: boolean,
	credentials?: { access?: string; refresh?: string },
): Promise<PlanModelDef[]> {
	if (!credentials?.access) return [];
	try {
		return await fetchPlanModels(force, credentials);
	} catch (e: unknown) {
		const cache = readJSON<PlanCache | null>(getPlanCachePath(), null);
		const message = e instanceof Error ? e.message : String(e);
		if (cache?.models?.length) {
			console.warn(
				`[alibaba] Plan catalog fetch failed (${message}); using cached models (${cache.models.length}, ${cacheAgeMin(cache.fetchedAt)}m old).`,
			);
			return cache.models;
		}
		console.warn(
			`[alibaba] Plan catalog fetch failed (${message}); no cache — Plan models unavailable until reconnected. Other providers still work.`,
		);
		return [];
	}
}

async function loadCloudDefs(
	provider: CloudProviderDef,
	apiKey: string,
	force: boolean,
): Promise<ProviderModelConfig[]> {
	try {
		return await fetchCloudModels(provider, apiKey, force);
	} catch (e: unknown) {
		const cache = readJSON<CloudCache | null>(provider.cachePath, null);
		const message = e instanceof Error ? e.message : String(e);
		if (cache?.models?.length && cache.domain === provider.domain) {
			console.warn(
				`[alibaba] ${provider.name} catalog fetch failed (${message}); using cached models (${cache.models.length}, ${cacheAgeMin(cache.fetchedAt)}m old).`,
			);
			return cache.models;
		}
		console.warn(
			`[alibaba] ${provider.name} catalog fetch failed (${message}); no cache — Cloud models unavailable until reconnected. Other providers still work.`,
		);
		return [];
	}
}

function createEmptyCloudDefs(): Record<CloudProviderId, ProviderModelConfig[]> {
	return {
		alibaba: [],
		"alibaba-cn": [],
		"alibaba-global": [],
	};
}

function ensureCloudLoginSeed(models: ProviderModelConfig[]) {
	return models.length ? models : CLOUD_LOGIN_SEED;
}

async function refreshCloudProvider(
	provider: CloudProviderDef,
	force: boolean,
	resolver?: CredentialResolver,
) {
	const key = await resolveCloudKey(provider, resolver);
	if (!key) {
		cloudDefsByProvider[provider.id] = CLOUD_LOGIN_SEED;
		return { provider, keyPresent: false, count: 0 };
	}
	const models = await loadCloudDefs(provider, key, force);
	cloudDefsByProvider[provider.id] = ensureCloudLoginSeed(models);
	return { provider, keyPresent: true, count: models.length };
}

async function refreshCloudProviders(
	force: boolean,
	resolver?: CredentialResolver,
) {
	return Promise.all(
		getCloudProviders().map((provider) =>
			refreshCloudProvider(provider, force, resolver),
		),
	);
}

function allCloudModelIds() {
	return getCloudProviders().flatMap((provider) =>
		cloudDefsByProvider[provider.id].map((m) => m.id),
	);
}

// ── Module-level mutable model lists ─────────────────────────────────
// Populated by the async extension factory before provider registration.
let planDefs: PlanModelDef[] = [];
const cloudDefsByProvider = createEmptyCloudDefs();

// ── Migration ─────────────────────────────────────────────────────────
const isPlanKey = (k: string) =>
	k.startsWith("sk-sp-") || k.startsWith("sk-tok-");

function extractKey(entry: AuthEntry | undefined): string | undefined {
	return entry?.key || entry?.access || undefined;
}

function setPlanAuth(auth: Record<string, AuthEntry | undefined>, key: string) {
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

		// 1) Legacy single-key "alibaba" now maps to the International Cloud
		// provider unless it contains a Plan token.
		const old = auth["alibaba"];
		if (old) {
			const key = extractKey(old);
			for (const legacyKey of ["alibaba-studio", "alibaba-token", "dashscope"]) {
				if (legacyKey in auth) {
					delete auth[legacyKey];
					dirty = true;
				}
			}
			if (!key) {
				delete auth["alibaba"];
				dirty = true;
			} else if (isPlanKey(key)) {
				setPlanAuth(auth, key);
				delete auth["alibaba"];
				dirty = true;
			} else if (old.type !== "api_key" || old.key !== key) {
				auth["alibaba"] = { type: "api_key", key };
				dirty = true;
			}
		}

		// 2) Previous versions used "alibaba-cloud" for the International Cloud
		// provider. Move that credential into the new "alibaba" provider id.
		const legacyCloud = auth["alibaba-cloud"];
		if (legacyCloud) {
			const key = extractKey(legacyCloud);
			if (key) {
				if (isPlanKey(key)) {
					setPlanAuth(auth, key);
				} else if (!auth["alibaba"]) {
					auth["alibaba"] = { type: "api_key", key };
				}
			}
			delete auth["alibaba-cloud"];
			dirty = true;
		}

		// 3) Ensure all Cloud providers use api_key shape, and move any misrouted
		// Plan token out of a Cloud provider slot.
		for (const provider of getCloudProviders()) {
			const cloud = auth[provider.id];
			const key = extractKey(cloud);
			if (!cloud) continue;
			if (!key) {
				delete auth[provider.id];
				dirty = true;
				continue;
			}
			if (isPlanKey(key)) {
				setPlanAuth(auth, key);
				delete auth[provider.id];
				dirty = true;
				continue;
			}
			if (cloud.type !== "api_key" || cloud.key !== key) {
				auth[provider.id] = { type: "api_key", key };
				dirty = true;
			}
		}

		if (dirty) writeAuth(auth);
	} catch {
		// Migration is best-effort; if auth file is corrupt or unreadable,
		// we don't want to block extension startup
	}
}


const createPlanOAuth = () => ({
	name: "Alibaba Model Studio Coding Plan",
	async login(callbacks: {
		onPrompt: (prompt: { message: string; placeholder?: string }) => Promise<string>;
	}) {
		const key = (
			await callbacks.onPrompt({
				message:
					"Coding Plan token (sk-sp-… or sk-tok-…). Run /alibaba afterwards if you need a non-Singapore region:",
				placeholder: "sk-sp-...",
			})
		).trim();
		if (!isPlanKey(key)) {
			throw new Error(
				"This doesn't look like a Coding Plan token (expected sk-sp-… or sk-tok-…). " +
					"If it's a Cloud API key, run /login and pick the matching Alibaba Cloud region instead.",
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
			refresh: JSON.stringify({
				openai: openaiUrl,
				anthropic: anthropicUrl,
			}),
			expires: Date.now() + 365 * 86400_000,
		};
	},
	async refreshToken(c: { access: string; refresh?: string; expires?: number }) {
		return {
			...c,
			refresh: c.refresh ?? c.access,
			expires: c.expires ?? Date.now() + 365 * 86400_000,
		};
	},
	getApiKey(c: { access: string }) {
		return c.access;
	},
	modifyModels(models: any[], credentials: any) {
		const ep = resolvePlanEndpoints(credentials);
		const updated = buildPlanModels(planDefs, ep.openai, ep.anthropic);
		return models.map((m) => {
			if (m.provider !== "alibaba-plan") return m;
			const found = updated.find((u) => u.id === m.id);
			if (!found || !found.api) return m;
			return { ...m, baseUrl: found.baseUrl ?? m.baseUrl, api: found.api };
		});
	},
});

const registerPlanProvider = (
	pi: ExtensionAPI,
	planEndpoints: { openai: string; anthropic: string },
	omp: boolean,
) => {
	const base = {
		name: "Alibaba Model Studio Plan",
		baseUrl: planEndpoints.anthropic,
		api: "anthropic-messages" as const,
		authHeader: true,
		oauth: createPlanOAuth(),
	};
	if (omp) {
		pi.registerProvider("alibaba-plan", {
			...base,
			fetchDynamicModels: async (apiKey: string | undefined) => {
				if (!apiKey) return [];
				const cached = loadPlanDefsFromCache();
				if (!cached.length) return [];
				planDefs = cached;
				const creds = { access: apiKey };
				const ep = resolvePlanEndpoints(creds);
				return buildPlanModels(cached, ep.openai, ep.anthropic);
			},
		} as unknown as OmpProviderConfig);
	} else {
		pi.registerProvider("alibaba-plan", {
			...base,
			models: buildPlanModels(
				planDefs,
				planEndpoints.openai,
				planEndpoints.anthropic,
			),
		});
	}
};

// ── Main ──────────────────────────────────────────────────────────────
// Async factory: pi awaits this before provider registrations are flushed.
// Model catalogs are loaded from on-disk cache only at startup — live API
// fetches happen exclusively via /alibaba → "Refresh model lists".
export default async function (pi: ExtensionAPI) {
	configureAgentDir(pi);
	const omp = isOmpRuntime;
	migrateLegacyAuth();
	const config = loadConfig();

	let planCreds: { access?: string; refresh?: string } | undefined;
	try {
		planCreds = readAuth()["alibaba-plan"];
	} catch {
		// If auth file is missing or corrupt, planCreds stays undefined;
		// extension will fall back to cache or require fresh login
	}

	// ── Cache-only catalog seed (no network at startup) ─────────────────
	const planEndpoints = resolvePlanEndpoints(planCreds);
	const cloudFmt = config.cloudApiFormat || "anthropic-messages";

	if (planCreds?.access) planDefs = loadPlanDefsFromCache();
	seedCloudDefsFromCache();

	// ── Plan provider ───────────────────────────────────────────────────
	registerPlanProvider(pi, planEndpoints, omp);

	// ── Cloud providers ─────────────────────────────────────────────────
	registerCloudProviders(pi, cloudDefsByProvider, cloudFmt);

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
				"Cloud — Change API Format",
				"Context Window — Override",
				"Reset all",
			]);
			if (!choice) return;

			const cfg = loadConfig();
			const resolver = credentialResolver(ctx.modelRegistry.authStorage);
			const planCred = getPlanCreds(resolver);

			if (choice === "Status") {
				const ep = resolvePlanEndpoints(planCred);
				const ageMin = (c: { fetchedAt: number } | null) =>
					c ? Math.round((Date.now() - c.fetchedAt) / 60000) : null;
				const planCache = readJSON<PlanCache | null>(getPlanCachePath(), null);
				const planAge = ageMin(planCache);
				const isPlanLive =
					planCache &&
					planAge !== null &&
					planCache.models.length === planDefs.length;
				const planState = isPlanLive
					? `live, ${planAge}m old`
					: planDefs.length
						? "live, not cached"
						: "not fetched";
				const lines = [
					`Plan:  ${planCred ? "logged in" : "not logged in"}`,
					`       Anthropic: ${ep.anthropic}`,
					`       OpenAI:    ${ep.openai}`,
					`       Models:    ${planDefs.length} (${planState})`,
				];
				for (const provider of getCloudProviders()) {
					const cache = readJSON<CloudCache | null>(provider.cachePath, null);
					const age = ageMin(cache);
					const defs = cloudDefsByProvider[provider.id];
					const live =
						cache && age !== null && cache.models.length === defs.length;
					const state = live
						? `live, ${age}m old`
						: defs.length
							? "live, not cached"
							: "not fetched";
					const cred = resolver.get?.(provider.id);
					const authState = cred
						? "logged in"
						: process.env[provider.apiKeyEnv]
							? `via $${provider.apiKeyEnv}`
							: "not logged in";
					lines.push(
						"",
						`${provider.name}: ${authState}`,
						`       Domain:    ${provider.domain}`,
						`       Env:       $${provider.apiKeyEnv}`,
						`       Format:    ${cfg.cloudApiFormat || "anthropic-messages"}`,
						`       Models:    ${defs.length} (${state})`,
					);
				}
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
					const refreshResolver = credentialResolver(ctx.modelRegistry.authStorage);
					const planCred = getPlanCreds(refreshResolver);
					planDefs = await loadPlanDefs(true, planCred);
					const cloudResults = await refreshCloudProviders(true, refreshResolver);
					const cloudSummary = cloudResults
						.map((result) =>
							result.keyPresent
								? `${result.provider.id}: ${result.count} models`
								: `${result.provider.id}: skipped`,
						)
						.join(", ");
					await ctx.reload();
					ctx.ui.notify(
						`Plan: ${planDefs.length} models. Cloud: ${cloudSummary}.`,
						"info",
					);
				} catch (e: unknown) {
					const message = e instanceof Error ? e.message : String(e);
					console.error(`[alibaba] Refresh model lists failed: ${message}`);
					ctx.ui.notify(
						`Refresh failed: ${message}. Full error was logged to the terminal.`,
						"error",
					);
				}
				return;
			}

			if (choice === "Re-login Plan") {
				if (
					!(await ctx.ui.confirm(
						"Wipe Plan credentials and re-login?",
						"Removes alibaba-plan from auth.json",
					))
				)
					return;
				// Use authStorage.remove() rather than fs.write — it persists AND updates pi's
				// in-memory credential map, so /login's `• configured` label refreshes without restart.
				ctx.modelRegistry.authStorage.remove("alibaba-plan");
				ctx.ui.notify(
					"Plan credentials wiped. Run /login → Alibaba Model Studio Coding Plan.",
					"info",
				);
				await ctx.reload();
				return;
			}

			if (choice === "Re-login Cloud") {
				const providerName = await ctx.ui.select(
					"Cloud provider:",
					getCloudProviders().map((provider) => provider.name),
				);
				if (!providerName) return;
				const provider = getCloudProviders().find((p) => p.name === providerName);
				if (!provider) return;
				if (
					!(await ctx.ui.confirm(
						`Wipe ${provider.name} credentials and re-login?`,
						`Removes ${provider.id} from auth.json`,
					))
				)
					return;
				ctx.modelRegistry.authStorage.remove(provider.id);
				ctx.ui.notify(
					isOmpRuntime
						? `${provider.name} credentials wiped. Run /login → ${provider.name}.`
						: `${provider.name} credentials wiped. Run /login → Use an API key → ${provider.name}.`,
					"info",
				);
				await ctx.reload();
				return;
			}

			if (choice === "Plan — Change Endpoints") {
				const o = (await ctx.ui.input("OpenAI-compat base URL:")) || "";
				const a = (await ctx.ui.input("Anthropic-compat base URL:")) || "";
				if (o && a) {
					cfg.planOpenAI = o;
					cfg.planAnthropic = a;
					saveConfig(cfg);
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


			if (choice === "Cloud — Change API Format") {
				const sel = await ctx.ui.select("Cloud API format:", [
					"Anthropic (recommended)",
					"OpenAI",
				]);
				if (!sel) return;
				cfg.cloudApiFormat = sel.startsWith("OpenAI")
					? "openai-completions"
					: "anthropic-messages";
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
				const ids = Array.from(
					new Set([...planDefs.map((m) => m.id), ...allCloudModelIds()]),
				).sort();
				const labelToId = new Map<string, string>();
				const opts: string[] = [];
				for (const id of ids) {
					const label = ov[id] ? `${id}  (override: ${fmt(ov[id])})` : id;
					labelToId.set(label, id);
					opts.push(label);
				}
				const allLabel = ov["*"]
					? `* every other model  (override: ${fmt(ov["*"])})`
					: "* every other model";
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
				const val = (
					await ctx.ui.input(
						`Context window for ${id} in tokens — e.g. 1048576 (0 to remove)${current ? `; currently ${fmt(current)}` : ""}:`,
					)
				)?.trim();
				if (!val) return; // cancelled / left blank → no change
				const n = Number(val.replace(/[_,\s]/g, ""));
				if (!Number.isFinite(n) || n < 0) {
					ctx.ui.notify(
						"Enter a non-negative number of tokens (0 removes the override).",
						"error",
					);
					return;
				}
				cfg.contextWindowOverrides = cfg.contextWindowOverrides || {};
				if (n === 0) {
					delete cfg.contextWindowOverrides[id];
					ctx.ui.notify(`Removed context-window override for ${id}.`, "info");
				} else {
					cfg.contextWindowOverrides[id] = Math.floor(n);
					ctx.ui.notify(
						`Context window for ${id} set to ${fmt(Math.floor(n))} tokens.`,
						"info",
					);
				}
				if (Object.keys(cfg.contextWindowOverrides).length === 0)
					delete cfg.contextWindowOverrides;
				saveConfig(cfg);
				await ctx.reload();
				return;
			}

			if (choice === "Reset all") {
				if (
					!(await ctx.ui.confirm(
						"Reset all Alibaba settings?",
						"Wipes config, Plan auth, Cloud auth entries, all model caches, and any alibaba-* entries in settings.json (enabledModels + defaultProvider/defaultModel if alibaba). Run before `pi remove` for a clean uninstall.",
					))
				)
					return;
				for (const p of [
					getConfigPath(),
					getPlanCachePath(),
					...getCloudProviders().map((provider) => provider.cachePath),
				]) {
					try {
						fs.unlinkSync(p);
					} catch {}
				}
				// Use authStorage.remove() so pi's in-memory credential cache stays in sync —
				// otherwise /login's "• configured" label persists until pi is restarted.
				for (const k of [
					...CLOUD_PROVIDER_IDS,
					"alibaba-plan",
					"alibaba-cloud",
					"alibaba-studio",
					"alibaba-token",
					"dashscope",
				]) {
					ctx.modelRegistry.authStorage.remove(k);
				}
				// Also strip stale alibaba-* / dashscope-* model ids from settings.json enabledModels,
				// and clear defaultProvider/defaultModel if they reference alibaba (otherwise pi would
				// try to default-launch into a now-missing provider).
				try {
					const SETTINGS_PATH = getSettingsPath();
					const s = readJSON<Record<string, unknown>>(SETTINGS_PATH, {});
					let touched = false;
					const enabledModels = s.enabledModels;
					if (Array.isArray(enabledModels)) {
						const before = enabledModels.length;
						const nextEnabledModels = enabledModels.filter(
							(id) =>
								typeof id === "string" &&
								!/^(alibaba(-plan|-cloud|-cn|-global|-studio|-token)?|dashscope)\//.test(
									id,
								),
						);
						s.enabledModels = nextEnabledModels;
						if (nextEnabledModels.length !== before) touched = true;
					}
					if (
						typeof s.defaultProvider === "string" &&
						/^(alibaba(-plan|-cloud|-cn|-global|-studio|-token)?|dashscope)$/.test(
							s.defaultProvider,
						)
					) {
						delete s.defaultProvider;
						delete s.defaultModel;
						touched = true;
					}
					if (touched) writeJSON(SETTINGS_PATH, s);
				} catch {
					// Settings file might be missing or corrupt;
					// still notify user that credentials were wiped
				}
				ctx.ui.notify(
					"All Alibaba settings wiped. Now safe to `pi remove`.",
					"info",
				);
				await ctx.reload();
				return;
			}
		},
	});
}
