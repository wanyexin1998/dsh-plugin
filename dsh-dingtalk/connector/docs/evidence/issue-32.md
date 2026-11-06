# #32 修复记录：OAuth 取消竞态、撤销持久化与非 443 代理 Host

- 审查基线：`608e21a`（`main`）
- 修复分支：`fix/oauth-cancel-revoke-host`（提交与 head 以 PR #33 为准）
- 环境：WSL2 Ubuntu 24.04.5，Node `22.19.0`，pnpm `11.7.0`，Docker `29.9.3`，Docker Compose `v5.7.0`，`umask 0022`，干净 ext4 clone

## 修复摘要

1. OAuth 取消与授权提交的先后关系
   - `UserSession.exchange` 增加授权代次与取消检查：换码后、身份校验后、status 等待后、持久化前与持久化后都判定取消/关闭/新事务。
   - 换码成功后发生取消时执行隔离清理：立即写 `revoked:true`（logout 失败或结果未知则保留 `revocationPending`），不重建 backend，不让旧事务影响新事务。
   - 换码前取消只恢复旧的可用会话，不恢复本次被取消的授权；仅测试模式新增 `DSH_CONNECTOR_TEST_COMMIT_GATE` 用于在最终持久化前后精确注入取消。
2. 撤销持久化失败 fail-closed
   - `UserSession.revoke` 不再吞掉撤销标记写入失败：抛 `revocation_failed`，保留内存阻断（closed、无 backend）。
   - admin revoke / unbind / test-bind 在撤销未可靠完成时不再删除并重建 session。
   - `ConnectorState.assertWritable` 启动时探测私有卷可写性，不可写则拒绝启动，避免重启后信任旧的 `revoked:false` 记录。
   - logout 失败仍保留已落盘的 `revocationPending`，可显式重试清除。
3. 非 443 代理 Host
   - `deploy/nginx-oauth.conf.example` 改为 `proxy_set_header Host $http_host`，保留浏览器请求的 `host:port`；Connector 仍对 `publicOrigin` 做精确比较。
   - 部署模板回归断言该 header，旧模板（`$host`）被禁止。

## 第二轮补修（审查反馈）

1. 取消时间窗口：`auth exchange` 子进程已把凭据写入磁盘、但尚未返回结果时取消，之前会被当成“未发生”并恢复旧会话。现在只要 exchange 已启动，取消就执行隔离清理（logout + `revoked`；清理失败或结果未知保留 `revocationPending`），不再依赖“已成功返回”的标志，也不会在重启后恢复授权。
2. 撤销失败后的重启：新增每个 caller 私有目录可写性探测，以及根目录 `pending-revocations/<callerId>.json` 回退标记。当 caller 目录不可写导致撤销无法落盘时，重启后依据回退标记保持阻断（`revocation_failed`），只有显式重试成功后才清除标记并恢复 `unlinked`。

## 第三轮补修（复审反馈）

1. 标记或旧授权记录读取失败时保持阻断：`hasRevocationPending` 读取失败不再当作“无标记”；`BindingStore.read` 读取失败不再当作已撤销记录。无法确认状态时设置 `storageBlocked` 并保留标记，绝不删除读不到的标记。
2. 残留标记不再误阻断重新授权：exchange 提交成功后清除该 caller 的 `pending-revocations` 回退标记，用户重新授权成功后，后续重启不会被旧标记错误阻断。
3. 回归覆盖（上一版 head `38e4f8b` 上失败、本提交通过）：
   - `an unreadable revocation marker keeps the caller blocked and is preserved`
   - `an unreadable old binding keeps the revocation marker and stays blocked`
   - `a successful re-authorization clears a leftover revocation marker`

## fail-first 回归

| 测试集                           | 基线 `608e21a`          | `5c1b413`                        | `38e4f8b`                        | 本提交                           |
| -------------------------------- | ----------------------- | -------------------------------- | -------------------------------- | -------------------------------- |
| `connector/tests/unit.test.mjs`  | 5 项：3 pass / 2 fail   | 14 项：11 pass / 3 skip / 0 fail | 14 项：11 pass / 3 skip / 0 fail | 14 项：11 pass / 3 skip / 0 fail |
| `connector/tests/linux.test.mjs` | 20 项：14 pass / 6 fail | 22 项：20 pass / 2 fail          | 25 项：22 pass / 3 fail          | 25 项：25 pass / 0 fail          |

基线失败项（第一轮）：

- configuration fails closed for transport, paths, OAuth origins and test seams
- ConnectorServer refuses to start when the private state volume is not writable
- cancelling while the exchange status is pending never persists a usable authorization
- cancelling at the persistence barrier wins over the commit
- a cancelled exchange whose credential cleanup fails stays blocked across restart
- a revocation that cannot persist fails closed without reviving the caller or affecting others

## 全量检查

| 检查                                                            | 结果                                                                                        |
| --------------------------------------------------------------- | ------------------------------------------------------------------------------------------- |
| `pnpm run ci`（secrets/lint/typecheck/test/test:web/test:pack） | PASS：425 项 418 pass / 7 skip / 0 fail；75 项 68 pass / 7 skip / 0 fail；tarball 400 files |
| 类型与格式                                                      | `pnpm run typecheck`、`pnpm run lint`                                                       | PASS |
| Connector 单元/CLI/部署                                         | 14 项：11 pass / 3 skip / 0 fail                                                            |
| Connector Linux 容器                                            | 25/25 PASS（真实固定 DWS 1.0.66 制品）                                                      |

## 真实 Nginx + Compose/TLS（非 443）

- 公网 origin `https://localhost:8443`，Compose 发布 8443，自签证书，真实 `nginx:1.27-alpine` 代理 + 生产 Connector 镜像。
- 修复模板结果：`Host: localhost:8443` → 400（Host 通过，ticket 无效）；`Host: localhost` / `localhost:8444` / `evil.example:8443` → 403；`/dsh-dingtalk/callback` 无 state → 400；health `ok:true`；日志未出现测试 ticket 字符串。
- 对照：同一请求在旧的 `Host $host` 模板下 → 403（端口被丢弃，复现 #32 第 3 项）；恢复新模板后 → 400。

## 未覆盖 / BLOCKED

- 真实企业 OAuth（真实 corpId、scope/IT 权限）、真实双用户、真实网络代理与机器人收发仍按 #30 补验。
- 生产证书、真实域名与 39/43 部署未执行；Nginx 复测使用自签证书与 synthetic 客户端标识。
- 官方 Windows CLI fixture 覆盖仍需在干净 Windows 环境补验（见 #31）。
