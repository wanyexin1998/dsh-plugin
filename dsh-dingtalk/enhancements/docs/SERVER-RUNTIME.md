# 服务端运行模式（mode=connector）

本页说明插件 Host 侧的服务端运行方式。范围：`enhancements/src/host/` 与 `enhancements/src/adapters/remote/`。固定 DWS Linux 制品见 [LINUX-DWS.md](LINUX-DWS.md)，独立 Connector 见 `../../connector/`。

## 选择后端

插件配置只允许 `mode: "local" | "connector"`（以及明确拒绝的 `"cellgent"` 占位）：

| 配置 | 行为 |
| --- | --- |
| `mode: "local"`（默认） | 现有单用户本机 LocalBackend，行为不变：Windows 本地授权、个人机器人、enterprise 共享机器人、ToolView/设置页均保留。 |
| `mode: "connector"` | `createRemoteConnectionFor()` 从 Host 环境读取 Connector 端点，走远端 Backend；本地 Catalog/Describe 仍在 Host 侧完成。 |
| `mode: "cellgent"` | 继续显式报错并提示改用 `connector`；不会静默回退 LocalBackend，也不会声称已支持 Cellgent。 |

`connector` 模式的 Host 私有环境（不进入插件配置投影、Tool 参数或 Client）：

```bash
DSH_DINGTALK_CONNECTOR_SOCKET=/run/dsh-connector/caller-a.sock   # 每条 socket 一个调用方
DSH_DINGTALK_TRUSTED_ORIGINS=https://dsh.example.com            # 精确受信浏览器 Origin
# 仅测试传输（无 UDS 的环境）：
# DSH_DINGTALK_CONNECTOR_URL=http://127.0.0.1:8791
# DSH_DINGTALK_CONNECTOR_TOKEN_FILE=/run/secrets/caller-a.token
# DSH_DINGTALK_CONNECTOR_ALLOW_TEST_TRANSPORT=1
```

配置缺失、契约不匹配、Connector 离线时，插件返回 `backend_not_ready`/`service_unavailable`，DSH 正常对话不受影响；不会借用其他调用方的实例或默认账号。

## 远端 Backend 行为

- 复用同一 `DingtalkBackend`/`ConnectionService` 契约与公开投影：`status`、`beginAuthorization`、`getAuthorizationStatus`、`disconnect`、`invoke`。`getSelf/calendar/docs` 经 Connector；`dws.catalog/describe` 在 Host 本地完成且不产生登录态副作用；`dws.execute/jobs` 在远端模式直接 `denied/command_unavailable`，不会发往 Connector。
- `prepareStart/Status/Cancel` 走 Connector 的 `/v1/prepare`（DWS 完整性、版本、可执行性预检），客户端准备流程与本地模式一致。
- 浏览器授权：Host 校验浏览器上下文后请求 Connector；`authorizeUrl` 为 Connector 的 HTTPS 受信 Origin。`bootstrap` 返回 Host 提供的 `callbackOrigin`，Client 只接受该精确来源的 `/dsh-dingtalk/start` 地址（不再硬编码 loopback）。
- 身份：Connector 只在已连接时返回调用方自己的 `corpId:userId`；Host 仅用于 IM 身份校验（`invokeFor`），不投影给 Client/模型。
- Connector 返回的 `account` 仅为脱敏展示占位，不包含 ID、路径或凭据。

## 安全边界

- 业务请求体不接受身份、凭据、路径、URL、argv；两侧都做字段白名单。
- 本地 loopback 授权保持原样（`127.0.0.1` + 一次性 state/proof cookie）；远端 HTTPS 授权由 Connector 实现，Host 只转发上下文并校验受信 Origin。没有把 loopback 改成 `0.0.0.0` 的代码路径。
- 远端模式不读取本机 DWS Token/Keychain；本地模式仍按原隐私守卫运行。
- 测试传输（loopback + capability token）必须显式开启 `DSH_DINGTALK_CONNECTOR_ALLOW_TEST_TRANSPORT=1`，不用于生产。

## 验证

- 单元测试：`enhancements/tests/remote.test.mjs`（mode 选择、离线降级、状态/准备/调用映射、Catalog 本地化、未开放操作拒绝、协议不匹配、capability token 错误）、`enhancements/tests/oauth.test.mjs`、`bootstrap.test.mjs`（本地模式回归）。
- Linux 容器测试：`connector/tests/linux.test.mjs` 先校验真实固定 Linux DWS 制品（SHA256、ELF、权限、`--version`），再用契约型 fake CLI 驱动 Connector 完整流程，覆盖双用户隔离、错绑/改绑拒绝、撤销、重启恢复、超时/取消、socket 权限与健康接口。使用 fake CLI 的原因：Linux DWS 1.0.66 的 `auth exchange` 对合成 code 走“managed token exchange”，不会使用本地合成端点，因此无法用真实二进制验证 OAuth 全链路；真实企业授权必须另行验收。
- 本机 Windows 环境：DWS `auth exchange --expected-corp-id/user-id` 在隔离临时目录中独立复现为文件锁 `Access denied`，与插件代码无关；无 expected 参数的自动路径可用。服务端验证因此放在 Linux 容器内完成。
- 真实企业授权、scope、IT 权限、真实双用户不在自动化范围，保持待验收。
