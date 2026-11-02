# ConnectionService v0 契约

实现与类型：`src/shared/`；Host 服务名：`dingtalkConnection`。内部服务由 Host 持有；Agent Tool 只暴露 invoke。授权与解绑通过 DSH 原生已认证 Connection RPC 进入，并在 Host 验证浏览器 owner Peer、随机浏览器能力与 UI 调用上下文。

## 统一接口

| 方法 | 输入 | 输出 |
| --- | --- | --- |
| `status(options?)` | 可选 Host AbortSignal | `ConnectionStatus` |
| `beginAuthorization(context, options?)` | 可选 sessionRef / callRef、Host AbortSignal；要求 UI 上下文 | 自动准备后返回 transactionId、受控 loopback start URL、expiresAt |
| `getAuthorizationStatus(id)` | 单次授权事务 ID | `ConnectionStatus` |
| `disconnect()` | 无，不可指定用户或 Profile | disconnected 布尔值 |
| `invoke(input, options?)` | operationId + 严格独立的 args；可选 Host AbortSignal | ok / auth_required / denied / failed |

状态枚举覆盖方案的 11 种状态。稳定 reasonCode 清单位于 `src/shared/models.ts`，由 `tests/fixtures/reason-codes.json` 快照约束；改变错误语义需同步文档和消费端。

公开连接状态只含展示所需的企业/员工脱敏名称、能力摘要、确认时间和受控原因码。适配器负责准备可信且已脱敏的名称，服务按白名单投影；corpId/userId、profile、credential path、Code/Token/Secret 不进入连接 DTO。AuthStart 不允许携带 code/token/secret 查询参数。

兼容输入：

- `identity.getSelf`：空 args。
- `calendar.listEvents`：start/end（带时区的 ISO 时间）、limit 1–100、cursor。
- `docs.search`：query、limit 1–30、cursor。

新增 dws.catalog / dws.describe / dws.execute / dws.jobs。command 只能精确匹配锁定版本官方目录；参数名和类型由该命令 Schema 校验。无任意 argv/shell 或账号切换通道。写入通过 Host 原生确认。详见 ../../docs/DWS-CAPABILITIES.md。

业务结果按 JsonValue 输出，限制深度及节点数量，并拒绝包含常见凭证字段名的嵌套对象。DWS 进程层的字节上限、日志脱敏、业务输出映射和更完整的资源控制属于 #6/#8，不能由本契约替代。

## 适配与生命周期

`DingtalkBackend` 实现同一接口和 dispose。`createConnectionService()` 包装它，严格校验入参、投影公开结果、遮蔽内部异常，并在卸载后拒绝旧引用及迟到的在途结果。后续执行器仍需在 dispose 内主动终止其进程/订阅。

`local` 与 `cellgent` 模拟适配器运行相同契约测试，测试类不装进归档。生产入口使用 managed LocalBackend：无私有配置即可加载，未绑定时返回 unlinked/not_connected，invoke 阻断既有默认账号读取。只有 UI begin 才准备锁定 DWS、发现官方应用并启动动态 loopback；准备中返回 authorizing/connection_preparing。首次从在线核验的身份建立绑定，后续重授权核对绑定；status 不能仅靠缓存返回 connected，重启后重新在线确认。

CallOptions 携带 Host 执行生命周期的 AbortSignal，以及可信会话 ID、工作目录、原生确认回调，属于同进程操作参数，不是模型 JSON、Tool 参数或可序列化 RPC 入参。队列、进程和错误细节见 [LOCAL-BACKEND.md](LOCAL-BACKEND.md)。

配置类型保留 `mode=local|cellgent`。P0 加载时明确拒绝 cellgent，拒绝未知配置和非法 mode，不会静默切回 local。真实远端适配器和 Connector 均未实现；未来增加适配器时保持本服务契约，不在 Tool/Client/Skill 硬编码企业路径或身份。

Host 注册由 Cordis fiber 持有。Client 用同一个 ConnectionStore 服务独立 settings.section 和 keyed tool.call.toolview；身份状态不从聊天文字推断。postMessage 只触发 Host 复查；验证 callback origin、popup source 和 transactionId，消息本身不能设置 connected。auth 轮询 2 秒且最多事务 TTL 120 秒；普通状态刷新 15 秒，取消订阅/卸载清理。会话卡片可单独隐藏，不退出 DSH、不伪造用户消息。

## 当前验收边界

类型约束、错误码快照、模拟适配器、负向输入、服务生命周期和 SlotCore 注册可自动验证。官方 DWS 的合成端点集成和 React/RPC 浏览器 Harness 各自有报告；正式 DSH Web 和真实企业结果分开记录，详见 P0-ACCEPTANCE.md。

真实授权、企业权限、业务查询及浏览器回调仍待最后联调，#4 G0 保持 HOLD。不自动关闭 Issue、合并或部署；当前只推送开发分支，不创建 PR。
