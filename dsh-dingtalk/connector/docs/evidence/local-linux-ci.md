# 本地 Linux CI 验收记录（#25）

- 日期：2026-11-06
- 基线提交：`d54444b`（`codex/dingtalk-server-runtime`）；本文件与审查修复一起作为后续提交合入，最终 head 以 PR #25 为准
- 环境：WSL2 Ubuntu 24.04.5（kernel `6.18.54.1-microsoft-standard-WSL2`），4 vCPU / 8 GB RAM，Node `v22.19.0`，pnpm `11.7.0`，Docker `29.9.3`，Docker Compose `v5.7.0`
- 检出方式：干净 ext4 目录（非 Windows `/mnt` 共享盘），`umask 0022`，构建前无宿主 `connector/lib`、无宿主 `node_modules`

## 结果

| 检查                                    | 命令                                                                                  | 结果                                                                                                                                  |
| --------------------------------------- | ------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------- |
| 敏感信息扫描                            | `pnpm run scan:secrets`                                                               | 通过                                                                                                                                  |
| 格式                                    | `pnpm run lint`（prettier）                                                           | 通过                                                                                                                                  |
| 类型检查                                | `pnpm run typecheck`                                                                  | 通过                                                                                                                                  |
| 主插件测试                              | `pnpm test`（构建 + `test/*.test.mjs`）                                               | 425 项：418 pass / 7 skip / 0 fail                                                                                                    |
| Web/DWS 测试                            | `pnpm run test:web`                                                                   | 75 项：68 pass / 7 skip / 0 fail                                                                                                      |
| 安装包边界                              | `pnpm run test:pack`                                                                  | 400 files / 4658858 bytes，通过                                                                                                       |
| Connector 构建与 CLI                    | `node scripts/build.mjs`、`node lib/main.mjs version`                                 | `dsh-dingtalk-connector 0.1.0 (protocol 1)`                                                                                           |
| Connector 单元/CLI/部署                 | `node --test tests/unit.test.mjs tests/cli.test.mjs tests/deploy.test.mjs`            | 12 项：9 pass / 3 skip / 0 fail                                                                                                       |
| Connector Linux 容器                    | `node scripts/test-linux.mjs`                                                         | 14/14 通过（真实固定 DWS 1.0.66 制品）                                                                                                |
| 生产镜像构建（默认 GitHub release URL） | `docker build -f connector/docker/Dockerfile -t dsh-dingtalk-connector:0.1.0-local .` | 通过；builder 阶段校验归档与二进制 SHA256                                                                                             |
| 运行时硬化                              | `docker run --read-only --tmpfs /tmp -v <volume>:...`                                 | 非 root `10001:10001`；`/app` 只读；`/opt/dws/bin/dws` root:0555；state 目录 0700；admin.token/bindings 0600；`health` 返回 `ok:true` |
| Compose + TLS 代理                      | `docker compose up -d connector oauth-tls`                                            | 两个服务 Up，connector healthy；仅发布 8443，8787 未发布                                                                              |
| TLS 路由与来源校验                      | `curl -k https://localhost:8443/...`                                                  | 无效 ticket 400；附加参数 400；错误 Host 403；未知路径 404；无 state 回调 400；非 GET 403；`/admin/*` 404                             |
| 重启恢复                                | `docker compose down`（保留命名卷）后 `up`                                            | admin token 摘要不变、health 通过、私有卷保留                                                                                         |
| Nginx 日志脱敏                          | 真实 nginx 1.27 + 合成敏感标记，运行 `connector/tests/nginx-logging.test.mjs`         | 2/2 通过；访问日志仅 allowlist 字段，无 token/code/cookie/完整路径                                                                    |

## 本次修复

- 3 个仅依赖官方 Windows DWS CLI fixture 的用例在非 win32 平台改为显式跳过（`officialFixtureSkip`，与 `bootstrap.test.mjs` 同一规则），消除 `dws.exe` ENOENT 假失败；win32 x64 且 fixture 存在时仍照常执行。
- `oauth-tls` 在 `cap_drop: ALL` 下无法启动：nginx master 需要 `CHOWN`、`SETUID`、`SETGID` 才能创建缓存目录并把 worker 降权。Compose 模板补齐最小 capability，并新增部署模板回归测试。

## 独立审查发现（P2）

| 发现                                                                                               | 状态                                                          |
| -------------------------------------------------------------------------------------------------- | ------------------------------------------------------------- |
| loopback 能力令牌在 unbind 后未失效、重绑后旧令牌可复用                                            | 已修复（`connector/src/server.ts`、`connector/src/state.ts`） |
| 失败/未知 logout 未在内存标记 `revocationPending`，status 会误报 `unlinked` 且重新授权可覆盖该标记 | 已修复（`connector/src/session.ts`）                          |
| remote `dispose()` 未中止/等待悬挂的 prepare 任务，迟到响应可在释放后写状态                        | 已修复（`enhancements/src/adapters/remote/index.ts`）         |
| 契约中的本地路径参数未全部纳入 workspace 限制（先于本 PR 存在于 `main`）                           | 跟进 #31                                                      |
| Connector 配置缺失时 offline 回退缺少 `context`                                                    | 跟进 #31                                                      |

## 未覆盖 / BLOCKED

- 真实企业 OAuth（真实 corpId 应用、scope、IT 限制）、真实双用户、真实网络代理链路、真实机器人收发：需要企业账号与公网 HTTPS 回调，本机不可执行，标记 BLOCKED。
- 官方 Windows DWS CLI fixture 用例需在 win32 x64 且 `.cache/dingtalk-g0` 含固定 fixture 的环境复跑；本机 Windows 受 `.data.lock` 权限限制（见 `env-baseline.md`），因此按平台跳过，未计入失败。
- TLS 使用合成自签证书与 `localhost` 域名；生产证书、真实域名与 39/43 部署未执行。
