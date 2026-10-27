# 开发进度与验收台账（BOOP）

> 对应冻结包 `handoff/验收执行台账_待填写.json` 的工程侧实时记录。
> 规则：未运行 = `NOT_RUN`；缺外部条件 = `BLOCKED`；只有真实执行证据才能写 `PASS`。
> 证据必须能复现：实现 commit、宿主版本、环境、命令、实际结果、审查人。

## 0. 环境事实（本机实测）

| 项 | 值 | 证据 |
|---|---|---|
| 当前桌面宿主 | Desktop **`0.2.1-rc.3`**（`E:\deepseek-harness\resources\app.asar` 根 `package.json`，包名 `@deepseek-ai/dsh-desktop`） | `dshBuildCommit = be72761ee1a6736ebcdf4f3739363b083ae53c98`，`dshBuildDirty=false`。副本在 `.work/desktop-package.json` |
| Web 测试载荷 | **`0.2.1-rc.2`**（`.work/test-host/payload-0.2.1/dsh`） | 宿主套件仍对着这份载荷；提交常量 `332895e0f7c9d4dbfb29729f5eb367fa263ff986` |
| 插件兼容声明 | `engines.dsh = "0.2.1-rc.2 \|\| 0.2.1-rc.3"` | 宿主 `semver.satisfies(..., { includePrerelease: true })` 对这两版为真，对 `rc.1` / `rc.4` / `0.2.1` 为假。没有 `compatibility.json` |
| 宿主运行时 Node | `v24.21.0`（`~/.dsh/dsh-runtimes/dsh-primary-runtime/dependencies/node/bin/node.exe`） | 本机探测 |
| 宿主 React | `18.3.1`（web shell 静态模块表内联） | `dsh-web-frontend/dist/assets` 字符串 |
| 测试用宿主副本 | `.work/test-host/payload-0.2.1/dsh`（`tools/build-test-payload.mjs` 从 asar 只读提取 405.60 MiB / 17,262 文件 + `app.asar.unpacked` 原生模块；旧 rc.2 副本仍在 `.work/test-host/payload/dsh` 作差异对照） | 本仓库工具 + `payload.json` |
| 用户真实 `~/.dsh` | **未读写其 DSH_HOME 数据**：所有测试用 `.work/test-runs/**` 独立 DSH_HOME（`.work/test-host/payload*` 仅作只读 payload）；测试会复用 `~/.dsh/dsh-runtimes` 下的 node/pnpm 可执行文件，但不读写 profiles/sessions/storages | 测试代码路径可见 + qa-verify 前后 mtime 抽查（`docs/development/evidence/rc21-alignment-verification.md`） |
| 自有模型服务（IN-01/02/03） | vLLM `http://172.26.0.49:8000/v1`；模型 id `qwen3.8-27b`（另有别名）；`max_model_len = 196608`；root `Qwen3.8-27B-AWQ-INT4`（4bit）；**无凭证**（内网 HTTP） | `/v1/models` + 真实金标实测（`docs/development/evidence/e05-00/qwen-gold-report.md`） |

> 陈旧值提示：`~/.dsh/dsh-runtimes/dsh-primary-runtime/runtime.json` 仍写 `desktopVersion: 0.2.1-rc.1`（上一次启动残留）。
> 以 asar 内 `package.json` 为准；不要用该 runtime.json 判定宿主版本。

## 0.1 rc.2.1 对齐（2026-10-18，commit `2c99dc2`）

用户桌面端由 `0.2.0-rc.2` 升级到 **`0.2.1-rc.2`**。本轮把 BOOP 的开发与验收基线切到新宿主，
并完成第一轮公开面适配。完整差异报告见 `docs/development/RC21_ALIGNMENT.md`；要点：

| # | rc.2.1 变化 | 对 BOOP 的影响 | 处理 |
|---|---|---|---|
| A1 | 插件兼容门在 rc.2.0 已有（**只看** `@deepseek-ai/dsh*` peerDependencies）；rc.2.1 改为**优先看 `engines.dsh`**（声明了它则 peers 被忽略），并新增 profile 级 `compatibility.json` 精确豁免。不满足时 bundle 被**静默跳过**（仅 stderr 一行 `skipping profile bundle … incompatible`） | 旧清单 peers 钉 `0.2.0-rc.2` → BOOP 行完全不装配、`/api/boop/*` 404、客户端模块图无 `dsh-boop` | **已改**：`package.json` 增加 `engines.dsh = "0.2.1-rc.2"`，peers 升至 `0.2.1-rc.2`；**不申请版本豁免**（对齐而非绕过） |
| A2 | npm 包集合 289→306；`dsh-client-store`/`-ui-slots`/`-ui-primitives` 不再作为独立包发货 | 曾担心浏览器半失效 | **无需改**：web shell 冻结静态模块表仍提供这些 id（与 rc.2.0 相同的 9 项，rc.2.1 另增 `zod`、`@tanstack/react-virtual` 共 11 项），`MenuItemButton` 仍由 primitives 命名空间导出；BOOP client 只依赖 React + primitives |
| A3 | web profile 挂载行变化：新增 `schedule`、`remote-access` 等（`session-title-llm` 等 rc.2.0 已存在）；新增 `tool-schedule`、`tool-session-query`、`tool-terminal`、`working-directory` 等包 | 能力矩阵与断言需按真实值更新 | **已改**：`capabilities.schedule` 在 rc.2.1 为 `true`，E00-01 断言与注释更新；探针始终读 live registry |
| A4 | 客户端 slot 面（`main` keyed、`sidebar.workspaces.session.menu.item`、`...session.row.action`、`slots` 服务、`layout.selectPanel`）保持兼容 | 菜单入口可继续使用 | **已确认（静态）**：shell 字符串 + 独立核验的 keyed `main`/slot 目录静态证据；live Inspector 在核验时多次报无连接页面，A4 的 live 半句保持 NOT_RUN。client entry 使用已验证的 `menu.item` |
| A5 | 宿主启动更慢（完整 Loader 树 ~40s+）暴露旧测试对 15s 租约 TTL 的时序依赖 | E01-02 重启用例在 rc.2.1 下必然失败；并实证「并发第二 Host 在 TTL 后接管仍存活 Host 的写管理」（fencingToken 2→3） | **已改**：重启改为真正先停后启，断言 scopeId 稳定 + 接管后 token 严格 +1；**心跳缺口记入风险**（见 §3），E07-01 前必须补心跳或明确单实例策略 |

对齐后证据（全部在 rc.2.1-rc.2 实跑，独立 `.work/test-runs/**`）：

- 宿主集成 **37/37**：E00-01 11/11、E00-02 8/8、E01-01 5/5、E03-01 5/5、E04-01 assets 8/8；
- 单元 + 客户端 **93/93**（本轮未改纯逻辑）；
- 复现：`node --test --test-force-exit tests/host/e00-01-plugin-load.test.mjs tests/host/e00-02-proxy-gate.test.mjs tests/host/e01-01-storage-in-host.test.mjs tests/host/e03-01-observe-in-host.test.mjs tests/host/e04-01-assets-in-host.test.mjs`；
- 已知未覆盖：Desktop Electron GUI 回归、真实浏览器截图回归（模型能力已在 E05-00 用真实服务验证）。

## 0.2 门账本与写入模式（唯一来源：`src/host/gates.ts`）

写入模式**不再由布尔量手工设置**，而是由冻结门账本派生：`writeMode.enabled = 所有必需门 PASS`；
`bootstrap` 同时返回 `gates`、`gateEvidence`（每门证据/缺口）与 `writeMode.blockedByGates`。

| Gate | 状态 | 证据 / 缺口 |
|---|---|---|
| G01 | **PASS** | `tests/host/e00-01-plugin-load.test.mjs` 11/11（0.2.1-rc.2，commit `2c99dc2`） |
| G02 | **PASS** | `docs/development/evidence/e05-00/qwen-gold-report.md` — 真实 Qwen 8/8 能力，上下文 196608 实测 |
| G03 | **PASS** | 真实宿主幂等/对账见 `tests/host/e02-03-idempotency-in-host.test.mjs`。生产启动会在持有写租约时调用 `reconcileOutbox`，并只在正常退出写下 `clean_shutdown`（`tests/unit/e03-05-host-init.test.mjs`）。边界：Host 自身无跨进程 messageId 去重。 |
| G04 | **PASS** | `tests/host/e00-02-pre-step-gate.test.mjs` 2026-10-27 为 7 通过、1 跳过（未设 Qwen，跳过真实模型回复）。官方 `agent/pre-step` waterfall（行 `boop-gate`）在 step/user-commit/request 前拦截未释放的 boop-command；显式释放后同一已 claim 消息恰执行一次，模型端口不可达时以错误结束且没有伪造回复；普通用户消息透传；超时/账本不可读 fail-closed；`runtimeEnforcement.composed=true`。边界：rc.2.1 在 pre-step 前已写 turn/start 并取走 inbox claim，故保证"无 step/无提交/无模型"而非"无 turn/start"；被拒 claim 不可复活（durable re-admission NOT_RUN） |
| G05 | **PASS** | 宿主控制面与 Edge 用同一套规则。2026-10-27T09-16-44-730Z：写模式开启时停止是 noop，恢复没有全选，批准落账且动作保持 `awaiting_approval`，过期卡批准按钮禁用。控制行 `dispatch.available` 始终为 false（`dispatch-not-on-this-row`）。渠道准入拒绝未知身份，没有审批授权方法。 |
| G06 | **PASS** | 真实宿主 `tests/host/e04-01b-main-session.test.mjs` 10/10：`from_now` 写入水位，`learn_history` 读完已解析来源并结束作业（不调用模型），没有确认预览的导入不写。遗忘 tombstone 与 FTS 降级见 `tests/unit/e03-05-host-init.test.mjs` 5/5。 |
| G07 | **BLOCKED** | 凭证未配置。主宿主行只挂关闭的渠道运行时（`tests/unit/e06-01-admission.test.mjs`）。不开网络。 |
| G08 | **PASS** | 真实 Web Host：第二进程在第一进程心跳期间保持只读且 fencing token 不变，释放后重启 token+1（`tests/host/e01-01-storage-in-host.test.mjs` 6/6）。单元：心跳越过 TTL 不放权、关闭后接管 token 增大（`e01-01-lease-heartbeat`）；node:sqlite、一致备份、失败迁移仍可读（`e00-03` 11/11）。Desktop GUI 打开同一账本并出现 `boot/reconciled clean=true`。macOS/Linux 不宣称。 |
| G09 | **PASS** | Desktop **0.2.1-rc.3** 私有窗口：任务板显示写模式开启且派发不可用（`dispatch-not-on-this-row`）、浅色/深色跟随宿主、停用后侧边栏和样式表消失且「新会话」仍在、同一开关重新打开后侧边栏回来（`docs/development/evidence/desktop-gui/report.md`，`desktop-gui-1793092410382`）。Edge 任务板搜索框 IME「波波」（`web-e2e-control/2026-10-27T09-16-44-730Z`）。无重复 React 报错。macOS/Linux 仍不宣称支持。 |

