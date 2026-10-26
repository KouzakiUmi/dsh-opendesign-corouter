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

npm 要求包记录先存在，才能建立 trusted publisher。首次发布由维护者通过网页登录与 Windows Hello / 安全密钥验证，使用已通过 CI 的同一安装包。之后再绑定上述信任配置。

首次人工发布与后续 OIDC 发布的认证来源不同。Windows Hello 验证由维护者本人完成；后续 CI 使用短期 OIDC 授权。首次人工发布的版本通常没有 CI provenance，后续由工作流实际发布的新版本才验证 provenance 记录。

配置前后可用维护者会话运行 `npm trust list dsh-opendesign-corouter --json` 核对绑定。OIDC 权限应通过实际发布操作验证，`npm whoami` 不能证明 trusted publisher 有效。

[返回主页](../README.md) · [开发与 CI](development.md) · [npm 官方文档](https://docs.npmjs.com/trusted-publishers/)
