# CoRouter 接入与模型来源

观察日期：2026-10-26。来源为 Open Design 0.26.1 客户端代码契约及 [CoRouter 官方首页](https://corouter.open-design.ai/zh/) / [模型目录](https://corouter.open-design.ai/zh/models/)。

## 接入

官网首页内联 `data-corouter-settings.copy` 的 OpenCode / Hermes 模板给出 OpenAI 兼容基址，首页示例使用 `chat.completions.create`：

```text
POST https://amr-link.open-design.ai/v1/chat/completions
Authorization: Bearer <工作空间 API Key>
```

推理使用 API Key，不把桌面 `controlKey` 或浏览器 Cookie 混入该通道。客户端内部控制面仍是 `https://amr-api.open-design.ai`；品牌名称不同不意味着这两个鉴权通道可以互换。

## 模型目录

[模型表](../src/catalog.ts) 收录官网详情页 `data-model` JSON 公开的 33 个对话模型 ID / 名称：

- 12 个官网 Design Plan 覆盖模型归入 `opendesign-corouter-plan`。
- 其余 21 个公开对话模型归入 `opendesign-corouter-paid`，不局限于套餐可抵扣子集。

这只是本地目录分类。实际权益、余额回退、扣款池与可用性由 OpenDesign 服务端决定；不能把“套餐赠送 Provider”解释为保证绝不动用钱包。

客户端模型目录来自 `vela model list --all --format json`；其静态 preset 属于旧目录，不含完整当前套餐权益，因此没有用旧 preset 覆盖官网模型表。未公开精确 ID 的型号，以及需要媒体专用接口的图像生成型号，不编造 chat ID。

## 能力元数据

套餐组 12 个模型的上下文、输出上限、输入模态和思考档位移植自同一推理端点的 [dsh-opendesign-go 0.1.9](https://github.com/EliteOtaku/dsh-opendesign-go) 元数据。它是部署参考，不是本项目对每个模型的真实调用证明。

其余模型缺少可核实的能力字段时保持未知，不用模型名称猜图像支持，也不臆造思考档位。目录与元数据由 [目录测试](../test/catalog.test.ts) 约束。

当前适配器为 Chat Completions；不声称已经实现 Responses、Anthropic Messages 或媒体生成接口。没有使用真实 Key 进行模型目录或推理调用验收。
