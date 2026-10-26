# 推理协议与模型发现

在设置的“高级 → API 协议”中直接选择协议。默认使用 Chat Completions；已保存的 Key 在三种协议下复用。

| 选择 | 默认推理地址 |
| --- | --- |
| OpenAI Chat Completions | `https://amr-link.open-design.ai/v1/chat/completions` |
| OpenAI Responses | `https://amr-link.open-design.ai/v1/responses` |
| Anthropic Messages | `https://amr-link.open-design.ai/v1/messages` |

**模型发现始终使用 OpenAI `GET /v1/models`。** 推理协议改变时，模型拉取路径与已发现目录不会随之切换。裸网关地址自动补上 `/v1`；明确提供的自定义 API 前缀保留原样。

## 协议差异

- Chat Completions 保留已有消息和工具转换方式。
- Responses 使用 `store:false` 和完整输入历史，不依赖服务端的 `previous_response_id`。工具调用、文本、推理摘要与用量分别转换；不支持的 stop 序列和思考档位明确报错。
- Messages 使用 Bearer 认证及 `anthropic-version: 2023-06-01`，未提供输出上限时采用 4096。思考使用现代 `adaptive` 与 `output_config.effort`，支持 `low/medium/high/xhigh/max`，`none` 关闭思考。仅支持旧版 `enabled + budget_tokens` 的上游可能拒绝该模式。

模型的实际兼容性以服务端为准，不按模型厂商名称限制协议。部分新 Claude 模型不接受自定义温度或 top-p，使用这类模型时可清空采样覆盖，继承服务端默认值；网关对其它模型的支持可能不同。明确设置不会被静默丢弃。

流式响应需要有效终态；截断、流内错误、空响应与缺失工具调用标识均不会伪装成成功。无论成功、取消、超时或消费方提前退出，均释放上游 reader。

## 依据

- [CoRouter 官方页面](https://corouter.open-design.ai/zh/) 列出 Chat Completions、Responses、Messages；Codex/OpenCode 使用 `/v1` 基址，Claude Code 使用网关根地址。
- [OpenAI OpenAPI](https://github.com/openai/openai-openapi) 提供 Responses 事件和参数定义。
- [Claude Messages API](https://platform.claude.com/docs/en/api/messages) 与[错误参考](https://platform.claude.com/docs/en/api/errors) 区分现代 adaptive thinking、旧 extended thinking 和模型代际采样限制。

[返回使用指南](usage.md)
