# Connector 部署、启动、停止与恢复

本文只描述服务器侧 Connector 与既有 gateway 的部署；**不包含** Cellgent 接入，也不授权在 39/43 上执行。所有示例使用 `dsh.example.com` 等占位值。

## 0. 制品与固定版本

| 项             | 值                                                                                                                   |
| -------------- | -------------------------------------------------------------------------------------------------------------------- |
| Connector 版本 | `0.1.0`（协议 `1`）                                                                                                  |
| 插件版本       | `@wanyexin1998/dsh-dingtalk` `0.2.0-dev.12`                                                                          |
| DSH API        | `0.2.1-rc.5`（`web` profile）                                                                                        |
| DWS            | `1.0.66`，commit `f215043e676d6889e1ddce3464828d8b1ec40c31`                                                          |
| Linux 归档     | `dws-linux-amd64.tar.gz`，size `19396103`，SHA256 `27cd2821e1f6523d1eeaf5688c23502bddbdd858cf82e32c197853065418bef8` |
| Linux 二进制   | `dws`，size `58091152`，SHA256 `4ee71b2e1d1d4b888dd41dbda6193d213636971196f0641d4ef1c74d12b49607`，mode `0755`       |
| Node           | `^22.19.0 \|\| >=24.0.0`，镜像 `node:22-bookworm-slim`                                                               |

以上与 `enhancements/dws.lock.json`、`version.json`、`docker/Dockerfile` 的 `ARG` 由 `node scripts/check-pins.mjs` 交叉校验。镜像构建时先校验归档 SHA256，再校验唯一 `dws` 二进制的 SHA256，并实际执行 `dws --version` 匹配版本和 commit；任何不匹配都使构建失败。运行时不再下载、不更新、不依赖宿主全局安装。

## 1. 阶段一：预置制品（不启动任何对外服务）

```bash
cd dsh-dingtalk
node connector/scripts/check-pins.mjs
docker build -f connector/docker/Dockerfile -t dsh-dingtalk-connector:0.1.0 .
docker run --rm --entrypoint node dsh-dingtalk-connector:0.1.0 /app/lib/main.mjs version
```

镜像内容：非 root `10001:10001`、只读根文件系统可用、`/opt/dws/bin/dws`（root 所有、0555）、`/app/lib`、`/app/version.json`、`/app/dws.lock.json`、私有卷 `/var/lib/dsh-dingtalk-connector`、健康检查命令。模型/会话不进入 Connector。

镜像摘要由发布流水或人工记录：

```bash
docker inspect --format '{{index .RepoDigests 0}}' dsh-dingtalk-connector:0.1.0
# 部署模板要求用 digest 固定，例如 CONNECTOR_IMAGE=registry.example/dsh-dingtalk-connector@sha256:...
```

## 2. 阶段二：启动 Connector

```bash
cd dsh-dingtalk/connector/deploy
cp connector.env.example connector.env      # 填入 clientId/scope/origin，绝不提交
cp nginx-oauth.conf.example nginx-oauth.conf  # 按实际域名调整（见 deploy/nginx-oauth.conf）
mkdir -p /srv/dsh-tls && cp fullchain.pem privkey.pem /srv/dsh-tls/
export CONNECTOR_IMAGE=<pinned-by-digest>
export OAUTH_TLS_DIR=/srv/dsh-tls OAUTH_PUBLIC_PORT=443
docker compose up -d connector oauth-tls
docker compose exec connector node /app/lib/main.mjs health
```

- Connector 默认以 `unix` 传输监听私有卷内 `sockets/<callerId>.sock`；`oauth-tls` 通过 `network_mode: service:connector` 共享命名空间，Connector 只监听 `127.0.0.1:8787`，浏览器只经 HTTPS 代理访问。
- 默认 Compose 不包含任何机器人 Stream 服务；`gateway.compose.yaml` 使用 `profiles: ["robot"]`，未显式启用时不会启动。
- 反向代理必须设置 `X-Forwarded-Proto: https` 且 Host 与 `DSH_CONNECTOR_OAUTH_PUBLIC_ORIGIN` 完全一致；直连 HTTP、错误 Host、错误 Origin 均被拒绝（403）。

调用方（DSH）接入：将 `<state>/sockets/caller-a.sock` 以文件方式挂载到调用方容器（例如 `/run/dsh-connector/caller-a.sock`），并设置：

