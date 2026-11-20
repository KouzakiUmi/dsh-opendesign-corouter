# 推理协议与模型发现

“高级 → API 协议”默认自动按型号选择，逐模型可覆盖；已有显式设置保留。GPT / DeepSeek 首选 Responses，Claude 首选 Messages，Kimi、GLM、MiMo 等精确型号按已有 API 证据选 Chat。未知原生路由（包含 Gemini）依用户策略默认 Responses，页面标为未确认。这里描述请求格式；CoRouter 内部是否透传未实测，无法保证不转译。

| 选择 | 默认推理地址 |
| --- | --- |
| OpenAI Chat Completions | `https://amr-link.open-design.ai/v1/chat/completions` |
| OpenAI Responses | `https://amr-link.open-design.ai/v1/responses` |
| Anthropic Messages | `https://amr-link.open-design.ai/v1/messages` |

**模型发现始终读取当前网关的 OpenAI 兼容 `GET /v1/models` 接口。** 推理协议改变时，模型拉取路径与已发现目录不会随之切换。裸网关地址自动补上 `/v1`；明确提供的自定义 API 前缀保留原样。

## 协议差异

- Chat Completions 保留已有消息和工具转换方式。思考增量按 `reasoning_content`、`reasoning`、`reasoning_details[].text` 三种已知拼写读取，同一段增量只取第一个有内容的那一种——网关常把同一段思考同时写进多个拼写，叠加会把每个词报两遍；漏读任何一种会让思考块打不开，推理模型的输出整段丢弃，最终只剩一句难以归因的空响应。
- Responses 使用 `store:false` 与完整输入历史，并请求 `reasoning.encrypted_content`。完整输出项保存在有界私有回放元数据；仅相同模型、Provider、网关、凭据且内容未修改时原样回放密态和 assistant phase，不把密文当作可见思考。工具调用、摘要与用量分别转换，不支持的 stop 明确报错。
- Messages 使用 Bearer 认证及 `anthropic-version: 2023-06-01`；输出上限优先采用调用或模型设置、目录限额，缺省无法获知时采用 4096。发送思考深度时使用 `adaptive` 与 `output_config.effort`；未显式选择时插件按目录的厂商默认档位发送（Claude 系为 high，Opus 5.5 与 Haiku 5.5 为 medium），因此请求不会落到厂商“完全省略思考配置”的情形——Opus 4.8 在省略时默认不启用思考，只有给出档位才启用。`none` 仅在模型与协议都允许关闭时可用。仅支持旧版 `enabled + budget_tokens` 的上游可能拒绝 adaptive。

模型的实际兼容性以服务端为准，不按模型厂商名称限制协议。目录中九个已核 Claude 型号在 Messages 协议下只能单独使用默认温度 1 或默认 top-p 0.99，两者不能同时设置；建议均留空。其他值会在请求前报错，历史配置可在模型页清除。新版 `2026-10-21` API 拒绝任何采样参数，当前插件仍使用上述旧版兼容头；网关对其他协议的实际转发尚未验证。这些型号的同步 Messages 输出上限按厂商资料限制为 128000；高思考档位可能需要调大部分型号的 4096 默认输出，实际 token 消耗以服务端为准。

Fable 5.2 始终 adaptive，不能关闭；Messages 签名回放还绑定实际 system、工具声明与此前的完整投影历史，任何改动、裁剪、超界或旧元数据都会移除不能验证的密态，仅保留可见正文和工具。目录模型的上下文使用[逐型号参考](model-context.md)，网关报告较小窗口会限幅；用户覆盖保留。上下文为完整输入输出工作窗口，实际网关上限仍未验证。

流式响应需要有效终态；截断、流内错误、空响应与缺失工具调用标识或名称均不会伪装成成功。`claude-opus-5.5` 使用 Messages 时，如果流在工具块开始前结束且没有终态，将其分类为传输中断，交由宿主的重试策略处理；重试会重新请求并可能产生额外用量。工具块开始后仍按无效响应处理，用户取消不会触发重试。无论成功、取消、超时或消费方提前退出，均释放上游 reader。

同一 `index` 的后续分片如果带上不同的工具调用 ID，按同一调用的重写处理：宿主已经收到第一个 ID 的 `tool-call-delta`，块内保留该 ID 并继续拼接参数，不再把整轮判为无效响应。缺失 ID 或名称仍然失败，因为这样的工具块无法被调用。

Messages 流中的签名思考和加密遮蔽块以宿主的回放元数据保存，并在同一模型、Provider、网关和推理凭据下按原顺序用于后续请求；不把签名或密文作为可见思考展示。插件使用凭据服务中的随机绑定密钥验证凭据身份，不保存推理 Key 的明文副本。凭据服务不可用时仅能在当前插件实例内回放，重启后需开始新会话或移除旧思考；切换推理 Key 后不能向新身份发送旧签名。会话记录和备份包含上游签名与密态数据。Chat Completions / Responses 的网关推理转换尚未验证，不假定提供相同的密态回放。

Anthropic 自己的 [OpenAI SDK 兼容层](https://platform.claude.com/docs/en/cli-sdks-libraries/libraries/openai-sdk)声明 `reasoning_effort` 会被忽略，且不返回 Claude 思考块；该说明不直接证明 CoRouter 兼容层的行为。需要原生签名回放时选择 Messages，并以实际网关支持情况为准。

## 依据

2026-11-17 已核对的公开问题仍未关闭：[#9232](https://github.com/nexu-io/open-design/issues/9232) 报告 Flash Chat 思考档位疑似被固定；[#9368](https://github.com/nexu-io/open-design/issues/9368) 报告 Eco Chat 工具参数缺失；[#9354](https://github.com/nexu-io/open-design/issues/9354) 报告 Responses 的 namespaced custom tools 返回 400，插件只发送普通 function tools，不触发该特定形状。未找到针对本插件 Gemini Responses 路由的直接复现；这不证明无缺陷。无自动协议回退，避免同一请求静默换格式或重复计费。

- [CoRouter 官方页面](https://corouter.open-design.ai/zh/) 列出 Chat Completions、Responses、Messages；Codex/OpenCode 使用 `/v1` 基址，Claude Code 使用网关根地址。
- [OpenAI OpenAPI](https://github.com/openai/openai-openapi) 提供 Responses 事件和参数定义。
- [Claude Messages API](https://platform.claude.com/docs/en/api/messages) 与[错误参考](https://platform.claude.com/docs/en/api/errors) 区分现代 adaptive thinking、旧 extended thinking 和模型代际采样限制。
- [Claude 思考与采样限制](https://platform.claude.com/docs/en/build-with-claude/thinking#sampling-parameters)及[版本迁移](https://platform.claude.com/docs/en/api/migration-2026-10-21#sampling-parameters)说明采样参数与兼容版本。
- [Claude 思考保留](https://platform.claude.com/docs/en/build-with-claude/preserved-thinking)说明签名块和跨轮回放要求。

[返回使用指南](usage.md)
