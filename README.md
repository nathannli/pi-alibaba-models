# pi-alibaba-models

The complete [`pi`](https://github.com/badlogic/pi-mono) and [`oh-my-pi`](https://github.com/nathannli/oh-my-pi) extension for Alibaba's model lineup — **Qwen 3.7 Max**, **Qwen 3.7 Plus** (both 1M context), **Qwen 3.6 Max**, **Qwen 3.6 Plus**, **DeepSeek V4 Pro**, **Kimi K2.6**, **GLM-5**, **MiniMax M2.5**, and the rest of the catalog. Native thinking-level support, both Anthropic- and OpenAI-shaped APIs, three Cloud regions (International, China, Global), both Coding Plan subscriptions and pay-per-token Cloud keys.

## Features

- **Dual Provider Support**: Both the subscription-based Model Studio Coding Plan **and** the pay-per-token Alibaba Cloud (DashScope) — registered side by side, switch per chat from the model picker.
- **Both API Shapes**: Anthropic-compatible (`/v1/messages`) by default; OpenAI-compatible (`/compatible-mode/v1`) auto-selected for DeepSeek and selectable per-Cloud via `/alibaba`.
- **Three Cloud Regions**: International (`dashscope-intl.aliyuncs.com`), China (`dashscope.aliyuncs.com`), and Global (`dashscope-us.aliyuncs.com`) — pick your region at login via the matching Cloud provider.
- **Native Reasoning**: First-class thinking-level support for every reasoning-capable model (Qwen 3.7 Max/Plus, Qwen 3.6 Max/Plus, DeepSeek V4, Kimi K2.6, GLM-5, MiniMax M2.5).
- **Vision Capable**: Image input automatically enabled for VL models and Qwen 3.x Plus variants.
- **Live Catalog**: Model catalogs are seeded from on-disk cache at startup — no network calls until you ask for them. Run `/alibaba → Refresh model lists` to pull the latest from DashScope. New models appear as Alibaba ships them — no extension update needed.
- **oh-my-pi**: First-class support for both `pi` and `oh-my-pi`. Paths, credential storage, and login flows are auto-detected per runtime.

## How to Use (Quickstart)

1. **Install** the extension (see below). Works with both `pi` and `oh-my-pi`.
2. **Restart** `pi` to load the extension.
3. Type `/login` in your pi chat input.
4. Select your provider based on your account type:
   - Choose **Plans > Alibaba Model Studio Coding Plan** if you have a subscription (your token likely starts with `sk-sp-` or `sk-tok-`).
   - Choose **Use an API key > Alibaba Cloud (API Key)** if you use the pay-as-you-go DashScope service (your token likely starts with `sk-`).
5. Paste your token when prompted.
6. Open the model picker, select a model (e.g., `Qwen 3.7 Max`, `Qwen 3.7 Plus`, `Qwen 3.6 Max`, or `DeepSeek V4 Pro`), and start chatting!

## Install

```bash
# recommended
pi install pi-alibaba-models

# explicit npm form (fallback if the bare name doesn't resolve)
pi install npm:pi-alibaba-models

# or from GitHub
pi install git:github.com/Fornace/pi-alibaba-models

# or from a local checkout (development)
git clone https://github.com/Fornace/pi-alibaba-models
cd pi-alibaba-models && pi install .
```

After install, restart `pi`. The extension registers four providers (Plan + three Cloud regions) and a slash command on every boot.

## Uninstall

`pi remove` only removes the package entry from `settings.json["packages"]` — it does not clean extension-private state (auth entries, config, model cache, enabled-model lists). For a clean uninstall:

```text
1. /alibaba  →  "Reset all"      (wipes config, both auth entries, plan-models cache, alibaba-* enabledModels)
2. pi remove pi-alibaba-models
```

If you've already run `pi remove` and want to clean leftovers manually:

```bash
rm -f ~/.pi/agent/alibaba-config.json ~/.pi/agent/alibaba-plan-models.cache.json
# then edit ~/.pi/agent/auth.json and remove the "alibaba-plan" / "alibaba-cloud" entries
# then edit ~/.pi/agent/settings.json and drop any "alibaba-*/..." or "dashscope/..." entries from enabledModels
```

## Providers

| Provider id      | Section in `/login`     | Auth shape | Use it for                                 |
|------------------|-------------------------|------------|--------------------------------------------|
| `alibaba-plan`   | Plans                   | OAuth (paste token) | Model Studio Coding Plan subscription |
| `alibaba`        | API Keys                | OAuth (paste API key) | Pay-per-token DashScope — International |
| `alibaba-cn`     | API Keys                | OAuth (paste API key) | Pay-per-token DashScope — China         |
| `alibaba-global` | API Keys                | OAuth (paste API key) | Pay-per-token DashScope — Global (US)   |

All providers are registered as `oauth`-shaped so they appear in `/login` and live in `auth.json` (pi) or `agent.db` (oh-my-pi) under their respective keys. The Plan provider stores the chosen endpoints in the `refresh` field as JSON.

> **Cloud without `/login`:** each Cloud provider also reads its own env var — `DASHSCOPE_API_KEY` (International), `DASHSCOPE_CN_API_KEY` (China), or `DASHSCOPE_GLOBAL_API_KEY` (Global). If set, the extension fetches your live model catalog on refresh — no `/login` needed. With **no** credential at all (no `/login`, no env var) each Cloud provider still shows up in `/login → API Keys` via a single placeholder model, so you can sign in; your real catalog replaces it the moment a key is present.

### Endpoints

**Plan (default Singapore / Global):**
- Anthropic-compat: `https://token-plan.ap-southeast-1.maas.aliyuncs.com/apps/anthropic` (pi appends `/v1/messages`)
- OpenAI-compat:    `https://token-plan.ap-southeast-1.maas.aliyuncs.com/compatible-mode/v1`

**Cloud — International (default):**
- Anthropic-compat: `https://dashscope-intl.aliyuncs.com/apps/anthropic`
- OpenAI-compat:    `https://dashscope-intl.aliyuncs.com/compatible-mode/v1`

**Cloud — China:**
- Anthropic-compat: `https://dashscope.aliyuncs.com/apps/anthropic`
- OpenAI-compat:    `https://dashscope.aliyuncs.com/compatible-mode/v1`

**Cloud — Global (US):**
- Anthropic-compat: `https://dashscope-us.aliyuncs.com/apps/anthropic`
- OpenAI-compat:    `https://dashscope-us.aliyuncs.com/compatible-mode/v1`

## Key prefix reference

| Prefix      | Provider       | Where to obtain                                                   |
|-------------|----------------|-------------------------------------------------------------------|
| `sk-sp-`    | `alibaba-plan` | Model Studio Coding Plan console — Singapore / Global             |
| `sk-tok-`   | `alibaba-plan` | Model Studio Coding Plan console — alternate token format         |
| `sk-`(other)| Cloud providers  | DashScope API Keys console (per-token billing)                    |

Consoles:
- International / Singapore Coding Plan: <https://modelstudio-intl.console.alibabacloud.com/>
- China Coding Plan:                     <https://bailian.console.aliyun.com/>
- DashScope (per-token):                 <https://dashscope.console.aliyun.com/> or <https://dashscope-intl.console.aliyun.com/>

The login flow validates the prefix and offers to redirect you to the correct provider if you paste the wrong type.

## Region table

| Region        | Cloud host                       | Env var                       |
|---------------|----------------------------------|-------------------------------|
| International | `dashscope-intl.aliyuncs.com`    | `DASHSCOPE_API_KEY`           |
| China         | `dashscope.aliyuncs.com`         | `DASHSCOPE_CN_API_KEY`        |
| Global (US)   | `dashscope-us.aliyuncs.com`      | `DASHSCOPE_GLOBAL_API_KEY`    |

## Studio plan models — dynamic source

The plan model list is fetched from the canonical Qwen Code template:

<https://github.com/QwenLM/qwen-code/blob/main/packages/cli/src/constants/codingPlan.ts>

Cached at `alibaba-plan-models.cache.json` for **4 hours**. The live API is always the source of truth; on a failed fetch the extension falls back to the last-known-good on-disk cache (and, if there's no cache either, registers an empty list rather than crashing). Force a refresh from `/alibaba → Refresh model lists`.

`deepseek-v3.2` (and any plan-served models the upstream template omits) is merged in via a small allow-list so the picker reflects what the endpoint actually serves. The Cloud provider mirrors the live `/v1/models` response — V4 Pro/Flash, Qwen 3.7 Max/Plus, Qwen 3.6 Max/Plus, Kimi K2.6, GLM-5, MiniMax M2.5 etc. all surface automatically as Alibaba ships them.

## Limitations & Known Issues

- **DeepSeek Compatibility**: The Anthropic-compatible path on the Alibaba Plan host often hangs or times out for DeepSeek models. To resolve this seamlessly, this extension automatically forces any model ID containing `deepseek` to use the **OpenAI-completions endpoint** instead.
- **Model Availability (404s)**: The model picker displays the universally *advertised* catalog. However, if your specific Alibaba Cloud account or Model Studio subscription tier does not include access to a specific model, the API will return a `model_not_found` error only when you actually attempt to send a message.
- **API Wrapper Quirks**: Alibaba's native Anthropic compatibility layer can occasionally be strict or quirky with complex parallel tool calls. If you experience systemic parsing errors on DashScope, you can use the `/alibaba` command to switch your Cloud API format to "OpenAI".
- **Dynamic Caching**: Model lists are cached for 4 hours. If a new model drops and you don't see it, run `/alibaba` -> `Refresh model lists`.
- **Inferred Context Windows**: The `/v1/models` API returns only ids and names, so context windows are inferred from the model id. If a brand-new model shows the wrong size, fix it yourself with `/alibaba → Context Window — Override` (per model, or `*` for all) — no extension update needed.

## `/alibaba` command reference

| Choice                       | What it does                                                              |
|------------------------------|---------------------------------------------------------------------------|
| Status                       | Print Plan/Cloud login state, active endpoints, model count, cache age   |
| Refresh model lists          | Force-fetch Plan + Cloud catalogs from the live API and reload            |
| Re-login Plan                | Wipe `alibaba-plan` from auth and reload (then run `/login`)             |
| Re-login Cloud               | Pick a Cloud region, wipe its auth entry, and reload (then run `/login`) |
| Plan — Change Endpoints      | Override OpenAI / Anthropic base URLs                                    |
| Cloud — Change API Format    | Switch between Anthropic-compat and OpenAI-compat                        |
| Context Window — Override    | Set the context-window shown on a model's card (per model, or `*` for all) |
| Reset all                    | Wipe all Alibaba state (config, all auth entries, all model caches)      |

## Troubleshooting

- **Model picker shows "No matching models"** → run `/login`, pick the right Alibaba entry, paste your key. Models register only after a successful login. Run `/alibaba → Refresh model lists` to pull the live catalog.
- **`sk-sp-` accidentally pasted into the Cloud slot** → run `/alibaba → Re-login Cloud`, then `/login → Alibaba Model Studio Coding Plan` and paste it there. (The login validators will also catch this and offer to redirect you.)
- **DeepSeek hangs / times out** → make sure you're on the latest version of this extension; it forces DeepSeek to OpenAI-compat. If you customised plan endpoints, verify the OpenAI URL ends in `/compatible-mode/v1`.
- **Plan picker shows models that 404 at request time** → your subscription tier may not include every advertised model. The picker shows whatever upstream advertises; the API tells you "model_not_found" only when you actually call it.
- **`/alibaba` command doesn't appear** → `pi list` should show `pi-alibaba-models` (or whatever source you installed from) under "User packages". If absent, run `pi install pi-alibaba-models` again and restart `pi`.

## Files

**pi** (`~/.pi/agent/`) / **oh-my-pi** (`~/.omp/agent/`):

| Path                                     | Purpose                            |
|------------------------------------------|------------------------------------|
| `auth.json` (pi) / `agent.db` (omp)      | All provider credentials (0600)    |
| `alibaba-config.json`                    | Endpoint / format config           |
| `alibaba-plan-models.cache.json`         | 4 h plan-models cache              |
| `alibaba-cloud-models.cache.json`        | 4 h international cloud cache      |
| `alibaba-cn-models.cache.json`           | 4 h China cloud cache              |
| `alibaba-global-models.cache.json`       | 4 h global cloud cache             |

## From the same author

By [Francesco Frapporti](https://fornace.it) at [Fornace](https://fornace.it).

- **[pi-bench](https://github.com/fornace/pi-bench)** — LLM benchmark toolkit for pi. Probes every available model to find the fastest and cheapest.
- **[pi-recap](https://github.com/fornace/pi-recap)** — Always-visible session recap panel for pi. Uses pi-bench data to pick the fastest summarization model.
- **[pi-banana](https://github.com/fornace/pi-banana)** — Generate and edit images inside pi using Google Nano Banana. All package banners in this ecosystem were created with pi-banana.
- **[pi-notte-theme](https://github.com/fornace/pi-notte-theme)** — Notte: a true-dark pi theme where darkness has color and text glows like terminal phosphor.
