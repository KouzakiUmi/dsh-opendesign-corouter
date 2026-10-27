# DeepSeek V4.1 Flash 异常结束监控

参考：[FYTXY/dsh-empty-turn-guard 0.4.0](https://github.com/FYTXY/dsh-empty-turn-guard)，MIT，Copyright (c) 2026 FYTXY。许可见 [第三方声明](../THIRD_PARTY_NOTICES.md)。

## 判定

[守卫](../src/empty-turn.ts) 对单次模型响应进行判断，三个必要条件同时成立：

1. 响应以 `stop` 结束。
2. 本步未出现任何 tool-call（start、delta 或 end 均能保护工具步）。
3. 可见文本为空、仅含已知 DSML / REA 工具调用文本或 thinking / 返璞归真标记，或者符合简短的待执行操作说明，包括进度说明后紧接下一步操作。

思考通道有内容、但没有可见答案时，仍视为空轮。操作说明使用保守的中英文启发式匹配，不是对模型意图的证明，仍可能漏检或误判；已完成的回答、工具调用、max-tokens、aborted 和已有 error 不改写。识别出的协议文本不会作为工具执行。

## 上游问题记录

- [OpenDesign #699](https://github.com/nexu-io/open-design/issues/699) 报告了 `deepseek-v4-flash` 经 Anthropic API 提前结束，并泄漏带参数的 `<rea:tool_calls>`。该报告不能证明本插件当前网关路径或每次异常的根因。
- [OpenDesign #1058](https://github.com/nexu-io/open-design/issues/1058) 讨论的是 OpenDesign API/BYOK 模式没有执行文本形式的工具调用，导致设计文件区域空白；与 DSH 工具循环不是同一实现路径。
- [OpenDesign #8687](https://github.com/nexu-io/open-design/issues/8687) 报告 `deepseek-v4.1-flash` 经网关 Anthropic Messages 接口出现一段操作前言后 `end_turn`、没有工具调用的情况；报告的客户端和协议与本插件可能不同。
- [OpenDesign #8846](https://github.com/nexu-io/open-design/issues/8846) 报告 Messages 流缺少终止事件；[OpenDesign #8880](https://github.com/nexu-io/open-design/issues/8880) 则报告 Chat Completions 的输出预算和 `length` 截断问题。二者不是同一种结束信号，不能仅凭截图推断具体原因。

## 接入

[适配器](../src/adapter.ts) 每条请求创建独立 tracker，仅对 `deepseek-v4.1-flash`、开启 `emptyTurnGuard` 且携带工具的对话启用。其他套餐模型、付费模型及无工具请求保留原有行为。

守卫将符合条件的最终结束原因改为 `error / OPENDESIGN_EOT`；不执行或重放工具。若流缺少终止事件，且该监控启用并且没有开始工具调用，适配器将中断归类为 `TRANSPORT`。已开始工具调用、监控关闭和其他模型保留原有失败分类。原生零内容响应仍由 [SSE 解析器](../src/stream.ts) 拒绝；仅当监控开启时，适配器把该响应归入 `OPENDESIGN_EOT`。

## 重试与成本

[恢复处理器](../src/eot-recovery.ts) 在宿主 `agent/request-error` 边界仅处理本插件的 `OPENDESIGN_EOT`：先持久记录重试，再进行可取消的指数退避，不限制尝试次数，直至成功、用户取消、监控关闭或插件释放。其他错误继续由宿主重试策略处理，包括 `TRANSPORT`。直接调用 `ctx.llm.stream()` 不进入 Agent 步骤恢复。重复请求可能额外消耗额度，也可能反复得到相同结果。

监控仅累计命中次数；内部证据只有长度 / 标志，无正文。所有 tracker 状态按请求隔离，回调异常不影响模型流。

## 验证

[守卫测试](../test/empty-turn.test.ts) 覆盖工具文本泄漏、待执行操作说明、真实回答、思考后无答案、工具三形态、截断、开关与并发隔离。[适配器测试](../test/adapter.test.ts) 覆盖三种协议的操作说明结束、流未到终态、监控开关、其他模型隔离及无工具跳过。[恢复测试](../test/eot-recovery.test.ts) 覆盖超过五次的持续重试、其他错误委派、取消、释放和多 Agent 隔离。

尚未以真实赠送模型故障样本验证端到端重试效果；不把合成测试当作上游已修复的证明。
