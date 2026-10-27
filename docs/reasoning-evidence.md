# 推理档位取证

本文记录 CoRouter 目录中 38 个对话模型 ID 的推理控制证据。采样日期 2026-10-27；所有来源在该日返回 HTTP 200。

## 证据层级

1. **厂商官方声明**（本文矩阵）：模型自身 API 接受的档位、开关/预算参数与默认档位。矩阵只描述厂商面，不代表 CoRouter 的实际转发结果。
2. **CoRouter 网关面**：CoRouter 未公开按型号的推理档位映射。已核查 `https://corouter.open-design.ai/models/`、`https://corouter.open-design.ai/zh/models/<slug>/`、`https://corouter.open-design.ai/docs`，三处只含价格、套餐与协议选择说明；唯一相关表述为 “Choose Chat Completions, Responses or Messages according to the model’s supported protocols.”。因此网关是否逐路由透传厂商档位、是否改写或归一化取值，属未验证项：本文不宣称矩阵中的档位已在 CoRouter 上逐一验证。

## 使用规则

- 厂商默认档位只作记录，不自动写入用户设置；用户未选择时由上游按其默认执行。
- 厂商未公布档位时保持缺省，不构造能力列表。
- 历史上保存的、已不在当前档位集合内的默认值可以清除。
- 协议层可用值 = 该模型官方档位集合 ∩ 当前协议支持集合；交集为空即该协议下不可调。
- 本记录不涉及媒体模型选择、上下文容量与计费归属。

## 目录实现对应

`src/catalog.ts` 的档位常量直接取自本文矩阵：

| 常量 | 档位 | 对应模型 |
| --- | --- | --- |
| `EFFORTS_REASONING` | low / medium / high / xhigh / max | OpenAI 6.1-sol、6-astra；Claude 8 款；MiniMax M3.1 Flash |
| `EFFORTS_OPENAI` | none + `EFFORTS_REASONING` | OpenAI 6-sol、6-luna、5.6-sol、5.6-terra、5.6-luna |
| `EFFORTS_GLM52` | none / minimal / low / medium / high / xhigh / max | GLM-5.2 |
| `EFFORTS_LOW_HIGH` | low / high / max | DeepSeek 4 款；GLM-5.3-flash、5.3-flashx；Kimi K3、K3.1 Pro |
| `EFFORTS_LEVELS` | low / medium / high | Gemini 4 Argon、3.8 Flash、3.7 Flash；Grok 4.5 |
| `EFFORTS_GROK` | low / medium / high / xhigh | Grok 4.7、4.6 |
| `EFFORTS_MUSE` | minimal / low / medium / high / xhigh / max | Muse Spark 1.3 |
| 空数组 `[]` | 无离散档位 | MiMo V2.6 Pro、MiMo V2.6 Flash、Kimi K2.7 Code、Qwen3.7 Max |
| 缺省 | 未知 | Muse Wonder |

合计 33 款可调档位、4 款固定思考或仅开关/预算控制、1 款未知。

## 证据矩阵

### OpenAI（7）