当前 `writeMode.enabled = true`，`blockedByGates = []`（G01–G06、G08、G09 PASS；G07 BLOCKED 不阻塞本地写）。持有写租约的进程才会真正写入。
`tests/unit/gates.test.mjs` 锁定规则（PASS 必须有证据、缺任一必需门则关闭、G07 不阻塞本地写）。

## 1. 已完成工作项

### E00-01 · rc.2 插件加载与公开适配面验证

| 项 | 内容 |
|---|---|
| Gate | **G01（插件装配、鉴权与公开适配面）** |
| 场景 | AT-08 / AT-35 / AT-38 |
| 实现 commit | `b16f4ea` |
| 环境 | Windows 10/11 · DSH 0.2.0-rc.2 · Node v24.21.0 · 独立 DSH_HOME `.work/test-runs/e00-01-*` |
| 复现命令 | `node --test tests/host/e00-01-plugin-load.test.mjs` |
| 结果 | **11/11 PASS**（0.2.0-rc.2；测试文件 `tests/host/e00-01-plugin-load.test.mjs`） |

已验证的具体断言：

1. 全部已装配条目激活，无 `failed to import` / `did not activate` 警告。
2. 未认证访问被拒绝：`GET /` → 401；`POST /api/boop/bootstrap` 无 cookie → 401。
3. 已认证 `boop/bootstrap` 返回 scope 身份、能力矩阵、G01–G09 门账本；写模式关闭、恢复门禁已装备。
4. BOOP 行（`dsh-boop`/`boop-tools`/`boop-api`/`preset-boop`）在合成配置中各出现一次（重复安装不重复注册）。
5. 加入 BOOP bundle 后，原生 web 配置顶层行与未装 BOOP 的 profile **逐行一致**（不污染普通 Session 配置）。
6. 客户端 bundle 在受权 index 中被引用并以 BOOP 模块 id 提供。
7. rc.2 真实服务键矩阵：`sessions`/`sessionController`/`typertGateway`/`connection`/`tools`/`agentLoop`/`llm`/`credentials`/`jobs` 存在；`schedule` 在 web profile 下缺失（可选行，如实记录）。
8. 卸载：移除 bundle 后 BOOP 行消失、`boop/bootstrap` 返回 404、原生启动零警告。

未覆盖 / 待办（不计入 PASS）：

- Desktop（Electron）端到端启动尚未实测（主机版本已确认相同，但未在 Electron 中跑过 GUI）；归入 G09。
- 冷历史读取不创建 Agent（AT-38 主体已由“读 bootstrap 不触发 Agent”间接覆盖，专门用例属 E02-04/E03-01）。

**0.2.1-rc.2 复跑（2026-10-18，commit `2c99dc2`）**：同一套断言 **11/11 PASS**（payload `.work/test-host/payload-0.2.1/dsh`）。断言随宿主更新的两处：宿主版本/提交常量 → `0.2.1-rc.2` / `332895e0…`；`capabilities.schedule` 由 `false` 改为 `true`（rc.2.1 web profile 挂载了 `schedule` 行）。

### E00-02 · 代理消息来源与谨慎恢复门禁

| 项 | 内容 |
|---|---|
| Gate | **G03（来源/消息/队列/对账）部分 PASS**、**G04（启动门禁）部分 PASS** |
| 场景 | AT-12 已验证、AT-14 未验证、AT-26 已验证、AT-13 **NOT_RUN** |
| 实现 | `src/host/gate/recovery-gate.ts`、`src/host/transport/command-envelope.ts`、`src/host/api-service.ts` |
| 环境 | DSH 0.2.0-rc.2 · 独立 DSH_HOME `.work/test-runs/e00-02-*` · 合成 Session，无模型调用 |
| 复现命令 | `node --test tests/host/e00-02-proxy-gate.test.mjs` |
| 结果 | **8/8 PASS** |

已验证的具体断言：

1. 代理命令 `source.kind = boop-command`，**永不等同 `user`**；正文不会被解析成权限。
2. 来源判定基于身份（宿主生成的 messageId + source 信封），**不基于文本**；伪造 `{"boop":…}` 文本的消息不被识别。
3. 门禁未装备时 fail-closed；装备后阻断上一轮遗留的代理命令；只接受按 messageId 的显式释放，并记录审计事件。
4. 真实 rc.2 持久化收件箱投影重建后，待执行消息的来源仍是 `boop-command`（AT-12/AT-26）。
5. 释放后放行；`disarmForRestart()`（新进程）重新全部阻断。
6. **Host 重启实测**：新进程重新装备门禁，但门内条目为 0、不隐式接管任何 messageId，上一进程的合成 Session 不会被自动恢复执行（AT-26）。
7. BOOP 的 `boop` preset 未注入原生 `standard` preset，普通 Session 配置不受影响。

**已由 E02-03 真实派发补齐（2026-10-18，见下文 E02-03 小节）**：真实 `agent.followup()` 投递到活动 Agent、durable provenance 与 inbox 认领对账已在真实宿主 + 真实 Qwen 模型上 PASS。**rc.2.1 事实修正**：`agent/inbox/claimed` 只经 `dispatch.emit` 发出，**不是 durable Session 事件**；durable 的认领边界是紧随的清空型 `agent/inbox/spliced`，对账以「splice 对 + `user/message`」为准。

**仍 NOT_RUN（不伪造 PASS）**

- AT-14：派发前用户改方案 → `taskVersion/policyEpoch` 拒绝旧动作（单元覆盖，真实链路未联调）。

**G04 收口：运行时 `agent/pre-step` 门控（2026-10-18，PASS）**

| 项 | 内容 |
|---|---|
| 实现 | `src/host/gate/pre-step.ts`（`PreStepRuntimeGate`）+ `src/host/gate/pre-step-api.ts`（独立行 `boop-gate`，注册官方 `agent/pre-step` waterfall、提供 `boopGateRuntime` 与只读 `boopGate/status`）；`control.ts` 的 `runtimeEnforcement.composed` 改读真实注册状态 |
| 复现命令 | `node --test --test-concurrency=1 --test-force-exit tests/host/e00-02-pre-step-gate.test.mjs`（真实模型 env 下 8/8；无 env 7 pass + 1 skip） |
| 结果 | **8/8 PASS**（真实宿主 + 真实 Qwen）；证据 `docs/development/evidence/e00-02/pre-step-report.md` |

已验证：未释放的 boop-command 被拦截在 `step/start` / user commit / `request/header` / 模型调用之前（durable 无 step、无 user/message、无 assistant）；`boopControl/release` 后同一已 claim 消息恰好执行一次且不重复；普通用户消息原样透传；超时/未装备/账本不可读对 BOOP 命令 fail-closed；放行/拦截写审计；`runtimeEnforcement.composed=true`。
**边界（如实）**：rc.2.1 在 pre-step 之前已写 `turn/start` 并取走 inbox claim，因此保证「无 step/无提交/无模型」而非「无 turn/start」；被 reject/超时的 claim 不可复活（durable re-admission NOT_RUN）；unarmed 状态 host 级未构造。

### rc.2 适配实测发现（已写入代码注释与测试）

| 发现 | 影响 | 处理 |
|---|---|---|
| 宿主模块同时导出 Service 类与 `apply` 时，rc.2 Loader 会**静默挂载类**，`apply` 不执行，Remote 端点不被认领（返回 404 且无告警） | 高 | `api.ts` 只导出函数式插件（`name`/`inject`/`apply`），服务类移到 `api-service.ts`；已加回归 |
| SRC 模式 Remote 方法按**形参名**组装参数，必须写普通命名参数，不能用单一 `args` 对象 | 中 | PoC 方法改为 `pocInbox(sessionId)` 等；E01-01 生成严格 descriptor 后复核 |
| Remote 线格式为 `{ type:'client-request', rpcId, method, payload:{ args:{…} } }` | 中 | 测试装置与客户端统一封装 |
| 会话重建种子事件必须带 `seq`/`time` 的完整信封 | 低 | `pocSeedInbox` 已按真实信封构造 |
| 收件箱是**持久投影**（`agent/inbox/spliced` 重建），跨重启确实保留待执行命令 | 高（验证了 G04 的必要性） | 门禁按“未知即阻断”设计 |

