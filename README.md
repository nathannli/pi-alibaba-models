# pi-alibaba-models

The complete [`pi`](https://github.com/badlogic/pi-mono) extension for Alibaba's model lineup — **Qwen 3.7 Max**, **Qwen 3.7 Plus** (both 1M context), **Qwen 3.6 Max**, **Qwen 3.6 Plus**, **DeepSeek V4 Pro**, **Kimi K2.6**, **GLM-5**, **MiniMax M2.5**, and the rest of the catalog. Native thinking-level support, both Anthropic- and OpenAI-shaped APIs, International, China, and Global endpoints, both Coding Plan subscriptions and pay-per-token Cloud keys.

## Features

- **Plan + Regional Cloud Providers**: Model Studio Coding Plan plus International, China, and Global pay-per-token DashScope providers — registered side by side, switch per chat from the model picker.
- **Both API Shapes**: Anthropic-compatible (`/v1/messages`) by default; OpenAI-compatible (`/compatible-mode/v1`) auto-selected for DeepSeek and selectable per-Cloud via `/alibaba`.
- **All Three Cloud Regions — Simultaneously**: International (`dashscope-intl.aliyuncs.com`), China (`dashscope.aliyuncs.com`), and Global (`dashscope-us.aliyuncs.com`) are all registered as separate providers. Log into any or all of them at once — each with its own API key — and switch between regions per-chat from the model picker.
- **Native Reasoning**: First-class thinking-level support for every reasoning-capable model (Qwen 3.7 Max/Plus, Qwen 3.6 Max/Plus, DeepSeek V4, Kimi K2.6, GLM-5, MiniMax M2.5).
- **Vision Capable**: Image input automatically enabled for VL models and Qwen 3.x Plus variants.
- **Live Catalog**: Pulls the real `/v1/models` from DashScope on every login + the canonical Qwen-Code plan template. New models appear as Alibaba ships them — no extension update needed.

## How to Use (Quickstart)

1. **Install** the extension (see below).
2. **Restart** `pi` to load the extension.
3. Type `/login` in your pi chat input.
4. Select your provider based on your account type:
   - Choose **Plans > Alibaba Model Studio Coding Plan** if you have a subscription (your token likely starts with `sk-sp-` or `sk-tok-`).
   - Choose **API Keys > Alibaba Cloud International / China / Global** for each pay-as-you-go DashScope region you use (your API keys likely start with `sk-`). You can log into any or all three regions — repeat `/login` for each one.
5. Paste your token when prompted.
6. Open the model picker, select a model (e.g., `Qwen 3.7 Max`, `Qwen 3.7 Plus`, `Qwen 3.6 Max`, or `DeepSeek V4 Pro`), and start chatting!

## Install

```bash
# pi (from fork)
pi install git:github.com/nathannli/pi-alibaba-models
```

Or clone locally first (for development / modifications):

```bash
git clone https://github.com/nathannli/pi-alibaba-models
cd pi-alibaba-models
pi install .
```

After install, restart `pi`. The extension registers four providers and a slash command on every boot.

## Uninstall

`pi remove` only removes the package entry from `settings.json["packages"]` — it does not clean extension-private state (auth entries, config, model cache, enabled-model lists). For a clean uninstall:

```text
1. /alibaba  →  "Reset all"      (wipes config, all Alibaba auth entries, model caches, alibaba-* enabledModels)
2. pi remove pi-alibaba-models
```

If you've already run `pi remove` and want to clean leftovers manually:

```bash
rm -f ~/.pi/agent/alibaba-config.json ~/.pi/agent/alibaba-*-models.cache.json ~/.pi/agent/alibaba-models-dev.cache.json
# then edit ~/.pi/agent/auth.json and remove the "alibaba", "alibaba-cn", "alibaba-global", and "alibaba-plan" entries
# then edit ~/.pi/agent/settings.json and drop any "alibaba/...", "alibaba-*/...", or "dashscope/..." entries from enabledModels
```

## Providers

| Provider id     | Section in `/login` | Authentication | Use it for |
|-----------------|---------------------|----------------|------------|
| `alibaba-plan`  | Plans               | Coding Plan token | Model Studio Coding Plan subscription |
| `alibaba`       | API Keys            | DashScope API key | International Cloud |
| `alibaba-cn`    | API Keys            | DashScope API key | China Cloud |
| `alibaba-global`| API Keys            | DashScope API key | Global Cloud |

All four providers register simultaneously. Cloud credentials remain independent, so any combination of regions can be active at once. The Plan provider stores chosen endpoints in its credential metadata.

> **Cloud without `/login`:** regional providers also read `DASHSCOPE_API_KEY`, `DASHSCOPE_CN_API_KEY`, and `DASHSCOPE_GLOBAL_API_KEY`, respectively. Each provider registers its cached catalog immediately, then refreshes from the live API in the background. With no credential, it remains visible in `/login → Use an API key` through a placeholder model.

### Endpoints

**Plan (default Singapore / Global):**

- Anthropic-compat: `https://token-plan.ap-southeast-1.maas.aliyuncs.com/apps/anthropic` (pi appends `/v1/messages`)
- OpenAI-compat:    `https://token-plan.ap-southeast-1.maas.aliyuncs.com/compatible-mode/v1`

**Cloud:**

| Region | Anthropic-compat | OpenAI-compat |
|--------|------------------|---------------|
| International | `https://dashscope-intl.aliyuncs.com/apps/anthropic` | `https://dashscope-intl.aliyuncs.com/compatible-mode/v1` |
| China | `https://dashscope.aliyuncs.com/apps/anthropic` | `https://dashscope.aliyuncs.com/compatible-mode/v1` |
| Global | `https://dashscope-us.aliyuncs.com/apps/anthropic` | `https://dashscope-us.aliyuncs.com/compatible-mode/v1` |

## Key prefix reference

| Prefix      | Provider       | Where to obtain                                                   |
|-------------|----------------|-------------------------------------------------------------------|
| `sk-sp-`    | `alibaba-plan` | Model Studio Coding Plan console — Singapore / Global             |
| `sk-tok-`   | `alibaba-plan` | Model Studio Coding Plan console — alternate token format         |
| `sk-`(other)| regional Cloud provider | DashScope API Keys console (per-token billing)              |

Consoles:

- International / Singapore Coding Plan: <https://modelstudio-intl.console.alibabacloud.com/>
- China Coding Plan:                     <https://bailian.console.aliyun.com/>
- DashScope (per-token):                 <https://dashscope.console.aliyun.com/> or <https://dashscope-intl.console.aliyun.com/>

The login flow validates the prefix and offers to redirect you to the correct provider if you paste the wrong type.

## Region table

| Region        | Plan host                                         | Cloud host                       |
|---------------|---------------------------------------------------|----------------------------------|
| International | `token-plan.ap-southeast-1.maas.aliyuncs.com`     | `dashscope-intl.aliyuncs.com`    |
| China         | configurable through Plan endpoints               | `dashscope.aliyuncs.com`         |
| Global        | configurable through Plan endpoints               | `dashscope-us.aliyuncs.com`      |

## Studio plan models — dynamic source

Plan models come from the Plan endpoint's live `/compatible-mode/v1/models` response. Cloud models prefer Alibaba's rich `/api/v1/models` catalogs for context windows, output limits, modalities, capabilities, and regional pricing. If a rich catalog fails or times out, the extension falls back to that region's compatible `/v1/models` endpoint.

Each catalog has a separate last-known-good disk cache. Startup registers those cached models without waiting for the network, then refreshes authenticated catalogs in parallel in the background. Network failures retain the matching cache. Force all regions to refresh from `/alibaba → Refresh model lists`.

## Limitations & Known Issues

- **DeepSeek Compatibility**: The Anthropic-compatible path on the Alibaba Plan host often hangs or times out for DeepSeek models. To resolve this seamlessly, this extension automatically forces any model ID containing `deepseek` to use the **OpenAI-completions endpoint** instead.
- **Model Availability (404s)**: The model picker displays the universally *advertised* catalog. However, if your specific Alibaba Cloud account or Model Studio subscription tier does not include access to a specific model, the API will return a `model_not_found` error only when you actually attempt to send a message.
- **API Wrapper Quirks**: Alibaba's native Anthropic compatibility layer can occasionally be strict or quirky with complex parallel tool calls. If you experience systemic parsing errors on DashScope, you can use the `/alibaba` command to switch your Cloud API format to "OpenAI".
- **Dynamic Caching**: Model lists use last-known-good disk caches while models.dev metadata is cached for 24 hours. If a new model drops and you don't see it, run `/alibaba` -> `Refresh model lists`.
- **Inferred Context Windows**: The `/v1/models` API returns only ids and names, so context windows are inferred from the model id. If a brand-new model shows the wrong size, fix it yourself with `/alibaba → Context Window — Override` (per model, or `*` for all) — no extension update needed.

## `/alibaba` command reference

| Choice                       | What it does                                                              |
|------------------------------|---------------------------------------------------------------------------|
| Status                       | Print Plan/Cloud login state, active endpoints, model count, cache age   |
| Refresh model lists          | Force-refetch Plan + Cloud catalogs and reload the extension             |
| Re-login Plan                | Wipe `alibaba-plan` from `auth.json` and reload (then run `/login`)      |
| Re-login Cloud               | Select and wipe one regional Cloud credential, then reload              |
| Plan — Change Endpoints      | Override OpenAI / Anthropic base URLs                                    |
| Cloud — Change API Format    | Switch between Anthropic-compat and OpenAI-compat                        |
| Context Window — Override    | Set the context-window shown on a model's card (per model, or `*` for all) |
| Reset all                    | Wipe config, all Alibaba credentials, caches, and settings entries       |

## Troubleshooting

- **Model picker shows "No matching models"** → run `/login`, pick the right Alibaba entry, paste your key, then run `/alibaba → Refresh model lists`. Cached models register immediately on later boots.
- **`sk-sp-` accidentally pasted into the Cloud slot** → run `/alibaba → Re-login Cloud`, then `/login → Alibaba Model Studio Coding Plan` and paste it there. (The login validators will also catch this and offer to redirect you.)
- **DeepSeek hangs / times out** → make sure you're on the latest version of this extension; it forces DeepSeek to OpenAI-compat. If you customised plan endpoints, verify the OpenAI URL ends in `/compatible-mode/v1`.
- **Plan picker shows models that 404 at request time** → your subscription tier may not include every advertised model. The picker shows whatever upstream advertises; the API tells you "model_not_found" only when you actually call it.
- **`/alibaba` command doesn't appear** → `pi list` should show `pi-alibaba-models` (or whatever source you installed from) under "User packages". If absent, re-install from your local clone (`cd pi-alibaba-models && pi install .`) and restart `pi`.

## Files

| Path                                                  | Purpose                            |
|-------------------------------------------------------|------------------------------------|
| `~/.pi/agent/auth.json`                               | Plan and regional Cloud credentials (0600) |
| `~/.pi/agent/alibaba-config.json`                     | Plan endpoint and Cloud format config |
| `~/.pi/agent/alibaba-plan-models.cache.json`          | Plan model cache                    |
| `~/.pi/agent/alibaba-cloud-models.cache.json`         | International Cloud model cache     |
| `~/.pi/agent/alibaba-cn-models.cache.json`            | China Cloud model cache             |
| `~/.pi/agent/alibaba-global-models.cache.json`        | Global Cloud model cache            |
| `~/.pi/agent/alibaba-models-dev.cache.json`           | models.dev metadata cache           |

## From the same author

By [Francesco Frapporti](https://fornace.it) at [Fornace](https://fornace.it).

- **[pi-bench](https://github.com/fornace/pi-bench)** — LLM benchmark toolkit for pi. Probes every available model to find the fastest and cheapest.
- **[pi-recap](https://github.com/fornace/pi-recap)** — Always-visible session recap panel for pi. Uses pi-bench data to pick the fastest summarization model.
- **[pi-banana](https://github.com/fornace/pi-banana)** — Generate and edit images inside pi using Google Nano Banana. All package banners in this ecosystem were created with pi-banana.
- **[pi-notte-theme](https://github.com/fornace/pi-notte-theme)** — Notte: a true-dark pi theme where darkness has color and text glows like terminal phosphor.
