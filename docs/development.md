# 开发与 CI

## 环境与命令

Node.js `>=24.9.0`，以锁文件中的官方 DSH Core `0.2.1-rc.3` 包进行开发。无需另一份 DSH 源码 checkout，不修改宿主或 Profile。

```console
npm ci --ignore-scripts
npm run check
npm run test:ui
```

- `check`：构建 → strict 类型检查 → Node 隔离测试 → 导出 / 工厂 / Patch / 官方 Typert manifest 校验。
- `build`：安全清理本包输出，从 Host 的 @Remote 声明生成受限 JSON 元数据，输出 Host、Client 和声明文件。
- `test:ui`：用本机 Chrome 渲染真实 Client bundle，模拟数据、阻断页面联网；不访问 DSH GUI 或真实账号。

直接运行 Node 测试前需要构建，Loader 组合测试消费真实产物。构建生成的元数据源位于 [生成目录](../src/generated/)，不要手动改表；修改声明后重跑生成或构建。[构建脚本](../scripts/build.mjs) · [生成器](../scripts/generate-remote.mjs)

## CI

[工作流](../.github/workflows/ci.yml) 在 main 推送、PR 或手动触发时执行：

1. Windows 与 Ubuntu 并行执行锁文件安装、构建、类型检查、隔离测试和包入口验证。
2. 两个平台通过后，Ubuntu 安装测试用 Chrome / 字体，执行 UI 和主题检查。
3. 打包 `.tgz`，验证包身份、公开导出与文件清单，生成 SHA-256。
4. 上传 `dsh-opendesign-corouter-build`（安装包与校验文件）及 `ui-previews`（模拟截图与报告），保留 14 天。

构建工作流申请 `contents: read`，官方 Actions 固定到提交。版本标签通过单独的 [发布工作流](../.github/workflows/publish.yml) 复用这些检查，仅发布 job 增加 `id-token: write`，将同一次构建的 tarball 发布到 npm。浏览器与系统依赖在临时 runner 中安装。详见 [发布说明](publishing.md)。

## 本地打包

```console
npm run check
mkdir dist
npm pack --ignore-scripts --json --pack-destination dist > dist/pack.json
node scripts/verify-dist.mjs
```

[包校验脚本](../scripts/verify-dist.mjs) 依据 npm 实际打包清单检查身份、导出及非发布文件，生成 `.sha256`。安装时使用 `.tgz`，不是 artifact 外层 ZIP。

## 验证边界

- Provider / SSE / 转换 / 额度 / 登录均有合成输入测试，不把模拟响应当真实接口成功。
- 官方 Cordis Loader + Typert Loader 组合测试验证自动注册、双目录、卸载和重载；只替换测试环境中的模块到达方式。
- UI 测试覆盖四页签、33 模型、Key 清空、开关、键盘、移动布局、亮→暗→亮切换、错误提示、焦点和强制颜色。
- 主题检查使用官方令牌夹具，检查可用文字与占位文字；不是完整可访问性认证。

真实账号登录、真实模型请求 / 工具执行、生产 Profile 安装与运行中 GUI 验收仍需单独进行。CI 通过仅表示它执行的这些检查通过。

[返回主页](../README.md) · [主题说明](ui-design.md) · [官方接口依据](host-evidence.md)
