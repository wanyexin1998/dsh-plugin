# 备份与恢复

## 需要备份的内容

| 位置                                                                    | 内容                                                                                                                                    | 是否含秘密                           |
| ----------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------ |
| Connector 命名卷 `connector-state`（`/var/lib/dsh-dingtalk-connector`） | `bindings.json`、`admin.token`、`callers/<id>/{home,dws,keychain,binding.json}`（DWS profile/Token/Keychain）、`sockets/`（运行时生成） | **是**，按秘密数据保护               |
| 既有 gateway 命名卷 `gateway-state`                                     | `bindings.json`、`stream-seen.json`、`feedback.json`                                                                                    | 视内容而定，按敏感数据保护           |
| 部署模板                                                                | `connector.env`、`gateway.json`、TLS 证书                                                                                               | **是**，从秘密管理系统恢复，不进 Git |

`sockets/` 与 `oauth/` 不需要备份：socket 在 Connector 启动时重建，授权事务只在内存中有界保存。

## 备份

```bash
# Connector 私有卷（停机或快照一致性由部署方保证）
docker run --rm -v dsh-dingtalk_connector-state:/data:ro -v "$PWD":/backup \
  alpine tar -czf /backup/connector-state-$(date +%Y%m%dT%H%M%S).tgz -C /data .

# gateway 状态目录（独立卷）
docker run --rm -v dsh-dingtalk_gateway-state:/data:ro -v "$PWD":/backup \
  alpine tar -czf /backup/gateway-state-$(date +%Y%m%dT%H%M%S).tgz -C /data .
```

备份文件含 Token/Keychain：加密后存放，访问权限与生产凭据一致；不要把备份放进插件仓库、镜像或 Git。

## 恢复

1. 用**相同 Connector 版本与协议**（`version.json`）部署新容器，确保镜像摘要与备份时的版本清单一致。
2. 停止新 Connector，清空卷内容后解包备份（保持 `0600/0700` 权限，属主为 `10001:10001`）：

```bash
docker compose stop connector
docker run --rm -v dsh-dingtalk_connector-state:/data -v "$PWD":/backup \
  alpine sh -c 'rm -rf /data/* /data/.[!.]* 2>/dev/null; tar -xzf /backup/connector-state-<ts>.tgz -C /data && chown -R 10001:10001 /data && chmod 0700 /data'
docker compose up -d connector
```

3. 恢复后逐一验证：`health`、每个调用方 `status`、三项只读能力各一次。若 DWS 判定 token 过期，需要重新授权；此时 `status` 返回 `not_connected`/`token_refresh_pending`，不会静默切换到其他账号。
4. gateway 恢复同理，使用独立卷；恢复后由部署方决定是否启用 `--profile robot`。

## 撤销语义

- Connector 管理面 `revoke` 立即阻断新调用并中止在途调用；`disconnect` 由调用方本人发起，清理本地授权并执行 `auth logout`。
- 撤销后旧的 `binding.json` 标记为 `revoked`；重新授权必须重新走浏览器授权事务。
- 备份回滚**不会**撤销外部业务系统中已经发生的操作（例如已创建的日程/文档），也不保证钉钉侧的 token 立即失效；需要撤销外部访问时，必须在钉钉管理后台或其他可信入口执行，并按企业安全流程处理。
- 从备份恢复等于恢复当时的授权状态：如果备份发生在撤销之前，恢复后授权会重新可用。这是恢复行为的固有语义，必须由安全负责人确认。

## 无法通过本地回滚撤销的操作

- 已在钉钉侧创建的日程、文档、待办等写操作（本交付的服务器能力不包含写操作，但插件本地模式仍可能对同一企业账号执行写操作）。
- 其他系统依据 DWS/钉钉 Token 完成的调用（Token 可能仍在有效期内）。
- 已发出的机器人消息。

这些必须在相应业务系统或钉钉后台处理，并记录在 Issue 中，不能以“已恢复备份”代替。
