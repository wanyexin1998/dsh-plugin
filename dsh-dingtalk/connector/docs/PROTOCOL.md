# Connector 协议（v1）

传输：每调用方一条 Unix Domain Socket（生产默认），HTTP/1.1、`POST` JSON。仅测试模式支持 `127.0.0.1` + `Authorization: Bearer <capability token>`。业务 socket 与 admin socket 分开，请求体 ≤ 64 KiB，响应 ≤ 1 MiB。

所有路由为固定路径，不接受查询串；字段白名单精确匹配，未知字段返回 `invalid_request`。响应统一为：

```json
{ "ok": true, "value": { } }
{ "ok": false, "error": { "code": "<reasonCode>" } }
```

`reasonCode` 来自插件共享错误码表；未知错误一律 `service_unavailable`，不回传原始 DWS 报错、路径或堆栈。

## 业务面（调用方身份由 socket 决定）

| 方法 | 路径                       | 请求                                            | 响应 value                                                             |
| ---- | -------------------------- | ----------------------------------------------- | ---------------------------------------------------------------------- |
| GET  | `/v1/health`               | —                                               | `{ ok, protocol, version, callbackOrigin? }`                           |
| POST | `/v1/status`               | `{}`                                            | `{ status: ConnectionStatus, identity: { corpId, userId } \| null }`   |
| POST | `/v1/prepare`              | `{}`                                            | `{ state: "ready"\|"failed", reasonCode?, callbackOrigin?, protocol }` |
| POST | `/v1/authorization/begin`  | `{ origin, returnPath }`                        | `{ transactionId, authorizeUrl, expiresAt }`                           |
| POST | `/v1/authorization/status` | `{ transactionId }`                             | `{ status: ConnectionStatus }`                                         |
| POST | `/v1/authorization/cancel` | `{ transactionId }`                             | `{ status: ConnectionStatus }`                                         |
| POST | `/v1/invoke`               | `{ operationId, args, sessionId?, confirmed? }` | `{ result: InvokeResult }`                                             |
| POST | `/v1/disconnect`           | `{}`                                            | `{ disconnected: boolean }`                                            |

约束：

- `invoke` 只接受本次交付的服务器操作：`dws.catalog`、`dws.describe`、`dws.execute`、`dws.jobs`、`identity.getSelf`、`calendar.listEvents`、`docs.search`。其他 operationId 返回 `command_unavailable`（HTTP 403）。`dws.execute` 执行锁定目录里的官方命令，包括读、写、文件和后台任务；`dws.jobs` 列出、读取或停止这些任务。写操作、文件操作和后台任务要先由 Host 完成原生确认，再带 `confirmed: true`；模型参数里不能带 `confirmed` 或 `yes`。`sessionId` 只标识本调用方的后台任务属主。参数复用插件的 `parseInvokeInput`。请求体和 `args` 不能带 `userId`、`corpId`、`profile`、`token`、`code`、`cookie`、`authorization`、`argv`、`path`、`url`、`home`、`keychain`、`configDirectory`、`binaryPath`；调用方是谁由 socket 绑定决定。
- `status` 返回调用方本人的绑定身份，仅供 Host 与本调用方使用；`createConnectionService` 的白名单投影不会把 `corpId/userId` 投影给 Client 或模型。
- `authorization/begin` 的 `origin` 必须精确命中 Connector 配置的受信 Origin 列表，`returnPath` 只能同源绝对路径，且不得携带 token/code/secret/state 参数。
- `identity` 只在 Connector 判定为已连接（或仅缺在线业务核验）时返回，否则 `null`。

IM 调用可以携带 Host 生成的 `expectedProfile`。Connector 仅在本 socket 的当前绑定与该值一致时执行，绑定不同返回 `identity_mismatch`。设备验证链接须手动输入授权码时，开始页显示该码和官方验证链接。

## 管理面（独立 socket + admin token）

请求头必须带 `x-dsh-connector-admin-token: <admin.token>`。

| 方法 | 路径                        | 请求                           | 说明                                                                                            |
| ---- | --------------------------- | ------------------------------ | ----------------------------------------------------------------------------------------------- |
| POST | `/admin/v1/health`          | `{}`                           | 进程/协议/调用方数量，无秘密                                                                    |
| POST | `/admin/v1/bindings`        | `{ callerId, corpId, userId }` | 生产绑定。管理面 admin token。拒绝 `test-*`。业务 socket 不能调用                               |
| POST | `/admin/v1/test-identity`   | `{ callerId, corpId, userId }` | **仅测试模式**（`DSH_CONNECTOR_TEST_IDENTITY=1`），且只接受 `test-*` 合成身份。禁止用于真实用户 |
| POST | `/admin/v1/bindings/remove` | `{ callerId }`                 | 撤销并删除调用方绑定/socket                                                                     |
| POST | `/admin/v1/revoke`          | `{ callerId }`                 | 撤销授权、阻断在途调用，保留绑定以便重新授权                                                    |
| POST | `/admin/v1/callers`         | `{}`                           | 调用方 ID、连接状态、是否绑定；不含身份或凭据                                                   |

管理面没有"以任意身份调用业务接口"的入口；不存在调试 impersonation API。未来平台通过管理面创建授权事务时，应沿用同一信任模型（见 `docs/CELLGENT-INTERFACE.md`）。

## 身份通道

- UDS：socket 位于私有卷 `<sockets>/<callerId>/dsh.sock`（每调用方独立目录，目录 0700、文件 0600；可用 `DSH_CONNECTOR_SOCKET_MODE=0660` 支持同组多 UID）。调用方只挂载自己的目录；Connector 重启会在同一路径重建 socket，目录挂载可保持连接路径稳定。
- 测试 loopback：`DSH_CONNECTOR_TRANSPORT=loopback` + `DSH_CONNECTOR_ALLOW_TEST_TRANSPORT=1`，每调用方一个 0600 capability token 文件；仅用于无 UDS 的开发/测试环境，文档标注不用于生产。
- 调用方身份 → `corpId:userId` 的绑定保存在私有卷 `bindings.json`；绑定与 DWS profile 不一致时返回 `identity_mismatch`，绝不复用旧账号 Token。

## 授权状态机

`authorizeUrl` 指向 `https://<public-origin>/dsh-dingtalk/start?t=<一次性 ticket>`；浏览器经 TLS 代理访问（Connector 仅监听 loopback，代理设置 `X-Forwarded-Proto: https`）。`begin` 在该用户自己的 DWS 里启动 `auth login --device --no-browser --yes`，不传企业应用 Client ID 或 Secret。stderr 出现官方 CLI 的验证码和确认链接后，开始页校验 ticket、Host 和协议，再 302 到该确认链接。CLI 完成后核验登录身份就是绑定的 `corpId:userId`，并做一次 `identity.getSelf` 在线验证后保存绑定。失败不覆盖旧的有效授权。旧的 `/dsh-dingtalk/callback` 不再换票。

## 限制与错误

- 每用户一个执行队列（默认 8 等待、5s 排队、15s 执行、256 KiB 输出），在途调用可被撤销中止；失败/结果未知不盲目重试，写操作返回 `outcome_unknown` 语义由插件侧统一处理。
- Connector 进度：`unlinked` → `authorizing` → `connected` / `auth_timeout` / `user_cancelled` / `identity_mismatch` / `revocation_failed` 等，沿用插件 `ConnectionStatus` 枚举。
