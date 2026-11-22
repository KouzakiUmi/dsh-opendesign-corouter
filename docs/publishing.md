# npm 发布

## 自动发布

更新包版本与锁文件，通过 main CI 后，为同一提交推送对应标签，例如版本 `0.1.2` 对应 `v0.1.2`。[发布工作流](../.github/workflows/publish.yml) 只接受稳定语义版本，标签必须与包版本完全一致，且提交属于 main 历史。

工作流复用 [CI](../.github/workflows/ci.yml)，通过 Windows / Ubuntu 检查与浏览器测试后下载同一次运行生成的安装包。发布 job 使用 GitHub OIDC 与 npm provenance，直接发布已校验的 tarball；版本已存在且 integrity 一致则跳过，内容不一致时失败。网络或权限错误会中断，发布后的短暂传播延迟只重查，不重发。

每次只推一个待发布版本并等待结果。GitHub concurrency 用于互斥，不是有序发布队列。手动执行也必须选择对应版本标签。

## Trusted Publisher 配置

在 npm 包设置中绑定：

| 字段 | 值 |
| --- | --- |
| Provider | GitHub Actions |
| Organization or user | `KouzakiUmi` |
| Repository | `dsh-opendesign-corouter` |
| Workflow filename | `publish.yml` |
| Environment | 留空 |
| Allow npm publish | 开启 |
| Allow npm dist-tag | 保持关闭；直接发布自身的 latest 标签由 publish 操作处理 |

仅 publish job 获得 `id-token: write`。npm 要求 GitHub 托管 runner、Node `>=22.14.0`、npm `>=11.5.1`；本仓库使用 Node 24，运行日志显示实际 npm 版本。维护信任关系的 `npm trust` 命令另要求 npm `>=11.15.0`，以及启用 2FA 的包维护者身份。

## 首次发布与 Windows Hello

npm 要求包记录先存在，才能建立 trusted publisher。平台阶段发布流程可以先创建 `0.0.0-stage` 占位记录；当它是包的唯一版本时，工作流允许首次正式发布。维护者通过 Windows Hello / 安全密钥绑定上述信任后，可由 CI 发布首个正式版本并附带 provenance。

已有待审批阶段包的版本应先由维护者审批，同一版本不能重复提交。Windows Hello 用于维护者操作的身份验证，CI 使用短期 OIDC 授权。人工发布与 CI 发布是不同路径，只有实际生成 provenance 的版本才有相应记录。

配置前后可用维护者会话运行 `npm trust list dsh-opendesign-corouter --json` 核对绑定。OIDC 权限应通过实际发布操作验证，`npm whoami` 不能证明 trusted publisher 有效。

## GitHub Release

发布工作流在 npm 完整性与 provenance 核验通过后，为同一标签创建 GitHub Release，附三个资产：不带版本名的 `dsh-opendesign-corouter.tgz`、带版本名的 `dsh-opendesign-corouter-<version>.tgz` 及其 `.sha256`。资产名不带版本，保证[最新安装包](https://github.com/KouzakiUmi/dsh-opendesign-corouter/releases/latest/download/dsh-opendesign-corouter.tgz)在后续发布后仍可下载；市场条目的 `tarball:` 指向该地址。Release 的 latest 由 GitHub 判定（`make_latest: legacy`）。重跑同一标签会更新既有 Release 并覆盖同名资产；npm 侧已发布且 integrity 一致时跳过发布，只补 Release。

## 市场收录（awesome-dsh-plugin）

投稿以 [awesome-dsh-plugin 贡献指南](https://github.com/awesome-dsh-plugin/awesome-dsh-plugin/blob/main/contributing.md) 为准：一个 PR 只添加一个条目文件 `data/plugins/KouzakiUmi__dsh-opendesign-corouter.yml`，不手工改注册表生成的 README。分类为 `model`：本插件注册模型路由，额度展示是附带能力，不是 `usage` 分类的只读用量语义。条目内容：

```yaml
url: https://github.com/KouzakiUmi/dsh-opendesign-corouter
name: KouzakiUmi/dsh-opendesign-corouter
category: model
description:
  en: 'OpenDesign CoRouter providers for DeepSeek Harness: separate Design Plan and paid model pools with per-model coverage preflight, layered quota windows and balances, desktop-session and device login, public website price tiers, per-model context, reasoning and image controls with a chat-side context capsule, and scoped empty-turn monitoring for deepseek-v4.1-flash.'
  zh: '为 DeepSeek Harness 提供 OpenDesign CoRouter 双 Provider：套餐赠送与付费模型池逐模型核实附赠权益，分层额度窗口与余额、桌面登录态与设备授权登录、官网公开价格档、每模型上下文/思考/图片控制与聊天侧上下文胶囊，并对 deepseek-v4.1-flash 做限定范围的空轮监控与恢复。'
tarball: https://github.com/KouzakiUmi/dsh-opendesign-corouter/releases/latest/download/dsh-opendesign-corouter.tgz
```

仓库侧契约（市场 CI 与维护者评审会核对）：

- 仓库设置 `dsh-plugin` topic；`package.json` 声明 `dsh.bundle` manifest 与根目录 `cordis.patch.yml`。
- 根目录 `screenshots.json` 声明 1–8 张仓库内图片；本仓库选六张 `docs/previews` 下的真实组件离线模拟数据界面，由 `npm run test:ui` 重新生成。换截图推本仓库即可，下一次市场构建生效，无需另交 PR。
- 官方 `@deepseek-ai/dsh-*` Core 包位于 `peerDependencies`，范围逐 0.2.x minor 带预发布下界分支（node-semver 只放行比较符元组自带预发布标签的版本，单分支会静默排除其余 minor 的预发布 Core）；`test/peer-range.test.mjs` 守住边界，Core 升新 minor 时补分支并同步测试与 README 兼容表。
- npm 包 `repository` 指回本仓库，市场自动采集关联；条目不写 `npm:` 字段。
- 条目描述只说功能且与代码核对一致；描述变更向市场仓库提 PR，截图与仓库物料变更推本仓库。

### 0.3.5 发布核验

- 2026-11-22 推送 `v0.3.5` 标签（提交 `4c46eb0`）→ [发布工作流 run 45023147988](https://github.com/KouzakiUmi/dsh-opendesign-corouter/actions/runs/45023147988)：首轮 npm 上传成功且 provenance 入透明度日志，但 registry 在 verify 的约 26 秒窗口内未可见而失败；轮询确认 registry 可读 `0.3.5`（含 attestations）后重跑失败 job 转绿，未重复发布。main CI [run 45023144024](https://github.com/KouzakiUmi/dsh-opendesign-corouter/actions/runs/45023144024) success。
- [v0.3.5 Release](https://github.com/KouzakiUmi/dsh-opendesign-corouter/releases/tag/v0.3.5) 三个资产：固定名 `dsh-opendesign-corouter.tgz`、带版本名安装包与 `.sha256`。固定名资产、带版本名资产与 npm tarball 三者 sha256 一致：`c783ea19d40f2abb69ba884c890523493a1c865a300c7437ad2dcc6cfcc504b9`（468048 字节）；`latest/download/dsh-opendesign-corouter.tgz` 解析 HTTP 200。
- 市场投稿 [awesome-dsh-plugin#17806](https://github.com/awesome-dsh-plugin/awesome-dsh-plugin/pull/17806)：单文件条目，分支基于 upstream/main；是否合并由维护者决定。

[返回主页](../README.md) · [开发与 CI](development.md) · [npm 官方文档](https://docs.npmjs.com/trusted-publishers/)