### E00-03 · SQLite、单控制者与备份可行性验证

| 项 | 内容 |
|---|---|
| Gate | **G08（存储、租约、迁移与恢复）** |
| 场景 | AT-02 / AT-36 |
| 实现 | `src/host/persistence/{database,lease,schema}.ts`（commit 随本行提交） |
| 环境 | 宿主运行时 Node v24.21.0 · SQLite **3.53.4** · 临时目录合成数据 |
| 复现命令 | `node --test tests/unit/e00-03-storage.test.mjs` |
| 结果 | **11/11 PASS** |

已验证的具体断言：

1. `node:sqlite` 在宿主运行时可用（3.53.4），持久库为 WAL，内存库为内存模式。
2. `foreign_keys=ON` 真实生效（越界 scope 写入被拒）。
3. JSON 列 `json_valid` 约束真实生效（畸形 criteria 被拒）。
4. 单写队列：200 个并发写事务串行提交，互不交错、不重复。
5. AT-02：第二 Host 对活动租约只能得到 `held`（只读）；TTL 过期后接管并铸出**更大的 fencing token**；旧 token 在所有写路径被拒（理由为 fencing）。
6. 租约过期后写入被拒并要求恢复，不会自动恢复业务。
7. AT-36：`VACUUM INTO` 生成一致快照；`integrity_check` + `foreign_key_check` 通过并可恢复数据。
8. AT-36：失败迁移回滚，schema 版本不推进，旧 schema 可读，备份完好。
9. UNC / 盘符根目录路径被拒绝启用写管理（03§02）。
10. FTS5 可选：关闭时核心账本照常工作。

未覆盖 / 待办：

- Desktop Electron 主进程内的同一路径尚未实测；代码只使用宿主 Node 运行时，不在渲染进程运行（本轮记录为 G08 部分 PASS，Desktop 侧待 E07-01 补测）。
- 网络共享目录的“拒绝启用”只有路径判定用例，无真实 SMB/NFS 环境（真实环境由 E07-01 在具备条件时补测）。

### E01-01 / E01-02 · 结构化账本、数据迁移与唯一身份

| 项 | 内容 |
|---|---|
| Gate | **G08 续**（账本与迁移）、**G09 部分**（身份与数据域绑定） |
| 实现 | `src/host/persistence/{repository,storage,migrate}.ts` + 宿主运行时接线 |
| 复现命令 | `node --test tests/unit/e01-01-ledger.test.mjs` / `node --test tests/host/e01-01-storage-in-host.test.mjs` |
| 结果 | 单元 **17/17 PASS**；真实宿主 **5/5 PASS** |

已验证：

1. 账本唯一位于 `$DSH_HOME/boop/boop.sqlite`（真实宿主实测），**绝不写入工作目录**。
2. scopeId 由规范化 `$DSH_HOME` + 本地 owner 派生（`boop-<16hex>`），**跨重启稳定**（实测）；同一安装的 Web/Desktop 共用一个数据域。
3. 单写者租约：**活动租约由进程内心跳续期**（新），因此活动 Host 不会被误判过期；TTL（15s）过期后第二个 Host 可接管并铸出更大的 fencingToken（AT-02 语义）；只读第二 Host 关闭时不会误释放主 Host 租约；写模式任何情况下都未开启。
4. 迁移前一致备份 + 失败回滚，schema 版本不推进。
5. 仓库层：三轴独立、任务版本乐观并发（AT-14 过期写者被拒）、资源键冲突、依赖环拒绝、审批单次消费绑定 (payloadHash, taskVersion, policyEpoch, nonce)、记忆快照 CAS、事实版本与证据 seq、审计。

### E02-01 / E02-02 / E02-03 · 任务账本、双层授权与可靠派发

| 项 | 内容 |
|---|---|
| Gate | **G03/G04 续**（派发控制流）、**G05 部分** |
| 实现 | `src/host/transport/dsh-adapter.ts`、`src/host/dispatch/dispatcher.ts` |
| 复现命令 | `node --test tests/unit/e02-dispatch.test.mjs` |
| 结果 | **11/11 PASS**（全部单元套件 46/46） |

**关键实测结论**：`SessionController.prompt()` 把消息来源硬编码为 `{kind:'user'}`，**无法携带代理来源**；因此 BOOP 走 Agent 自身的 `followup/steer` 直发，来源为宿主生成的 `boop-command` —— 既保留代理溯源，又不冒充人类消息。

已验证：任务版本 / 策略纪元 / 载荷哈希 / 审批四项前置全部在消息进入用户收件箱**之前** fail-closed；参数变化使旧审批卡立即失效；outbox 租约认领；派发后异常归 `outcome_unknown` 且**永不自动重试**；停止仅作用于 BOOP 自有动作。

**NOT_RUN**：真实 Agent 投递与 `agent/inbox/claimed` 对账、AT-13 断网重试对账 —— 需模型凭证（IN-01/IN-02）。

**G03 收口：AT-13 重复/断连对账 + 跨 turn 幂等（2026-10-18，PASS）**

| 项 | 内容 |
|---|---|
| 实现 | `src/host/dispatch/dispatcher.ts`（幂等派发 + durable 三态对账）、`src/host/transport/dsh-adapter.ts`（有界 durable trace 读 + pending 同 ID 去重）、`src/host/api-service.ts`（PoC-only `pocReconcile`，默认关） |
| 复现命令 | `node --test --test-concurrency=1 --test-force-exit tests/host/e02-03-idempotency-in-host.test.mjs`（真实模型 env 下 6/6；无 env 5 pass + 1 skip） |
| 结果 | **6/6 PASS ×3 连续**（51–55s/次）；证据 `docs/development/evidence/e02-03/idempotency-report.md` |

已验证：`messageId == action.id` 恒定，已投递重试返回 `duplicate`（不换 ID/不二次投递）；`outcome_unknown` 先做 durable 三态对账 `accepted / not-delivered / indeterminate`（`user/message` + splice 对 + inbox projection；`claimed` 不作 durable 证据）；只有「完整可读日志无痕迹 + cleanRestart 声明」才判 not-delivered 并落 planned/blocked，**绝不自动重试**；重复 reconcile `changed:false` 且不写第二条审计；SIGKILL+重启后由 durable 证据补记 accepted、零重放；真实模型 turn claim=1 / user-message=1、duplicate 后仍 1/1。
**边界（如实）**：Host 自身无跨进程 messageId 去重（由 BOOP dispatcher/adapter 层覆盖，绕过 BOOP 注入的重复 id 不在覆盖内）；生产 boot 自动对账与持久 clean-shutdown 标记尚未接线；多 Host 并发 reconcile、>200 候选截断路径 NOT_RUN。

**真实派发与对账（2026-10-18，E02-03 补齐，真实宿主 + 真实 Qwen 模型 PASS）**

| 项 | 内容 |
|---|---|
| 实现 | `src/host/transport/dsh-adapter.ts`（3 处真实部署缺陷修复）+ `src/host/api-service.ts` 新增 PoC-only 端点 `pocResolveAgent`/`pocDispatch`/`pocSessionRecord`/`pocClaimFeed`（`pocEnabled` 默认关闭） |
| 复现命令 | `$env:BOOP_QWEN_BASE_URL="http://172.26.0.49:8000/v1"; $env:BOOP_QWEN_MODEL="qwen3.8-27b"; $env:BOOP_QWEN_KEY="placeholder"; node --test --test-force-exit tests/host/e02-03-real-dispatch.test.mjs` |
| 结果 | **5/5 PASS × 4 次连续真实运行**（30–48s/次；单 turn 6.7–8.1s）；证据 `docs/development/evidence/e02-03/real-dispatch-report.md` |

已验证：
1. 模型路由：hand-declared `llm-pi-ai` gateway（`qwen-local` / `qwen3.8-27b` / `openai-completions` / `baseURL` 用户服务 / `contextWindow: 196608`），`agent-default-model` 覆写；assistant 消息实测 `provider=qwen-local`，回复 `BOOP-OK`、`turn/end=completed`。**无凭证服务仍需要 key 字段**（pi-ai OpenAI-compatible 限制），用占位 env，无真实密钥。
2. 派发：`prepareProxyCommand` + `Agent.followup` accepted=true（74ms），messageId/actionId 为宿主铸造；durable `user/message` 的 id/actionId 与回执一致且 `source.kind="boop-command"`（≠ user）。
3. 对账：runtime `agent/inbox/claimed` 恰好 1 次（同 id/source/actionId/turn）；durable 认领边界为清空型 `agent/inbox/spliced`（插入→清空）；inbox projection 消费为空；重启后 durable 记录存活、新进程零收养、零重放。
4. **修复 3 个只在真实部署暴露的适配缺陷**：(a) 静态 import `@deepseek-ai/dsh-llm`（未声明 peer）→ 整个 `boop-api` 行加载失败、所有端点 404，改为本地按 host 运行时语义构造消息；(b) `createUserMessage` 覆盖传入 id 导致回执 id 与 durable id 分叉，改为使用宿主铸造的 `envelope.messageId`；(c) `resolveAgent()` 返回 `{agent}|{error}` 联合未解包导致 followup 失败，改为解包 + `inspectAgent` 诊断。
5. **事实修正**：`agent/inbox/claimed` 不是 durable 事件（`dsh-agent-loop` 只 `dispatch.emit`），STATUS/证据以「splice 对 + `user/message`」为 durable 对账依据。

