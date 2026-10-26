<div align="center">

# OpenDesign CoRouter for DSH

**模型接进来，额度看清楚。**

在 DeepSeek Harness 中使用 CoRouter 模型，分开查看套餐赠送窗口与钱包余额；桌面登录态优先，也能独立登录。

[![CI](https://github.com/KouzakiUmi/dsh-opendesign-corouter/actions/workflows/ci.yml/badge.svg)](https://github.com/KouzakiUmi/dsh-opendesign-corouter/actions/workflows/ci.yml)
[![DSH Core](https://img.shields.io/badge/DSH_Core-0.2.1--rc.3-64748b)](#兼容性)
[![Node.js](https://img.shields.io/badge/Node.js-%3E%3D24.9-64748b)](#开发与构建)

[快速开始](#快速开始) · [功能预览](#功能预览) · [连接与凭据](docs/usage.md) · [常见问题](docs/troubleshooting.md) · [更新记录](docs/changelog.md)

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="docs/previews/overview-dark.png">
  <img src="docs/previews/overview-light.png" width="1040" alt="CoRouter 四层额度概览：套餐赠送窗口、套餐余额、充值赠送金额与总额度；模拟数据">
</picture>

<sub>真实组件 · 模拟数据 · 离线预览，不是运行中的 DSH 或真实账号截图</sub>

</div>

## 快速开始

### 1. 通过 DSH 安装

```console
dsh plugin --profile web add dsh-opendesign-corouter
```

也可打开 [Actions → CI](https://github.com/KouzakiUmi/dsh-opendesign-corouter/actions/workflows/ci.yml)，从成功构建下载 **`dsh-opendesign-corouter-build`** artifact。登录 GitHub 后解压 ZIP，取得 `.tgz` 与 `.sha256`，再安装本地包：

```console
dsh plugin --profile web add /absolute/path/to/dsh-opendesign-corouter-0.1.2.tgz
```

`web` 只是示例，请替换为目标 Profile。Desktop 使用桌面安装器提供的 `dsh` 入口；独立公共 CLI 不能代管保留的 `desktop` Profile。安装后的启用与重载按目标 DSH 的管理流程进行。

### 2. 配置连接

1. 打开 **设置 → OpenDesign CoRouter → 连接与登录**。
2. 为推理配置 CoRouter 工作空间 **API Key**，或沿用启动环境中的 `COROUTER_API_KEY`。
3. 额度默认读取桌面登录态；没有桌面端时，点击 **登录并保存会话**，在官方页面自行完成登录。
4. 回到模型选择器，选择 **OpenDesign CoRouter · 套餐赠送** 或 **OpenDesign CoRouter · 付费模型**。

**API Key 用于推理，桌面 / 控制台会话用于查额度。两者不能互相代替。** [完整连接说明](docs/usage.md)

## 功能预览

### 两个 Provider，逐模型配置

| Provider | 模型数 | 用途 |
| --- | ---: | --- |
| `opendesign-corouter-plan` | 12 | 官网 Design Plan 套餐赠送模型 |
| `opendesign-corouter-paid` | 21 | 其余公开对话模型 |

上表为内置目录。模型页可从 OpenAI `/models` 端口刷新，逐个启用或停用模型，并配置温度、top-p、默认输出上限、上下文预算及思考深度。停用同时影响模型选择器和直接调用；参数会保存并应用到实际请求。媒体生成接口不在对话目录中，未知能力不按名称猜测。

推理协议可选 **OpenAI Chat Completions、OpenAI Responses、Anthropic Messages**。模型发现始终使用 OpenAI 端口，不随推理协议切换。

> **分组不等于计费隔离。** 赠送额度耗尽后是否转扣套餐余额或钱包，由服务端和账号权益决定。选择“套餐赠送”不能保证绝不消耗钱包余额。

### 四层额度，不重复相加

- **套餐赠送窗口**：各自显示已用、剩余及重置时间。
- **套餐余额**：订阅池的可用金额。
- **充值 / 赠送金额**：钱包中对应池的可用金额。
- **总额度**：接口报告的总余额，不再与分池数字重复相加。

接口缺失或权限不足时显示未知 / 部分可用，不补成 0。窗口重置、订阅账期结束和下次自动刷新分别显示。桌面通道只有部分额度且已有完整独立会话时，会整体切换到独立会话并标明来源，不拼接账号数据。额度身份与推理 Key 的账号 / 工作区仍需保持一致。

### 桌面优先，也能独立登录

不复制或修改桌面配置。独立登录使用临时 Chrome 窗口，用户亲自完成官方登录与人机验证；验证通过才保存到 DSH 凭据服务。支持取消、超时和卸载清理，不触碰日常浏览器。

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="docs/previews/theme-dark.png">
  <img src="docs/previews/theme-light.png" width="1040" alt="连接与登录页，展示桌面优先开关、独立登录按钮和不回填的 API Key 输入框；模拟数据">
</picture>

### 空轮监控，只作用于赠送模型

独立开关，默认开启。参考 [dsh-empty-turn-guard](https://github.com/FYTXY/dsh-empty-turn-guard)，将“正常 stop、没有工具调用、答案为空或只剩协议残渣”的工具对话标成 `EMPTY_RESPONSE`。

监控不注入提示、不修改正文、不重放工具、不自动重启；实际重试交给宿主策略，**可能额外消耗额度**。付费 Provider 和无工具后台请求不启用这项附加监控。

## 使用前先知道

- **数字不是账单**：部分读取接口属于桌面 / 控制台私有协议，可能随上游变化。
- **凭据不是加密承诺**：插件使用 DSH 凭据服务，不把 Key / Cookie 放进普通设置或回填网页；落盘保护仍取决于宿主凭据实现和本机权限。
- **验证有范围**：已做类型检查、隔离 Loader 装载 / 卸载 / 重载、离线界面与主题检查；尚未完成本插件的真实账号登录、推理及生产 Profile 联调。

## 兼容性

| 项目 | 要求 / 证据 |
| --- | --- |
| 目标 DSH Core | `0.2.1-rc.3`，以官方同版本发布包验证 |
| Core 声明范围 | `>=0.2.1-rc.3 <0.3.0-0`，范围内其他版本不代表已实测 |
| Node.js | `>=24.9.0` |
| 独立登录 | 本机 Google Chrome；插件不会自动下载 |
| 默认推理接口 | `https://amr-link.open-design.ai/v1/chat/completions` |

CI 在 Windows 与 Ubuntu 执行构建、类型检查及隔离测试；Ubuntu 另执行四页签浏览器和亮暗主题检查。通过 CI 不等于已安装或已通过真实账号验收。[开发与验证范围](docs/development.md)

## 开发与构建

```console
git clone https://github.com/KouzakiUmi/dsh-opendesign-corouter.git
cd dsh-opendesign-corouter
npm ci --ignore-scripts
npm run check
npm run test:ui
```

本地 UI 测试需要 Chrome，页面使用模拟数据并阻断联网。源码 checkout 不包含预构建 `lib`；需要安装本地目录时，先运行构建。[开发与 CI](docs/development.md)

## 文档与反馈

[使用指南](docs/usage.md) · [排障](docs/troubleshooting.md) · [更新记录](docs/changelog.md) · [安全边界](SECURITY.md) · [第三方声明](THIRD_PARTY_NOTICES.md)

通过 [Issues](https://github.com/KouzakiUmi/dsh-opendesign-corouter/issues) 反馈时，请附插件版本、DSH **Core** 版本和已脱敏的错误说明。不要贴 API Key、Cookie、凭据文件或含秘密的 URL。

本项目采用 [MIT 许可](LICENSE)，上游版权声明见 [第三方声明](THIRD_PARTY_NOTICES.md)。版本标签通过 GitHub OIDC trusted publishing 发布到 npm，流程见 [发布说明](docs/publishing.md)。本项目与 OpenDesign、DeepSeek 无官方隶属关系。
