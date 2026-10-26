# 套餐赠送模型空轮监控

参考：[FYTXY/dsh-empty-turn-guard 0.4.0](https://github.com/FYTXY/dsh-empty-turn-guard)，MIT，Copyright (c) 2026 FYTXY。许可见 [第三方声明](../THIRD_PARTY_NOTICES.md)。

## 判定

[守卫](../src/empty-turn.ts) 沿用参考实现的三个必要条件：

1. 响应以 `stop` 结束。
2. 本步未出现任何 tool-call（start、delta 或 end 均能保护工具步）。
3. 可见文本为空，或剥离已知 DSML / thinking / 返璞归真标记后为空。

思考通道有内容、但没有可见答案时，仍视为空轮。正常回答、包含真实正文的协议标记、工具调用、max-tokens、aborted 和已有 error 均不改写。

## 接入

[适配器](../src/adapter.ts) 每条请求创建独立 tracker，仅对套餐赠送 Provider、开启 `emptyTurnGuard` 且携带工具的对话启用。付费 Provider 和无工具后台请求不启用。

守卫只将最终结束原因改为 `error / EMPTY_RESPONSE`；不删除之前发出的块，不注入消息，不修改历史，不执行或重放工具，不自动重启。原生零内容响应仍由 [SSE 解析器](../src/stream.ts) 拒绝，与附加监控开关无关。

## 重试与成本

重试执行者是宿主已有的 `dsh-llm-retry` / Provider 策略，不是守卫本身。`EMPTY_RESPONSE` 属于宿主默认可重试集合；未装重试插件时只会显示错误。重复请求会额外消耗额度，重试耗尽不保证成功。

监控仅累计命中次数；内部证据只有长度 / 标志，无正文。所有 tracker 状态按请求隔离，回调异常不影响模型流。

## 验证

[守卫测试](../test/empty-turn.test.ts) 覆盖残渣、真实回答、思考后无答案、工具三形态、截断、开关与并发隔离。[适配器测试](../test/adapter.test.ts) 验证赠送 / 付费路由隔离及无工具跳过。

尚未以真实赠送模型故障样本验证端到端重试效果；不把合成测试当作上游已修复的证明。
