# 个人机器人工作区工具权限（Issue #27）

已支持**已配置的 personal、本机 profile owner、插件自有会话**继承已核实的普通宿主工具。权限依据是机器人渠道自身的可信配对和官方消息 sender，不要求 DWS OAuth 当前有效，不要求重新做工作区绑定，不新增工作区 ACL。

企业机器人可按席位配置下列只读问数工具。旧共享 Relay、standalone 和数字员工不继承这些权限。原生子 Agent、工作流和文件/图片回传仍受原限制。

## 企业机器人问数

在已有的 `robotConnection` 内配置 `queryTools`（完整工具名称数组，默认为空）。仅把该席位原有且允许该员工使用的 MCP 工具加入配置。工具还必须经过宿主的启用、限制和审批检查。

```yaml
queryTools:
  - mcp__openmetadata__search_metadata
```

可配置的操作如下。每个名称使用前缀 `mcp__服务名__` 加表中的操作名；未知名称与通配符均拒绝。

| 服务         | 只读操作                                                                                                                                                           |
| ------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| wren         | semantic_instructions、list_semantic_models、describe_semantic_model、list_semantic_cubes、describe_semantic_cube、dry_plan_only、run_semantic_sql、run_cube_query |
| openmetadata | search_metadata、get_entity_details                                                                                                                                |
| doris        | get_db_list、get_db_table_list、get_table_schema、exec_query                                                                                                       |

启用查询前，部署方须核对连接的实际服务、数据范围及数据库只读授权；特别是 SQL 工具需要服务端限制和数据库最小权限。机器人配对不会给共享数据库凭据自动添加行列权限，不能把工具名称当作 SQL 写入防护。

私聊与网关接收的群聊都使用发送人的既有企业配对。查询不需要逐群配置；群内结果发回原群，可被全群阅读。@ 同事不会切换到对方身份。工具根据当前接收端已验证的原始消息、企业、员工及在线连接执行；断开或更换连接后，旧消息不能沿用授权。查询不授予文件、命令、数据库管理、元数据写入或其他 MCP 权限。

## 两条独立授权链

**机器人渠道**：已认证的 DSH browser owner 经原有 Host RPC 发起连接；机器人应用自己的 OAuth 验证企业与成员；Gateway 提交设备绑定，再向当前 profile 的接收端交付设备凭据。消息由官方 Stream 提供企业和 sender，并由 Gateway 匹配已配对设备。每次普通宿主工具执行核对当前个人配置、在线设备、持久绑定、profile 和连接存活信号。

**DWS 数据工具**：`dingtalk_call` 继续使用 Agent 局部 shadow 和 `managed.invokeFor`，独立验证 DWS OAuth、企业/用户、scope、撤销和原生审批。DWS 未授权时普通宿主工具仍可执行，DWS 工具仍返回需要授权；DWS 换号不会改变机器人渠道 owner，也不能借用另一个 DWS 用户的数据。

个人通道的状态、消息接收、owner 判断和工具授权均不再以当前 DWS identity 为条件。机器人断开、被其他设备替换、停止或连接关闭会使通道执行信号失效；DWS 注销不会撤销机器人配对。已有设备重启后用原 token 向 Gateway 验证，旧记录缺少 device 时从已认证握手补齐，无需重新配对。企业和旧 Relay 保留原有策略。

全新、尚未配置的个人机器人仍需要首次取得企业信息：当前安装流程用 DWS 身份发现 corpId。本次未新增企业字段或更改设置页；这个初始化限制不适用于已经配置的机器人，也不作为普通工具执行、恢复或重新连接的授权前提。原有 personal 配置不会因 DWS 换号而迁到另一企业。

## 工作区与会话

