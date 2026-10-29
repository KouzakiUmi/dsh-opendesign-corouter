# 模型上下文窗口参考

目录中的上下文窗口是**已知参考**：用于宿主的占用监控和自动压缩预算，也是设置页可选窗口档位的封顶依据。以下为厂商公开规格、同一网关的既有部署参考或明确标出的暂定值，**不是 CoRouter 网关实测上限**；账号、协议或网关可能有更低限制。刷新模型目录后，网关显式报告的较小窗口会降低参考上限。数值单位为 token；输出能力参考与上下文窗口分别配置，自动输出预留随有效窗口变化。

设置页不再提供上下文的自由数字输入，改为三个互斥档位；档位是输入与输出**合计**的工作总窗口，不是留给输入的有效预算，见[工作档位](#工作档位)。

## 工作档位

| 档位 | 合计窗口 | 用途 |
| --- | ---: | --- |
| 默认 | 272,000 | 默认工作预算；没有保存过上下文覆盖的模型按此档生效 |
| 扩展 | 500,000 | 单轮输入更长时手动选用 |
| 最大 | 872,000 | 单轮输入更长时手动选用的上限档 |

- 三档都是输入与输出**合计**的工作总窗口。输出仍在这段窗口内预留，输入可用量等于总窗口减去输出预留与已占用内容。
- 目录中的厂商参考（例如 1,000,000、1,048,576）保持原样，只作为已知参考：它决定某个档位是否可选，本身不是实际可用窗口，也不会被改写成档位数值。
- 有效工作总窗口 = min(所选档位, 该模型的已知参考)。超过已知参考的档位在设置中不可选并说明原因；默认档数值高于某些模型的参考时（例：262,144）按参考限幅，不会上调。目录未记录参考的模型以所选档位为准。
- 输出预留仍在有效窗口内：自动预留最多取总窗口的 1/4，且不超过目录记录的单次输出上限。新默认下 DeepSeek V4.1 Flash 的有效总窗口为 272,000，自动输出预留 68,000，输入预算约 204,000。
- 显式设置的单次输出优先于自动预留；若它不小于新的有效窗口，保存被拒绝并要求先清除或调小输出，插件不会静默改写显式值。
- 已保存的任意数字上下文覆盖继续按旧值生效：一律按自定义处理，即使数值与某个档位相同也不当作该档位，且不按已知参考限幅，界面标注为自定义。只有选择档位才会替换它，选择默认档会清除该覆盖。「恢复默认」回到默认档，不回到厂商参考的最大容量。

档位只调整本地工作预算：它不改变服务端或网关的实际限制，也不保证长输入、长任务在所有账号、协议与网关下都能完成。已知参考偏保守时，实际可用窗口可能小于所选档位。

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

`claude-haiku-5.5`、`gpt-6-luna`、`deepseek-v4.1-flash`、`deepseek-v4-pro`、`deepseek-v4-flash`、`deepseek-v4-flash-vision-exp`、`glm-5.3-flashx`、`glm-5.3-flash`、`kimi-k2.7-code`、`mimo-v2.6-pro`、`mimo-v2.6-flash` 和 `hy4-preview` 的原有数值沿用同网关客户端 [dsh-opendesign-go 0.1.9 的模型表](https://github.com/EliteOtaku/dsh-opendesign-go/blob/v0.1.9/src/model-params.ts#L45-L94)；该表将数字标为厂商参考，并非逐项网关实测。同项目的[独立实验记录](https://github.com/EliteOtaku/dsh-opendesign-go/blob/15ac4ba144e914fe9eef56dbef8d0acbee56b5b9/CHANGELOG.md#L5-L23)描述了 DeepSeek 请求的输入加输出限制，不能外推到其他模型、账户或协议。

例如，[DeepSeek 官方价格表](https://api-docs.deepseek.com/zh-cn/quick_start/pricing)对原生 V4.1 Flash / V4 Pro 写为 1M 上下文、最大 384K 输出，并未在该处给出精确窗口整数。目录的 1,000,000 / 384,000 是既有部署参考；[官方请求参数](https://api-docs.deepseek.com/zh-cn/api/create-chat-completion)将 384K 的参数上界写为 393,216。这里不把二者当作已验证的 CoRouter 硬限制。

Kimi K2.7 Code 的[厂商说明](https://platform.kimi.ai/docs/guide/kimi-k2-7-code-quickstart.md)给出 256K 共用窗口；目录的 262,144 窗口和输出上限来自部署参考，而非厂商声明的精确整数。输入与输出不能同时占满该窗口；插件默认输出预留小于窗口。

## 网关发现与字节限制

OpenDesign 的 [Vela 模型解析](https://github.com/nexu-io/open-design/blob/c6bb5a8b8190e17b7e9c546c731814ffe10d4f67/apps/daemon/src/runtimes/defs/amr.ts#L202-L235)识别可选的上下文窗口字段；同网关第三方客户端的[历史模型响应样本](https://github.com/EliteOtaku/dsh-opendesign-go/blob/15ac4ba144e914fe9eef56dbef8d0acbee56b5b9/.tmpw/models.json)另含 `metadata.context_limit`，[Pi 客户端](https://github.com/Lokeraar/pi-opendesign-bridge/blob/8641954aa11629db61d855ee91e254ab5eec5c35/opendesign-live.ts#L370-L384)也将其解释为窗口。刷新时，插件接受有界正整数窗口字段，并取它们与内置参考中较小的值；新 ID 仅在网关提供明确窗口字段时获得参考。网关给出的较小窗口同样降低已知参考，使更高的档位不可选；已保存的自定义数值仍按旧值生效。`context_budget` 和 `output_budget` 的网关语义尚不足以证明是硬上限，因此不用于替代窗口或输出限制。不同来源的报告仍可能不准确，已保存的自定义数值优先。

HTTP 413 是请求体大小限制，不等于 token 窗口限制。[Anthropic 错误文档](https://platform.claude.com/docs/en/api/errors)对其直接 Messages API 给出 32 MB 请求上限；CoRouter 或其他协议可能不同。图片编码后的字节预算和 413 恢复见[排障指南](troubleshooting.md)。