**NOT_RUN（存续）**：AT-13 同一 messageId 跨 turn/跨进程重放去重（幂等键在 dispatch 层，host inbox 无跨 turn 去重）；`agent/pre-step` 运行时门控接线（目前仅验证重启后的 durable 事实）；UI 代理标签（客户端 E04）；并发/长 prompt 压测。

### E02-04 · 工作区与 Session 管理适配（Host 侧）

| 项 | 内容 |
|---|---|
| Gate | **G01/G05 续**、**G09 部分** |
| 场景 | AT-06、AT-08、AT-09、AT-38 |
| 实现 | `src/host/workspace.ts`（无框架核心：能力矩阵、精确解析、预览、gate 提交、审计）+ `src/host/workspace-api.ts`（独立 Cordis 行 `boop-workspace`）、`cordis.patch.yml`、`build.mjs` |
| 复现命令 | `node --test tests/unit/e02-04-workspace.test.mjs` / `node --test --test-force-exit tests/host/e02-04-workspace-in-host.test.mjs` |
| 结果 | 单元 **31/31 PASS**；真实 rc.2.1 宿主 **15/15 PASS**（约 21–40s） |

已验证：
1. 逐方法能力矩阵：listWorkspaces / listSessions / resolveTarget / previewBatch / auditTrail 真实可用；缺失服务 → `CAPABILITY_UNAVAILABLE`，不伪装成功；ledger 不可用时审计降级为内存并明示。
2. **解析绝不猜**：对象 ID（`workspace:`/`session:`）严格身份；同名/歧义 → `TARGET_AMBIGUOUS` + 候选列表；相似名不匹配；标题不可读 → `NOT_FOUND(definitive:false)` 并披露覆盖缺口；ID 跨改名/重排稳定。
3. **移除注册只删注册**：mutation port 结构上没有删除/rm 方法；真实宿主上原生 `workspace/delete` 后目录与文件仍在。
4. **归档如实报告**：预览逐项报告仍在运行的内容；open-gate 注入下证明部分成功列表（1 succeeded + 1 refused `TARGET_ACTIVE`，`claimedComplete=false`）。
5. **写入口 fail-closed**：唯一写入口 `commitBatch` 先查 `boop.isWriteModeEnabled()`（false，阻塞于 G02/G05）→ `CAPABILITY_UNAVAILABLE` + 审计；客户端伪造 granted/ownerId/writeModeEnabled → `SCOPE_DENIED`；`previewHash` 绑定拒绝过期预览。
6. 目录创建按 backend 如实：Windows native picker 不暴露 createDirectory → 报 unavailable + 原因（冻结规则禁止 UI 点击自动化替代）；只有 browse 后端可用时才报 available。
7. 移除 bundle 后 `boop-workspace` 行消失、原生 web-profile 顶层行不变、启动零告警。

**未覆盖 / 风险**：本节记录时写模式尚未打开，端到端 commit 当时未执行。当前门账本已打开写模式（见 §0.2）；坏的 previewHash 仍然拒绝执行。本机 directoryPicker=native，因此目录创建 unavailable；冷会话标题可能不可读（`titlesUnknown`，不猜）。

### E03-01 · 全域轻量观察与持久化读取水位

| 项 | 内容 |
|---|---|
| Gate | **G09 部分**（观察面）、**G08 续**（水位持久化） |
| 实现 | `src/host/observe/{observer,host-reader}.ts`，只读端点 `boop/observeSources` |
| 复现命令 | `node --test tests/unit/e03-01-observer.test.mjs` / `node --test tests/host/e03-01-observe-in-host.test.mjs` |
| 结果 | 单元 **9/9 PASS**；真实宿主 **5/5 PASS** |

已验证：冷发现只读（**不建 Agent、不唤醒、不写用户会话**）；每个 (scope, session, generation) 一条持久水位；只有前进的源才标脏；覆盖必须连续，缺 seq 报 gap 而不是假装连续；水位永不回退；generation 变更从零开始且**不改写旧代**；被遗忘的源不再被读。

**rc.2.1 重基线（2026-10-18）**：宿主绑定的旧实现假设扁平 Session 行 —— rc.2.1 `sessionQuery.listSessions()` 实际返回 `{header,live,persisted}` 的 body-free `SessionRecord`，且 `listEvents()` 不含文本、`SessionHeader` 不含事件数；旧 in-host 用例的域是空的，因此断言空转、未暴露问题。已改 `src/host/observe/host-reader.ts`：
- 从嵌套 `header.{id,version,createdAt,parentSession}` 读身份与 generation（旧扁平形状仅作兼容回退），workspaceId 经 `workspaceRegistry` 映射、解析不到时如实 null；
- 语义文本改由 rc.2.1 `filterEvents(id, [])` 的文档（含 `text`）提供，`listEvents` 仅作无文本回退；
- head seq 需要整日志读取（rc.2.1 无轻量计数），因此**按扫描有界解析**（上限 25，仅对已有 cursor 的源），其余报 `headSeq:null`；`SourceObserver.scan()` 新增 `headDeferred`，**无法证明前进的源不标脏、下轮重试，绝不臆造移动**。
- 测试：单元 9/9→**10/10**（新增 head 未解析不得标脏/延迟上报）；in-host 5/5→**7/7**（经 PoC 种入真实 Session，断言真实 id/世代非空、第二轮解析 head 并标 dirty，不再空转）。

### E03-02 · Session 工作记忆与工作区聚合（提交层 + 模型抽取）

| 项 | 内容 |
|---|---|
| Gate | **G06 部分** |
| 实现 | `src/host/memory/committer.ts`（提交层，既有）+ 新增 `src/host/memory/extractor.ts`（模型侧受限抽取）+ `src/host/model/permits.ts`（单并发许可/45s 软超时/取消/退避） |
| 复现命令 | `node --test tests/unit/e03-02-memory.test.mjs` / `node --test tests/unit/e03-02-extractor.test.mjs`；真实模型 opt-in：见下 |
| 结果 | 提交层 **10/10**、抽取器 **25/25**；真实宿主 + 真实 Qwen 抽取 **5/5 PASS ×4 连续** |

已验证（提交层）：证据必须落在声明的读取窗口内（跨 Session/跨 scope/越窗一律拒绝）；基线 CAS（落后基线直接拒绝）；权威顺序（弱来源不能覆盖强事实）；同类事实冲突进入 `disputed` 而非静默覆盖；覆盖精确记录 (generation, throughSeq)，过期可见；工作区视图聚合覆盖并如实报告 stale。本轮修复 coverage 生成记录：`MemoryProposal.sourceGeneration` 由抽取器传入真实 sourceGeneration（此前用 sessionId/`current` 占位），新增覆盖键测试。

已验证（模型抽取，真实服务）：`MemoryExtractor.extract()` = observer 单窗口（绑定 fromSeq/toSeq）→ ~12k 输入保守估算 → `qwen-client.chat` + `json_schema(strict)`（reasoning/content 分离）→ 纯函数候选审查（kind/authority/confidence/文本长度/疑似密钥/重复/证据 seq 必须落在窗口）→ 既有 `MemoryCommitter.commit`（CAS/权威/冲突不绕过）→ 成功后仅推进到本次 durable 边界。真实宿主 fixture（真实 Agent turn）上：1 次抽取（3.8–4.7s，finish=stop）提交 3 条事实，`fact_evidence` 的 seq=8/source_hash 命中真实 durable 消息，coverage=水位=17=durable head，Session JSONL SHA 不变（零写入）；第二次运行 **no-op + 0 次模型调用**；空输出失败 **0 提交且水位回滚**；连续 2 次格式失败停批；不建隐藏 Agent/Session、不换供应商。证据：`docs/development/evidence/e03-02/real-extraction-report.md`。

**后续收口（2026-10-18，G06 PASS）**：模型侧抽取已接入 E05-01 调度（真实后台批次），E03-03/E03-04 主机路径 E2E 分别 6/6、8/8（见上方小节）；committer 冲突语义已收紧为同 (kind, subjectKey)，真实抽取 disputed=0；E03-02 真实抽取测试复跑 5/5。\n\n**仍 NOT_RUN / 已知残留**：格式失败计数跨进程持久化；`memory_job`/`fact` 缺 processed/total/paused/subject_key 列（跨提案 subjectKey 回退保守）；forget 未 tombstone；生产 query planner/FTS 未实现；authority 缺失仍依赖模型输出降级 inference。

### E03-03 · 三种初始化、导入、纠错与遗忘

| 项 | 内容 |
|---|---|
| 实现 | `src/host/memory/lifecycle.ts` |
| 复现命令 | `node --test tests/unit/e03-03-lifecycle.test.mjs` |
| 结果 | **9/9 PASS** |

已验证：三种初始化是彼此独立、可恢复的任务；**从现在开始**只落水位、不导入旧历史；**学习已有会话**按处理量汇报（"已整理 12/40 个会话"）并逐个列出失败对象，暂停不回滚已提交进度；导入先预览再落盘，不支持格式**不解析不执行**直接拒绝，导入项一律标记为 `import_unverified`；纠错必须携带来源并说明受影响范围，**绝不声称已执行任务被追回**；遗忘写规则（来源/事实/全域），原聊天保留可读。

