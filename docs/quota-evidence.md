# 额度与登录契约

来源：[dsh-subusage 0.16.2](https://github.com/KouzakiUmi/dsh-subusage)、[dsh-opendesign-go 0.1.9](https://github.com/EliteOtaku/dsh-opendesign-go)，以及 Open Design 0.26.1 客户端的登录态读取 / 钱包调用代码。私有接口可能变化，以下是版本相关的实现证据，不是官方稳定 API 承诺。

## 四层口径

[额度实现](../src/quota.ts) 沿用 subusage 的窗口解析与钱包换算，展示分为：

| 层 | 来源 |
| --- | --- |
| 套餐赠送窗口 | `coding-plan-usage.windows` 的 used / limit / remaining / resetsAt |
| 套餐余额 | `balances.subscriptionCredits / creditsPerUsd` |
| 充值 / 赠送金额 | `balances.rechargeCredits / creditsPerUsd` |
| 总额度 | `balanceUsd`，或接口报告的其他等价总余额字段 |

窗口不是钱包分母，不外推月额度，不把几层数字重复相加。remaining 优先保留接口报告值。未知字段不补 0，团队工作区不混入未经核实的个人钱包。

## 桌面优先通道

[会话解析](../src/auth.ts) 只读桌面 `AMR_HOME/config.json`（默认用户主目录下 `.amr`），使用生产 profile 的 controlKey。严格限制控制面为 `https://amr-api.open-design.ai`；非生产环境或非法地址不会改投生产。

[桌面额度](../src/desktop-quota.ts) 只使用有证据的 Bearer 钱包端点和固定只读 CLI argv：

```text
GET https://amr-api.open-design.ai/api/v1/wallet/balance
vela team-projects list
vela billing funding-check --workspace-id <真实 workspaceId> --format json
```

不猜测 funding-check 的 HTTP 路径，不将 Bearer 发到只验证过 Cookie 用法的控制台接口。桌面令牌权限较窄时仅展示可确认的窗口 / 总额，其余分池标为未知。桌面认证失效可整体回退到独立登录，不拼接两个身份的池子。

## 控制台 Cookie 通道

```text
GET https://amr-api.open-design.ai/api/v1/workspaces/current
GET https://amr-api.open-design.ai/api/v1/workspaces/<真实 workspaceId>/billing/coding-plan-usage
GET https://amr-api.open-design.ai/api/v1/billing/summary
```

先取得真实 workspaceId，再查询窗口；只有 personal 工作区读取账号钱包汇总。401 使身份失效，403 表示该层读取权限不足，允许另一层已成功结果独立显示；不会用成功结果掩盖 401。

## 独立登录

[登录实现](../src/login.ts) 使用独立非持久 Chrome 上下文，用户在官方控制台亲自登录；只提取对控制面 URL 生效、尚未过期的 Cookie。额度端点验证通过后经 DSH credentials 的插件专属 grant 原子保存，不写桌面文件。

- 状态封闭为 idle / launching / waiting / verifying / success / cancelled / error。
- 五分钟超时；取消、关闭窗口和卸载清理自身浏览器。
- 登录起点捕获 revision，提交前检查记录 / 配置冲突与 AbortSignal。
- 持久化成功是提交边界；写入后不谎称取消能撤回。
- Cookie 的最早声明过期时间透传保存；未声明过期的会话型 Cookie 记为 0，不猜截止时间。

测试使用合成凭据和注入的请求 / 浏览器桩，不访问真实账号。完整取数、真实 Chrome 登录和 API Key 推理仍需后续账号验收。
