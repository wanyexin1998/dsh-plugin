# ConnectionService v0 契约

实现与类型：`src/shared/`；Host 服务名：`dingtalkConnection`。这是插件内部服务 seam，不是公开 HTTP 或 Agent 工具入口。授权与解绑控制面后续只能由已鉴权的人类 UI 发起。

## 统一接口

| 方法 | 输入 | 输出 |
| --- | --- | --- |
| `status()` | 无 | `ConnectionStatus` |
| `beginAuthorization(context)` | 可选 sessionRef / callRef | transactionId、HTTPS authorizeUrl、expiresAt |
| `getAuthorizationStatus(id)` | 单次授权事务 ID | `ConnectionStatus` |
| `disconnect()` | 无，不可指定用户或 Profile | disconnected 布尔值 |
| `invoke(input)` | operationId + 严格独立的 args | ok / auth_required / denied / failed |

状态枚举覆盖方案的 11 种状态。稳定 reasonCode 清单位于 `src/shared/models.ts`，由 `tests/fixtures/reason-codes.json` 快照约束；改变错误语义需同步文档和消费端。

公开连接状态只含展示所需的企业/员工脱敏名称、能力摘要、确认时间和受控原因码。适配器负责准备可信且已脱敏的名称，服务按白名单投影；corpId/userId、profile、credential path、Code/Token/Secret 不进入连接 DTO。AuthStart 不允许携带 code/token/secret 查询参数。

只读输入当前预留：

- `identity.getSelf`：空 args。
- `calendar.listEvents`：start/end（带时区的 ISO 时间）、limit 1–100、cursor。
- `docs.search`：query、limit 1–30、cursor。

拒绝未知字段、写操作和用户可选的内部目标。没有 command/argv/shell/cwd/userId/profile/path/URL 通道。#6/#8 将在这些稳定 operationId 后对接官方命令；不把官方 Skill 中提到的其他业务入口自动纳入白名单。

业务结果按 JsonValue 输出，限制深度及节点数量，并拒绝包含常见凭证字段名的嵌套对象。DWS 进程层的字节上限、日志脱敏、业务输出映射和更完整的资源控制属于 #6/#8，不能由本契约替代。

## 适配与生命周期

`DingtalkBackend` 实现同一接口和 dispose。`createConnectionService()` 包装它，严格校验入参、投影公开结果、遮蔽内部异常，并在卸载后拒绝旧引用及迟到的在途结果。后续执行器仍需在 dispose 内主动终止其进程/订阅。

`local` 与 `cellgent` 两个模拟适配器运行相同的契约测试；测试类只存在于 tests，不会装进归档。生产代码目前只提供 `local` 占位适配器：状态为 `unknown/backend_not_ready`，授权报 backend_not_ready，解绑返回 false，调用明确 failed。它不发起网络、不运行 CLI、不读取个人配置或修改任何 DWS 默认 Profile。

配置类型保留 `mode=local|cellgent`。P0 加载时明确拒绝 cellgent，拒绝未知配置和非法 mode，不会静默切回 local。真实远端适配器和 Connector 均未实现；未来增加适配器时保持本服务契约，不在 Tool/Client/Skill 硬编码企业路径或身份。

Host 注册由 Cordis fiber 持有；Client 用 `ctx.effect()` 注册独立 settings.section，停用时清理。#5 尚未注册 `dingtalk_call` 或 ToolView；对应工作分别属于 #8/#9，设置页完整连接管理属于 #10。

## 当前验收边界

类型约束、错误码快照、双模拟适配器、负向输入、服务生命周期、Client 模块注册、归档安装/加载/卸载均可本地验证。Client 组件用真实 React 渲染检查占位文案和禁用按钮；Slot API 检查使用真实 SlotCore，不能当作完整 Desktop/Web 浏览器验收。

真实授权、企业权限、业务查询及浏览器回调仍待最后联调，#4 G0 保持 HOLD。不自动关闭 Issue、合并或部署；当前只推送开发分支，不创建 PR。