| 模型 ID | 官方档位 | 官方默认 | 原生控制与协议限制 | 官方来源 | 原文要点 |
| --- | --- | --- | --- | --- | --- |
| gpt-6.1-sol | low / medium / high / xhigh / max | medium | 工具调用需要 Responses；支持集合未含 none、minimal | [模型页](https://developers.openai.com/api/docs/models/gpt-6.1-sol.md)、[迁移指南](https://developers.openai.com/api/docs/guides/latest-model.md) | “`reasoning.effort` supports `low`, `medium` (default), `high`, `xhigh`, and `max`”；迁移指南明确 Astra 与 6.1 Sol 不支持 none |
| gpt-6-astra | low / medium / high / xhigh / max | 未声明 | none 不可用，传 none 返回 HTTP 400 | [模型页](https://developers.openai.com/api/docs/models/gpt-6-astra.md)、[推理指南](https://developers.openai.com/api/docs/guides/reasoning.md) | “`reasoning.effort` supports `low`, `medium`, `high`, `xhigh`, and `max`”；“GPT-6 Astra does not support `none` reasoning effort … returns HTTP 400” |
| gpt-6-luna | none / low / medium / high / xhigh / max | medium | 内置工具与函数调用需用 Responses；Chat Completions 仅在 `reasoning_effort` 为 none 时支持函数调用 | [模型页](https://developers.openai.com/api/docs/models/gpt-6-luna.md) | “`reasoning.effort` supports `none`, `low`, `medium` (default), `high`, `xhigh`, and `max`” |
| gpt-6-sol | none / low / medium / high / xhigh / max | medium | 同 6-luna | [模型页](https://developers.openai.com/api/docs/models/gpt-6-sol.md) | “`reasoning.effort` supports `none`, `low`, `medium` (default), `high`, `xhigh`, and `max`” |
| gpt-5.6-luna | none / low / medium / high / xhigh / max | medium | Responses 另有 `reasoning.mode`（standard/pro），与 effort 相互独立 | [模型页](https://developers.openai.com/api/docs/models/gpt-5.6-luna.md)、[推理指南](https://developers.openai.com/api/docs/guides/reasoning.md) | “Reasoning.effort supports: none, low, medium (default), high, xhigh, and max” |
| gpt-5.6-sol | none / low / medium / high / xhigh / max | medium | 同上 | [模型页](https://developers.openai.com/api/docs/models/gpt-5.6-sol.md) | 同上 |
| gpt-5.6-terra | none / low / medium / high / xhigh / max | medium | 同上 | [模型页](https://developers.openai.com/api/docs/models/gpt-5.6-terra.md) | 同上 |

### Anthropic（8）

全部型号档位一致，为 low / medium / high / xhigh / max；原生控制为 Messages 协议的 `output_config.effort`。默认档位：Claude Opus 5.5、Claude Haiku 5.5 为 medium，其余为 high。

| 模型 ID | 官方档位 | 官方默认 | 原文要点 |
| --- | --- | --- | --- |
| claude-haiku-5.5 | low / medium / high / xhigh / max | medium | “Most Claude models default to high effort … Claude Opus 5.5 and Claude Haiku 5.5 default to medium” |
| claude-opus-5.5 | low / medium / high / xhigh / max | medium | 同上 |
| claude-fable-5.1 | low / medium / high / xhigh / max | high | “Set `effort` to the model’s default (`"medium"` on Claude Opus 5.5 and Claude Haiku 5.5, `"high"` on other models) produces exactly the same behavior as omitting the `effort` parameter entirely.” |
| claude-fable-5 | low / medium / high / xhigh / max | high | 同上；档位表列出 Fable 5 支持 max 与 xhigh |
| claude-opus-5 | low / medium / high / xhigh / max | high | 同上 |
| claude-opus-4.8 | low / medium / high / xhigh / max | high | 同上 |
| claude-sonnet-5.5 | low / medium / high / xhigh / max | high | 同上 |
| claude-sonnet-5 | low / medium / high / xhigh / max | high | 同上 |

来源：[Effort](https://platform.claude.com/docs/en/build-with-claude/effort.md)。该页档位表逐型号列出 max 与 xhigh 的可用范围，上述 8 款均在列表内；“Not every model that supports `max` supports `xhigh`.”

### DeepSeek（4）

厂商文档中官方模型名为 `deepseek-flash`（版本 DeepSeek-V4.1-Flash-1017）与 `deepseek-v4-pro`（版本 DeepSeek-V4-Pro-0813）；`deepseek-v4-flash`、`deepseek-v4-flash-vision-exp` 是官方保留的旧名，对应模型已下线，请求由 V4.1-Flash-1017 提供服务。四者档位一致。

| 模型 ID | 官方档位 | 官方默认 | 原生控制与协议限制 | 官方来源 | 原文要点 |
| --- | --- | --- | --- | --- | --- |
| deepseek-v4.1-flash | low / high / max | high | OpenAI 用 `thinking.type` 开关与 `reasoning_effort`；Anthropic 用 `thinking.type` 与 `output_config.effort`；Responses 用 `reasoning.effort`（none 关闭、low/high/max 调节）；思考模式下 temperature 等采样参数被忽略 | [思考模式](https://api-docs.deepseek.com/zh-cn/guides/thinking_mode/)、[模型与价格](https://api-docs.deepseek.com/zh-cn/quick_start/pricing/) | “思考模式默认打开，且 effort 默认为high”；表格合并列中 `reasoning.effort` 属于 Responses 列 |
| deepseek-v4-pro | low / high / max | high | 同上；思考模式下忽略传入的 top_p（携带 tools 固定 0.95，否则 1.0），非思考模式才生效 | [思考模式](https://api-docs.deepseek.com/zh-cn/guides/thinking_mode/) | “deepseek-v4-pro：思考模式下会忽略传入值（携带 tools 时固定为 0.95，否则为 1.0）；非思考模式下生效” |
| deepseek-v4-flash | low / high / max | high | 同 V4.1 Flash | [模型与价格](https://api-docs.deepseek.com/zh-cn/quick_start/pricing/)、[首页](https://api-docs.deepseek.com/zh-cn/) | “旧模型名 deepseek-v4-flash、deepseek-v4-flash-vision-exp 仍可调用，但对应模型已下线，请求由 DeepSeek-V4.1-Flash-1017 模型提供服务，并按 Flash 价格计费” |
| deepseek-v4-flash-vision-exp | low / high / max | high | 同 V4.1 Flash | [模型与价格](https://api-docs.deepseek.com/zh-cn/quick_start/pricing/) | 同上 |

厂商另给出别名映射：minimal → low，low → low，medium → high，high → high，xhigh → high，max → max，ultra → max。目录只暴露 low / high / max，别名不单列。

### Z.ai（3）

| 模型 ID | 官方档位 | 官方默认 | 原生控制与协议限制 | 官方来源 | 原文要点 |
| --- | --- | --- | --- | --- | --- |
| glm-5.3-flash | max / high / low | max | `thinking.type` 强制思考，传 disabled 报错；其余取值报错 | [深度思考](https://docs.bigmodel.cn/cn/guide/capabilities/thinking)、[Deep Thinking](https://docs.z.ai/guides/capabilities/thinking.md) | “针对GLM-5.3 GLM-5.3-FLASH GLM-5.3-FLASHX，仅支持 max、high、low，其余输入将报错”；“GLM-5.3 GLM-5.3-FLASH 不再支持关闭思考（API 请求中 thinking.type 传 disabled 将会报错）” |
| glm-5.3-flashx | max / high / low | max | 同上 | 同上 | 同上 |
| glm-5.2 | max / xhigh / high / medium / low / minimal / none | max | none、minimal 表示放弃思考；low、medium 映射为 high；xhigh 映射为 max；仅 5.2 仍支持 `thinking.type` disabled | 同上 | “针对GLM-5.2，支持 max（默认且推荐，深度推理）、xhigh、high、medium、low、minimal、none，其中 none 或 minimal 代表模型放弃思考；low / medium 映射为 high；xhigh 映射为 max” |

### Moonshot（3）

| 模型 ID | 官方档位 | 官方默认 | 原生控制与协议限制 | 官方来源 | 原文要点 |
| --- | --- | --- | --- | --- | --- |
| kimi-k3.1-pro | low / high / max | max | 始终推理，不接受 `thinking` 参数；保留式思考恒开；多轮与工具调用须原样回传完整 assistant message；切换档位会破坏前缀缓存 | [推理强度](https://platform.kimi.com/docs/guide/use-reasoning-effort.md)、[思考模型](https://platform.kimi.com/docs/guide/use-thinking-models.md) | “Kimi K3.1 Pro 始终进行推理，并通过请求顶层 `reasoning_effort` 配置推理强度。该字段支持 `"low"` / `"high"` / `"max"` 三档，默认 `"max"`” |
| kimi-k3 | low / high / max | max | 与 K3.1 Pro 参数约束一致；始终推理，无 `thinking` 参数 | [模型参数参考](https://platform.kimi.com/docs/api/models-overview.md)、[思考模型](https://platform.kimi.com/docs/guide/use-thinking-models.md) | 参数对照表中 `kimi-k3` 的 `reasoning_effort` 为 `"low"` / `"high"` / `"max"`（默认 `"max"`） |
| kimi-k2.7-code | 不支持 | 无档位概念 | 始终思考；`thinking.type` 仅接受 `{"type":"enabled","keep":"all"}`，传 disabled 报错；`thinking.keep` 恒为 all；temperature 固定 1.0 | [思考模型](https://platform.kimi.com/docs/guide/use-thinking-models.md)、[模型参数参考](https://platform.kimi.com/docs/api/models-overview.md) | 参数对照表中 `kimi-k2.7-code` 的 `reasoning_effort` 为“不支持”；“思考默认开启，仅支持 `{"type":"enabled","keep":"all"}`，传入其他配置会报错” |

### Google（3）

三款原生控制均为 Gemini 侧 `thinking_level`，取值为 low / medium / high，默认 On (medium)；OpenAI 兼容层以 effort 映射到 `thinking_level`。

| 模型 ID | 官方档位 | 官方默认 | 官方来源 | 原文要点 |
| --- | --- | --- | --- | --- |
| gemini-4-argon | low / medium / high | On (medium) | [思考文档](https://ai.google.dev/gemini-api/docs/thinking)、[模型页](https://ai.google.dev/gemini-api/docs/models/gemini-4-argon) | 思考文档表：“gemini-4-argon | On (medium) | low, medium, high”；模型页：“Thinking Supported (low, medium, high)” |
| gemini-3.8-flash | low / medium / high | On (medium) | [思考文档](https://ai.google.dev/gemini-api/docs/thinking)、[模型页](https://ai.google.dev/gemini-api/docs/models/gemini-3.8-flash) | 模型页：“Thinking Supported (low, medium, high). Note: minimal is not supported and returns an error.” |
| gemini-3.7-flash | low / medium / high | On (medium) | [模型页](https://ai.google.dev/gemini-api/docs/models/gemini-3.7-flash) | “Thinking Supported (low, medium, high). Note: minimal is not supported and returns an error.” |

### xAI（3）

| 模型 ID | 官方档位 | 官方默认 | 原生控制 | 官方来源 | 原文要点 |
| --- | --- | --- | --- | --- | --- |
| grok-4.7 | low / medium / high / xhigh | high | Responses `reasoning.effort`；Chat Completions `reasoning_effort` | [Reasoning](https://docs.x.ai/developers/model-capabilities/text/reasoning) | “`"xhigh"` is available on `grok-4.6` and later”；模型能力数据中 grok-4.7 为 `supportedEfforts ["low","medium","high","xhigh"]`、`defaultEffort "high"` |
| grok-4.6 | low / medium / high / xhigh | high | 同上 | 同上 | 同上；xhigh 起始型号 |
| grok-4.5 | low / medium / high | high | 同上 | 同上 | 正文将 xhigh 视作 high，故不作为独立档位列出 |

同页内嵌的模型目录 JSON 仍把 grok-4.5 的 `supportedEfforts` 列为含 `xhigh`；与正文冲突处以上述正文为准。

### Xiaomi（2）

| 模型 ID | 官方档位 | 官方默认 | 原生控制与协议限制 | 官方来源 | 原文要点 |
| --- | --- | --- | --- | --- | --- |
| mimo-v2.6-pro | Chat Completions 无离散档位；Responses 接受 none / minimal / low / medium / high / xhigh / max / ultra，但现阶段不区分强度 | 思考开启 | Chat Completions 仅 `thinking.type` enabled/disabled；Responses 侧 none 关闭推理、其余取值一律开启且行为一致，minimal 映射为 low，xhigh / max / ultra 映射为 high；思考模式不支持自定义 temperature 与 top_p（强制 1.0 / 0.95） | [深度思考](https://mimo.mi.com/docs/zh-CN/quick-start/usage-guide/text-generation/deep-thinking)、[Responses 兼容](https://mimo.mi.com/docs/zh-CN/api/chat/responses) | “当前暂不支持自定义调节推理投入档位：参数设为 none 时关闭推理，其余合法取值均开启推理。minimal 被映射为 low。xhigh、max 和 ultra 被映射为 high。” |
| mimo-v2.6-flash | 同上 | 思考开启 | 同上 | 同上 | “支持的模型：mimo-v2.6-flash，mimo-v2.6-pro，mimo-v2.6-pro-ultraspeed” |

### Tencent（1）

| 模型 ID | 官方档位 | 官方默认 | 原生控制与协议限制 | 官方来源 | 原文要点 |
| --- | --- | --- | --- | --- | --- |
| hy4-preview | none / high | high | `thinking.type` enabled/disabled，默认 enabled；同页通用表中的 low / medium / high 属 hy3，不适用于本型号 | [Deep Reasoning](https://www.tencentcloud.com/document/product/1300/80637)、[Hy API Guide](https://intl.cloud.tencent.com/document/product/1300/80695) | 推理深度表：“Hy4 preview \| hy4-preview \| Default high, supports none,high”；“Hy3 \| hy3 \| Default high, supports low, high and none.” |

### Alibaba（1）

| 模型 ID | 官方档位 | 官方默认 | 原生控制与协议限制 | 官方来源 | 原文要点 |
| --- | --- | --- | --- | --- | --- |
| qwen3.7-max | 无离散档位 | 思考开启 | `enable_thinking` 混合模式（默认开启）+ 整数 `thinking_budget` 预算；预算仅 Chat Completions 与 DashScope 支持，Responses API 不支持 | [思考模式](https://platform.qianwenai.com/docs/developer-guides/text-generation/thinking)、[Model reasoning capabilities](https://github.com/QwenLM/qwen-code/blob/b695664b8df06d06c625db3e30b97045d82092c7/docs/design/model-reasoning-capabilities.md) | “qwen3.7-max, and qwen3.5-plus as hybrid-thinking models that can enable or disable thinking but use an integer thinking budget instead of discrete Chat Completions effort levels”；能力表：`qwen3.7-max | Optional | None` |

### MiniMax（1）

| 模型 ID | 官方档位 | 官方默认 | 原生控制与协议限制 | 官方来源 | 原文要点 |
| --- | --- | --- | --- | --- | --- |
| minimax-m3.1-flash | low / medium / high / xhigh / max | max | none 不支持（返回 400）；始终思考，`thinking.type` disabled 同样 400；temperature 恒 1、top_p 恒 0.95；不支持 service_tier | [OpenAI SDK](https://platform.minimax.io/docs/api-reference/text-openai-api) | “Accepts low, medium, high, xhigh, and max; higher levels think more thoroughly. Defaults to max when omitted. none is not supported.”；错误文案“model "MiniMax-M3.1-Flash" requires adaptive thinking; thinking.type="disabled" (including reasoning.effort=none) is not allowed (2013)” |

### Meta（2）

| 模型 ID | 官方档位 | 官方默认 | 原生控制与协议限制 | 官方来源 | 原文要点 |
| --- | --- | --- | --- | --- | --- |
| muse-spark-1.3 | minimal / low / medium / high / xhigh / max | 由模型决定 | none 不可用，返回 HTTP 400；max 超出 xhigh，模型思考时间与 token 更多；`muse-spark-1.3-contributor` 变体不支持 max | [Reasoning](https://dev.meta.ai/docs/reasoning)、[Models](https://dev.meta.ai/docs/models) | “Disables reasoning. Not supported by Muse Wonder or Muse Spark: returns HTTP 400”；档位表“`"minimal"` Shortest reasoning pass.”、“`"low"` Light reasoning.”；示例 `"model": "muse-spark-1.3", "reasoning": { "effort": "high" }` |
| muse-wonder | 未知 | 未知 | CoRouter 侧 ID 与官方 `muse-wonder-1.0` 的精确对应未确认；官方文档出现 `muse-wonder-1.0`（示例 effort 为 max） | [Reasoning](https://dev.meta.ai/docs/reasoning)、[Models](https://dev.meta.ai/docs/models) | “Meta ships six model lines.”；示例 `"model": "muse-wonder-1.0", "reasoning": { "effort": "max" }` |

## 冲突与第三方来源

- **xAI**：官方正文将 grok-4.5 的 xhigh 按 high 处理；同页内嵌模型目录 JSON 仍将 xhigh 列在可用值中。目录只暴露正文定义的独立档位 low / medium / high。
- **第三方网关（非厂商原文）**：Cloudflare 的 DeepSeek V4.1 Flash [更新说明](https://developers.cloudflare.com/changelog/post/2026-10-19-deepseek-v4.1-flash-workers-ai/index.md)允许用 none 关闭思考。DeepSeek 官方 OpenAI 格式使用 `thinking.type: disabled`，其 Responses 格式才使用 `reasoning.effort: none`；这类差异说明不同网关的映射需要分别核对。
- **托管平台文档（非模型厂商原文）**：腾讯云 TokenHub 的推理深度表同时列出 deepseek-v4-flash、deepseek-v4-pro、kimi-k3、glm-5.2 等档位（<https://www.tencentcloud.com/document/product/1300/80637>），与对应厂商原文一致，可作交叉参考，不单独作为结论来源。

## 相关文档

[模型证据](client-evidence.md) · [协议差异](protocols.md) · [使用指南](usage.md)
