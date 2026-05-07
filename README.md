# pi-alibaba-models

A [`pi`](https://github.com/badlogic/pi-mono) extension that adds two Alibaba providers — Model Studio Coding Plan and Alibaba Cloud (DashScope) — plus an `/alibaba` slash-command for runtime configuration.

## Install

This package is a local pi-package. Install via either:

```bash
# from a local checkout
pi install /Users/francesco/alibaba-pi-package

# or pack and install globally
cd /Users/francesco/alibaba-pi-package && npm pack
pi install /Users/francesco/alibaba-pi-package/pi-alibaba-models-1.0.0.tgz
```

After install, restart `pi`. The extension registers two providers and a slash command on every boot.

## Uninstall

`pi remove` only removes the package entry from `settings.json["packages"]` — it does not clean extension-private state (auth entries, config, model cache, enabled-model lists). For a clean uninstall:

```text
1. /alibaba  →  "Reset all"      (wipes config, both auth entries, plan-models cache, alibaba-* enabledModels)
2. pi remove /Users/francesco/alibaba-pi-package
```

If you've already run `pi remove` and want to clean leftovers manually:

```bash
rm -f ~/.pi/agent/alibaba-config.json ~/.pi/agent/alibaba-plan-models.cache.json
# then edit ~/.pi/agent/auth.json and remove the "alibaba-plan" / "alibaba-cloud" entries
# then edit ~/.pi/agent/settings.json and drop any "alibaba-*/..." or "dashscope/..." entries from enabledModels
```

## Two providers

| Provider id    | Section in `/login`     | Auth shape | Use it for                                 |
|----------------|-------------------------|------------|--------------------------------------------|
| `alibaba-plan` | Plans                   | OAuth (paste token) | Model Studio Coding Plan subscription |
| `alibaba-cloud`| API Keys (via OAuth UI) | OAuth (paste API key) | Pay-per-token DashScope API           |

Both are registered as `oauth`-shaped providers so they appear in `/login` and live in `~/.pi/agent/auth.json` under their respective keys. The Plan provider stores the chosen endpoints in the `refresh` field as JSON; the Cloud provider stores its domain in `~/.pi/agent/alibaba-config.json`.

### Endpoints

**Plan (default Singapore / Global):**
- Anthropic-compat: `https://token-plan.ap-southeast-1.maas.aliyuncs.com/apps/anthropic` (pi appends `/v1/messages`)
- OpenAI-compat:    `https://token-plan.ap-southeast-1.maas.aliyuncs.com/compatible-mode/v1`

**Cloud (default International):**
- Anthropic-compat: `https://dashscope-intl.aliyuncs.com/apps/anthropic`
- OpenAI-compat:    `https://dashscope-intl.aliyuncs.com/compatible-mode/v1`

## Key prefix reference

| Prefix      | Provider       | Where to obtain                                                   |
|-------------|----------------|-------------------------------------------------------------------|
| `sk-sp-`    | `alibaba-plan` | Model Studio Coding Plan console — Singapore / Global             |
| `sk-tok-`   | `alibaba-plan` | Model Studio Coding Plan console — alternate token format         |
| `sk-`(other)| `alibaba-cloud`| DashScope API Keys console (per-token billing)                    |

Consoles:
- International / Singapore Coding Plan: <https://modelstudio-intl.console.alibabacloud.com/>
- China Coding Plan:                     <https://bailian.console.aliyun.com/>
- DashScope (per-token):                 <https://dashscope.console.aliyun.com/> or <https://dashscope-intl.console.aliyun.com/>

The login flow validates the prefix and offers to redirect you to the correct provider if you paste the wrong type.

## Region table

| Region        | Plan host                                         | Cloud host                       |
|---------------|---------------------------------------------------|----------------------------------|
| International | `token-plan.ap-southeast-1.maas.aliyuncs.com`     | `dashscope-intl.aliyuncs.com`    |
| China         | (region-specific host, paste via "Custom")        | `dashscope.aliyuncs.com`         |
| Custom        | paste both base URLs at login                     | paste domain at login            |

## Studio plan models — dynamic source

The plan model list is fetched from the canonical Qwen Code template:

<https://github.com/QwenLM/qwen-code/blob/main/packages/cli/src/constants/codingPlan.ts>

Cached at `~/.pi/agent/alibaba-plan-models.cache.json` for **24 hours**. On stale cache, the extension re-fetches with a 4 s timeout and falls back silently to a hardcoded list on failure. Force a refresh from `/alibaba → Refresh studio models`.

`deepseek-v3.2` is merged in even when upstream omits it (the user's plan endpoint serves it as well).

## DeepSeek note

Any model id matching `/deepseek/i` is **forced to the OpenAI-completions endpoint** regardless of upstream metadata. The Anthropic-compat path on the plan host hangs / times out for DeepSeek models.

## `/alibaba` command reference

| Choice                       | What it does                                                              |
|------------------------------|---------------------------------------------------------------------------|
| Status                       | Print Plan/Cloud login state, active endpoints, model count, cache age   |
| Refresh studio models        | Force-refetch plan models from upstream and reload the extension         |
| Re-login Plan                | Wipe `alibaba-plan` from `auth.json` and reload (then run `/login`)      |
| Re-login Cloud               | Wipe `alibaba-cloud` from `auth.json` and reload (then run `/login`)     |
| Plan — Change Endpoints      | Override OpenAI / Anthropic base URLs                                    |
| Cloud — Change Domain        | International / China / Custom domain                                    |
| Cloud — Change API Format    | Switch between Anthropic-compat and OpenAI-compat                        |
| Reset all                    | Wipe all Alibaba state (config, both auth entries, plan-models cache)    |

## Troubleshooting

- **Model picker shows "No matching models"** → run `/login`, pick the right Alibaba entry, paste your key. Models register only after a successful login (Cloud fetches its real model list at boot from the live key).
- **`sk-sp-` accidentally pasted into the Cloud slot** → run `/alibaba → Re-login Cloud`, then `/login → Alibaba Model Studio Coding Plan` and paste it there. (The login validators will also catch this and offer to redirect you.)
- **DeepSeek hangs / times out** → make sure you're on the latest version of this extension; it forces DeepSeek to OpenAI-compat. If you customised plan endpoints, verify the OpenAI URL ends in `/compatible-mode/v1`.
- **Plan picker shows models that 404 at request time** → your subscription tier may not include every advertised model. The picker shows whatever upstream advertises; the API tells you "model_not_found" only when you actually call it.
- **`/alibaba` command doesn't appear** → `pi list` should show `../../alibaba-pi-package` (or wherever you installed it) under "User packages". If absent, run `pi install <path>` again.

## Files

| Path                                                  | Purpose                            |
|-------------------------------------------------------|------------------------------------|
| `~/.pi/agent/auth.json`                               | Both provider credentials (0600)   |
| `~/.pi/agent/alibaba-config.json`                     | Endpoint / domain / format config  |
| `~/.pi/agent/alibaba-plan-models.cache.json`          | 24 h plan-models cache             |
