# DeepSeek V4.1 Flash 异常结束监控

监控分为协议保护和任务收尾核验，两者由 `emptyTurnGuard` 控制，仅作用于本插件 `deepseek-v4.1-flash` 的工具对话。

## 协议保护

[空轮守卫](../src/empty-turn.ts) 仅在 `stop`、本次没有工具调用、可见回答为空或只有已知 REA / DSML / thinking / 返璞归真残留时改写为 `OPENDESIGN_EOT`。思考内容不能代替可见答案。包含正常正文的操作前言保持成功响应，留给 Agent 收尾核验，不再依赖语言句式把正文改判为请求错误。原有待执行句式匹配已移除。

[适配器](../src/adapter.ts) 将监控范围内、工具调用开始前的缺终态流归为 `TRANSPORT`。原生零内容流由解析器拒绝，监控范围内再归为 `OPENDESIGN_EOT`。实际工具调用、其他模型和无工具请求保留原有语义。

[请求恢复](../src/eot-recovery.ts) 在 `agent/request-error` 边界仅接管本 Provider 的 `OPENDESIGN_EOT`，持久记录 `llm/retry` / `llm/retry-started`，按可取消退避持续重试，直到成功、取消、禁用或卸载。其他错误继续使用宿主策略。直接调用 `ctx.llm.stream()` 不进入 Agent 恢复。