**G06 主机路径 E2E（2026-10-18，6/6 PASS）**：`tests/host/e03-03-lifecycle-in-host.test.mjs` 在真实 rc.2.1 宿主 + 真实 SQLite 账本 + plain-JSONL durable Session 上验证：三种初始化；失败对象逐个单列；暂停/续跑；`from_now` 只落真实 durable 水位（throughSeq=17）不导入历史；导入预览零写入 → 落盘 3 条 `import_unverified`，且执行文件未被执行的 canary 证据（0 连接/sentinel 不存在/端口 ECONNREFUSED）；不恢复旧 task/approval；纠错来源为真实 human seq=8 + 受影响范围 + 旧版本可寻址；遗忘写真实 `forget_rule`，原 Session SHA 前后一致、18 事件全可读。
**边界（如实）**：初始化执行面仍为 test-side InitStore（Host 端点未接）、`memory_job`/`fact` 无 processed/total/paused/subject_key 列 → 跨提案 subjectKey 回退保守、forget 未 tombstone、生产 query planner/FTS 索引未实现。
**冲突语义收紧（同 G06 收口）**：committer 仅在同 `(kind, subjectKey)` 且取值不同时标 disputed；不同 subject 同类事实各自 active；缺 key 保留保守规则；冲突只改 status，不改 kind/authority、不覆盖文本。extractor 候选增加可选 `subjectKey`（规范化，不可用即丢 key 不拒事实）。真实抽取 3/3 带 subjectKey、disputed=0（此前误标 2 条 decision 已修复）。

### E03-04 · 分层项目上下文与轻量检索

| 项 | 内容 |
|---|---|
| 实现 | `src/host/memory/retrieval.ts` |
| 复现命令 | `node --test tests/unit/e03-04-retrieval.test.mjs` |
| 结果 | **7/7 PASS** |

已验证：owner → workspace → global 三层上下文，**排序优先、层级只作平局裁决**（查询命中的工作区事实不会被无关的个人偏好挤掉）；排序后再按层限额，任何一层都灌不满预算；字符预算超限时如实报告截断；有 FTS 用 FTS，没有则退化为精确匹配并**明确标记 degraded**（不退化为更弱的策略）；每条命中都带 (scopeId, sessionId, sourceGeneration, seq)；来源代变化时标记 stale 而不静默刷新；被取代与被遗忘的事实不进入上下文。

**G06 主机路径 E2E（2026-10-18，8/8 PASS）**：`tests/host/e03-04-retrieval-in-host.test.mjs` 在真实 rc.2.1 宿主 + 真实 SQLite 账本上验证：分层排序两次完全一致；每条账本命中证据与 `fact_evidence`/durable 日志 seq 对齐；世代变化 → stale（text 不变）；被取代/被遗忘事实不进上下文（含对照）；FTS 缺失 `degraded=true`；真实 Qwen 1 次调用（3914ms）抽取 3 条事实（3/3 带 subjectKey、disputed=0）→ 提交 → 检索闭环成功，Session 零写入。证据 `docs/development/evidence/e03-06/g06-report.md`。

### E04-01（第一批）· 可交互立体 BOOP 形象 + 身份主导面板

| 项 | 内容 |
|---|---|
| Gate | FE-01/FE-09 部分（样式隔离与主题）、视觉规则落地 |
| 实现 | `src/client/companion.tsx`（角色）、`src/client/board.tsx`（面板）、`src/client/styles.ts`（作用域 token）、`demo/boop-companion.html`（独立体验页） |
| 复现命令 | `node --test tests/client/e04-01-companion.test.mjs` |
| 结果 | **6/6 PASS**；真实宿主确认客户端包（26.6 KB）携带角色组件 |

**先读依据**：`baseline/docs/05_BOOP（波波）视觉设计方案.md`（角色绘制简报、色彩系统、状态与真实任务分离、UI 层次）与 `baseline/docs/04_前端设计方案.md`（原生接入方案、页面地图、组件清单、验收清单）。

已落地的视觉与交互：

- 角色严格按冻结简报绘制：一体短圆蓝鲸、奶白腹面、**两枚深色竖胶囊眼**、短圆胸鳍、上扬尾鳍、顶部水滴、**默认无嘴无鼻**；分层渐变 + 单方向轮廓光做出软胶立体感，配自然接触阴影。
- 真实交互：**眼睛跟随鼠标**（受限幅��）、自然眨眼节奏、点击打招呼轻弹；`prefers-reduced-motion` 下全部动效关闭但角色仍可读。
- 状态一律由真实证据驱动（05册§08）：思考=模型确在运行（水滴轻摆、眼睛上移）；待确认=确有待决审批（一圈安静描边，**不闪烁、不撒娇**）；离线=**变暗并停止**，不哭泣不抖动。
- 面板以身份为主：角色 + 「BOOP · 波波」+ 诚实状态标签（恢复门禁已装备 / 写模式关闭 / 账本在位·单写者），下方数据域、G01–G09 门账本、能力矩阵，全部来自真实 `boop/bootstrap`。
- 样式严格作用域化（`[data-boop-panel]` / `[data-boop-companion]`），明暗主题跟随宿主 `body[data-ds-dark-theme]`，不污染普通 Session。

**用户可见入口**：`demo/boop-companion.html` 为独立可交互体验页（同源设计、免启动宿主），可切换七种状态、体验跟随/眨眼/点击与「减弱动态」开关。

**已补（2026-10-18）**：浏览器自动化环境已就绪（`tools/web-e2e.mjs` + 已安装 Edge，见下方"Web 真机 UI 回归环境"小节），1280×800 / 390×844 / 深浅主题 / 普通会话 vs BOOP 主会话截图均已产出；交互式审批/停止/恢复点击流程与 IME 仍 NOT_RUN。

### E04-01（第二批）· 原生主聊天、初始化与来源交互

| 项 | 内容 |
|---|---|
| Gate | **G09 部分**；FE-01/FE-02/FE-03/FE-05/FE-08/FE-09 |
| 场景 | AT-01、AT-03、AT-04、AT-25、AT-37 |
| 实现 | `src/client/{main-session,init,source,header,settings,brand,interaction-styles}.tsx` + `src/host/main-session.ts` + `api-service.ts` 只读端点；`src/client/{index,board}.tsx` 接线 |
| 复现命令 | `node --test --test-force-exit tests/client/e04-01b-*.test.mjs` / `node --test --test-force-exit tests/host/e04-01b-main-session.test.mjs` |
| 结果 | 客户端（jsdom）新增 **29/29 PASS**（client 全量 42/42）；真实 rc.2.1 宿主 **9/9 PASS** |

已验证：
1. **固定入口复用原生 Conversation**：`sidebar.footer.action` → 定位/创建唯一 BOOP 主 Session（固定 id `boop-main` + 账本 `scopes.main_session_id` 幂等绑定）→ `ctx.uiWorkspace.openSession` 打开原生会话；重复点击/目录离线/身份冲突均不重复建（FE-02）；不抢面板、不自造聊天编辑器。
2. **初始化同消息内选择**：挂在 additive `conversation.input.dock`（仅 BOOP 主会话，无第二输入根/不抢全屏，FE-03）；三种 E03-03 模式从 `boop/initPlan` 读取真实状态，未接线路径如实 `state:unavailable / executed:false / reason`，不伪造 PASS。
3. **来源卡**（`boop/sources` 只读、不写 cursor）：真实 scopeId/sessionId/世代/seq 与覆盖状态（full/behind/unseen/unverified/processing/gap/excluded）；不可读报 unavailable 而非空列表（FE-11）；精确 sessionId 回跳，不猜同名；草稿由原生 per-Session composer 保留。
4. 身份与任务入口：`conversation.session.header.actions` 主会话头部；`sidebar.panellist` 指向 `main/boop.tasks` 看板；`settings.general.item` 一个原生设置行。
5. 浅/深主题、`[data-boop-*]` 作用域样式、reduced-motion、卸载清理（FE-12）；普通 Session 无样式/输入污染（FE-01）；IME/键盘路径（FE-08 部分）。

**NOT_RUN（如实标注）**：真实浏览器 1280/1440/390 深浅截图、Desktop 窗口 chrome、slot 真机布局落位、回跳滚动锚点；client live Inspector 本会话不可用（client Inspect Provider 属可选 experimental-inspector bundle，默认 profile 未挂载），slot 契约以已安装 rc.2.1 payload 权威目录 + 静态证据核对。E03-03 执行（真正落盘/导入）尚未接线，端点如实 unavailable。

### E04-02 · Taskboard 适配与唯一任务状态视图

| 项 | 内容 |
|---|---|
| Gate | **G09 部分**、TB01–TB10（可证部分） |
| 场景 | AT-19、AT-37、FE-04、FE-09、FE-10 |
| 实现（Host） | `src/host/tasks.ts`（无框架 view-model）+ `src/host/tasks-api.ts`（独立行 `boop-tasks`，Typert Remote `boopTasks`）+ `repository.ts` 只读查询（+643 行、0 删除） |
| 实现（客户端） | `src/client/taskboard/**`（选择性复用 Apache-2.0 上游布局思路；`docs/development/taskboard-sources.md` 逐文件登记）+ `board.tsx` 接线 |
| 复现命令 | `node --test tests/unit/e04-02-tasks.test.mjs` / `node --test --test-force-exit tests/host/e04-02-tasks-in-host.test.mjs` / `node --test --test-force-exit tests/client/e04-02-taskboard.test.mjs` |
| 结果 | 单测 **22/22**、真实 rc.2.1 宿主 **11/11**、客户端 jsdom **16/16**；全量离线 **199/199**（unit 141 + client 58） |

