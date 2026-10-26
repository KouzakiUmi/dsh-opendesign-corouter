# 第三方代码与资料

本项目的消息/图片兼容处理、套餐模型元数据参考 [dsh-opendesign-go 0.1.9](https://github.com/EliteOtaku/dsh-opendesign-go)。额度归一化及登录生命周期的基础处理改编自 [dsh-subusage 0.16.2](https://github.com/KouzakiUmi/dsh-subusage)；临时授权窗口的 Chrome 启动策略改编自 [dsh-subusage 0.16.3](https://github.com/KouzakiUmi/dsh-subusage) 的 `lib/cookie-login.js`。空轮判定参考 [dsh-empty-turn-guard 0.4.0](https://github.com/FYTXY/dsh-empty-turn-guard)。设置布局参考 [dsh-code-pill](https://github.com/KouzakiUmi/dsh-code-pill)。

离线主题夹具使用 [DeepSeek Harness 官方主题令牌](https://github.com/deepseek-ai/deepseek-harness/blob/22ddee3792402c3e70ec5f86a63c3e3e895a2f60/packages/client/ui-theme/src/styles/design-platform.css)，仅供测试，不随插件安装包分发。

Client bundle 内含 [Zod 4.6.6](https://github.com/colinhacks/zod) 与 DSH 协议辅助代码，分别保留 Colin McDonnell 与 DeepSeek 的 MIT 声明。

Host 侧运行时依赖 [playwright-core 1.63.0](https://github.com/microsoft/playwright)（Apache-2.0），只用于启动显示官方授权页的临时 Chrome 窗口：不下载浏览器，使用本机已安装的 Chrome。它按 npm 依赖安装，不并入本项目源码。

```text
                                 Apache License
                           Version 2.0, January 2004
                        http://www.apache.org/licenses/

Copyright (c) Microsoft Corporation.
Licensed under the Apache License, Version 2.0 (the "License");
you may not use this file except in compliance with the License.
You may obtain a copy of the License at

    https://www.apache.org/licenses/LICENSE-2.0

Unless required by applicable law or agreed to in writing, software
distributed under the License is distributed on an "AS IS" BASIS,
WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
See the License for the specific language governing permissions and
limitations under the License.
```

以上项目为 MIT 许可。保留如下版权和许可声明，适用于相应移植与改编部分：

```text
MIT License

Copyright (c) 2026 EliteOtaku
Copyright (c) 2026 KouzakiUmi
Copyright (c) 2026 FYTXY
Copyright (c) 2026 DeepSeek
Copyright (c) 2025 Colin McDonnell

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

模型 ID / 分组来自 [CoRouter 官方目录](https://corouter.open-design.ai/zh/models/) 与 [官方套餐页](https://corouter.open-design.ai/zh/)，观察日期 2026-10-26。仅使用接入所需事实，不分发 OpenDesign 客户端代码、资源或账号数据。
