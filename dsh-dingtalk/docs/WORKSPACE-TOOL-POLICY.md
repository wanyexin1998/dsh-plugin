# 工作区工具权限：Issue #27 阻断记录

状态：**未开放，Issue #27 未完成验收**。目标是继承可信绑定用户在对应 DSH 工作区中已有的工具与审批权限；本次不授予新权限。父分支为 `codex/dingtalk-server-runtime`，核查基线为 `0c50a3b063ecc87ee14b51d536bcf8c289af37d7`。

## 权威来源核查

核查插件源码及公开 npm 发布的 `@deepseek-ai/dsh-*` **`0.2.1-rc.5`**，不是从模型参数或前端显示推断权限。

| 环节            | 已有证据                                                                                                                                                | 不能证明的事项                                                                                  |
| --------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------- |
| 消息主体        | `src/identity.ts` 从官方消息取 `senderCorpId + senderStaffId`；Relay 再核对已配对主体                                                                   | 该主体在 DSH 的用户身份、工作区授权                                                             |
| DWS 授权        | `enhancements/src/host/managed-connection.ts` 的 `invokeFor` 逐次校验主体、reader、撤销状态；审批后再核对授权版本                                       | shell、文件、其他插件等宿主工具的授权                                                           |
| 工作区          | `src/workspace.ts` 与 `@deepseek-ai/dsh-workspace/lib/types/spec.d.ts` 提供真实路径及会话归组                                                           | 用户对该工作区的访问权；`/cd`、目录存在、注册成功都不是授权                                     |
| Agent 创建/恢复 | `src/host.ts` 与 `@deepseek-ai/dsh-agent/lib/types/index.d.ts` 提供 session、cwd、preset、setup                                                         | 可信 DSH 用户、用户与工作区的有效授权、持久会话的用户归属证明                                   |
| 工具与审批策略  | `dsh-tools` 的 guard 可继续拒绝；`dsh-permission-presets`、`dsh-sandbox-policy`、`dsh-user-approval` 使用会话覆盖值及部署默认值                         | 这些值是否属于当前钉钉主体，以及主体撤销后的有效策略                                            |
| 子 Agent        | `dsh-subagent/lib/index.js` 的 `applyChildComposition` 使用 `composeFrom`；`dsh-agent-preset-registry/lib/index.js` 将子 Agent 绑定到 preset generation | 父机器人 Agent 的 IM shadow、guard 和审批监听器会自动继承；`parentAgent` 本身只表达运行时所有权 |

子 Agent 的原生审批策略为 `never`，本单没有修改它。公开 API 没有提供完整的可信主体到工作区授权映射或机器人子 Agent 的安全组合契约。不能把 DWS 登录相同、机器人 owner、默认 preset、当前 Web 用户或工作目录相同当成替代证明。

因此保留入口拒绝。未注册、已禁用及其他非 DWS 工具不会因本单变得可用；返回 `im_tool_unavailable: im_workspace_policy_unavailable`。这不是一个返回“允许”的空壳权限服务，也没有添加 allow-all 配置。

## 本次交付

- `ImTools` 固定实际 Agent 对象及消息主体。guard 和 DWS 局部 shadow 拒绝其他 Agent、相同 session ID 的替代实例，以及借用该 shadow 的子作用域。安装 guard 失败时撤销 shadow，允许宿主安全回滚/重试。
- 到达机器人作用域的审批缺失会话路由或 Agent 不符时返回 `unavailable`。文字回复按企业、会话类型、会话和发送者匹配；有企业身份的请求不能被缺失或不同企业身份的回复批准。原有无企业字段的事件只匹配同类旧路由，不由此获得 DWS 或工作区权限。
- 既有 owner 审批策略保留；允许一次、拒绝、AbortSignal 取消、超时和不可达均有回归。尚未实现一般 DSH 用户的审批授权映射。
- 创建、恢复、setup 回滚、preset 缺失、外部运行实例恢复及 `/cd` 路径都有拒绝策略断言。测试中的目录/工具注册不被当作授权证据。
- `send_file` / `send_image` 继续独立拒绝，现有文件实现、Agent/会话目标、真实路径、类型、20 MB 限制及未知结果不重试语义未变。
- Connector 的 `identity.getSelf` / `calendar.listEvents` / `docs.search` operation 白名单未变。本地/远端 DWS 身份校验、每用户凭据、撤销和队列未变。