已验证：
1. **唯一任务状态视图**：四组（todo/in_progress/needs_me/finished）由三轴 + 待决原因派生（Host 真实账本），筛选/分页（50/100）/单次扫描上限 500 且 `scan.truncated` 如实上报；不把结束当验收通过，verification/approval 不可改。
2. **只读安全**：读取零账本行变化；唯一写端点 `boopTasks/setPriority` 一律 `CAPABILITY_UNAVAILABLE` + 持久审计（task/action/approval/revision 不变）；verification/approval 变更端点不存在（404）；匿名 401。
3. **旧响应保护**：单调 `projectionSeq` + 每卡 `taskVersion` + 客户端请求序号三层丢弃过期响应（AT-19/FE-04）。
4. **详情与证据**：最新快照、revision 摘要、targets/依赖、actions、approvals（含 expired/version-moved/epoch-moved 失效原因）、证据地址 `session:<id>#seq:<n>`、子列表上限 50 且 truncated 如实。
5. **客户端**：看板/列表、筛选、详情抽屉、空/不可用/错误/部分覆盖/旧响应提示；无跨列拖拽、键盘与菜单全路径、纯文本无 Markdown 管线（TB07）、作用域样式 + 卸载清理；TB02/TB04/TB05/TB06(客户端)/TB07/TB08 在组件/jsdom 级可证。
6. 上游来源：固定提交 `723c400e`，逐文件记录复用/裁除与修改点；无 Codex api/actors、无第二 React、无 `startViewTransition` 依赖。

**NOT_RUN**：TB01/TB03 真实 Web/Desktop 安装与窗口分屏、TB06/TB09 真机重连与联调（Host 侧另证）；真实浏览器三尺寸/深浅截图。

### E04-03 · 审批、停止、恢复与异常端到端交互

| 项 | 内容 |
|---|---|
| Gate | **G04/G05 部分**、**G09 部分** |
| 场景 | AT-09、AT-25、AT-26、AT-28、AT-30、AT-37、FE-06/07/10/11/12 |
| 实现（Host） | `src/host/control.ts` + `src/host/control-api.ts`（独立行 `boop-control`，Typert Remote `boopControl`：state/approvals/decideApproval/stop/recovery/release） |
| 实现（客户端） | `src/client/control-model.ts`、`control.tsx`、`control-styles.ts`；`board.tsx` 接入控制区；主会话 header 角标（本轮已由 Lead 接线 index/header） |
| 复现命令 | `node --test tests/unit/e04-03-control.test.mjs` / `node --test --test-force-exit tests/host/e04-03-control-in-host.test.mjs` / `node --test --test-force-exit tests/client/e04-03-control.test.mjs` |
| 结果 | 单测 **26/26**、真实 rc.2.1 宿主 **16/16**、客户端 jsdom **24/24** |

已验证：
1. **审批人工决定只落账**：`decideApproval` 服务端校验 payloadHash/taskVersion/policyEpoch/nonce 单次绑定；过期/版本/纪元移动 → `APPROVAL_STALE` 且只把该卡持久化失效（不误伤其他 pending 卡）；伪造绑定 → STALE 但不毁合法卡；重复 → already-handled。**始终 executed:false / dispatched:false**，决策不受写模式门控但绝不派发。
2. **确定性 Stop**（无模型）：范围 all/task/action/session；只停 BOOP 账本中未投递动作（action→stopped、outbox→cancelled、其 pending 审批→rejected）；已投递/终态 refused、sending/unknown 归 unknown（不重试、不宣称撤销）；无可停内容如实 noop；policy 明示 `userTurnsStopped:false`、`externalSideEffectsUndone:false`。
3. **恢复核查与显式释放**：展示门禁条目/unknown 结果；release 必须显式 messageIds（空 → INVALID_ARGUMENT，绝不默认全选），未知 id 进 ignored，审计 `control/gate-released`；`runtimeEnforcement.composed:false` 如实（pre-step 未接线）。
4. **客户端**：审批卡有效/失效/拒绝原因回显、Stop 三桶结果与“请求已发送≠已撤销”文案、恢复逐项勾选（无全选按钮）、unknown/断线/旧响应/截断如实显示、键盘可达、header 待批角标（仅真实 valid-pending 计数）、作用域样式与卸载清理。
5. 缺 writer lease → 控制面只读（canDecide:false，decide/stop CAPABILITY_UNAVAILABLE）；无门禁 → recovery unavailable；所有响应带 writeMode/ledger/dispatch/audit 事实；匿名 401。

**后续证据**：Edge 已覆盖停止、恢复、审批点击、过期卡和 IME（`docs/development/evidence/web-e2e-control/2026-10-27T07-02-41-595Z`）。Desktop 窗口、浅色/深色和停用恢复见 `docs/development/evidence/desktop-gui/report.md`。G05 已 PASS：批准只落账，控制行不派发。

### Web 真机 UI 回归环境（浏览器自动化，2026-10-18）

| 项 | 内容 |
|---|---|
| 工具 | `tools/web-e2e.mjs`（playwright-core 驱动**已安装 Edge 155**，无 Chromium 下载；真实 Host 跑在私有 DSH_HOME） |
| 复现命令 | `$env:BOOP_QWEN_KEY='placeholder'; node tools/web-e2e.mjs` |
| 结果 | **19/19 步骤 PASS**；证据 `docs/development/evidence/web-e2e/`（报告 + 12 张 1280×800 / 390×844 / 深浅主题截图） |

已验证（真实浏览器，非 jsdom）：
1. 真实 Edge 渲染 DSH shell，BOOP 任务板入口注册在侧边栏；面板显示**真实 Host 事实**：恢复门禁已装备、写模式关闭、账本在位（单写者）、`boop-main` 已绑定、来源计数、数据域、宿主版本 0.2.1-rc.2 + 固定提交 + schema v1、G01–G09 真实门状态、宿主能力矩阵。
2. **3D 角色在真实 WebGL 下渲染**（GLB 资产路由可用）；任务看板四组、人工控制区（待决审批 0 / Stop 桶 / 重启恢复核查）真实渲染。
3. 初始化卡在写模式关闭时**如实拒绝**（`G05 NOT_RUN · G06 PASS`、`已执行：否（0 写入）`、`reason: write-mode-disabled`），不伪造成功。
4. 深色主题跟随真实宿主（`data-ds-dark-theme`、背景 `rgb(21,21,23)`），390×844 移动视口截图；普通 Session 无 BOOP 面板/dock，仅 scoped style（additive，不污染原生 UI）；真实浏览器无 console/page error。
5. 首次运行的 shell 对话框（预览版说明/云账号 onboarding）与"先选工作区"已由脚本自动处理并写入报告；launch token 必须用打印原始 URL 交换。

**NOT_RUN（G05/G09 仍 NOT_RUN）**：交互式审批/停止/恢复的**真实点击流程**（需在私有账本种入 task/approval/action fixtures）、IME 合成输入、键盘焦点/无障碍、三视口×主题全矩阵、Desktop Electron GUI（G08/G09 桌面端）、IM 渠道规则（G07/M2）。本工具只把「Web UI 真机渲染与接入」标为工具级 PASS，门账本未因此改动。

### E05-00 · 自有 Qwen 真实金标（G02）

| 项 | 内容 |
|---|---|
| Gate | **G02** |
| 场景 | AT-07、AT-10、AT-16、AT-39、AT-40 |
| 实现 | `src/host/model/qwen-adapter.ts`（策略/熔断，既有）；新增 `qwen-client.ts`（真实 OpenAI 兼容传输：reasoning 分离、工具调用、usage、取消）、`src/host/model/qwen-probe.ts`（真实金标熔断梯）、`tools/qwen-gold.mjs`（证据生成）、`tests/unit/e05-00-transport.test.mjs`、`tests/host/e05-00-real-gold.test.mjs`（opt-in） |
| 复现命令 | `$env:BOOP_QWEN_BASE_URL="http://172.26.0.49:8000/v1"; $env:BOOP_QWEN_MODEL="qwen3.8-27b"; node tools/qwen-gold.mjs`；离线传输契约：`node --test tests/unit/e05-00-transport.test.mjs` |
| 结果 | 真实服务 **8/8 能力 PASS**；离线传输契约 **7/7 PASS**；报告见 `docs/development/evidence/e05-00/qwen-gold-report.md` |

**实测事实（2026-10-18，用户提供 IN-01/02/03：base URL + 模型 id + 无凭证）**：
1. 服务：vLLM `http://172.26.0.49:8000/v1`；served ids `Qwen3.8-27B` / `qwen3.8-27b` / `qwen3.8`；root `./Qwen3.8-27B-AWQ-INT4`（4bit）；**服务端报告 `max_model_len = 196608`**。
2. **有效上下文整数 = 196608**（不是从模型名或 "196k" 标签推断）：接近上限实测 ~186k prompt tokens 接受（finish=length），超上限实测 HTTP 400，错误文本明确 "maximum context length is 196608 tokens"；请求按 `input + outputReserve + safetyMargin(≥1024/5%) <= 196608` 收紧（`clampRequest`）。
3. 分长度实测 prompt tokens：**8288 / 33116 / 66219**（目标 8k/32k/64k；64k prefill 约 17s）。
4. 工具调用 PASS：无副作用 `echo` 工具被正确提出，参数 JSON 完整；中文 + Unicode（`你好，波波 🐳 — ünïcode`）参数**无损往返**；多步链（提出→BOOP 执行→最终回答）PASS。
5. 严格 JSON PASS：`response_format=json_schema` 输出可解析并通过结构校验；极小 `max_tokens` 截断输出**解析失败 → 不得提交**（tiny-budget parseable=false）。
6. 取消 PASS（仅客户端侧）：流式 3 个 chunk（首 chunk 185ms）后 abort 生效并释放连接；**不声称服务端已停止推理**（冻结规则）。
7. Token 计量 PASS：三次实测 usage 单调且一致（约 1.0–1.1 token/字符），无伪造精确值。
8. reasoning 与最终文本**分离**（`message.reasoning` vs `message.content`），BOOP 不把思考轨迹当回答或命令。
9. 能力映射（熔断规则）：只读聊天 ✅、记忆提取 job ✅、自主派发 ✅（tool-call+multi-step）、历史批量学习 ✅（strict JSON + 已验上下文）→ **G02 具备真实服务证据**。