```bash
DSH_DINGTALK_CONNECTOR_SOCKET=/run/dsh-connector/caller-a.sock
DSH_DINGTALK_TRUSTED_ORIGINS=https://dsh.example.com
# 插件配置由部署方写入：{ "mode": "connector" }
```

绑定创建：本期只有显式测试身份适配器（`admin test-bind`，仅 `test-*` 合成身份）用于验证；生产身份绑定入口留给未来平台实现，见 `docs/CELLGENT-INTERFACE.md`。禁止把测试适配器用于生产。

停止：

```bash
docker compose stop        # 保留私有卷，授权可恢复
docker compose down        # 移除容器，保留命名卷
```

## 3. 阶段三：启用真实机器人接收（可选、独立）

```bash
cd dsh-dingtalk && pnpm run build && npm pack --pack-destination artifacts
docker build -f connector/deploy/gateway/Dockerfile -t dsh-dingtalk-gateway:0.2.0-dev.12 artifacts
cd connector/deploy
cp gateway/gateway.json.example gateway.json   # 填入真实机器人凭据（不进 Git/镜像）
export GATEWAY_IMAGE=dsh-dingtalk-gateway:0.2.0-dev.12
docker compose -f gateway.compose.yaml --profile robot up -d
```

gateway 与 Connector 分进程、分状态目录、分权限；gateway 不保存个人 DWS Token，也不重造消息路由。默认不启动该服务，因此默认模板不会连接现有真实机器人 Stream，也不会替换机器人接收者。

## 4. 健康检查与诊断

- 容器健康检查：`node /app/lib/main.mjs health`（走 admin socket + admin token），成功打印 `{"ok":true,...}` 并退出 0。
- 业务面 `GET /v1/health` 只返回协议/版本，不含秘密。
- 诊断只收集：版本、协议、调用方数量、连接状态枚举、错误码；不收集 Token/Code/Keychain/业务正文。
- Connector 离线时插件状态为 `backend_not_ready`/`service_unavailable`，普通 DSH 对话仍可用；不会借用其他调用方的实例或默认账号。

## 5. 出网与代理

DWS 子进程不继承宿主的任意环境变量，仅继承白名单变量与显式配置：

- `DSH_CONNECTOR_PROXY_URL`（http/https 代理）会写入子进程的 `HTTPS_PROXY/HTTP_PROXY`（含小写形式）；`DSH_CONNECTOR_NO_PROXY` 写入 `NO_PROXY`。不设置时按直连处理，不默认全网放行。
- DWS API 走 HTTPS + MCP endpoint（`mcp.dingtalk.com`、企业 MCP 域名）与钉钉登录域名；必须允许这些出网目标。
- 现有 gateway 的 WebSocket/Stream 连接由 gateway 进程负责，与 Connector 分进程；其代理/直连能力按 gateway 现有实现单独核对，不由 Connector 代管。
- 本项目未在真实企业网络中验证代理链路；上线前需按实际网络逐项核对并在 Issue 记录结果。

## 6. 资源与并发

Compose 模板未强制 CPU/内存上限，可按部署规模设置 `deploy.resources.limits`。Connector 侧默认：每用户 1 个在途操作、8 个排队、5s 排队上限、15s 执行上限、256 KiB 输出上限（均可用 `DSH_CONNECTOR_*` 调整）。进程内存主要来自 DWS 子进程，建议每 Connector 实例 ≥ 512 MiB。

## 7. 已知限制

- 真实企业 OAuth、scope、IT 权限、真实双用户与真实机器人收发**未验证**；当前仅有合成端点的自动化 / 容器验证（Linux DWS 1.0.66 的 `auth exchange` 对合成 code 走托管换取，因此 Connector 流程测试使用契约型 fake CLI，真实制品另行校验）。
- 没有在线自升级：升级必须重新构建镜像并重新固定 DWS/Connector 摘要。
- 不允许直接用 `latest` 标签部署；`check-pins` 会拒绝 Compose 中的 `:latest`。
- 测试 seam（`DSH_CONNECTOR_TEST_*`、`DSH_CONNECTOR_TEST_DWS_BINARY`、loopback 传输）只在显式测试模式下解析，生产部署不得设置。
