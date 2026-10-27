# 模型图片输入能力

观察日期：2026-10-28。目录中的输入模态只描述文本对话的输入，不表示支持图像生成。厂商原生 API 的能力不保证 CoRouter 每个网关、协议或账号都能使用；尚未逐型号进行网关图片推理验收。

## 厂商文档

| CoRouter 模型 ID | 图片输入依据 |
| --- | --- |
| `gpt-6.1-sol`、`gpt-6.1-terra`、`gpt-6-astra`、`gpt-6-luna`、`gpt-6-sol`、`gpt-5.6-luna`、`gpt-5.6-sol`、`gpt-5.6-terra` | OpenAI 型号页逐项列出 “Input modalities: text, image”： [6.1 Sol](https://developers.openai.com/api/docs/models/gpt-6.1-sol.md)、[6.1 Terra](https://developers.openai.com/api/docs/models/gpt-6.1-terra.md)、[6 Astra](https://developers.openai.com/api/docs/models/gpt-6-astra.md)、[6 Luna](https://developers.openai.com/api/docs/models/gpt-6-luna.md)、[6 Sol](https://developers.openai.com/api/docs/models/gpt-6-sol.md)、[5.6 Luna](https://developers.openai.com/api/docs/models/gpt-5.6-luna.md)、[5.6 Sol](https://developers.openai.com/api/docs/models/gpt-5.6-sol.md)、[5.6 Terra](https://developers.openai.com/api/docs/models/gpt-5.6-terra.md)。 |
| `claude-fable-5.1`、`claude-fable-5`、`claude-opus-5.5`、`claude-opus-5`、`claude-opus-4.8`、`claude-sonnet-5.5`、`claude-sonnet-5`、`claude-haiku-5.5` | [Anthropic 型号总览](https://platform.claude.com/docs/en/models/overview)列出对应产品并说明当前型号支持文本和图片输入。CoRouter 产品页分别标识 [Fable 5.1](https://corouter.open-design.ai/zh/models/claude-fable-5-1/)、[Opus 5.5](https://corouter.open-design.ai/zh/models/claude-opus-5-5/)、[Opus 4.8](https://corouter.open-design.ai/zh/models/claude-opus-4-8/)、[Sonnet 5.5](https://corouter.open-design.ai/zh/models/claude-sonnet-5-5/) 和 [Haiku 5.5](https://corouter.open-design.ai/zh/models/claude-haiku-5-5/) 的点号 ID 与产品名称；厂商 API 使用连字符版本号。此处按产品名称关联，不表示两方 ID 字符串相同或网关已实测。 |
| `gemini-4-argon`、`gemini-3.8-flash`、`gemini-3.7-flash` | Google 型号页的输入数据类型包含 Image：[4 Argon](https://ai.google.dev/gemini-api/docs/models/gemini-4-argon)、[3.8 Flash](https://ai.google.dev/gemini-api/docs/models/gemini-3.8-flash)、[3.7 Flash](https://ai.google.dev/gemini-api/docs/models/gemini-3.7-flash)。后者厂商页标记为 deprecated。 |
| `grok-4.7`、`grok-4.6`、`grok-4.5` | xAI 型号页分别列出 “text, image → text”： [4.7](https://docs.x.ai/developers/models/grok-4.7.md)、[4.6](https://docs.x.ai/developers/models/grok-4.6.md)、[4.5](https://docs.x.ai/developers/models/grok-4.5.md)。 |
| `kimi-k3`、`kimi-k3.1-pro`、`kimi-k2.7-code` | [Kimi 视觉指南](https://platform.kimi.com/docs/guide/use-kimi-vision-model)列出支持视觉输入的型号。 |
| `glm-5.3-flash`、`glm-5.3-flashx` | [GLM 型号页](https://docs.bigmodel.cn/cn/guide/models/vlm/glm-5.3-flash)列出图片、视频、文本及文件输入。 |
| `mimo-v2.6-pro`、`mimo-v2.6-flash` | [MiMo 图片理解指南](https://mimo.mi.com/docs/zh-CN/quick-start/usage-guide/multimodal-understanding/image-understanding)列出两个型号。 |
| `minimax-m3.1-flash` | [MiniMax OpenAI 兼容接口](https://platform.minimax.io/docs/api-reference/text-openai-api)列出 `MiniMax-M3.1-Flash` 支持文本、图片与视频。CoRouter 的小写 ID 与厂商型号名按大小写归一对应；网关转发未实测。 |
| `muse-spark-1.3` | [Meta 型号文档](https://dev.meta.ai/docs/models.md)列出对应 ID 与图片输入。 |
| `glm-5.2` | [厂商型号页](https://docs.bigmodel.cn/cn/guide/models/text/glm-5.2)列出输入模态为文本。 |
| `qwen3.7-max` | [阿里云型号页](https://help.aliyun.com/zh/model-studio/qwen3-7-max)明确当前该 ID 为纯文本；其他带日期的多模态快照是不同 ID。 |

## 网关参考及未知项

原有 12 个套餐型号的能力曾参考同一端点的 `dsh-opendesign-go` 0.1.9 部署默认值，详见[接入证据](client-evidence.md)。其中 `deepseek-v4.1-flash`、旧名 `deepseek-v4-flash` / `deepseek-v4-flash-vision-exp` 保留图片能力；DeepSeek 的[视觉指南](https://api-docs.deepseek.com/zh-cn/guides/vision)和[价格页](https://api-docs.deepseek.com/zh-cn/quick_start/pricing/)对旧名与当前 Flash 的路由也有说明，但不能据此断言 CoRouter 的实际图像转发。`hy4-preview` 仍按同端点部署参考标记为仅文本，厂商未找到逐 ID 明确的图像能力说明。

`deepseek-v4-pro` 旧部署参考为仅文本，但厂商[价格页](https://api-docs.deepseek.com/quick_start/pricing)与[路由公告](https://api-docs.deepseek.com/zh-cn/news/news260910)对其是否继续按原模型处理存在不一致，因此目录将其模态保持未知，不把上游路由变化当成网关已确认。`muse-wonder` 的厂商文档使用带版本号的 `muse-wonder-1.0`；CoRouter 未确认该无版本 ID 的具体映射，保持未知。

## 设置与请求行为

模型设置中的图片输入开关可覆盖目录：手动启用/关闭分别声明 `text + image` / `text`，恢复自动则重新使用目录证据。未知不是“仅文本”：自动状态下保留未知元数据，并尝试把可读取的用户或工具图片传给网关；网关可能拒绝不支持的图片。手动启用也不能保证网关支持，手动关闭则让 Host 按仅文本模型投影图片。读取失败时保留命名占位而不改变模型能力。