**边界与限制（如实）**：内网 HTTP、无 TLS/鉴权（用户提供即如此）；端点/GPU 为共享资源，排队与并发不受 BOOP 控制（02§05：只审计 BOOP 自身调用）；真实调用必须受 BOOP 的 1 并发许可与 45s 软超时约束（E05-01 已接线）；本报告只证明模型能力，不证明 BOOP 的调度/派发已端到端打通。

### E05-01 · 前后台调度、原生自动化与巡检

| 项 | 内容 |
|---|---|
| 实现 | `src/host/scheduler.ts`（P2<P3<P4 优先级、idle 2s 合并、复用 `permits.ts` 单许可、P1 前台阻断新后台批次、退避、halted 停批保水位、精确 pause/resume/cancel、原生 `schedule` 绑定）；`src/host/patrol.ts`（只读巡检）；`src/host/scheduler-api.ts`（独立行 `boop-scheduler` / `boopScheduler`） |
| 复现命令 | `node --test tests/unit/e05-01-scheduler.test.mjs` / `node --test --test-force-exit tests/host/e05-01-scheduler-in-host.test.mjs`；真实 opt-in `tests/host/e05-01-scheduler-real.test.mjs` |
| 结果 | 单测 **27/27**、真实 rc.2.1 宿主 **7/7**、真实 Qwen opt-in **3/3 ×3 连续** |

已验证：
1. **单许可串行**：所有 BOOP 自管模型批次共享 `permits.ts` 的 1 个许可（45s 软超时/取消/退避），后台不占第 2 个；P1 前台事件到达后不再启动新后台批次，在跑批次 `pauseAfter` 到安全边界（不声称服务端抢占）。
2. **合并与限批**：idle 2s 同主题合并、单批输入上限约 12k tokens（保守估算）、输出 2k–4k、连续格式失败 2 次 halt 并保留水位。
3. **确定性命中**：pause/resume/cancel 作用域 all/task/action/session 精确、缺 id 拒绝、部分中断如实上报、审计落账；重启队列为空（内存队列，不自动重放）。
4. **真实后台批次**（真实 Qwen）：`committed` 3841ms / 1 次调用，3 条事实，watermark `-1→17 = durable head`，证据 3 行 seq=8 真实 user/message，cursor 17 dirty；第二次批次 **no-op + 0 模型调用**、零重复；P1 真实观测 foreground→idle。
5. **原生自动化**：rc.2.1 schedule 行按需解析并自愈（挂载顺序晚于本行），只建/删自己的 marker task、收养不重复；不可用时明确 unavailable。
6. **巡检只读**：租约/水位 gap/待决+过期审批/unknown outbox/恢复门禁/原生绑定/模型路由 → 事实+告警+notDone；`readOnly:true/modelCalls:0`，不自动恢复、不改账本。

**集成修复**：调度暴露 `host-reader.listEvents` 只返回语义文档 → 真实 Session 会被误判永久 READ_GAP（违反观察平面“连续事件 + semantic 标志”契约）。已由 Lead 修复：`listEvents` 全事件连续性 + `filterEvents` 语义文本按 seq 合并（新增 `tests/unit/e03-01-host-reader.test.mjs` 3/3）。另：租约新增进程内心跳（G08 缺口收口，`tests/unit/e01-01-lease-heartbeat.test.mjs` 2/2），且只读第二 Host 关闭时**不再误释放**主 Host 的租约。

**NOT_RUN**：P2/P4 实际 worker、60s cadence 长跑、原生 daily 到期投递、真实前台+后台同端点叠加压测。

### E05-02 · 证据验收与有限自愈

| 项 | 内容 |
|---|---|
| 实现 | `src/host/verify/verifier.ts`（只读证据链验收）、`src/host/verify/self-heal.ts`（有限自愈预览）、`src/host/verify/verify-api.ts`（独立行 `boop-verify` / `boopVerify`）；`src/host/tools.ts` 新增只读 `boop_verify` 工具；`cordis.patch.yml`/`build.mjs` 各加一项 |
| 复现命令 | `node --test tests/unit/e05-02-verifier.test.mjs` / `node --test --test-concurrency=1 --test-force-exit tests/host/e05-02-verify-in-host.test.mjs` |
| 结果 | 单测 **23/23**、真实 rc.2.1 宿主 **7/7**；证据 `docs/development/evidence/e05-02/verify-report.md` |

已验证：
1. **保守验收语义**：用户标准 → taskVersion → durable 证据 → 未覆盖项；结论 `passed/failed/partial/unknown/stale`；**口头完成/执行结束不算通过**（AT-16）；证据版本/世代不匹配 → `stale`（AT-17）；无法判定 → `unknown`，不伪造绿。
2. **零写入**：verify 多次调用前后 13 张账本表行数完全不变（含 audit_event）；不执行任意测试命令、不读任意文件。
3. **失败指纹有限自愈**：稳定 fingerprint + 每指纹 2 次尝试上限，超限 `halted/stop-dispatch`（AT-18）；`previewHeal` 在写模式关闭时一律 `CAPABILITY_UNAVAILABLE + executed:false + dispatchAllowed:false` + 审计，指纹用尽零候选，绝不绕过 dispatcher 派发。
4. 独立行唯一、无激活告警、匿名 401、写模式全程 false、`boop_verify` 工具在真实工具目录。
5. **顺带修复真实缺陷**：M0 `boop_catalog` 工具因输出 schema 使用 DSL 不支持的 `required` 关键字 + 参数显式 `required:false` 而 `defineTool` 抛错被静默吞掉 → 工具自始未注册；已修复并以真实宿主断言确认。

**NOT_RUN**：模型生成的 repair 文案（模板化已覆盖）、自愈实际执行（需 dispatcher/写模式）、失败指纹跨进程持久化、UI 证据下钻、真实用户任务端到端验收（E07）。

### E07-01 · 故障注入与回归编排（准备阶段）

| 项 | 内容 |
|---|---|
| 实现 | `tools/run-regression.mjs`（offline/host/real 三组独立报告）；`tests/host/e07-01-fault-{kill-restart,model-down,approval-concurrency}.test.mjs`；`docs/development/regression/compatibility-matrix.md` |
| 结果 | 故障注入 **13/13 PASS**；编排工具实测 offline 307/307、host(filter) 13/13、real 无 env SKIPPED |

已验证：
1. **SIGKILL/重启**：真实 turn 中途杀进程 → 同 DSH_HOME 重启：恢复门禁不收养（entries/adopted 空）、无自动重放/无 claim、durable `turn/end=interrupted`、assistant=0；4 份 DB `integrity ok`、scopeId/schema 不变、旧行可读、无关用户 Session 不变。
2. **模型不可达**：闭合端口路由 → `turn/end="error: Connection error."`、assistant=0、无外部回退、有限重试（5 次）收敛、claim 1 次；确定性 Stop 仍可用且 noop 如实。2026-10-27 重跑 4/4：`writeMode.enabled=true`，控制行仍不派发（`docs/development/evidence/e07-01/fault-model-down-2026-10-27T09-11-29-738Z.json`）。同日审批并发 4/4：伪造卡 `APPROVAL_STALE`，决定不派发。
3. **审批并发/伪造**：并发两次 decide → 恰好 1 allowed + 1 already-handled、1 条 decision 审计；伪造 payloadHash/nonce → `APPROVAL_STALE` 且不毁合法卡；审批不派发。
4. 编排工具三组独立报告、失败非零退出、real 组无 env 时 SKIPPED 不伪造；证据 `docs/development/evidence/e07-01/`。

**已知项（登记，不冒充修复）**：A) 运行中 `VACUUM INTO` 的快照含未过期 `runtime_lease` → 恢复后暂时只读 fail-closed（安全；“恢复即可写”的运维步骤需按 runbook 等待 TTL 或清理租约行）；B) SIGKILL 多轮中 1 次观察到未落盘 session 尾部丢失（按未知结果窗口如实记录，不伪造成功）。

**NOT_RUN（Gate E07-01 仍 NOT_RUN）**：Desktop Electron、真实浏览器三屏+深浅主题截图、IME/触屏/无障碍、macOS/Linux、IM 渠道、真实模型 opt-in 组默认不跑、`agent/pre-step` 运行时强制、完整 40 场景矩阵。

### E07-02 · 安装包、许可、运维与隐私（准备阶段）

| 项 | 内容 |
|---|---|
| 实现 | `package.json` files 修复（补 `assets/3d`、`NOTICE`，`lib/*.js` 排除测试 bundle）+ `tools/package-boop.mjs`（dry-run 白名单 → npm pack → 自解析 tgz 逐文件 sha256/sha512/结构校验 → 清单 JSON，可复现）+ `tools/rehearse-install.mjs`（隔离 profile 安装/重装/卸载演练）；`README.md` / `LICENSE`（Apache-2.0）/ `NOTICE` / `docs/development/release/{install,upgrade,rollback,uninstall,privacy,support-matrix}.md` / `source-inventory.json` |
| 结果 | tarball 最终树 26 files / 1,102,402 B（sha256 `0cbd2f7e…`，两次运行 `reproducible:true`）；必需条目 24/24、禁止条目 0、测试 bundle/内部素材未入包；**隔离 profile 安装 → 启动 → 重装 → 卸载演练 20/20 PASS** |