协议保护参考 [FYTXY/dsh-empty-turn-guard 0.4.0](https://github.com/FYTXY/dsh-empty-turn-guard)，MIT，Copyright (c) 2026 FYTXY；见[第三方声明](../THIRD_PARTY_NOTICES.md)。

## 任务收尾核验

[收尾控制器](../src/turn-monitor.ts) 实时观察当前轮的 Session 与 assistant-stream 事件，在 `agent/turn-stopping` 检查点工作：

1. 只处理对应 Provider / 型号、实际携带工具且成功结束的响应；取消、截断、请求失败、工具主动结束以及新输入保留宿主处理。
2. 当前存在未完成的 Goal 时，让既有 Goal 状态和续办组件控制后续，不创建、恢复或修改 Goal。
3. 本会话有运行中或停止中的后台 job，或有仍运行的本地子 Agent / 后代时，记录等待状态，不重新启动它们。后台工作状态读取失败时显示无法确认，不视为已完成。
4. 尚无收尾声明时，仅在该 Agent 的作用域临时注册 `opendesign_finish_turn`，通过 `agent.steer()` 追加一条带证据引用的核验输入。原回答和已执行工具结果保持在历史中，不重放工具。
5. 模型可以实际执行剩余工作，也可以报告 `completed`、`waiting_user`、`waiting_work`、`blocked` 或 `continue`。`continue` 必须说明下一步，后续核验输入会携带这项说明。普通问答可报告完成，需要用户信息时可报告等待用户。

首次核验通常增加一次模型步骤，即使原回答已经完整。收尾是当前 Agent 在已有上下文中做的结构化自检，没有额外选择另一模型、调用任意验收命令或另起子代理。

### 证据与声明

工具只接受受限字段：说明最多 1200 字符，下一步最多 800 字符，证据最多 16 个序号。证据必须对应本轮已观察到的成功工具结果；执行过工具的本轮不能提交无证据的完成声明。保留最近 64 项结果引用和去重指纹，不保留工具参数正文。提示中列出最近结果的序号、工具名及成功标志，正文仍由原历史提供。

完成声明确认的是“模型已报告完成，且所引用结果真实存在”，不是独立证明全部业务要求已经满足。插件不自动检查任意文件、执行测试或认证模型的语义结论；验收范围仍需要对照任务要求。待办清单不是硬性门禁。

声明必须先成为 `tools/result` 的权威成功结果，再由对应根调用的成功 `tool/result` 持久确认。被后置策略阻止、取消或 PTC 外层失败的声明不能结束核验。工具调用使用 Core 的 `concludeTurn()`；泛型工具卡和结果 JSON 同时适用于实时显示与回放，无自定义 Client 卡槽。

### 限额和生命周期

- `turnReviewMaxContinuations`：每轮最多追加的核验 / 续办步骤，默认 3，范围 1–10。
- `turnReviewNoProgressLimit`：连续未出现新成功工具结果的停止阈值，默认 2，范围 1–5。相同工具参数和相同结果不算新进展；改变前言文字也不重置计数。
- 达限后停止插件续办并在设置中记录原因，不把未核实状态伪装成任务完成。限额针对插件追加的步骤，不限制原任务自己的正常工具循环，也不替代协议重试策略。
- 本轮结束、Agent 释放、监控关闭和插件卸载均移除临时工具及尚未消费的本插件输入。按 Agent、轮次和回答序号隔离、去重，不执行其他生产者的待办输入。
- `user/message` 按 Core 的直接消息载荷读取，不套用 assistant 事件的轮次包装；只有新的人类输入会取代旧核验，运行时上下文刷新和后台通知不取消正在进行的收尾。
- 控制器从 `turn/start` 开始观察；在一轮中途首次加载插件不会补读旧日志或恢复旧核验，从下一轮开始工作。

## 设置与观测

设置分别展示空响应 / 残留拦截、已开始请求重试、结束核验和已追加任务步骤的次数，及最近一次固定分类的决定、原因和时间。计数从插件加载起累计；新诊断字段缺失时保留未知，旧版本的协议拦截数仍可单独显示。Client 不接收模型原文、工具参数、证据正文或会话标识。

## Core 兼容依据

基线为包声明的 Core 范围。本实现核对过随包 `0.2.1-rc.3` 的 `dsh-agent-loop`、`dsh-tools`、`dsh-session`、`dsh-agent` 与 `dsh-goal` 行为，而不是用同版本开发分支推断接口。该随包工具注册只有单参数，故采用按需 Agent 作用域注册，不依赖后续增加的 `register(..., { when })`。工具输出 schema 只使用该版本支持的 JSON Schema 子集，长度与条数在工具执行入口强制校验。

公开背景：[Agent 结束检查点](https://github.com/deepseek-ai/deepseek-harness/blob/master/docs/subsystems/core.md#agentturn-stopping--serial)、[Goal 续办组件](https://github.com/deepseek-ai/deepseek-harness/blob/master/packages/goal/goal-round-driver/README.md)。公开主分支可能继续演进，实际消费接口仍以目标 Core 为准。

## 上游问题与验证边界

- [OpenDesign #8687](https://github.com/nexu-io/open-design/issues/8687#issuecomment-6124210593)：维护者确认 Messages 思考流形状丢失，但未证明该现象导致每次漏工具调用。切换 Chat 端点是该报告的缓解方法，不是普遍保证。
- [OpenDesign #8846](https://github.com/nexu-io/open-design/issues/8846#issuecomment-6261273902)：缺少终止事件的 EOF 不应被当作成功完成。
- [OpenDesign #8880](https://github.com/nexu-io/open-design/issues/8880)：Chat 路径的输出预算 / 截断问题，与正常 `stop` 提前结束不同。
- [OpenDesign #699](https://github.com/nexu-io/open-design/issues/699) 与 [#1058](https://github.com/nexu-io/open-design/issues/1058) 涉及旧模式中的文本工具调用泄漏，不能视为当前 DSH 网关路径的相同根因。

[守卫测试](../test/empty-turn.test.ts)、[适配器测试](../test/adapter.test.ts)、[恢复测试](../test/eot-recovery.test.ts) 和[收尾测试](../test/turn-monitor.test.ts) 覆盖两层职责、结构化声明、证据、PTC 根调用失败、预算、后台等待、Goal、取消、禁用、并发隔离和释放。离线 UI 覆盖计数分层、限额保存、回滚、旧状态兼容和主题。

这些回归使用合成模型响应及隔离宿主事件；尚未验证真实 CoRouter 模型的收尾服从率、成本和端到端效果，不将测试通过解释为上游故障已修复。
