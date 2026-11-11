# Standalone DWS Connector（服务端）

本目录是 Issue #24 的服务端交付：`@wanyexin1998/dsh-dingtalk` 的独立 Connector，可单独构建、部署和备份，不依赖 Cellgent、cellgent-auth、DSH 核心或 Supabase，也不修改或 fork 官方 DWS CLI。

- 版本锁定：`version.json`（Connector 0.1.0、协议 1、插件 `0.2.0-dev.12`、DWS 1.0.66 `f215043e…`）。
- 底层复用：`enhancements/` 的 `DwsExecutor`、`ExecutionQueue`、`createLocalBackend`、`operations`、错误码与 `dws.lock.json` 版本锁。
- 运行形态：一个 Connector 进程，多用户隔离；每个调用方一条 Unix Domain Socket（生产默认，`<state>/sockets/<callerId>/dsh.sock`）或仅测试用的 loopback + capability token。
- 服务器能力：`dws.catalog`、`dws.describe`、`dws.execute`、`dws.jobs`，以及兼容的 `identity.getSelf`、`calendar.listEvents`、`docs.search`。`dws.execute` 包含读、写、文件和后台任务。其他 operationId 显式拒绝。写操作、文件和后台任务要先经过 Host 确认。

> 本交付**不等于** Cellgent 已接入。真实企业 OAuth、scope、IT 权限与双用户必须在真实环境验收，见 [docs/CELLGENT-INTERFACE.md](docs/CELLGENT-INTERFACE.md) 与 [docs/DEPLOYMENT.md](docs/DEPLOYMENT.md)。

## 目录

```text
connector/
  src/           TypeScript 源码（config / state / session / oauth / server / main）
  lib/           构建产物（esbuild 单文件 bundle + 官方 catalog 副本）
  tests/         跨平台单元测试 + Linux 容器集成测试
  docker/        Connector 镜像与 Linux 测试镜像
  deploy/        Compose 模板、TLS 代理、网关模板与示例配置
  docs/          协议、部署、备份恢复、Cellgent 接线说明
  version.json   版本与制品清单
```

## 快速开始（Linux 容器）

```bash
# 1. 构建镜像（下载并校验固定 Linux DWS 归档和二进制，运行时不再下载）
cd dsh-dingtalk
docker build -f connector/docker/Dockerfile -t dsh-dingtalk-connector:0.1.0 .

# 2. 准备配置（绝不提交真实值）
cd connector/deploy
cp connector.env.example connector.env

# 3. 启动 Connector（本模板不会启动机器人 Stream）
docker compose up -d connector

# 4. 健康检查
docker compose exec connector node /app/lib/main.mjs health
```

浏览器授权需要 HTTPS：用 `oauth-tls` 服务（与 Connector 共享网络命名空间，Connector 仍只监听 `127.0.0.1:8787`）终止 TLS，证书通过挂载目录提供。

## 调用方接入（插件远端模式）

调用方（DSH Host）设置：

```bash
# 插件 config：{ "mode": "connector" }（由部署方写入 DSH 插件配置）
DSH_DINGTALK_CONNECTOR_SOCKET=/run/dsh-connector/caller-a.sock
DSH_DINGTALK_TRUSTED_ORIGINS=https://dsh.example.com
```

- 每条 socket 只挂载给一个调用方容器；socket 文件即该调用方的凭据，业务请求体中没有身份字段。
- `mode=connector` 由部署方配置；`cellgent` 仍被拒绝并提示改用 `connector`，不存在静默回退到 LocalBackend 的路径。
- Connector 离线时插件返回 `backend_not_ready`/`service_unavailable`，普通 DSH 对话不受影响。

## 运维命令

```bash
# 健康（容器健康检查使用同一命令）
node lib/main.mjs health

# 生产绑定：管理面 admin token。Cellgent 把已经掌握的钉钉身份绑到席位。拒绝 test-*。
node lib/main.mjs admin bind --caller seat-a --corp <corpId> --user <userId>
# 测试身份适配器：仅当 DSH_CONNECTOR_TEST_IDENTITY=1 时可用，且只接受 test-* 合成身份。禁止用于真实用户。
node lib/main.mjs admin test-bind --caller caller-a --corp test-corp --user test-user-a
node lib/main.mjs admin callers
node lib/main.mjs admin revoke --caller caller-a
node lib/main.mjs admin unbind --caller caller-a

# 版本与协议
node lib/main.mjs version
```

管理通道使用独立 socket/端口和 `admin.token`（0600，位于私有卷），业务通道无法触达。

## 构建与检查

```bash
cd dsh-dingtalk/connector
node ../node_modules/typescript/bin/tsc -p tsconfig.json   # 类型检查
node scripts/build.mjs                                      # 构建 lib/
node --test --test-concurrency=1 tests/unit.test.mjs        # 跨平台单元测试
node scripts/check-pins.mjs                                 # 版本/镜像/模板一致性
node scripts/test-linux.mjs                                 # Linux 容器集成测试（校验真实固定 DWS 制品 + 契约型 fake CLI 驱动 Connector 流程）
```

## 安全边界（摘要）

- 凭据（DWS profile/Token/Keychain、admin token）只存在 Connector 私有卷，不挂载到 DSH Agent、viewer 或业务调用方；业务响应、健康接口、日志不返回 Code/Token/Secret。
- 每个用户独立 `HOME`、`DWS_CONFIG_DIR`、`DWS_KEYCHAIN_DIR`、`binding.json` 和刷新锁；同一只读 DWS 二进制共享。
- 授权事务绑定调用方 + 精确受信 Origin + 一次性 ticket + 过期/取消保护。数据授权由该用户自己的 DWS 执行 `dws auth login --device`（官方 CLI 身份，不传企业应用 Client ID/Secret）；浏览器只打开 CLI 打印的确认链接。登录结果必须是绑定的 `corpId:userId`，并做一次 `identity.getSelf` 在线验证后保存。
- 撤销阻断新调用并中止在途调用；失败/未知结果不自动重试；重启后从私有卷恢复有效授权。
- 测试身份适配器只能创建 `test-*` 合成身份，且必须显式开启测试模式；禁止用于真实用户。生产绑定是管理面 `POST /admin/v1/bindings`，由 Cellgent 写入它已经掌握的 `corpId:userId`。测试专用 seam（`DSH_CONNECTOR_TEST_*`、`DSH_CONNECTOR_TEST_DWS_BINARY`）只有在显式测试模式下才会被解析，生产镜像不设置它们。

细节见 [docs/PROTOCOL.md](docs/PROTOCOL.md)、[docs/DEPLOYMENT.md](docs/DEPLOYMENT.md)、[docs/BACKUP-RESTORE.md](docs/BACKUP-RESTORE.md)。
