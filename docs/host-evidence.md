# DSH 官方基线与验证

目标为 **DSH Core 0.2.1-rc.3**。参考 [官方源码固定提交](https://github.com/deepseek-ai/deepseek-harness/tree/22ddee3792402c3e70ec5f86a63c3e3e895a2f60) 及 npm 发布的同版本类型 / JavaScript；开发依赖由锁文件固定，不依赖外部 checkout。

## Host

[适配器](../src/adapter.ts) 使用公开 LlmAdapter、prepareCall 和 StreamChunk，缓存 token 按非重叠口径计算，usage 先于 finish。prepareCall 捕获同一代配置，防止模型信息与请求设置跨代。默认输出预算会作为 max_tokens 明确发送。

[服务](../src/index.ts) 使用 Cordis 作用域清理，凭据通过 credentials 的插件专属记录和原子修改接口保存。服务使用 TypeScript private 字段，以兼容 Cordis 接收者代理。文件内容由 Core 先投影成文本，不接受绕过 Core 的原生 file 块。

## RPC 与 Client

[本地生成器](../scripts/generate-remote.mjs) 从 @Remote 标注及参数 / 返回类型生成受限的单参数 JSON 接口，遇到不支持的签名会失败。它使用官方 createTypertRemoteInfo 格式，不是官方 monorepo 生成器；业务值仍由 [白名单解析器](../src/remote.ts) 验证，Cookie / Key 不在状态响应中。

Host 产物具名导出 TYPERT，经 ./typert 交由官方 Typert Loader 自动注册；主插件不重复注册。Client 挂载生成的 ./remote 信息，经命名输入解析和 invoke 调用，零参数方法实际传零个实参。工厂只接收 require 并返回局部 module.exports，不依赖不存在的额外参数。

UI 通过 configForms 写入 volatile 配置，RPC 可用性由 ctx.inject 生命周期驱动，不轮询服务。自定义设置页禁用宿主重复生成的自动表单。

## 验证范围

[隔离组合测试](../test/plugin.test.ts) 覆盖双 Provider、生成元数据、完整卸载和重载。[Host 测试](../test/host.test.ts) 覆盖服务代理、原子写冲突、桌面认证失效回退和额度节流。离线 Chrome 使用模拟数据，验证页签、零参数调用、Key 保存清空、开关、键盘导航、移动深色布局及资源清理。

已完成独立设备授权、模型目录读取及逐模型计费预检，详见[连接与模型证据](client-evidence.md)和[额度证据](quota-evidence.md)。上述实测在隔离脚本中进行；已安装 Profile 的界面到凭据持久化，以及真实推理尚待验证。
