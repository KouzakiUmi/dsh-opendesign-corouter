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

[模型表](../src/catalog.ts) 收录 38 个目录项：官网详情页已公开的 33 个模型，以及 2026-10-27 官方 `GET https://amr-link.open-design.ai/v1/models` 实测补齐的 5 个 ID。

- 附赠通道 `opendesign-corouter-plan` 共 13 项：官网 Design Plan / Core 的 12 项，加逐模型预检确认覆盖的 MiniMax M3.1 Flash。保留历史 Provider ID，不把内部 `plan` 字段误解为官网 Plan 付费分类。
- 其余 25 项归入 `opendesign-corouter-paid`，包含官网 Plan 套餐模型及钱包模型，不等于全部可用套餐付费额度抵扣。

### 官方 API 补齐的五项

| 精确 ID | 显示名 | 官方页面与权益依据 |
| --- | --- | --- |
| `gemini-4-argon` | Gemini 4 Argon | [官网套餐卡](https://corouter.open-design.ai/zh/)列于套餐模型，不是 Core 附赠。 |
| `muse-spark-1.3` | Muse Spark 1.3 | [官方详情页](https://corouter.open-design.ai/zh/models/muse-spark-1-3/)及官网套餐卡确认名称；ID 由官方 API 确认。 |
| `kimi-k3.1-pro` | Kimi K3.1 Pro | 官方 API 确认 ID；桌面预检 `modelCovered: false` / `funding: wallet`，归付费通道。显示名为 ID 的本地可读格式。 |
| `minimax-m3.1-flash` | MiniMax M3.1 Flash | 官方 API 确认 ID；桌面预检 `modelCovered: true` / `funding: coding_plan`，归附赠通道。显示名为本地格式。 |
| `muse-wonder` | Muse Wonder | 官方 API 确认 ID；桌面预检 `modelCovered: false` / `funding: wallet`，归付费通道。显示名为本地格式。 |

[官网公开目录](https://corouter.open-design.ai/models/)目前仍展示 33 个模型。部分未存在的详情路径会返回 HTTP 200 的首页，不能把这种响应当作模型文档。上述五项均不填上下文、输出上限、模态或思考档位，也不宣称所有推理协议均可用。实测 `/models` 原始 43 项、无重复 ID，按既有过滤规则保留 38 项；全部原有 33 项均在响应中。

### 桌面与官方源码交叉核验

2026-10-27，使用 Open Design 0.26.1 随附的 Vela CLI，在同一已选工作区执行只读 `model list --all --format json`、`team-projects list` 及 `billing preflight --workspace-id <id> --model <id> --format json`。未记录工作区或账号标识。以 DeepSeek V4.1 Flash 为对照，其与 MiniMax M3.1 Flash 均为 `codingPlan.eligible: true`、`modelCovered: true`、`funding: coding_plan`；另外四个新增模型均为 `modelCovered: false`、`funding: wallet`。CLI 的 `metadata.cost` 对 MiniMax 为 `low`、其他四个为 `high`，但费用标签不替代预检覆盖证据。

已核对官方源码提交 [`26d60298`](https://github.com/nexu-io/open-design/tree/26d60298f8129e229a1c10aab4df7ca25b1e9ad3)：[模型缓存](https://github.com/nexu-io/open-design/blob/26d60298f8129e229a1c10aab4df7ca25b1e9ad3/apps/daemon/src/runtimes/amr-model-cache.ts)明确 preset 不携带套餐权益；[tier 辅助函数](https://github.com/nexu-io/open-design/blob/26d60298f8129e229a1c10aab4df7ca25b1e9ad3/apps/web/src/runtime/amr-unlimited-models.ts)明确标签不建立覆盖；[计费规范](https://github.com/nexu-io/open-design/blob/26d60298f8129e229a1c10aab4df7ca25b1e9ad3/specs/current/coding-plan-client-billing.md)规定用工作区及模型预检，最终准入仍由 Link 决定。

这只是基于当次工作区证据的本地目录分类，不保证其他账号或未来套餐权益。实际权益、余额回退、扣款池与可用性由 OpenDesign 服务端决定；不能把“套餐赠送 Provider”解释为保证绝不动用钱包。后续更新查询步骤见[项目维护入口](../AGENTS.md#model-catalog-maintenance-evidence-lookup)。

客户端模型目录来自 `vela model list --all --format json`；其静态 preset 属于旧目录，不含完整当前套餐权益，因此没有用旧 preset 覆盖官网模型表。未公开精确 ID 的型号，以及需要媒体专用接口的图像生成型号，不编造 chat ID。

## 能力元数据

原有 12 个套餐模型的上下文、输出上限和输入模态保留同一推理端点的 [dsh-opendesign-go 0.1.9](https://github.com/EliteOtaku/dsh-opendesign-go) 部署参考。思考档位已独立改为[厂商逐型号文档](reasoning-evidence.md)，与容量证据分别维护。

其余容量和模态保持既有未知状态。思考能力区分离散档位、无离散控制与未知别名；Host 选择器和设置页使用同一协议交集，历史默认值不作为能力来源。目录与元数据由[目录测试](../test/catalog.test.ts)及[宿主档位回归](../test/reasoning.test.ts)约束。

当前适配器支持 Chat Completions、Responses 和 Anthropic Messages，模型发现固定使用当前网关的 OpenAI 兼容 `/models` 接口。协议与取消行为有离线合成流回归覆盖；Responses 的完整工具参数会补齐已发送增量，矛盾终项按无效响应处理。未实现媒体生成接口。已使用真实设备授权的运行时令牌验证模型目录读取；尚未进行真实推理调用验收。
