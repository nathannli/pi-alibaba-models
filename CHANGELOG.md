# Changelog

## 1.0.0

- Initial release
- Two providers: `alibaba-plan` (Model Studio Coding Plan) and `alibaba-cloud` (DashScope API Key)
- `/alibaba` slash command for runtime configuration
- Dynamic plan model list fetched from upstream Qwen Code template
- Cloud model list fetched live from DashScope `/v1/models`
- Vision support via `input: ["text", "image"]` for VL/Qwen-plus models
- Qwen thinking support with `thinkingFormat: "qwen"` and `thinkingLevelMap`
- DeepSeek models forced to OpenAI-compat endpoint (Anthropic-compat hangs)
- Auth migration from legacy single-key format to split Plan/Cloud
