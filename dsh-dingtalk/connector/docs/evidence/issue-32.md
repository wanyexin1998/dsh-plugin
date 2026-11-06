# #32 修复记录：授权生命周期、撤销状态与非 443 代理 Host

- 审查基线：`608e21a`（`main`）
- 修复分支：`fix/oauth-cancel-revoke-host`（提交与 head 以 PR #33 为准）
- 环境：WSL2 Ubuntu 24.04.5，Node `22.19.0`，pnpm `11.7.0`，Docker `29.9.3`，Docker Compose `v5.7.0`，`umask 0022`，干净 ext4 clone

## 授权生命周期与状态

| 阶段     | 状态与最终生效点                                                                                                                                                                                                            |
| -------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 开始授权 | 事务在 `ServerOAuth` 创建，仅生成一次性 ticket/state/proof；此时没有可用的 DWS 凭据。                                                                                                                                       |
| 换码     | 子进程开始写入凭据；从这一刻起取消不能再被当作“未发生”。                                                                                                                                                                    |
| 校验     | 身份与 status 校验通过后才允许进入提交。                                                                                                                                                                                    |
| 提交     | 先过提交屏障，再写 `binding.json revoked:false`，再过一次屏障；期间任意取消/关闭/新事务都使本次授权不生效。                                                                                                                 |
| 标记清理 | 提交后删除遗留的 `pending-revocations/<callerId>.json`；删除失败时不报告 connected，转为持久阻断。                                                                                                                          |
| 流程完成 | 回调记录 `lastExchange`；若用户在回调最终返回前取消，`rollbackExchange` 撤销刚提交的授权。                                                                                                                                  |
| 用户取消 | 换码前取消不产生状态；换码开始后取消隔离凭据（logout + `revoked`，清理失败保留 `revocationPending`）；提交后取消由回滚路径处理。                                                                                            |
| 撤销     | 关闭会话并中止在途授权 → 与授权/断开串行 → 写撤销标记 → 清理遗留标记 → logout → 清空绑定；任一步无法确认都保持阻断并报错。                                                                                                  |
| 并发     | 会话内 `mutate` 串行化 exchange/disconnect/revoke；撤销会中止在途 exchange，旧授权流程不能覆盖或删除新撤销标记。                                                                                                            |
| 进程重启 | 结合 `binding.json`、`pending-revocations` 标记、记录/标记可读性与 caller 目录可写性判定：可确认则恢复，不确定则 `revocation_failed`/`service_unavailable` 阻断；显式恢复路径为存储修复后 admin revoke 重试（或重启重读）。 |

## 修复摘要

1. OAuth 取消与授权提交的先后关系
   - `UserSession.exchange` 使用会话内串行化与授权代次；换码、校验、status、持久化前后都检查取消/关闭/新事务。
   - 换码开始后取消执行隔离清理（logout + `revoked`；失败保留 `revocationPending`）；提交后最终返回前取消由 `rollbackExchange` 撤销。
2. 撤销与授权并发
   - `exchange/disconnect/revoke` 通过会话级 `mutate` 串行；撤销先关闭会话并中止在途 exchange，旧流程无法在撤销后清除新标记。
   - 撤销不需要 caller 目录可写即可登记 root 回退标记；标记写失败明确返回 `revocation_failed`，不返回假成功。
3. 标记与存储故障
   - 标记读取失败、旧记录读取失败都按“不确定”阻断，绝不删除读不到的标记。
   - 授权成功但清理遗留标记失败时，不报告 connected，改为持久阻断并返回错误。
   - 撤销时删除遗留标记失败返回 `revocation_failed`；存储恢复后 admin revoke 重试或重启可恢复。
4. 非 443 代理 Host
   - `deploy/nginx-oauth.conf.example` 使用 `proxy_set_header Host $http_host` 保留 `host:port`；Connector 继续精确匹配 `publicOrigin`，错误 Host/端口 403。

## fail-first 回归

| 测试集                           | 基线 `608e21a`          | `5c1b413`                        | `38e4f8b`               | `ff01827`               | 本提交                  |
| -------------------------------- | ----------------------- | -------------------------------- | ----------------------- | ----------------------- | ----------------------- |
| `connector/tests/unit.test.mjs`  | 5 项：3 pass / 2 fail   | 14 项：11 pass / 3 skip / 0 fail | 同左                    | 同左                    | 同左                    |
| `connector/tests/linux.test.mjs` | 20 项：14 pass / 6 fail | 22 项：20 pass / 2 fail          | 25 项：22 pass / 3 fail | 29 项：26 pass / 3 fail | 29 项：29 pass / 0 fail |

本轮新增用例（上一版 head `ff01827` 上先失败）：

- `cancelling after the exchange commit but before the flow completes rolls back the authorization`
- `an authorization is not reported connected when a stale revocation marker cannot be deleted`
- `revocation reports failure and stays blocked when a stale marker cannot be deleted`

并发撤销用例 `a concurrent admin revoke wins over an in-flight authorization` 作为时序回归保留（上一版 head 偶发通过，不单独作为 fail-first 证据）。

## 全量检查

| 检查                                                            | 结果                                                                                        |
| --------------------------------------------------------------- | ------------------------------------------------------------------------------------------- |
| `pnpm run ci`（secrets/lint/typecheck/test/test:web/test:pack） | PASS：425 项 418 pass / 7 skip / 0 fail；75 项 68 pass / 7 skip / 0 fail；tarball 400 files |
| 类型与格式                                                      | `pnpm run typecheck`、`pnpm run lint`                                                       | PASS |
| Connector 单元/CLI/部署                                         | 14 项：11 pass / 3 skip / 0 fail                                                            |
| Connector Linux 容器                                            | 29/29 PASS（真实固定 DWS 1.0.66 制品）                                                      |

## 真实 Nginx + Compose/TLS（非 443）

- 公网 origin `https://localhost:8443`，Compose 发布 8443，自签证书，真实 `nginx:1.27-alpine` 代理 + 生产 Connector 镜像。
- 修复模板结果：`Host: localhost:8443` → 400（Host 通过，ticket 无效）；`Host: localhost` / `localhost:8444` / `evil.example:8443` → 403；`/dsh-dingtalk/callback` 无 state → 400；health `ok:true`；日志未出现测试 ticket 字符串。
- 对照：同一请求在旧的 `Host $host` 模板下 → 403（端口被丢弃，复现 #32 第 3 项）；恢复新模板后 → 400。

## 验证性质

- 真实环境验证：真实 nginx + Compose/TLS（自签证书）、真实固定 DWS 1.0.66 制品的 ELF/SHA256/`--version` 与容器内运行；本地 Docker/文件系统权限故障注入。
- 模拟验证：钉钉 OAuth 换码、身份/业务调用、logout 使用 fake DWS 与 synthetic 端点；并发与取消时序使用测试屏障。
- 未覆盖 / BLOCKED：真实企业 OAuth（真实 corpId、scope/IT 权限）、真实双用户、真实网络代理与机器人收发；生产证书、真实域名与 39/43 部署未执行；Windows 官方 CLI fixture 覆盖仍需干净 Windows 环境（见 #31）。