## 解除阻断所需契约

需要宿主维护者提供并确认：可信消息主体到 DSH 用户及工作区的可撤销映射；创建/恢复前的会话归属验证；每次执行及等待审批后的有效工具、沙箱和审批策略；在子 Agent 发布前安装同一身份边界的机制。未知、失效、撤销、主体不符和无审批承接能力均须拒绝。

本单不修改 DSH/Cellgent 核心，不用新凭据或持久授权绕过缺失契约。等上述契约可验证后，才能实施非 DWS 正向调用、权限动态变化与真实子 Agent 继承验收。当前 draft PR 不应关闭 Issue #27。

## 复现检查

仓库未包含 `.agents/skills`；开发检查遵循 `AGENTS.md`。使用 Node `24.19.0`、pnpm `11.19.0`。

```bash
cd dsh-dingtalk
pnpm install --frozen-lockfile
pnpm run ci

# 独立目录安装官方发布包，不改项目依赖、不启动 DSH 服务/机器人
mkdir -p /tmp/dsh-issue27-runtime
npm install --prefix /tmp/dsh-issue27-runtime --ignore-scripts \
  @deepseek-ai/cordis@4.0.5 \
  @deepseek-ai/dsh-system-prompt@0.2.1-rc.5 \
  @deepseek-ai/dsh-tools@0.2.1-rc.5 \
  @deepseek-ai/dsh-scope@0.2.1-rc.5
DSH_TEST_RUNTIME=/tmp/dsh-issue27-runtime node scripts/verify-boundary.mjs
```

`verify-boundary.mjs` 使用真实发布的 ToolRuntime、Scope 与合成工具。它证明精确 Agent 的 DWS shadow、宿主 guard 仍可拒绝、非 DWS/文件工具拒绝及独立 Web 不受影响；手工挂接父作用域的子 Agent 用于验证拒绝，不代表原生子 Agent 已安全继承。

公开运行时测试使用模拟 Stream/网络/审批承载；没有连接真实企业、真实机器人，未操作 39/43、部署、发布或合并。最终检查结果记录在 PR，不能把安全阻断测试通过视为权限继承功能通过。

### 2026-11-05 本地结果

| 检查                                                       | 结果                                                 |
| ---------------------------------------------------------- | ---------------------------------------------------- |
| `pnpm run ci` 中 secrets / prettier / 两组 TypeScript 检查 | 通过                                                 |
| `umask 0022 && pnpm run ci` 中消息侧全量测试               | 430 tests：423 pass、7 skip、0 fail                  |
| 同次 CI 的 Web/DWS 测试                                    | 75 tests：66 pass、5 skip、4 fail；CI 最终非零退出   |
| 基线 `0c50a3b` 独立 checkout 的 Web/DWS 全量测试           | 相同 66 pass、5 skip、4 fail                         |
| `pnpm run test:pack`（CI 因上述失败未走到此步，单独运行）  | 通过；包含权限核查文档                               |
| `DSH_TEST_RUNTIME=… node scripts/verify-boundary.mjs`      | 固定公开 `0.2.1-rc.5` ToolRuntime/Scope 离线验证通过 |
| `git diff --check`                                         | 通过                                                 |

Web/DWS 的三个失败（`capabilities.test.mjs` 一项、`identity.test.mjs` 两项）因测试固定读取 `.cache/dingtalk-g0/bin-amd64/dws.exe`，本 Linux 环境缺少该制品；第四个是 `local.test.mjs` 的进程树超时/Abort 夹具未在期限内创建预期子进程状态。四项均在未修改基线复现，未跳过或改写测试使检查变绿。远端 backend、Relay、文件边界等其余测试通过；缺制品的本地真实 CLI 身份/撤销场景仍有验证限制。

首次 CI 使用环境默认 `umask 0077`，另有 `doctor-report.test.mjs` 权限夹具失败：其要求创建 `0644` 文件，但被 umask 收紧。该失败也在基线复现；仅在测试子 shell 设为 `0022` 后消息侧全量通过，没有修改应用或全局 umask。安装依赖时使用工作区内的 XDG/pnpm 缓存目录，未改凭据或远端服务。
