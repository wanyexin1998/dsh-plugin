# 第二轮评审修复验证（PR #25）

本记录对应 PR #25 当前分支 `codex/dingtalk-server-runtime` 的下一轮修复，环境与限制见 `env-baseline.md`。

## 代码修复与测试

| 评审项                                        | 修复                                                                                                                                                                             | 测试                                                                                                                                                              |
| --------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1. 远程 HTTPS bootstrap 被本地来源校验拒绝    | `ManagedConnection.context` 钩子：local 保持 loopback/桌面规则，connector 精确匹配 `DSH_DINGTALK_TRUSTED_ORIGINS`                                                                | `enhancements/tests/remote.test.mjs`：受信 HTTPS bootstrap 成功、未配置 Origin/额外字段/跨站路径/反斜杠/敏感查询参数拒绝；`ui-rpc.test.mjs`：本地模式仍拒绝 HTTPS |
| 2. Connector CLI 双 shebang                   | 删除 esbuild banner，保留源码唯一 shebang；构建脚本断言首行唯一并实跑 `node lib/main.mjs version`                                                                                | `connector/tests/cli.test.mjs`：shebang 唯一、version、serve、health、无效配置退出码；Linux 容器测试同样执行                                                      |
| 3. 首次 health 失败永久污染连接               | readiness 改为可重建探测：失败后清除、并发合并、成功后缓存；`callbackOriginReady` 使用同一探测；disposed/协议不匹配仍失败关闭                                                    | `remote.test.mjs`：首次 503 后恢复、8 并发只加一次 health、协议不匹配、dispose                                                                                    |
| 4. remote cancel 不等待且吞错                 | `cancel` 改为异步：await Connector 结果、`publicStatus` 校验、错误经 UI 返回                                                                                                     | `remote.test.mjs`：响应前不提前完成、返回真实状态、`invalid_auth_state` 可见且不自动重发                                                                          |
| 5. 请求取消未传达到服务端；prepareCancel 竞态 | Connector 业务处理器建立请求级 AbortController（仅在响应未完成时取消），传入 session/队列/子进程；remote prepare 使用代次与独立 controller，取消后旧任务不得回写                 | `linux.test.mjs`：客户端中断后同 caller 队列释放、另一 caller 不受影响；`remote.test.mjs`：开始→取消→旧响应到达仍 cancelled、新 prepare 不被旧响应覆盖            |
| 6. 生产镜像依赖预生成 lib                     | Dockerfile 增加 `connector-build` stage：`npm ci`（`connector/package-lock.json`）+ 源码构建 + CLI 实跑，运行时从 stage COPY；`.dockerignore` 保留源码/脚本/锁文件、排除宿主 lib | 本机实建镜像成功并验证 version/serve/health，见 `production-image.txt`；`deploy.test.mjs` 断言构建关系                                                            |
| 7. compose 共享 netns 与 ports 冲突           | 端口发布移到拥有命名空间的 `connector` 服务，代理服务不声明 ports；只发布 `443:8443`                                                                                             | `deploy.test.mjs` 静态断言；Compose 运行验收因本机无 `docker compose` 插件未执行（见下）                                                                          |
| 8. Nginx 可能记录 OAuth 查询参数              | 授权路径与默认路径 `access_log off`，无 `log_format`/`$request`/`$request_uri`/`$args`；仅 `proxy_set_header` 使用 Cookie                                                        | `deploy.test.mjs` 静态断言；真实代理日志运行时验收未执行（需可运行 Compose + 证书）                                                                               |
| 9. 重复 test-bind 触发无意义撤销              | 相同 caller/profile 幂等：保留 session 与真实状态；从未授权无凭据时 revoke 不执行 logout、直接清理；真实 logout 失败保留 `revocationPending`                                     | `linux.test.mjs`：重复绑定保持 connected、不产生 logout；从未授权 revoke 不产生 logout/revocation_failed；logout 失败保持阻断、成功后清除                         |
| 10. 单 socket 文件挂载重启失效                | 每 caller 独立 socket 目录 `<state>/sockets/<callerId>/dsh.sock`（目录 0700/0750、socket 0600）；重启同路径重建；文档改为挂载目录                                                | `linux.test.mjs`：路径/权限、重启后同路径新 socket、远程重连；真实容器目录挂载验收未执行（见下）                                                                  |
| 11. 文档模板文件名与 gateway 初始化           | 提交 `nginx-oauth.conf.example`，compose 挂载操作者生成的 `nginx-oauth.conf`；文档补 `cp gateway/gateway.env.example gateway.env`、`gateway.json` 初始化与变量说明               | `deploy.test.mjs`：模板文件存在、引用一致、gateway profile 默认不启动                                                                                             |

## 本地验证结果

- `connector/tests/unit.test.mjs`：3/3
- `connector/tests/cli.test.mjs`：3/3
- `connector/tests/deploy.test.mjs`：4 pass / 1 skip（skip = 本机无 `docker compose` 插件）
- `connector/tests/linux.test.mjs`（Linux 容器、真实固定 DWS 制品 + 契约型 fake CLI）：14/14
- `enhancements/tests/remote.test.mjs`：8/8
- `enhancements/tests/*.test.mjs` 全量：75 tests / 72 pass / 3 fail；3 个失败仍是基线可复现的 DWS expected-flags 本机环境问题（`env-baseline.md`）
- 生产镜像：从干净构建上下文（无宿主 `connector/lib`、无宿主 node_modules）构建成功，`version`/`serve`/`health` 通过（`production-image.txt`）

## 未执行及原因

- Compose `up` / HTTPS 健康链路 / 代理日志运行时验收：本机 Docker CLI 无 `compose` 插件（`docker: unknown command: docker compose`），且需要可信 TLS 证书与可解析域名；模板已通过静态断言，运行时验收需在部署机执行。
- 真实容器目录挂载跨重启验收（调用方容器保持运行）：需要可运行的 Compose/容器编排；Linux 测试已覆盖同一路径 socket 重建与重连。
- 真实企业 OAuth、scope、IT 权限、真实双用户、真实网络代理、真实机器人收发：仍待真实企业环境验收，不以模拟结果代替。