- 默认目录仍是 `config.workspace`，未配置时是 `~/dsh-dingtalk-workspace`，由原安装流程创建。目录存在或自动注册只说明工作目录可用；授权来自已经配对的本机 profile owner。
- `/cd` 仍是 owner 的显式选择，可用现有路径或已注册工作区序号。选择前沿用目录存在检查；执行时取真实路径，记录为新会话的工作区。没有因为本单获得其他用户或企业工作区的权限。
- 消息接收时、任何异步等待前保存当前配对、连接 lease 和会话选择版本，入队时再固定真实路径。出队、setup、同步 commit、消息注入前、每次工具 guard、调度后的实际 dispatch、审批前与允许返回时重新核对。`/cd`、`/new` 或模型重开撤销旧选择；旧消息即使正在等待模型能力查询或排队，也不会转到新工作区执行。
- setup/commit 固定实际 Agent 对象、session ID、主体、设备配对、profile、scope 和工作区。普通工具只在 Host session.header.cwd 与 workingDirectory.get(session) 都匹配时继承。路径不可解析、符号链接改指、上下文缺失或校验失败均拒绝。
- 私有 `workspace-session-owners.json` 是插件会话归属记录，不是新的授权数据库。恢复必须匹配原配对、主体、profile 和真实工作区。旧版本没有该记录或归属不明时，新建插件会话并保留旧历史；不会接管 Web 或其他运行实例。
- 恢复后的新 Agent 会撤销同一 session ID 的旧实例授权；撤销期间等待的执行不能移到新配对、新连接或另一个 Agent。取消信号跟随宿主调用，未声称可以强杀不遵守 AbortSignal 的第三方同进程代码。

工作区检查保持宿主现有路径、沙箱和审批语义，不把 cwd 冒充操作系统隔离边界，也不覆盖宿主对工作区外访问的拒绝。

撤销阻止后续授权和工具 dispatch，并向仍在等待的工具调用传递取消信号；已经被宿主接受的后台作业/终端任务按宿主原有生命周期运行，可能继续执行。已经开始的入站附件写入也不承诺回滚。本次没有新增进程沙箱或后台任务清理服务。

## 可继承的普通工具

仅允许已核实的 DSH `0.2.1-rc.5` 普通工具名称进入宿主原有执行链。工具仍须已注册、可见且被宿主有效策略允许；禁用、restriction、guard、沙箱及审批都不会被插件覆盖。

| 类别          | 工具                                                                                                    |
| ------------- | ------------------------------------------------------------------------------------------------------- |
| 文件与搜索    | `read`、`write`、`edit`、`read_image`、`glob`、`grep`、`str_replace_editor`                             |
| 命令          | `bash`、`pwsh`                                                                                          |
| 宿主作业      | `job_output`、`job_list`、`job_kill`                                                                    |
| 终端          | `terminal_open`、`terminal_send`、`terminal_read`、`terminal_signal`、`terminal_close`、`terminal_list` |
| 宿主 PTC 入口 | `run_code` 暂不开放：内层权限/审批/撤销尚未由固定版本探针覆盖，保持 fail-closed；验证通过后另行开启     |
| 既有 IM 工具  | `dingtalk_call`、`skill`、`ask_user_question`                                                           |

名称依据为固定公开 npm 包的 `lib/index.js`：`dsh-tool-fs`、`dsh-tool-fs-search`、`dsh-tool-str-replace-editor`、`dsh-tool-bash`/`-persistent`、`dsh-tool-pwsh`/`-persistent`、`dsh-tool-jobs`、`dsh-tool-terminal` 和 `dsh-tools`。未注册/未核实的名字拒绝；没有 allow-all 配置。

作业和终端 ID 继续经过宿主归属检查：有属主的作业匹配 session ID，终端匹配实际 Agent 对象，不能借参数访问另一个属主。宿主明确设为无属主的共享作业仍按原有服务语义可见；插件没有另建作业隔离策略。

`run_code` 是 PTC 内层工具入口：固定版本 `dsh-tools` 的嵌套 dispatch 会复用同一 scheduler/guard，但本仓库尚无覆盖“内层审批与撤销”的固定版本探针，因此暂不纳入本名单，按未核实工具默认拒绝。

`subagent`、`spawn_agent` 继续显式拒绝。公开 `dsh-subagent` 经 `composeFrom` 组合到 preset generation，不能保证继承父机器人 Agent 的 shadow、guard 和审批。`workflow`、`ralph`、`spawn_teammate` 及自定义编排名也可能启动 Agent，因此未经核实的工具默认拒绝，不能只靠列出几个禁用名称防护。

