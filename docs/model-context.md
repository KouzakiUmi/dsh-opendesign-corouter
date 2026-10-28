# 模型上下文窗口参考

目录中的上下文窗口用于宿主的占用监控和自动压缩预算。以下为厂商公开规格、同一网关的既有部署参考或明确标出的暂定值，**不是 CoRouter 网关实测上限**；账号、协议或网关可能有更低限制。可在模型设置中逐项覆盖。数值单位为 token；输出额度与上下文窗口分别配置，补充窗口不会自动提高默认最大输出。

## 厂商型号参考

| 目录模型 ID | 参考窗口 | 依据与口径 |
| --- | ---: | --- |
| `gpt-6.1-sol`、`gpt-6.1-terra`、`gpt-6-astra`、`gpt-6-luna`、`gpt-6-sol`、`gpt-5.6-luna`、`gpt-5.6-sol`、`gpt-5.6-terra` | 1,050,000 | OpenAI 各型号页分别给出 context window：[6.1 Sol](https://developers.openai.com/api/docs/models/gpt-6.1-sol.md)、[6.1 Terra](https://developers.openai.com/api/docs/models/gpt-6.1-terra.md)、[6 Astra](https://developers.openai.com/api/docs/models/gpt-6-astra.md)、[6 Luna](https://developers.openai.com/api/docs/models/gpt-6-luna.md)、[6 Sol](https://developers.openai.com/api/docs/models/gpt-6-sol.md)、[5.6 Luna](https://developers.openai.com/api/docs/models/gpt-5.6-luna.md)、[5.6 Sol](https://developers.openai.com/api/docs/models/gpt-5.6-sol.md)、[5.6 Terra](https://developers.openai.com/api/docs/models/gpt-5.6-terra.md)。[上下文定义](https://developers.openai.com/api/docs/guides/conversation-state.md)包含输入、输出及思考 token。 |
| `claude-fable-5.1`、`claude-fable-5`、`claude-opus-5.5`、`claude-opus-5`、`claude-opus-4.8`、`claude-sonnet-5.5`、`claude-sonnet-5`、`claude-haiku-5.5` | 1,000,000 | [Anthropic 型号窗口表](https://platform.claude.com/docs/en/build-with-claude/context-windows)逐型号给出 1M。厂商小版本 ID 使用连字符，CoRouter 目录使用点号；网关的实际映射和限制未实测。 |
| `kimi-k3`、`kimi-k3.1-pro` | 1,048,576 | [K3 官方配置](https://platform.kimi.ai/docs/guide/use-kimi-in-hermes-agent.md)、[K3.1 Pro 官方配置](https://platform.kimi.ai/docs/guide/codex-kimi)均为 1,048,576；[Kimi 文档](https://platform.kimi.ai/docs/introduction.md)规定输入与输出共用总窗口。 |
| `gemini-4-argon` | 1,048,576 | [Google 型号页](https://ai.google.dev/gemini-api/docs/models/gemini-4-argon.md.txt)明确输入、思考和输出共用窗口。 |
| `gemini-3.8-flash`、`gemini-3.7-flash` | 1,048,576 | Google 的 [3.8](https://ai.google.dev/gemini-api/docs/models/gemini-3.8-flash.md.txt) 与 [3.7](https://ai.google.dev/gemini-api/docs/models/gemini-3.7-flash.md.txt) 页面给出 1,048,576 **输入上限**及独立输出预算。此处保守地将输入上限作为宿主的合计预算，避免把独立输出额度直接叠加到可用输入；Google 已将 3.7 标为弃用并路由到 3.8。 |
| `grok-4.7`、`grok-4.6`、`grok-4.5` | 500,000 | xAI [4.7](https://docs.x.ai/developers/models/grok-4.7)、[4.6](https://docs.x.ai/developers/models/grok-4.6)、[4.5](https://docs.x.ai/developers/models/grok-4.5) 各自给出 context window；是否包含输出未明确，此处作为保守的合计预算。 |
| `glm-5.2` | 1,000,000 | [智谱型号页](https://docs.bigmodel.cn/cn/guide/models/text/glm-5.2.md)写为 1M，没有精确整数；这里使用十进制百万作为保守参考，不将其宣称为厂商精确的二进制或十进制上限。[上下文定义](https://docs.z.ai/guides/overview/concept-param.md)包含输入和输出。 |
| `qwen3.7-max` | 1,000,000 | [阿里云型号页](https://help.aliyun.com/zh/model-studio/qwen3-7-max)明确给出上下文长度 1,000,000，并对最大输入及思考模式另设限制；不能把完整窗口当作保证可用的输入长度。 |
| `minimax-m3.1-flash` | 1,000,000 | [MiniMax 型号表](https://platform.minimax.io/docs/guides/text-generation)列出当前 `MiniMax-M3.1-Flash` 为 1,000,000；厂商页面未明确该数值是否为输入输出合计，此处作为保守的合计预算。CoRouter 使用小写 ID，实际网关映射与预算未实测。 |
| `muse-spark-1.3` | 1,048,576 | [Meta 型号表](https://dev.meta.ai/docs/getting-started/models)列出精确 ID 与窗口；[长上下文说明](https://dev.meta.ai/docs/cookbook/long-context)说明输入和请求输出共用预算。 |
| `muse-wonder` | 1,048,576 | **暂定参考**：Meta 的 [Muse Wonder 型号](https://dev.meta.ai/docs/models)为 `muse-wonder-1.0`、窗口 1,048,576；[OpenRouter 公共目录](https://openrouter.ai/meta/muse-wonder)以同名 ID 列出该模型，其[公开模型列表](https://openrouter.ai/api/v1/models)返回 `meta/muse-wonder` 的 `context_length: 1048576`。CoRouter 的 `muse-wonder` 实际对应版本尚未确认，不能把此值当作已验证网关能力；可按实际限制覆盖。 |

## 既有部署参考

`claude-haiku-5.5`、`gpt-6-luna`、`deepseek-v4.1-flash`、`deepseek-v4-pro`、`deepseek-v4-flash`、`deepseek-v4-flash-vision-exp`、`glm-5.3-flashx`、`glm-5.3-flash`、`kimi-k2.7-code`、`mimo-v2.6-pro`、`mimo-v2.6-flash` 和 `hy4-preview` 的原有数值沿用同一网关部署资料 [dsh-opendesign-go 0.1.9](https://github.com/EliteOtaku/dsh-opendesign-go)，其中厂商有同名规格的型号同时列于上表。部署参考不保证当前网关有效。

例如，[DeepSeek 官方列表](https://api-docs.deepseek.com/zh-cn/api/list-models)对原生 V4.1 Flash / V4 Pro 给出 1,048,576，而既有 CoRouter 部署参考使用 1,000,000；本次保留较保守的既有网关参考，不将原生 API 的数值冒充 CoRouter 的实测结果。

动态发现的新 ID 若没有已核实的目录参考，仍保持未知，不按名字推断容量。