已验证：打包完整性（宿主资产行依赖 `assets/3d` 已入包；`files` 白名单由 patch 行+exports 动态派生）、许可与归属（上游 `dashi-taskboard@723c400e` Apache-2.0 改写式提取逐文件声明、用户视觉资产归属、内部素材不出包）、备份机制在合成账本上 `VACUUM INTO` integrity ok、支持矩阵只列实测组合。
**隔离安装演练（2026-10-18，最终树 20 阶段 PASS）**：`tools/rehearse-install.mjs` 在私有 DSH_HOME 中初始化 web profile → `dsh plugin add <tgz>` → 启动真实 Host：`/api/boop/bootstrap` 200（scope=0.2.1-rc.2）、`/api/boop/model.glb` 200、门账本 writeMode 仍 OFF → 重装（升级原语）后同样可用 → 卸载后端点 404、账本保留。过程中发现并写入 runbook：CLI 首次 `plugin add` 初始化的是最小 profile（无 `dsh-web-app`，需先有 web/desktop profile）；launch token 必须用服务器打印的原始 URL 交换。证据 `docs/development/evidence/e07-02/install-rehearsal-report.md`。

**NOT_RUN（Gate E07-02 仍 NOT_RUN）**：真实**用户 profile** 安装、真实版本→版本升级与回滚演练、Desktop GUI、macOS/Linux、公开 registry 发布（`private:true` 防误发布）、独立法务评审、真实环境隐私审计；证据绑定取证时工作区，最终提交后以 `node build.mjs && node tools/package-boop.mjs && node tools/rehearse-install.mjs` 刷新。恢复快照的租约处理已补进 rollback runbook。

## 1.5 进度小结（2026-10-18 第五轮快照：E05-02 + G03/G04/G06 收口）

本节只记录 2026-10-18 当时的数字。当前门账本、写模式和 G05/G08/G09 以 §0.2 为准。

- 已完成：**E00-01**、**E00-02**（来源/门禁 + G04 运行时收口）、**E00-03**、**E01-01**（含租约心跳）、**E01-02**、**E02-01/02**、**E02-03**（真实派发 + **G03 幂等/对账收口**）、**E02-04**、**E03-01**、**E03-02**（提交层 + 真实 Qwen 抽取）、**E03-03**、**E03-04**（**G06 主机 E2E + 冲突语义收紧**）、**E04-00**、**E04-01 第一/二批**、**E04-02**、**E04-03**、**E05-00**（真实 Qwen 金标 8/8）、**E05-01**（调度/巡检/原生自动化）、**E05-02**（证据验收与有限自愈）、**E07-01（准备）**、**E07-02（准备 + 隔离安装/升级/卸载演练）**、rc.2.1 对齐、门账本如实化
- 下一批：Desktop GUI 回归（G08/G09）→ 浏览器里的过期审批卡 → 写模式仍须等 G05/G08/G09。PoC 端点仅在 `BOOP_ALLOW_POC=1` 时生效，安装步骤不设置它。
- 测试现状（rc.2.1-rc.2，最终树，宿主串行 `--test-concurrency=1`，真实 Qwen env 提供时）：
  - 离线：单元 **262/262** + 客户端 **82/82** = **344/344**
  - 宿主：**166/166 PASS**（真实 rc.2.1 宿主；含 G03 幂等 6、G04 pre-step 8、E05-02 7、E03-03 6、E03-04 8 等新增，及既有真实模型 opt-in 组）；E07-01 故障注入 13/13 含于其中
- 门账本：**G01/G02/G03/G04/G06 PASS**、G05/G08/G09 NOT_RUN（环境/真机回归）、G07 BLOCKED；`writeMode.enabled=false`，blockedByGates=[G05,G08,G09]
- 依赖面：`pnpm-lock.yaml` / `node_modules` 已重装到 `0.2.1-rc.2`（旧引用 0 条），`pnpm install` 退出码 0；`@types/node` 已补
- 打包/运维：E07-02 准备就绪（tarball 完整性 + 许可 + runbook + 隔离演练）；最终提交后需重跑构建/打包/演练刷新证据\n- Web 真机 UI 回归：`tools/web-e2e.mjs`（playwright-core + 已安装 Edge，无 Chromium 下载）**19/19 步骤 PASS**，截图/报告在 `docs/development/evidence/web-e2e/`；交互流程与 IME 仍待补
- 写入模式：仍 **OFF**，由门账本派生 `blockedByGates=[G05,G08,G09]`；**G01/G02/G03/G04/G06 PASS**、G07 BLOCKED

## 2. M0 其余工作项状态

| ID | 状态 | 说明 |
|---|---|---|
| E00-02 | **部分完成（真实投递已补齐）** | G03/G04 核心断言已验证；真实 `Agent.followup` 投递 + durable provenance + inbox 认领对账已由 E02-03 在真实宿主+真实模型上 PASS；仍剩 AT-13 跨 turn 重放去重与 `agent/pre-step` 运行时门控接线 |
| E02-03 | **完成（真实派发与对账 PASS）** | 真实宿主 + 真实 Qwen Agent：5/5 PASS ×4 连续；修复 3 个只在真实部署暴露的适配缺陷；`agent/inbox/claimed` 非 durable，对账以 splice 对 + `user/message` 为准；证据 `docs/development/evidence/e02-03/` |
| E05-00 | **完成（真实金标 8/8 PASS）** | 真实 Qwen 服务：能力熔断全 PASS、有效上下文 196608（服务端整数 + 越界 400 实测）、中文/Unicode 工具参数无损、严格 JSON、取消、token 计量；证据 `docs/development/evidence/e05-00/qwen-gold-report.md` |
| E04-00 | 完成（Spike） | 上游 `chuspeeism/dashi-taskboard@723c400e` 已固定检出并完成兼容性审查，见 `docs/development/E04-00-taskboard-spike.md`；未移植代码，TB01–TB10 仍 NOT_RUN |

M0 退出条件以 §0.2 为准：G01、G02、G03、G04、G05、G06、G08、G09 为 PASS。G07 为 BLOCKED，不挡住本地写。写模式因此打开，但仍要求本进程持有写租约。本节旧说法里「G03/G04 仍未跑」已经过时。

## 3. 风险与阻塞汇总

| 项 | 影响 | 处理 |
|---|---|---|
| 宿主 esbuild 本机二进制被安全策略阻断（winapi error #5） | 构建 | 改用 `esbuild-wasm`（同 API、无子进程），已在 `build.mjs` 注明 |
| **模型服务为内网明文 HTTP、无 TLS/鉴权** | 数据边界 / G02 | 用户明确提供且为内网 vLLM；BOOP 只按配置路由、不落盘密钥、不外部回退。上线前若跨网络使用，需用户侧加网络边界或 TLS（不改代码） |
| **共享 GPU 端点无并发控制** | E05-01 调度 | 64k prefill 实测 ~17s、接近上限 ~50s；BOOP 侧必须保持 1 并发许可 + 45s 软超时 + 退避（02§05），不得假设抢占 |
| 未配置钉钉/飞书（IN-07/IN-08） | G07 | 渠道保持关闭；M2 才联调 |
| macOS/Linux 与真实用户 profile 的 Desktop 安装仍未测 | G09 | Windows Desktop 0.2.1-rc.3 私有窗口已测（`docs/development/evidence/desktop-gui/report.md`）。不把未测平台写成已支持 |
| 安全关键代码（派发、审批、恢复门禁）尚无独立审查人 | G03/G04/G05 | 如实标记“待独立审查”，不冒充批准 |
| ~~宿主租约无心跳~~（已收口） | G08 多 Host 场景 | 已实现进程内租约心跳（`tests/unit/e01-01-lease-heartbeat.test.mjs` 2/2）：活动 Host 不再被误判过期；只读第二 Host 关闭时**不再误释放**主 Host 租约。剩余：Desktop 侧多 Host 环境回归（E07-01）。 |
| **DSH 升级兼容门** | 每次宿主升级 | 清单声明 `engines.dsh`；升级后必须重新对齐并复跑全套证据（旧证据只作历史），不申请版本豁免 |
| `tsc --noEmit` 尚未全绿 | 开发体验 | `@types/node` 已补；剩余为 pre-existing 的 tsconfig（`allowImportingTsExtensions` 未开）与 `ctx.boop` 等未类型化的长尾错误。构建（esbuild）与全部测试通过；typecheck 不作为当前 Gate 证据 |
| **目录创建能力依赖 directoryPicker backend** | E02-04 管理动作 | Windows native picker 不暴露 createDirectory → 如实 unavailable（禁止 UI 点击自动化替代）；browse/remote 组合才可用；E07-01 在目标环境确认 |
| 导入初始化仍要确认过的预览 | E04-01 | `from_now` / `learn_history` 在写模式且持有租约时会执行；`import_memory` 没有确认预览时不写入 |
| **client live Inspector 不可用** | A4 客户端 live 取证 | 当前 profile 未挂载 experimental-inspector；slot 以 payload 权威目录 + 静态证据核对，建议在 GUI 人工确认 `boop.tasks` 面板与“BOOP 任务板”菜单项 |