`send_file` / `send_image` 独立拒绝；现有发送实现的当前 Agent/会话目标、真实路径、类型、20 MB 和结果未知不重试规则未修改。Connector 接受本次交付的服务器操作（发现、执行、后台任务和三项兼容查询）；调用方身份仍由 socket 绑定决定。

## 审批

宿主决定是否需要审批及是否直接拒绝；`never` 等原生策略没有被放宽。机器人按已配对 owner 承接允许一次、拒绝、取消、超时和不可达，文字回复精确匹配企业、聊天类型、会话和 sender。到达 IM 作用域但缺少路由、Agent 不符或授权失效时不回退 Web。

允许结果返回前再次检查原 Agent 的配对与工作区。工具进入 dispatch 时还会检查一次，并合并原调用、渠道、会话选择及 Agent 生命周期取消信号，覆盖审批等待和调度延迟中的撤销。

审批在 dispatch 前就绑定原调用、渠道、会话选择及实际 Agent 这一代的取消信号。配对撤销、设备替换、重连、`/cd`、`/new` 或模型重开会立即取消对应旧审批并释放文字/卡片路由；`/cd` 与模型重开命令优先于旧问题/审批回答处理。旧代清理和迟到卡片不能删除新代等待，其他会话的目录切换也不取消本会话审批。

设置页文案的合并交接：`enhancements/src/client/relay.ts` 的 personal 未连接提示仍写有“请先完成上方个人钉钉授权”，应在修改该文件的设置页 PR #29 中去掉这个 DWS 前置提示，分别说明机器人应用配对与 DWS 数据授权。本分支不改该前端文件，合并时保留这里的 Host 解耦及审批生命周期实现，不用任一分支整文件覆盖另一分支。

## 验证

遵循 `AGENTS.md`，仓库未包含 `.agents/skills`。Node `24.19.0`、pnpm `11.19.0`；未改 DSH/Cellgent 核心。

```bash
cd dsh-dingtalk
pnpm install --frozen-lockfile
umask 0022
pnpm run ci
pnpm run test:pack

# 独立安装固定公开运行库，不启动 DSH 服务或机器人
mkdir -p /tmp/dsh-issue27-runtime
npm install --prefix /tmp/dsh-issue27-runtime --ignore-scripts \
  @deepseek-ai/cordis@4.0.5 \
  @deepseek-ai/dsh-system-prompt@0.2.1-rc.5 \
  @deepseek-ai/dsh-tools@0.2.1-rc.5 \
  @deepseek-ai/dsh-scope@0.2.1-rc.5
DSH_TEST_RUNTIME=/tmp/dsh-issue27-runtime node scripts/verify-boundary.mjs
```

`personal-workspace-runtime.test.mjs` 通过公开 apply 使用真实 Bridge/Commands/策略，覆盖无 DWS 授权时普通工具、跨主体拒绝、队列撤销/换绑、setup commit、有效恢复、旧会话/外部实例和 `/cd`。`workspace-tool-policy.test.mjs` 覆盖真实路径、profile/配对隔离、重启和执行期间取消；审批测试覆盖返回前撤销；Relay 测试使用真实本地 socket 和合成 OAuth，区分 DWS 注销与机器人撤销。

`verify-boundary.mjs` 使用真实固定 ToolRuntime/Scope，验证普通 `read` 正向调用、宿主 guard/restrict、审批决策、实际 scheduler prepare/dispatch 间撤销及执行中取消。工具、渠道和审批答复为离线夹具；未宣称真实机器人、真实审批 UI 或 PTC 解释器联调通过。

完整结果在 PR 中记录。已知原始基线 `0c50a3b` 的 Web/DWS 环境限制：三个测试固定读取缺失的 `.cache/dingtalk-g0/bin-amd64/dws.exe`，一个进程树超时/Abort 夹具未及时达到预期状态；默认 umask 0077 还会收紧 doctor 的 0644 权限夹具，因此测试子 shell 使用 0022。没有删改/跳过失败测试使 CI 变绿。

未连接真实企业或机器人，未操作 39/43、部署、发布或合并。全新个人配置的 corpId 引导、未核实工具、原生子 Agent 及非 personal 路径仍是明确限制。

企业问数在 MCP 返回时再次校验派发时的员工和连接。执行期间撤权或换号的结果不会交回原会话。
