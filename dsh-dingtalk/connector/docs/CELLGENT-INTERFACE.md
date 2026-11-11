# Cellgent 后续接线清单

Connector 已提供生产绑定入口 `POST /admin/v1/bindings`。Cellgent 仍须用自己已经掌握的钉钉身份调用它。**本交付没有修改 Cellgent、cellgent-auth 或 DSH 核心，也没有完成任何真实企业接入。**

## 本期已经交付、Cellgent 可以直接复用的部分

- 独立 Connector 进程：`dsh-dingtalk/connector/`，协议 v1（`docs/PROTOCOL.md`）。
- 每个调用方一条私有 Unix Socket；调用方身份由 socket 决定，业务请求没有身份字段。
- 服务器操作：`dws.catalog`、`dws.describe`、`dws.execute`、`dws.jobs`，以及兼容的 `identity.getSelf`、`calendar.listEvents`、`docs.search`。`dws.execute` 包含读、写、文件和后台任务。其他 operationId 显式拒绝。写操作、文件和后台任务要先经过 Host 确认。
- 每用户独立 `HOME`/`DWS_CONFIG_DIR`/Keychain/绑定/刷新锁；凭据只在 Connector 私有卷。
- 浏览器通过 HTTPS 打开设备登录入口，首次访问绑定该浏览器，刷新时校验其安全 Cookie。员工在钉钉确认后，Connector 核对 corpId/userId；取消或过期的入口失效。
- 撤销、在途中止、重启恢复、健康检查、独立镜像、Compose 模板、备份恢复说明。
- 管理面（独立 socket + admin token）：绑定/撤销/列举，以及仅测试用的合成身份适配器。

## Cellgent 必须实现的接口

1. **可信身份入口**
   - Cellgent 自己完成用户认证，然后调用 `POST /admin/v1/bindings`，创建 `callerId → corpId:userId`。
   - 绑定请求必须来自 Cellgent 的可信服务身份（管理面 admin socket + admin token）。
   - 不得把 `corpId/userId` 选择权交给模型、前端或业务调用参数。不要用 `test-identity` 绑定真实用户。
2. **授权事务发起**
   - 本期授权由调用方经自己的业务 socket 发起。平台化后建议新增（协议 v2，需 bump `CONNECTOR_PROTOCOL`）：
     `POST /admin/v1/authorization/begin { callerId, origin, returnPath }`，由 Cellgent 为指定用户创建一次性授权事务并返回 `authorizeUrl`；事务仍绑定 callerId + 受信 Origin + 过期/重放保护。
3. **生产绑定管理**（Connector 已提供入口；Cellgent 调用它，不把身份放进业务请求）
   - `POST /admin/v1/bindings { callerId, corpId, userId }`，或 `admin bind --caller <id> --corp <corpId> --user <userId>`。请求走管理面，必须带 admin token。
   - Cellgent 把自己已经掌握的钉钉 `corpId:userId` 绑到该席位的 `callerId`。`callerId` 匹配 `^[a-z0-9][a-z0-9-]{1,62}$`。
   - 该入口拒绝 `test-*` 身份。`POST /admin/v1/test-identity` 仍只在 `DSH_CONNECTOR_TEST_IDENTITY=1` 时接受 `test-*`，禁止用于真实用户。
   - `POST /admin/v1/revoke { callerId }`：用户注销/离职/换绑时调用，必须处理在途调用与重授权。
4. **状态与事件**
   - 通过 `GET /v1/status`（各调用方）或管理面状态接口读取 `ConnectionStatus`，不得读取 Token/Keychain。
   - 如需主动通知，可增加管理面 webhook/事件流；不得把业务正文或凭据放进事件。
5. **版本协商**
   - 连接前读取业务面 `GET /v1/health` 的 `protocol`，与 Cellgent 支持的版本比对；不兼容时拒绝服务而不是降级到本机 LocalBackend。
6. **部署与凭据**
   - Connector 的 `admin.token`、TLS 证书、代理凭据由秘密管理下发；不得写入镜像、Git 或日志。
   - 每个 DSH 调用方只挂载自己的 socket；不得把 Connector 私有卷挂进业务容器。

## 明确不在本期范围

- Cellgent / cellgent-auth 的任何代码、SSO、Supabase 表、39/43 服务器操作。
- 真实企业 OAuth、scope、IT 权限、真实双用户与机器人收发验收。
- 机器人 Stream 的自动启用；gateway 模板默认不启动真实 Stream。
- 把本单完成描述为 "Cellgent 已接入"。

## 待真实环境验收的清单

- [ ] 真实企业 corpId 下的自有应用/官方应用授权（clientId、scope、回调域名）。
- [ ] 真实两个用户分别授权、互不可见、错绑被拒。
- [ ] 撤销 A 后 A 立即不可用、B 不受影响；重启后 B 仍可用。
- [ ] 真实网络下的出网/代理路径（DWS API、登录域名、企业 MCP 域名）。
- [ ] 真实机器人收发与身份一致性（独立于本单，由既有 gateway 验收）。
