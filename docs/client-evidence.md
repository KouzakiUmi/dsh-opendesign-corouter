# CoRouter 接入与模型来源

观察日期：2026-10-26 至 2026-10-27。来源为 Open Design 0.26.1 客户端代码契约、桌面 CLI 只读模型/计费预检及 [CoRouter 官方首页](https://corouter.open-design.ai/zh/) / [模型目录](https://corouter.open-design.ai/zh/models/)。

## 接入

官网首页内联 `data-corouter-settings.copy` 的 OpenCode / Hermes 模板给出 OpenAI 兼容基址，首页示例使用 `chat.completions.create`：

```text
POST https://amr-link.open-design.ai/v1/chat/completions
Authorization: Bearer <工作空间 API Key>
```

推理使用 API Key，不把桌面 `controlKey` 或浏览器 Cookie 混入该通道。客户端内部控制面仍是 `https://amr-api.open-design.ai`；品牌名称不同不意味着这两个鉴权通道可以互换。

## 模型目录

[模型表](../src/catalog.ts) 收录 39 个目录项：官网详情页已公开的 33 个模型，2026-10-27 官方 `GET https://amr-link.open-design.ai/v1/models` 实测补齐的 5 个 ID，以及同日由厂商型号文档与服务目录补齐的 GPT-6.1 Terra。

- 附赠通道 `opendesign-corouter-plan` 共 13 项：官网 Design Plan / Core 的 12 项，加逐模型预检确认覆盖的 MiniMax M3.1 Flash。保留历史 Provider ID，不把内部 `plan` 字段误解为官网 Plan 付费分类。
- 其余 26 项归入 `opendesign-corouter-paid`，包含官网 Plan 套餐模型及钱包模型，不等于全部可用套餐付费额度抵扣。

### 官方 API 补齐的五项

| 精确 ID | 显示名 | 官方页面与权益依据 |
| --- | --- | --- |
| `gemini-4-argon` | Gemini 4 Argon | [官网套餐卡](https://corouter.open-design.ai/zh/)列于套餐模型，不是 Core 附赠。 |
| `muse-spark-1.3` | Muse Spark 1.3 | [官方详情页](https://corouter.open-design.ai/zh/models/muse-spark-1-3/)及官网套餐卡确认名称；ID 由官方 API 确认。 |
| `kimi-k3.1-pro` | Kimi K3.1 Pro | 官方 API 确认 ID；桌面预检 `modelCovered: false` / `funding: wallet`，归付费通道。显示名为 ID 的本地可读格式。 |
| `minimax-m3.1-flash` | MiniMax M3.1 Flash | 官方 API 确认 ID；桌面预检 `modelCovered: true` / `funding: coding_plan`，归附赠通道。显示名为本地格式。 |
| `muse-wonder` | Muse Wonder | 官方 API 确认 ID；桌面预检 `modelCovered: false` / `funding: wallet`，归付费通道。显示名为本地格式。 |

[官网公开目录](https://corouter.open-design.ai/models/)目前仍展示 33 个模型。部分未存在的详情路径会返回 HTTP 200 的首页，不能把这种响应当作模型文档。上述五项的上下文使用[型号窗口参考](model-context.md)，并非网关实测；输出上限仍保持未知。图片输入能力按[独立的厂商证据](model-capabilities.md)填写；Muse Wonder 的精确别名未确认，其窗口仅作暂定参考，图片模态与思考档位保持未知。2026-10-27 当日首次实测的官方 `/models` 原始 43 项、无重复 ID，按既有过滤规则保留 38 项；全部原有 33 项均在响应中。同日稍后的复核多出 1 项，见下节。

### GPT-6.1 Terra

| 依据 | 结果 |
| --- | --- |
| 厂商型号文档 | [模型页](https://developers.openai.com/api/docs/models/gpt-6.1-terra.md)（HTTP 200，2026-10-27）：标题 “GPT-6.1 Terra”，Model ID `gpt-6.1-terra`；`reasoning.effort` 支持 `none`、`low`、`medium`（默认）、`high`、`xhigh`、`max`；工具调用需要 Responses；输入模态 text、image；上下文 1,050,000，输出上限 128,000。 |
| 厂商迁移指南 | [GPT-6 指南](https://developers.openai.com/api/docs/guides/latest-model.md)：明文 “GPT-6 Astra and GPT-6.1 Sol do not support the `none` reasoning effort; GPT-6.1 Terra, GPT-6 Sol, and GPT-6 Luna do.”；工具调用需 Responses 的名单含 GPT-6.1 Terra。 |
| 服务目录 | 桌面随附 Vela CLI `vela model list --all --format json`（source 为 remote）返回 44 个唯一 ID，含 `gpt-6.1-terra`（`metadata.cost: high`、`metadata.capability: advanced`）。扣除 5 个媒体型号后，其余 39 个对话 ID 与本目录完全一致。 |
| 分组预检 | 同一工作区 `billing preflight`：`codingPlan.eligible: true`、`modelCovered: false`、`funding: wallet`；对照 DeepSeek V4.1 Flash 为 `modelCovered: true` / `funding: coding_plan`。据此归付费通道 `opendesign-corouter-paid`。 |

显示名沿用厂商文档标题；该型号在官网公开目录中尚未出现——`/zh/models/` 的 33 款 ID 清单里没有它，详情路径 `/zh/models/gpt-6-1-terra/` 虽返回 HTTP 200，但响应体是首页（标题为首页标题、717,945 字节，而真实型号页为 449,648 字节），即官网暂无该型号详情页。

上下文、输出上限与输入模态取自厂商型号文档，与既有 `gpt-6-luna` 同一口径；CoRouter 网关侧的有效预算未实测，可在设置中按模型覆盖。

### 桌面与官方源码交叉核验

2026-10-27，使用 Open Design 0.26.1 随附的 Vela CLI，在同一已选工作区执行只读 `model list --all --format json`、`team-projects list` 及 `billing preflight --workspace-id <id> --model <id> --format json`。未记录工作区或账号标识。以 DeepSeek V4.1 Flash 为对照，其与 MiniMax M3.1 Flash 均为 `codingPlan.eligible: true`、`modelCovered: true`、`funding: coding_plan`；另外四个新增模型均为 `modelCovered: false`、`funding: wallet`。CLI 的 `metadata.cost` 对 MiniMax 为 `low`、其他四个为 `high`，但费用标签不替代预检覆盖证据。同日复核 GPT-6.1 Terra，并以 gpt-6.1-sol、gpt-5.6-terra、gpt-6-sol 作同系列参照，四者同为 `modelCovered: false` / `funding: wallet`。

已核对官方源码提交 [`26d60298`](https://github.com/nexu-io/open-design/tree/26d60298f8129e229a1c10aab4df7ca25b1e9ad3)：[模型缓存](https://github.com/nexu-io/open-design/blob/26d60298f8129e229a1c10aab4df7ca25b1e9ad3/apps/daemon/src/runtimes/amr-model-cache.ts)明确 preset 不携带套餐权益；[tier 辅助函数](https://github.com/nexu-io/open-design/blob/26d60298f8129e229a1c10aab4df7ca25b1e9ad3/apps/web/src/runtime/amr-unlimited-models.ts)明确标签不建立覆盖；[计费规范](https://github.com/nexu-io/open-design/blob/26d60298f8129e229a1c10aab4df7ca25b1e9ad3/specs/current/coding-plan-client-billing.md)规定用工作区及模型预检，最终准入仍由 Link 决定。

这只是基于当次工作区证据的本地目录分类，不保证其他账号或未来套餐权益。实际权益、余额回退、扣款池与可用性由 OpenDesign 服务端决定；不能把“套餐赠送 Provider”解释为保证绝不动用钱包。后续更新查询步骤见[项目维护入口](../AGENTS.md#model-catalog-maintenance-evidence-lookup)。

客户端模型目录来自 `vela model list --all --format json`；其静态 preset 属于旧目录，不含完整当前套餐权益，因此没有用旧 preset 覆盖官网模型表。未公开精确 ID 的型号，以及需要媒体专用接口的图像生成型号，不编造 chat ID。

## 能力元数据

原有 12 个套餐模型的上下文和输出上限保留同一推理端点的 [dsh-opendesign-go 0.1.9](https://github.com/EliteOtaku/dsh-opendesign-go) 部署参考；其余上下文参考取自厂商公开规格或明确标注的暂定值，详见[型号窗口参考](model-context.md)。网关侧容量尚未实测，可在模型设置中覆盖。仅增加上下文不会改变原有最大输出默认值。图片模态按[型号能力证据](model-capabilities.md)维护，存在来源冲突或型号映射不确定时保持未知。思考档位按[厂商逐型号文档](reasoning-evidence.md)维护，与容量证据分别记录。

其余缺乏证据的容量和模态保持未知；图片输入可逐型号手动覆盖，未知模态不应被自动当作仅文本。思考能力区分离散档位、无离散控制与未知别名；Host 选择器和设置页使用同一协议交集，历史默认值不作为能力来源。目录与元数据由[目录测试](../test/catalog.test.ts)、[图片能力回归](../test/image-capabilities.test.ts)及[宿主档位回归](../test/reasoning.test.ts)约束。

当前适配器支持 Chat Completions、Responses 和 Anthropic Messages，模型发现固定使用当前网关的 OpenAI 兼容 `/models` 接口。协议与取消行为有离线合成流回归覆盖；Responses 的完整工具参数会补齐已发送增量，矛盾终项按无效响应处理。未实现媒体生成接口。已使用真实设备授权的运行时令牌验证模型目录读取；尚未进行真实推理调用验收。
