# 推理协议与模型发现

在设置的“高级 → API 协议”中直接选择协议。默认使用 Chat Completions；已保存的 Key 在三种协议下复用。

| 选择 | 默认推理地址 |
| --- | --- |
| OpenAI Chat Completions | `https://amr-link.open-design.ai/v1/chat/completions` |
| OpenAI Responses | `https://amr-link.open-design.ai/v1/responses` |
| Anthropic Messages | `https://amr-link.open-design.ai/v1/messages` |

**模型发现始终读取当前网关的 OpenAI 兼容 `GET /v1/models` 接口。** 推理协议改变时，模型拉取路径与已发现目录不会随之切换。裸网关地址自动补上 `/v1`；明确提供的自定义 API 前缀保留原样。

## 协议差异

- Chat Completions 保留已有消息和工具转换方式。思考增量按 `reasoning_content`、`reasoning`、`reasoning_details[].text` 三种已知拼写读取，同一段增量只取第一个有内容的那一种——网关常把同一段思考同时写进多个拼写，叠加会把每个词报两遍；漏读任何一种会让思考块打不开，推理模型的输出整段丢弃，最终只剩一句难以归因的空响应。
- Responses 使用 `store:false` 和完整输入历史，不依赖服务端的 `previous_response_id`。工具调用、文本、推理摘要与用量分别转换；不支持的 stop 序列和思考档位明确报错。
- Messages 使用 Bearer 认证及 `anthropic-version: 2023-06-01`；输出上限优先采用调用或模型设置、目录限额，缺省无法获知时采用 4096。显式指定思考深度时使用 `adaptive` 与 `output_config.effort`，未指定时保留服务端默认：例如厂商的 Opus 4.8 默认不启用思考，可选择一个档位启用。`none` 仅在模型与协议都允许关闭时可用。仅支持旧版 `enabled + budget_tokens` 的上游可能拒绝 adaptive。

模型的实际兼容性以服务端为准，不按模型厂商名称限制协议。目录中八个 Claude 型号在 Messages 协议下只能单独使用默认温度 1 或默认 top-p 0.99，两者不能同时设置；建议均留空。其他值会在请求前报错，历史配置可在模型页清除。新版 `2026-10-21` API 拒绝任何采样参数，当前插件仍使用上述旧版兼容头；网关对其他协议的实际转发尚未验证。这些型号的同步 Messages 输出上限按厂商资料限制为 128000；高思考档位可能需要调大部分型号的 4096 默认输出，实际 token 消耗以服务端为准。

目录模型的上下文窗口使用[逐型号参考](model-context.md)，网关报告较小窗口时刷新目录会采用较小值，模型设置可覆盖。CoRouter 网关的实际硬限制尚未验证。上下文元数据表示输入和输出的完整窗口；厂商仅提供独立输入上限时采用保守预算，宿主再为输出和压缩预留空间。容量变更会影响上下文监控与自动压缩；监控还需要新请求的用量数据。

流式响应需要有效终态；截断、流内错误、空响应与缺失工具调用标识均不会伪装成成功。`claude-opus-5.5` 使用 Messages 时，如果流在工具块开始前结束且没有终态，将其分类为传输中断，交由宿主的重试策略处理；重试会重新请求并可能产生额外用量。工具块开始后仍按无效响应处理，用户取消不会触发重试。无论成功、取消、超时或消费方提前退出，均释放上游 reader。

Messages 流中的签名思考和加密遮蔽块以宿主的回放元数据保存，并在同一模型、Provider、网关和推理凭据下按原顺序用于后续请求；不把签名或密文作为可见思考展示。插件使用凭据服务中的随机绑定密钥验证凭据身份，不保存推理 Key 的明文副本。凭据服务不可用时仅能在当前插件实例内回放，重启后需开始新会话或移除旧思考；切换推理 Key 后不能向新身份发送旧签名。会话记录和备份包含上游签名与密态数据。Chat Completions / Responses 的网关推理转换尚未验证，不假定提供相同的密态回放。

Anthropic 自己的 [OpenAI SDK 兼容层](https://platform.claude.com/docs/en/cli-sdks-libraries/libraries/openai-sdk)声明 `reasoning_effort` 会被忽略，且不返回 Claude 思考块；该说明不直接证明 CoRouter 兼容层的行为。需要原生签名回放时选择 Messages，并以实际网关支持情况为准。

## 依据

- [CoRouter 官方页面](https://corouter.open-design.ai/zh/) 列出 Chat Completions、Responses、Messages；Codex/OpenCode 使用 `/v1` 基址，Claude Code 使用网关根地址。
- [OpenAI OpenAPI](https://github.com/openai/openai-openapi) 提供 Responses 事件和参数定义。
- [Claude Messages API](https://platform.claude.com/docs/en/api/messages) 与[错误参考](https://platform.claude.com/docs/en/api/errors) 区分现代 adaptive thinking、旧 extended thinking 和模型代际采样限制。
- [Claude 思考与采样限制](https://platform.claude.com/docs/en/build-with-claude/thinking#sampling-parameters)及[版本迁移](https://platform.claude.com/docs/en/api/migration-2026-10-21#sampling-parameters)说明采样参数与兼容版本。
- [Claude 思考保留](https://platform.claude.com/docs/en/build-with-claude/preserved-thinking)说明签名块和跨轮回放要求。

[返回使用指南](usage.md)
