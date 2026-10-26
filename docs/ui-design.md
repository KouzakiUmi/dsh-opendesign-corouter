# OpenDesign CoRouter 设置 UI 设计

## 目标与结构

设置区只保留一个 `OpenDesign CoRouter` 入口，最大内容宽度 860px，使用四个页签避免把全部控件堆在一页：

1. **概览**：套餐赠送窗口、套餐余额、充值 / 赠送金额、总额度。窗口和钱包分开表达，不用余额推算窗口。缺失值显示 `—`，真实的 `0` 正常显示；无窗口时不补 `0%`。显示更新时间与安全来源标签；`partial` 等异常状态下的 Host `note` 提供恢复指引。
2. **模型**：套餐赠送 Provider、付费 Provider 两张独立卡片，各自维护搜索词。只展示模型 `name`、`id` 与归属，不提供 API、路由或当前会话模型修改控件。
3. **连接与登录**：桌面登录态优先开关、独立登录、API Key。主按钮明确写为“登录并保存会话”，说明用户必须在官方页面亲自完成登录；进行中可取消。官网链接使用 `noreferrer noopener`。
4. **高级**：独立空轮监控开关、已拦截轮数、Base URL 和 API Key 引用名。空轮提示明确说明宿主重试会额外消耗额度。

## 数据与保存边界

- Client 挂载共享 `openDesignCoRouterRemote`，通过 `remote.openDesignCoRouter` 的六个既定方法通信，不访问 Node、真实网页或 Host 内部实现。
- `status()` 是缓存读取。初次挂载、从其他页签返回概览、手动刷新以及登录成功时，执行 `refreshQuota()` 后读取 `status()`，以同步额度、来源和 revision；忙碌期间防止重复刷新。
- 登录进行中仅轮询 `loginStatus()`，终态停止。登录成功触发一次额度刷新，不把不同身份或不同分池的数据自动混合。
- 设置字段使用宿主 `configForms.get('llm-opendesign-corouter')` 的 `getSnapshot()`、`subscribe()` 与 `set()`；React 通过 `useSyncExternalStore` 读取快照。没有自造 `saveSettings` RPC 或网页持久化。
- API Key 只存在于密码输入组件的短暂 state，并通过 `saveApiKey` 发送。保存结束后清空且永不回填；不写入 URL、日志或 LocalStorage。界面只回显 `apiKeyConfigured` 布尔状态。
- RPC 服务通过 `ctx.inject(['remote.openDesignCoRouter'])` 跟踪生命周期，不就绪轮询；可用性最多等待 4 秒，单次调用最多等待 25 秒。卸载时 `AbortController` 清理就绪等待和超时计时器；异步结果另有 mounted 与版本检查，忽略过期响应。

## 视觉与响应式

样式由插件卸载时移除的局部 `<style>` 提供，全部类名使用 `odc-` 前缀。颜色、边框、背景和焦点使用 DSH `--dsw-alias-*` 语义令牌，随宿主浅色、深色及强制颜色模式工作；没有远程字体、图标或其他资源。

桌面钱包额度为三列，窄屏降为两列或一列；模型双栏在窄屏改为单栏。卡片只保留必要标题、短说明与一个主要动作，状态放在对应操作附近。

## 可访问性

- 页签使用 `tablist` / `tab` / `tabpanel`、`aria-selected`、`aria-controls` 和 `aria-labelledby`。
- 支持 Left / Right / Up / Down 循环切换，以及 Home / End；采用 roving `tabIndex`，键盘切换后聚焦新页签。
- 异步状态使用 `role="status"`，操作错误使用 `role="alert"`；输入均有显式 label，焦点使用高可见度令牌描边。
- 错误文案为安全的通用提示，不回显 RPC 上游错误。安全的 `quota.note` 按状态展示；错误指引使用 `role="alert"`。错误前景色与主文字令牌混合，保证官方亮暗主题下小字可读。

## 验证范围

[组件测试](../test/client-ui.test.ts) 覆盖四页签语义、未知额度、真实零值、Host 指引与键盘页签计算。[离线浏览器测试](../scripts/ui-smoke.mjs) 使用官方主题夹具，覆盖亮→暗→亮切换、四页签、按钮悬停、占位文字、焦点、错误提示、移动布局和 Chromium 强制颜色模式。普通可用文字与占位文字按 WCAG sRGB 算法检查至少 4.5:1；大字至少 3:1。禁用控件不计入文字对比度断言，这不是完整可访问性认证。

主按钮采用官方按钮填充 / 前景色令牌，不用系统 Canvas 猜文字颜色。输入框占位文字显式使用次要文字令牌。截图和 [测量报告](previews/theme-contrast.json) 均为模拟数据，不是生产 GUI 或真实账号验收。
