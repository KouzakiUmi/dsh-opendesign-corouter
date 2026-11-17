# CoRouter 接入与模型来源

观察日期：2026-11-17。来源为 Open Design 0.26.1 随附 Vela 的只读命令、同一令牌对的官方 HTTP 查询、[官网套餐页](https://corouter.open-design.ai/zh/)及厂商资料。账号、成员、工作区标识和凭据不记录在本文。

## 当前模型目录

使用结构化 `team-projects list` 核实本机工作区，再执行 `vela model list --all --format json --workspace-id <本地已核工作区>`，source 为 remote，返回 57 个唯一 ID。排除 11 个媒体型号后，46 个对话 ID 与[模型参考表](../src/catalog.ts)一致。比旧版本新增：

| 精确 ID | 显示名 | 本次工作区 Coding Plan 覆盖 |
| --- | --- | --- |
| `claude-fable-5.2` | Claude Fable 5.2 | false |
| `deepseek-v4.1-flash-eco` | DeepSeek V4.1 Flash Eco | true |
| `gemini-4-carbon` | Gemini 4 Carbon | false |
| `hy4` | Hy4 | false |
| `hy4-flash` | Hy4 Flash | false |
| `muse-ember-1.0` | Muse Ember 1.0 | false |
| `qwen4-max` | Qwen4 Max | false |

官网套餐页已出现部分新增型号，但[公开价格目录](https://corouter.open-design.ai/models/)仍只列 33 款；缺失的详情路径可返回 HTTP 200 首页，不能作为型号能力证据。Link 行目前只有 id/object/owned_by 与 metadata.cost/capability，没有容量、原生协议或明确权益。cost/capability 不用于分组。

## 按账号和工作区核实分组

对同一工作区先以 DeepSeek V4.1 Flash 为对照，再为全部 46 个对话 ID 执行 `billing preflight --workspace-id <同一作用域> --model <精确ID> --format json`。本次 codingPlan.eligible=true、tier=pro：

- 11 项 modelCovered=true、funding=coding_plan：DeepSeek V4 Flash、Vision Exp、V4 Pro、V4.1 Flash、V4.1 Flash Eco；GLM-5.3 Flash；Hy4 Preview；Kimi K2.7 Code；MiMo V2.6 Flash / Pro；MiniMax M3.1 Flash。
- 其余 35 项 modelCovered=false。本次 funding=gateway、fundingCheck=insufficient，不能据此声称有钱包可用、也不能将它们当作全球不可用。
- GPT-6 Luna、Claude Haiku 5.5、GLM-5.3 Flash-X 已不在本次账号 Coding Plan 覆盖内，旧的静态附赠分类失效。

HTTP 实测 `GET /api/v1/workspaces/current` 与 `GET /api/v1/workspaces/<id>/billing/preflight?modelId=deepseek-v4.1-flash` 返回 200，与 CLI 当前工作区、成员及模型相符。推理 runtimeKey 只发送到官方 Link；同一次授权的 controlKey 才用于该账号预检。控制令牌不用于推理，runtimeKey 不用于账单读取。

运行时目录按以下口径处理：

1. 精确匹配设备或桌面的 runtime/control 令牌对，再解析工作区与成员；普通 Key 无法匹配时，不借用另一个桌面账号的数据。
2. `/models` 与推理请求携带同一 `x-vela-workspace-id`；预检逐行校验 schemaVersion、workspaceId、workspaceMemberId、modelId 与订阅字段。
3. eligible 且 modelCovered 为 true 归 `opendesign-corouter-plan`。额度用尽后 wallet/gateway 回退不改变覆盖；false 归非附赠；缺失、失败、冲突归未知。
4. 保留历史两个 Provider ID。`opendesign-corouter-paid` 包含非附赠及未知行，设置页逐行明确区分；目录可见不是钱包准入或实际调用成功的证明。
5. 首次读取及十分钟后按需刷新，手动刷新共用在途操作；更新一次发布，通知失败回滚。成功快照用插件随机密钥 HMAC 绑定推理身份、网关、工作区和成员；重启后重新确认身份及权益，旧无绑定快照不恢复附赠分类。

## 官方源码

已检查提交 [`f2ecaa3f`](https://github.com/nexu-io/open-design/tree/f2ecaa3f88e1eba001379ea845e7b7754310ea6d)：

- [amr-model-cache.ts](https://github.com/nexu-io/open-design/blob/f2ecaa3f88e1eba001379ea845e7b7754310ea6d/apps/daemon/src/runtimes/amr-model-cache.ts)：preset 不携带账号权益，remote cache 按作用域保存，十分钟刷新。
- [vela-billing.ts](https://github.com/nexu-io/open-design/blob/f2ecaa3f88e1eba001379ea845e7b7754310ea6d/apps/daemon/src/integrations/vela-billing.ts)：预检绑定 workspace/member/model，funding=gateway 表示交由网关判断。
- [计费契约](https://github.com/nexu-io/open-design/blob/f2ecaa3f88e1eba001379ea845e7b7754310ea6d/specs/current/coding-plan-client-billing.md)：预检不预留额度、不保证运行可完成，Link 是最终准入和计费方。

## 能力与验证边界

容量、输出、图片、思考默认分别按[上下文证据](model-context.md)、[图片证据](model-capabilities.md)、[思考证据](reasoning-evidence.md)维护；未知字段保持缺省。CoRouter 新 ID 与厂商产品的关联不证明网关协议透传，见[协议与问题反馈](protocols.md)。

本次已做真实 scoped 目录和逐模型预检，未把这些读操作当成推理成功或无转译证明。离线测试覆盖身份隔离、分组重算、缓存、协议选择、能力元数据及流式回放；真实推理和安装状态在发布验收中单独报告。
