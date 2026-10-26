# 额度与登录契约

来源：[dsh-subusage 0.16.3](https://github.com/KouzakiUmi/dsh-subusage/blob/dea7df35497bde56c4df3c3b546b9225d72df4c3/lib/index.js)、[dsh-opendesign-go 的桌面额度实现](https://github.com/EliteOtaku/dsh-opendesign-go/blob/0268db8a819667abdbd7a70fa91532c3cdc375d8/src/vela-billing.ts)，以及 Open Design 0.26.1 客户端的登录态读取 / 钱包调用代码。私有接口可能变化，以下是版本相关的实现证据，不是官方稳定 API 承诺。

## 四层口径

[额度实现](../src/quota.ts) 沿用 subusage 的窗口解析与钱包换算，展示分为：

| 层 | 来源 |
| --- | --- |
| 套餐赠送窗口 | `coding-plan-usage.windows` 的 used / limit / remaining / resetsAt |
| 套餐余额 | `balances.subscriptionCredits / creditsPerUsd` |
| 充值 / 赠送金额 | `balances.rechargeCredits / creditsPerUsd` |
| 总额度 | `balanceUsd`，或接口报告的其他等价总余额字段 |

窗口不是钱包分母，不外推月额度，不把几层数字重复相加。remaining 优先保留接口报告值。未知字段不补 0，团队工作区不混入未经核实的个人钱包。

订阅池周期来自 `billing/summary.subscriptionCurrentPeriodStart/End`。`windows[].resetsAt` 仅用于各个赠送窗口；`nextRefreshAt` 则由本插件缓存策略提供，表示下一次自动读取时间，不能当作额度重置时间。

## 桌面优先通道

[会话解析](../src/auth.ts) 只读桌面 `AMR_HOME/config.json`（默认用户主目录下 `.amr`），使用生产 profile 的 controlKey。严格限制控制面为 `https://amr-api.open-design.ai`；非生产环境或非法地址不会改投生产。

[桌面额度](../src/desktop-quota.ts) 只使用有证据的 Bearer 钱包端点和固定只读 CLI argv：

```text
GET https://amr-api.open-design.ai/api/v1/wallet/balance
vela team-projects list
vela billing funding-check --workspace-id <真实 workspaceId> --format json
```

不猜测 funding-check 的 HTTP 路径，不将 Bearer 发到只验证过 Cookie 用法的控制台接口。桌面结果仅包含可确认的字段；若只有部分额度且已保存的独立会话能给出完整结果，则整体使用独立会话并标明来源。桌面认证失效也可整体回退，不拼接两个身份的池子。`vela billing summary` 和 `workspace-snapshot` 的旧调用曾返回 403，不能据此编造订阅池；`billingState` 是状态字符串，不是余额数据。

## 控制台 Cookie 通道

```text
GET https://amr-api.open-design.ai/api/v1/workspaces/current
GET https://amr-api.open-design.ai/api/v1/workspaces/<真实 workspaceId>/billing/coding-plan-usage
GET https://amr-api.open-design.ai/api/v1/billing/summary
```

先取得真实 workspaceId，再查询窗口；只有 personal 工作区读取账号钱包汇总。401 使身份失效，403 表示该层读取权限不足，允许另一层已成功结果独立显示；不会用成功结果掩盖 401。

## 设备授权登录

本机 OpenDesign 0.26.1 的 daemon 启动 `vela login`，解析 stdout 中的激活网址与用户码。随附 Vela 二进制确认了 `CreateDeviceAuthorization`、`PollDeviceAuthorizationToken` 及请求 / 返回字段。公开[官方解析测试](https://github.com/nexu-io/open-design/blob/26d60298f8129e229a1c10aab4df7ca25b1e9ad3/apps/daemon/tests/vela-login-activation.test.ts)确认设备授权流程；具体 HTTP 请求依据 [opencode-opendesign-auth 0.1.4](https://unpkg.com/opencode-opendesign-auth@0.1.4/index.mjs)交叉核对，不视为标准 OAuth 或服务端稳定契约。

```text
POST https://amr-api.open-design.ai/api/v1/cli/device-authorizations
  { cliVersion: <本插件版本>, host: "DSH CoRouter", profile: "prod" }
  → deviceId, deviceSecret, userCode, activationUrl, pollIntervalSeconds, expiresAt
POST https://amr-api.open-design.ai/api/v1/cli/device-authorizations/<deviceId>/token
  { deviceSecret }
  → 等待状态，或同一响应中完整的 controlKey / runtimeKey
```

[登录实现](../src/login.ts)将官方激活页作为普通链接交给用户。浏览器沿用既有配置；插件不启动或控制浏览器。授权服务发出完整双令牌后，经 DSH credentials 的插件专属 grant 原子保存，不写桌面文件。额度的 403 / 未知数据不影响登录成功判定。

- 状态为 idle / launching / waiting / verifying / success / cancelled / error。只有 waiting 暴露公开授权码、白名单链接与本地有效期；deviceSecret 与双令牌不进入 RPC。
- 每次 HTTP 请求最多 20 秒、响应最多 64 KiB，禁止自动重定向。轮询不早于服务端间隔；等待上限取服务端到期与本地五分钟中较早者。
- 登录起点捕获 revision，提交前检查记录 / 配置冲突与 AbortSignal。取消、超时和卸载中止轮询，不关闭用户浏览器。
- 持久化成功是提交边界；写入后不谎称取消能撤回。设备码有效期不套用为令牌失效期，不推断永久有效或 refresh-token 能力。
- 旧版 Cookie grant 继续按原有效期读取，仅供兼容；新登录不再产生 Cookie grant。

## 设备令牌额度通道

设备 controlKey 使用独立 Bearer 请求，接口依据上述 0.1.4 实现：

```text
GET /api/v1/workspaces/current
GET /api/v1/workspaces/<真实 workspaceId>/billing/preflight
GET /api/v1/billing/summary  （仅工作区明确为 personal）
```

从 preflight 的 `codingPlan` 解析窗口、从 `balanceUsd` 读取报告的总额；个人汇总提供有证据的分池和订阅周期。身份为团队或类型未知时不调用个人汇总，不从桌面 CLI 拼入其他账户的额度。401 表示失效，403 或字段缺失显示部分未知。设备 runtimeKey 仅在没有显式 Key 且目标为官方推理 origin 时用于模型目录和推理。

测试使用合成凭据、注入请求和离线 UI。设备授权服务对本插件 cliVersion 的接受情况、实际激活页返回格式、令牌权限及真实推理仍需账号验收；本次未发起真实授权或读取用户凭据。
