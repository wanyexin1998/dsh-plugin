# BOOP v0.2 MVP 重构方案与工程交付

> 2026年10月28日 · 固定源码基线 · 29项工程任务 · 42项验收用例。
> 状态：方案已定义，代码尚未实施，验收尚未运行。

本文件是完整方案。便于逐项领取的工单、JSON台账与原目录结构见配套ZIP；阅读器HTML提供章节导航、筛选与页面结构示意。

## 目录

- [工程师先读](#c00)
- [产品与交互](#c01)
- [客户端接入](#c02)
- [服务端与数据](#c03)
- [29 项开发任务](#c04)
- [迁移与发布](#c05)
- [42 项验收用例](#c06)
- [源码与复用](#c07)
- [开工与交付](#c08)
- [关键决策 ADR](#c09)

---

<a id="c00"></a>

# BOOP v0.2 MVP 重构：工程师先读

> 交付日期：2026年10月28日。本文是可执行的重构规格，不是已经完成的功能或测试报告。全部开发任务初始状态为 `TODO`，全部产品验收初始状态为 `NOT_RUN`。

## 1. 要完成什么

在现有 `wanyexin1998/dsh-plugin` 仓库的 `dsh-boop/` 目录内，把 BOOP 重构成一个有独立主页、能持续交流、能接着已有 DSH 会话推进工作的个人助理。

最小闭环只有一条：**进入 BOOP 专属页面 → 直接聊天 → 定位已有会话 → 用户明确委托 → 原会话真正执行 → 结果回到 BOOP → 用户查看、确认或继续处理。**

用户不需要理解账本、数据域、门禁、水位和任务版本号。主页以对话为中心；工作进展、成果与需要处理的事情通过轻卡片和按需打开的抽屉呈现。

本轮保留 BOOP 单一逻辑身份；每条任务只涉及一个已有 Session；全局最多一个 BOOP 委托正在派发或执行。目标忙的任务只在 BOOP 侧等待，不占活动槽；无法排除已经执行的未知请求占用活动槽，先核对再释放。普通主聊天不占委托槽。

## 2. 五项架构定案

1. **独立页面。** 注册自有 `main` 面板 `boop.home`。自己的头部、欢迎态、工作抽屉、设置与导航；正文和输入使用 DSH 公开的 `conversation.content` embedded Factory。主入口不调用普通 `openSession`，不改变用户原来选中的普通会话。
2. **定向复用 DS-Bot。** 参考并适配身份呈现、轻状态、详情抽屉、原生 followup/flush 调用。保留现有 BOOP 代码主干；不导入 DS-Bot 全站 surface、Bot roster、群聊、独立任务主库和自动续跑策略。
3. **单一账本。** SQLite 继续管理 task/action/outbox/fact/approval。补最小结果、幂等、主身份和观察结构。所有结果和进度都能追溯到真实 Session 事件。
4. **用户直接操作优先。** 目标忙时等待；派发前复核最新直接用户指令；停止只处理精确归属于本任务的消息或当前轮次。用户接管后不继续替用户执行旧安排。
5. **安全升级，不伪造完成。** 修迁移启动顺序后才增加 schema；持久备份、故障原子性、未知状态与真正跨版本回滚进入验收。旧版 PASS 不能作为新版发布证据。

这些定案源于当前产品要求与固定版本源码，详细证据见 [源码依据与复用清单](#c07)。

## 3. 固定基线和工作位置

| 对象 | 固定版本 | 用途 |
|---|---|---|
| 原仓库 | `wanyexin1998/dsh-plugin@98991899eecea6c6af1faa158e92cb73e555a5a5` | 本方案所有当前文件分析基准 |
| 原包 | `dsh-boop@0.1.0` | 旧版安装、数据与回滚 fixture |
| 参考项目 | `Fei2411/DS-Bot@4a7b55069ad300eae8be42a74f31bc170b40ead7`，包版本 0.2.3 | 只取 `ds-bot/` 的相关源码；不取桌面 app 壳 |
| DSH rc.2 官方源码 | `687f282e8625c6b8d11ff58211a90524be2e4317` | 已核对的公开客户端及 Host 契约 |
| DSH rc.3 官方源码 | `1f81c047fc48fa190a683e469daa699857e9afe8` | 客户端相关契约对照；仍需独立运行验证 |
| 目标版本 | BOOP `0.2.0` 候选版，完成全部发布条件后定版 | 工程版本号须与实际打包产物一致 |

GitHub 中 `dsh-boop/` 是普通被跟踪目录。不能据此推断开发者本地是否另有嵌套 `.git`。开工先在实际 checkout 运行 `git rev-parse --show-toplevel`、`git status --short`、`git rev-parse HEAD`，确认提交归属和未提交改动，不能重置用户工作。若本地已超过上述基线，先评估差异，再应用文件级方案；不要把整个目录覆盖成旧快照。

现包声明 DSH `0.2.1-rc.2 || 0.2.1-rc.3`。开发依赖与运行宿主分别记录。当前这两个版本的源码契约核对不代表四个 Web/Desktop 运行组合都已通过。

## 4. 阅读顺序

| 文件 | 谁先看 | 得到什么 |
|---|---|---|
| [01_产品与交互.md](#c01) | 产品、设计、全体工程师 | 必做与暂缓范围、完整用户流程、视觉与文案规格 |
| [02_客户端架构与接入.md](#c02) | 前端、集成 | 真实公开 API、独立页面、Provider/Factory、草稿、输入和样式边界 |
| [03_服务端协议与数据.md](#c03) | 后端、集成 | DTO、工具、状态转换、数据库、派发、停止与结果回传 |
| [04_开发任务清单.md](#c04) | 技术负责人、执行工程师 | 29 项有依赖、有文件范围、有完成标准的工单 |
| [05_迁移与发布验收.md](#c05) | 后端、QA、发布负责人 | 工具链预检、升级、故障、回滚与发布门槛 |
| [06_验收用例.md](#c06) | QA、产品、工程师 | 42 项逐步验收、fixture 与证据要求 |
| [07_源码依据与复用清单.md](#c07) | 代码审查、移植执行者 | 固定 SHA、复用决策、许可证与当前缺口 |
| [08_开工与交付说明.md](#c08) | 接手工程师或编码 Agent | 开工操作顺序、每批交付、不可误报的边界 |
| `tasks.json`（配套ZIP内） / `acceptance.json`（配套ZIP内） | 任务系统、自动化 | 结构化工单与验收台账，可导入后跟踪 |
| `issues/T01.md`—`issues/T29.md` | 每位执行者 | 单张工单可独立领取 |
| [ADR-0001-boop-home.md](#c09) | 代码审查、后续维护 | 为什么替换旧原生 Conversation 入口约束 |

文档冲突处理：本轮用户目标与本目录 ADR 决定产品形态；01 决定用户行为；02/03 决定接入与接口；04 决定任务交付；05/06 决定验收证据。旧 `baseline/`、`handoff/` 继续作为历史和未被本轮替换的工程依据，不能删改历史来伪装早已符合新方案。

## 5. 五个可以演示的里程碑

| 里程碑 | 包含任务 | 必须展示的结果 | 不算完成的情况 |
|---|---|---|---|
| M0：开发基础可用 | T01–T03 | 原工程可重现构建；测试路径可配置；真实 DSH 契约探针有记录 | 只有 mock、旧机器路径或沿用历史 PASS |
| M1：独立助理可聊天 | T04–T09 | 旧库安全打开；唯一主身份；专属页面中能直接聊、刷新续聊、保留草稿 | 只有静态页面或点击后又跳普通 DSH 起始页 |
| M2：真实委托闭环 | T10–T18 | 发到原会话一次；主聊天可继续；结果返回；停止和重启不误执行 | 只写任务记录、只显示 toast、结果来源无法关联 |
| M3：用户能理解和控制 | T19–T23 | 工作抽屉、结果卡、来源、历史与设置接真实数据；没有默认技术任务板 | 仍让用户面对 raw 状态或后台假进度 |
| M4：可升级、可验收、可安装 | T24–T29 | 42 用例、兼容矩阵、旧→新→旧演练、包与证据对应 | 测试跳过却标全部通过，或只有同版本重装 |

前端可在服务端完成前使用契约 fixture 开发页面，但必须明确是假数据。M1/M2/M3 的演示验收要用真实 Host；M4 不能由 fixture 截图替代。

关键依赖链：T01/T02 → T03 → T04/T05 → T06 与 T10 → T11/T12/T13 → T14/T15/T16/T17 → T18 → T24/T25/T26/T27/T28 → T29。具体依赖以 `tasks.json` 为准；可以并行完成视觉、目录和持久化模块，但共享接口先冻结再各自实现。

## 6. 统一完成定义

每项工单同时满足以下条件才进入 DONE：

- 指定行为由真实实现承载，新增与修改文件可定位；没有只在 PoC 端点可用的业务路径。
- 相关接口与 schema、DTO、错误映射一致；类型检查结果如实报告，并区分原有问题和新增问题。
- 该工单规定的验收可重放，证据绑定候选提交、环境和实际观察；未运行记录 `NOT_RUN`，缺环境记录 `BLOCKED` 或有原因的 `SKIPPED`。
- 新版没有增加第二套任务主库、全局 React 实例或影响普通会话的 UI 覆盖。
- 可疑投递不盲目重发，原生 cancel 的接受不冒充已停，模型的完成文案不冒充验证证据。
- 改动、运行说明和已知限制同步到对应工单；移植代码有来源记录。

最终发布不是把 29 个勾全部手工填满。必须完成一条真实自然语言操作产生实际产物的演示、升级回滚、所声明宿主范围与故障语义验证，再由发布负责人依据证据签收。

## 7. 本交付包已经完成和未执行的事项

已经完成：按固定提交阅读代码、核对相关公开接口、审查截图与入口、确定 MVP 范围、制定文件级改动与数据/接口方案、拆分工单与验收用例。交付前另核对任务依赖和用例覆盖，并对文档 SQL 草案做内存 SQLite 的语法、外键与少量旧行保留检查；这些是规格检查，不是插件实现验收。

尚未执行：修改用户仓库、安装其依赖、编译插件、运行真实 DSH、迁移用户数据库、执行42项验收、发布安装包。本交付包不包含这些结果的任何 PASS 声明。



---

<a id="c01"></a>

# BOOP 最小版本产品与交互方案

> 版本：v0.2 MVP · 日期：2026年10月28日 · 适用目录：`dsh-plugin/dsh-boop`  
> 状态：开发交接规格。需求与验收已定义，功能尚待开发和运行验收。源码依据见《07_源码依据与复用清单》。

## 1. 本轮要交付的产品

BOOP 是用户在 DSH 中持续交流的个人工作助理。第一版交付一个独立的 BOOP 主页：用户进入后直接与波波聊天；需要推进已有项目时，波波定位已有工作区与会话，携带最新要求委托执行，并把进展、阻塞和交付结果带回主聊天。

本轮的完成标准是一条真实闭环：**打开 BOOP → 直接聊天 → 找到已有工作现场 → 明确委托 → 原会话实际执行 → 结果回到 BOOP → 用户查看、确认或继续处理。**

### 1.1 必须解决的当前问题

| 当前现象 | 本轮应达到的行为 |
|---|---|
| BOOP 入口打开普通 DSH 起始页，要求先选工作区 | 入口打开专属主页；主聊天工作上下文由系统准备，用户可立即输入 |
| 任务板首先展示账本、数据域、水位、内部 ID 和门禁 | 首屏展示对话；工作进展以一句话和必要动作呈现；诊断信息进入高级设置 |
| 有任务、审批、记忆模块，但自然语言委托未形成完整入口 | 模型实际具备发现、读取、派发、控制工具；每次委托可追踪到原生 Session |
| 工程状态被直接当成产品状态 | 由服务端生成用户投影，展示“等待原会话空闲”“正在处理”“有结果”“需要你决定” |
| 已有“PASS”和截图容易被当成新版已完成 | 新版本所有验收从 NOT_RUN 开始，证据必须绑定本次候选构建 |

依据：现 BOOP 客户端入口、board、main-session 与 tools 源码；截图体现的问题与上述源码一致。[c01-B01] [c01-B02] [c01-B03] [c01-B04]

## 2. 已确定的产品与工程决策

| 决策 | 本轮采用的做法 | 原因 |
|---|---|---|
| 产品入口 | 新增独立 `main` 面板 `boop.home`；保留单一 BOOP 身份 | 用户进入后清楚地知道在与波波合作 |
| 仓库 | 在原 `dsh-boop/` 内重构，包名及数据目录不变 | 保持现有安装方式、历史数据与工程交付关系 |
| DS-Bot 复用 | 定向移植身份呈现、轻状态、聊天交互思路与必要代码；逐文件记来源 | 获得完整助理体验，同时控制宿主影响和迁移成本 |
| 聊天底座 | 使用 DSH 官方可嵌入会话 Factory，显式绑定 BOOP Session | 保留流式消息、草稿、输入法、附件与原生权限交互 |
| 任务数据 | 继续使用 BOOP SQLite 任务与动作账本 | 同一任务只有一个权威状态来源 |
| 执行对象 | 一次委托只关联一个已有 Session | 先跑通真实工作，暂不引入多执行者编排 |
| 并发 | 首版最多一个受托执行处于派发或运行状态；无法排除已执行的未知请求也占槽；其他任务等待；主聊天仍可交互 | 降低并发关联与停止语义的复杂度 |
| 目标正在忙 | 在 BOOP 侧等待，空闲后重新核对；不向用户的无关运行中任务插话 | 保留用户直接操作的优先级 |
| 长期交流 | 一个逻辑身份，日常沿用原生会话压缩；仅在必要迁移时建立历史段映射 | 不在 MVP 移植 DS-Bot 整套分段运行时 |
| 记忆 | 保留原事实及遗忘规则；本轮按需读原会话、持久保存任务约束与结果 | 无需先整理全部历史就能工作 |
| 交付判断 | “收到结果”“用户确认”“验证通过”分别记录 | 避免把一句“完成了”展示为已验证成功 |
| 中断恢复 | 自动读取和核对事实；业务动作须重新满足授权和恢复条件 | 不把历史授权当作当前自动执行许可 |

这些决策替代旧前端方案中“BOOP 必须直接导航普通 Conversation”“任务板作为主要展示面”等本轮相关约束。旧 `baseline/` 与 `handoff/` 保留历史，新增 ADR 记录覆盖范围。与本轮无关的安全、归属、用户指令优先等规则继续成立。

## 3. MVP 范围与暂缓范围

### 3.1 必做能力

| 需求 ID | 能力 | 第一版做到的程度 | 主要验收 |
|---|---|---|---|
| F01 | 独立主页 | 固定入口、BOOP 头部、自有欢迎态、聊天区、输入区、按需展开的工作抽屉 | A01、A02、A34 |
| F02 | 连续聊天 | 普通问答、流式回复、停止当前回复、附件、中文输入、草稿与重连；不先选业务工作区 | A03–A06 |
| F03 | 查找原工作 | 列出授权范围内工作区与 Session；按标题、项目和近期活动查候选；同名时让用户选 | A07、A08 |
| F04 | 读取相关上下文 | 先读元信息、有效限制与最近内容；不足时按引用补读；显示来源可回查 | A08、A11、A12 |
| F05 | 真实委托 | 用户明确要求行动后，生成任务并通过正式工具发到精确 Session | A09、A13、A22、A37 |
| F06 | 跟进和回报 | 观察对应动作/轮次；阶段性结果、阻塞和最终结果返回主聊天与工作卡 | A10、A14–A17、A37 |
| F07 | 停止与继续 | 明确区分停止波波回复与停止受托工作；无模型也可停止；恢复不重放旧动作 | A06、A18、A21、A23、A38 |
| F08 | 查看与确认交付 | 展示成果、验证事实、未完成项；用户“确认收下”单独记账 | A14、A15、A40 |
| F09 | 历史与升级 | 继承原主聊天或明确保留历史段；任务、事实、遗忘及排除规则保留 | A25–A32 |
| F10 | 宿主共存 | 普通 DSH 工作区、会话、默认模型、搜索、主题和插件正常使用 | A33、A39、A41 |
| F11 | 可理解的异常 | BOOP 自有异常说明哪件事受影响、下一步能做什么，原始信息进入脱敏诊断；原生输入的未知 Toast 保持宿主行为 | A17、A19–A24 |
| F12 | 可安装可验证 | 原包构建与安装方式可延续；新兼容矩阵和真实用例有证据 | A27–A36、A42 |

### 3.2 本轮暂不实现

- 多 Bot 团队、群聊、多个主 Bot；多 Session 子任务树、DAG 与自动并行分工。
- 自动创建业务工作区、批量重命名或整理全部工作区。本轮可定位并使用已有工作。
- 全量历史学习、历史导入、向量库、后台持续理解所有未受托 Session。
- DS-Bot 完整 roster/state 存储、自动更新器、整套权限与重启恢复策略。
- 钉钉、飞书、远程通知；新的每日摘要、定时主动问候或通知中心。
- BOOP 自带浏览器、语音通话、独立桌面安装壳、云同步、多租户平台。
- 看板拖拽、复杂排序、批量操作、管理员统计页和工程监控仪表盘。
- 自动合并、自动部署、自动批准原 Session 的工具请求。
- 自研全功能聊天编辑器或重新实现 DSH 消息协议。

已有功能的数据和必要运行保护不能因暂缓而删除。暂缓模块默认不新建后台任务、不增加可见入口，也不继续成为首屏必经步骤。旧每日9点计划只停用能证明由 BOOP 创建的绑定；用户或其他插件在同一时间的日程保持不变。

## 4. 第一版的四条用户流程

### 4.1 首次进入

1. 用户点左侧“BOOP · 波波”。
2. 页面立即出现 BOOP 自有外壳和“正在准备你的波波…”。
3. Host 找回或创建主会话，并完成 BOOP preset、内部工作上下文及数据域绑定。
4. 有可用模型时显示：“我是波波。你可以和我聊想法，也可以让我继续推进已有项目。”输入框可用。
5. 没有可用模型时显示：“先连接一个模型，就可以开始和我聊了。”在页面说明如何从保留的 DSH 设置入口连接；已有可选模型时展开原生模型选择器。不虚构当前宿主没有公开的直接设置导航 API。
6. 普通聊天不要求项目读取授权。读取项目继承宿主现有授权与 BOOP 排除规则；用户明确点名的既有可访问目标不重复索要许可。实际缺少权限时说明影响并引导到现有授权入口。

不展示三选一记忆初始化卡。开始聊天不以整理历史、创建业务工作区或完成工程检查表为前提。

### 4.2 普通交流

用户说“我在考虑以后增加三分屏，你怎么看”，BOOP 正常分析。系统不创建执行任务，不向原 Session 派发，不弹出任务确认表。

用户与 BOOP 的普通聊天历史由原生 Session 保存。查看工作抽屉、打开设置或返回普通 DSH 后，未发送草稿保留。新消息不抢夺用户阅读历史的位置。

### 4.3 交代已有项目继续执行

例：“继续 Cellgent 分屏的原开发会话，按最近确认的方案检查窄屏问题，先不要部署。”

1. BOOP 在授权范围内检索工作区与会话。精确唯一命中可继续；多个候选时展示最多 5 项，附工作区、会话标题和最近活动时间。选择会话将原生引用 chip 写入输入草稿；用户发送后才继续，未选中目标不提前读全部正文。
2. 读取选中 Session 的最新直接用户要求、当前执行状态与必要上下文。旧摘要与最新指令冲突时以最新有效指令为准。
3. 主聊天出现简短回执：“我会继续 Cellgent 的分屏开发会话，检查窄屏问题并整理结果；这次不部署。”
4. 回执说明目标、目标会话、完成标准和限制；不额外要求用户把已经明确交代的内容再确认一遍。
5. 通过正式工具原子写入任务、动作与 BOOP outbox；调度器先检查全局活动槽、目标空闲和最新用户指令。符合条件才调用受控 DSH 适配器；成功取得接收证据后显示“已交给原会话处理”。
6. 原会话忙时显示“原会话正在处理其他工作，空闲后我会再核对并继续”；只在 BOOP 侧等待，不占活动槽、不调用其 steer、不提前插入原生 inbox。调度器可处理后续已具备条件的其他任务。
7. BOOP 的这一轮回复可以结束；用户仍可询问其他事情。后台仅跟踪本次受托执行。
8. 有结果时返回一条带任务名的交付消息；有阻塞时说明具体影响和下一步。无变化不持续发状态消息。

### 4.4 收到结果与继续处理

交付内容固定包含：做了什么、成果在哪里、验证过什么、还缺什么。

- 原 Agent 只说“完成了”而没有可定位结果：显示“已收到回复，结果还需要核对”，不显示“验证通过”。
- 关联执行已结束、结果及来源已持久保存：显示“已交付”，附原会话与合法成果引用；交付状态不等同于所有检查通过。
- 用户点击“确认收下”：记录用户确认，不等同于自动测试通过。
- 用户说“这里还要改”：建立同任务的新修订和新动作；保留旧结果及来源，旧验收不沿用。
- 用户点击“停止任务”：立即进入确定性控制流程；不依赖模型推理。界面说明已停止后续派发、当前运行是否已停止，以及是否存在未知结果。

## 5. 页面结构与视觉规格

### 5.1 页面层级

| 层级 | 内容 | 常驻与否 |
|---|---|---|
| DSH 外层导航 | 原有工作区与会话；新增一个 BOOP 固定入口 | 常驻，维持宿主使用方式 |
| BOOP 顶部 | 32px 波波头像、名称、一条短状态；“工作”“设置”入口 | 常驻 |
| BOOP 内容 | 欢迎态或持续聊天；需要时出现候选对象、工作回执与结果卡 | 主内容 |
| BOOP 输入 | 自然语言输入、附件、发送或停止当前回复；高级项可展开 | 常驻 |
| 工作抽屉 | 我交代的工作、当前状态、结果和操作 | 点击“工作”后展开 |
| 设置面板 | 模型入口、可访问工作范围、历史、可折叠诊断 | 点击后展开 |

默认页不出现会话 ID、scopeId、SQLite 路径、门禁编号、nonce、水位、schema、原始 capability 矩阵和工具总数。发生异常时可提供“复制诊断信息”，复制内容经过脱敏。

### 5.2 布局与组件参数

以下为本轮新设计规格，替代旧任务板的布局默认值；工程师不需要重新选择设计方向。

| 项目 | 规格 |
|---|---|
| 桌面整体 | BOOP 占用主内容区域全部可用高度；内容居中，不把全部信息挤在左侧留下大片空白 |
| 内容宽度 | 无抽屉时聊天容器最大 820px，左右弹性留白；正文消息最大 740px |
| 头部 | 56–64px 高；头像 32px；名称 16px/600；状态 12–13px |
| 正文 | 15px，行高 1.65；窄屏 14–15px；跟随 DSH 字体栈与中文字体回退 |
| 输入 | 与聊天宽度一致；最小 64px，随内容增加，上限 200px 后内部滚动 |
| 圆角 | 输入区与浮层 16px；消息或轻工作卡 12px；小控件 8px |
| 工作抽屉 | 桌面 340–380px；内容区不足 1000px 时使用覆盖式抽屉；手机为全宽 sheet |
| 触控 | 主要点击目标至少 40px；移动端建议 44px；图标按钮有可访问名称 |
| 边框和阴影 | 一层轻边框或低强度阴影；不用大面积蓝底堆叠所有卡片 |
| 角色形象 | 复用已有 BOOP 资产；静态头像为必需，3D 为可选增强，加载失败不影响聊天 |
| 动效 | 仅状态过渡和轻展开；尊重减少动画，不用循环动画代替真实执行状态 |
| 焦点 | 清晰可见；弹层关闭回到触发按钮；后台消息不抢焦点 |

### 5.3 局部颜色规格

沿用 BOOP 的品牌识别色，把蓝色主要用于动作和小面积强调。当前品牌依据中 boopBlue 为 `#449BCC`、interactive 为 `#17648B`；这些是已有品牌值。[c01-B11]

| Token | 浅色 | 深色 | 用途 |
|---|---|---|---|
| `--boop-bg` | `#FAFBFC` | `#141517` | BOOP 画布 |
| `--boop-surface` | `#FFFFFF` | `#1D1F23` | 输入、抽屉、轻卡片 |
| `--boop-text` | `#20242A` | `#ECEEF2` | 正文 |
| `--boop-muted` | `#606B78` | `#AFB7C3` | 次要说明 |
| `--boop-border` | `#E2E6EC` | `#373C44` | 分隔与边界 |
| `--boop-accent` | `#17648B` | `#86C9EE` | 主操作和链接 |
| `--boop-accent-text` | `#FFFFFF` | `#0B2637` | 主操作文字 |
| `--boop-soft` | `#F1F5F8` | `#252A31` | 助理消息或轻背景 |

变量只定义在 `[data-boop-home]` 下。不能写入 body、html 或覆盖全局 DSH theme tokens。交付前对实际文本、禁用态和焦点颜色做对比度测量；正文目标至少 4.5:1。

### 5.4 输入区

默认展示附件、发送/停止当前回复和一个“更多”入口。模型配置、执行权限模式、计划模式、工具/Token 统计不占默认输入区域；高级区可显示实际模型与原生设置入口。

输入去噪只控制稳定槽锚点或稳定数据属性，不隐藏真实工具审批、追问或错误恢复卡。不注册影响全站的替代 input slot，也不通过宿主 CSS module 类名片段控制普通会话。

### 5.5 工作卡

每项工作最多展示以下首层字段：

1. 标题，例如“检查 Cellgent 分屏的窄屏效果”。
2. 工作区与必要的会话简称。
3. 一句用户状态，例如“原会话正在处理，暂时不需要你操作”。
4. 最新结果摘要或待决原因。
5. 当前可用动作：查看详情、打开原会话、停止任务、继续处理或确认收下。

卡片不展示三条后台状态轴、任务版本号、数据库 ID 和原始拒绝码。进度没有可计算依据时不用百分比。“工作”抽屉按需要处理、进行中、已交付/已停止排列，可用简单筛选，不引入看板列和拖拽。

## 6. 状态与文案矩阵

| 场景 | 页面或卡片文案示例 | 可用动作 | 后台应做什么 |
|---|---|---|---|
| 主会话准备中 | 正在准备你的波波… | 可返回普通 DSH | 单次确保身份，不调用模型 |
| 模型未配置 | 先连接一个模型，就可以开始和我聊了 | 查看连接说明；已有模型时选择模型 | 引导用户打开保留的 DSH 设置入口；不使用不存在的设置导航 API |
| 没有受托工作 | 你交代给我的事情会出现在这里 | 回到聊天 | 不扫描全库、不生成假任务 |
| 多个同名会话 | 找到两个相关会话，你想继续哪一个？ | 选择具体项 | 仅保存明确目标，不按标题猜 ID |
| 原会话忙 | 原会话正在处理其他工作，空闲后我会再核对 | 停止任务、查看原会话 | BOOP 侧等待；不抢占、不提前排入宿主 |
| 已接收 | 已交给原会话，等待开始处理 | 查看、停止 | 接收与运行分开记账 |
| 正在执行 | 正在检查窄屏问题，有结果会告诉你 | 查看、停止 | 仅观察本动作的执行 |
| 等待原生授权 | 这项操作需要你在原会话确认 | 打开原会话、停止 | 不代用户批准、不复制另一套审批中心 |
| 收到结果 | 已收到结果：完成了两处布局调整 | 查看结果、确认收下、继续处理 | 保留产物和证据来源 |
| 证据不足 | 已收到回复，验证结果还不完整 | 查看原会话、继续核对 | 不写 verification=passed |
| 请求结果未知 | 暂时无法确认请求是否送达，我会先核对，避免重复执行 | 核对进展 | 只读对账，不重发业务指令 |
| 请求停止中 | 已停止后续安排，正在确认当前执行是否停下 | 查看原会话 | 仅取消所属待发消息或关联当前轮 |
| 停止遇到人工接管 | 原会话已有你新的操作，我没有停止这段新工作 | 打开原会话 | 保留用户直接操作 |
| 连接断开 | 连接断开，恢复后会重新同步进展 | 重试连接 | 保留最后事实并标为未同步 |
| 模型不可用 | 暂时连接不上模型，你仍可以停止已交代的工作 | 重试、停止任务 | 不静默切供应商 |
| 主绑定异常 | 波波的历史连接需要恢复，原记录仍保留 | 查看历史、恢复连接 | 不按标题覆盖、不隐式重放 |
| 新版本数据库不可读 | 当前数据需要匹配的 BOOP 版本 | 查看恢复说明、复制诊断 | 保持只读，不降写版本 |

## 7. 首版交付与验证语义

界面状态采用业务投影；内部仍保持任务生命周期、动作执行、证据验证的既有分离。

- **已交付**：执行轮次已结束，存在可关联的结果或明确结论，回报已保存。
- **待你处理**：需要选择目标、完成原生审批、处理失败、决定恢复或补充信息。
- **你已确认**：用户在当前任务修订上点击确认；记录用户确认事实。
- **验证通过**：仅当对应版本的验证证据足够并通过已有验证器时出现。用户确认本身不生成该结论。
- **已停止**：不再派发；当前关联执行已确认停止或已经结束。仍存在未知执行时不能先显示已停止。

需要补做时生成新任务修订和新动作，不能修改旧证据所属版本。任何自动汇报都不得扩展原委托权限。

## 8. 最小成功场景

验收使用一个已经存在的临时项目和原生 Session。用户只在 BOOP 页面输入：

> 继续这个项目的原开发会话，修复演示页面的窄屏标题换行，并运行对应检查。完成后告诉我改了什么、怎么验证的，不提交、不部署。

现场必须看到：

1. 系统找到正确的原会话，而不是新建一个替代 Agent。
2. 原会话收到一条带 BOOP 来源、精确目标和限制的指令。
3. 目标目录中的演示问题被修改，实际检查被执行；报告标明模型路由真假。
4. BOOP 仍能接收用户的普通问答。
5. 结果自动回到 BOOP，可打开原会话与证据。
6. 用户能停止任务、确认收下或继续提出修改。
7. 普通 DSH 会话、搜索、默认模型与其他插件没有被修改。

仅有页面截图、直接往数据库写一条完成任务，或者调用 PoC 派发端点，都不能替代上述验收。


## 源码引用

[客户端入口][c01-B01] · [现有任务板][c01-B02] · [主会话实现][c01-B03] · [模型工具][c01-B04] · [既有品牌颜色][c01-B11]

[c01-B01]: https://github.com/wanyexin1998/dsh-plugin/blob/98991899eecea6c6af1faa158e92cb73e555a5a5/dsh-boop/src/client/index.tsx
[c01-B02]: https://github.com/wanyexin1998/dsh-plugin/blob/98991899eecea6c6af1faa158e92cb73e555a5a5/dsh-boop/src/client/board.tsx
[c01-B03]: https://github.com/wanyexin1998/dsh-plugin/blob/98991899eecea6c6af1faa158e92cb73e555a5a5/dsh-boop/src/host/main-session.ts
[c01-B04]: https://github.com/wanyexin1998/dsh-plugin/blob/98991899eecea6c6af1faa158e92cb73e555a5a5/dsh-boop/src/host/tools.ts
[c01-B11]: https://github.com/wanyexin1998/dsh-plugin/blob/98991899eecea6c6af1faa158e92cb73e555a5a5/dsh-boop/baseline/assets/boop-brand-tokens.json


---

<a id="c02"></a>

# BOOP MVP 客户端架构与 DSH 接入

> 版本：v0.2 MVP。实施目录：`dsh-plugin/dsh-boop`。本文定义需开发的客户端接线与验收要求；官方接口已按固定源码核实，双版本集成和用户流程尚未运行验收。产品范围、文案和视觉以《01_产品与交互》为准，远端 DTO 以《03_服务端协议与数据》为准。

## 0. 架构决策与验证状态

**主路径：BOOP 自有 `main` 面板 `boop.home`，自有身份头部、欢迎区、轻工作摘要、抽屉和设置；正文及输入通过 DSH `conversation.content` 的 `embedded` 实例承载。该实例绑定 Host `boop/ensureHome` 返回的真实 BOOP SessionReference，使用 `hero:false`，不挂载普通 DSH ConversationRoot，也不改变普通 activeSession。**

独立页面的判据是产品路由、页面结构、首次进入状态、身份、设置与工作闭环均由 BOOP 所有；底层复用 DSH 消息与输入控制器。首屏不是 DSH 新会话页换标题：没有原生 ConversationHeader、workspace/preset hero、普通新会话欢迎语、view tabs；有自有 BOOP 欢迎与业务卡片。原生 Chat 与 InputBar 只作为页面内部能力。

固定读码版本：

- BOOP `98991899eecea6c6af1faa158e92cb73e555a5a5`。
- DS-Bot `4a7b55069ad300eae8be42a74f31bc170b40ead7`。
- 官方 DSH tag `dsh-v0.2.1-rc.2` → `687f282e8625c6b8d11ff58211a90524be2e4317`。
- 官方 DSH tag `dsh-v0.2.1-rc.3` → `1f81c047fc48fa190a683e469daa699857e9afe8`。

已比较 rc.2/rc.3 的 `ConversationContent.tsx`、`InputBar.tsx`、ui-session `index.ts`、ui-slots `index.ts`、session-controller `contract/sessions.ts`：内容相同。`apply.ts`/`contract/slots.ts` 有 rc.3 View 菜单 pin 支持的新增，本文所用 factory/provider/session contract 未变。另核对 connection 的公开 state/generation/reconnect、SettingsRoot 和 Toast 在两版的行为一致。**源码验证不等于运行验证**：工程任务须补真实宿主证据；所有新增验收初始为 NOT_RUN。

## 1. 已核实的宿主公开接口

| 目的 | 实际公开面与限制 | 证据（rc.2 路径及行号） |
|---|---|---|
| 自有主页面 | `ctx.slots.register({name:'main',key:'boop.home',...}, BoopHome)`；`ctx.layout.selectPanel('boop.home')`；`null` 返回原生 Conversation，不改已选 Session | `packages/client/ui-layout/README.zh.md` L32、L57；现 BOOP `src/client/index.tsx` L138–150 已使用同种 main 注册 |
| 显式 Session retain | `ctx.sessions.retain(id,{source:'boopHome',signal})` → `SessionReference`，`await ref.ready`，离开时 `ref.release()` | `packages/api/session-controller/src/client/contract/sessions.ts` L25–38、L58；公开类型由 `.../client/index.ts` L53–54 导出 |
| Provider | **不是**从 ui-session import 的 React 组件。注册组件声明 session/session-maybe 子槽后，框架向 props 注入 `SessionProvider`；`session` 参数是 `SessionReference` | `packages/client/ui-slots/src/index.ts` L349–366、L399–401；`ui-session/src/client/index.ts` L152–155 |
| BOOP 自有 session 子槽 | root main 声明自己的 `boop.session`（single/session），再注册它；root 用注入的 Provider 包 `renderSlot('boop.session',{})`。不要冒领 conversation 的 foreign children | 同上；`ui-renderer/src/client/scoped-slots.tsx` L538–591 |
| 内嵌会话 | session 子槽拿框架提供的 `renderFactorySlot`：`renderFactorySlot('conversation.content',{variant:'embedded',phase:'active',hero:false},{slots:{views:BoopConversationViews},fallback:<BoopUnavailable/>})` | `ui-slots/src/index.ts` L481–499；`ui-conversation/src/client/contract/slots.ts` L301–322、L535–539；原生用法 `skeleton/ConversationMainPanel.tsx` L45–54 |
| 原生消息视图 | 自有局部 `BoopConversationViews` 内仍 `renderSlot('conversation.session',{view:'chat'})`；外围可加 BOOP 欢迎/工作摘要。不替换全球 conversation.session | `contract/slots.ts` L206–210；`skeleton/DefaultConversationViews.tsx` L32–41 |
| 同一 Session 状态与输入 | `useSession`、`useConversation`、`useInput`、`inputActions` 为标准 props；由 uiSession.provide 指向同一个 Session binding | `ui-conversation/src/client/apply.ts` L309–326；`contract/slots.ts` L330–336 |
| 局部 factory overrides | **仅 `views`、`widthControls`**。没有局部 `composer`/`InputBar` override；children 是槽能力，不等于局部可覆盖位 | `contract/slots.ts` L303–322；`apply.ts` L336–353 |
| 稳定样式锚点 | 每次 renderSlot 都有 `[data-slot="完整槽名"]` 包裹；内联 `display:contents`。这是真实渲染器契约，不是猜 CSS module 名 | `ui-renderer/src/client/scoped-slots.tsx` L1088–1097 |

### 1.1 公共包、依赖与接线

使用公开类型入口：

- `@deepseek-ai/dsh-api-session-controller/client`：`SessionReference`、`SessionRetainOptions` 等类型。`SessionReferenceSourceMap` 可 declaration merge 自有 `boopHome` 来源（该入口 L79–88），不要冒用 `mainView`。
- `@deepseek-ai/dsh-client-ui-slots`：根出口正式导出 slot map、`PropsRenderSlots`、`PropsRenderFactories`、`ScopeStandardProps`、factory render 类型（其 package.json 的 `.` exports 已核对）。运行时只用注入的 ctx/props。
- `@deepseek-ai/dsh-client-ui-session/client`：标准 props 的类型扩展；Provider 本身不 import。
- `@deepseek-ai/dsh-client-ui-conversation/client`：`ConversationViewsProps`、`InputActions`、`InputState`、`ConversationContentInputProps` 等已公开；`UiConversation` / `IConversation` 也公开，但主路径无须 new 控制器。

该入口**没有导出** `InputBar`、`DraftEditor`、`DefaultConversationViews` 组件（见其 `index.ts` L83–104 的实际 exports）。不得写 `import { InputBar } ...`，也不从 npm 包 `src/` 深导入内部 TSX：包的源码通配 export 不等于发布文件包含这些源文件。

主消息流由宿主原有 `ui-chat` 注册支持；将 ui-conversation/ui-session/ui-chat 等所需能力纳入激活依赖或明确的 unavailable 判断。不要打包另一份 React、ConversationController 或 ui-chat 插件实例。

下面展示实际公开 API 的组合。`HomeRoot`、`BoopSession`、`BoopConversationViews`、`BoopLoadingOrError`、`BoopUnavailable` 均为 **BOOP 本项目拟新增组件**。此片段用于明确边界，不是已经运行验证的完整实现：

```tsx
import React from 'react'
import type {} from '@deepseek-ai/dsh-client-ui-layout/client'
import type {} from '@deepseek-ai/dsh-client-ui-session/client'
import type {} from '@deepseek-ai/dsh-client-ui-chat/client'
import type { SessionReference } from '@deepseek-ai/dsh-api-session-controller/client'
import type {
  PropsRenderSlots, PropsRenderFactories, ScopeStandardProps,
} from '@deepseek-ai/dsh-client-ui-slots'
import type { ConversationViewsProps } from '@deepseek-ai/dsh-client-ui-conversation/client'

declare module '@deepseek-ai/dsh-api-session-controller/client' {
  interface SessionReferenceSourceMap { boopHome: unknown }
}
declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface SlotMap { 'boop.session': { kind: 'single'; scope: 'session' } }
}

type HomeRootProps = PropsRenderSlots<'boop.session'> & {
  homeReference: SessionReference | undefined
  advanced: boolean
}
function HomeRoot({ SessionProvider, renderSlot, homeReference, advanced }: HomeRootProps) {
  return <section data-boop-home data-boop-advanced={advanced ? 'true' : 'false'}>
    {/* BOOP 自有 Header/loading/error/UI context 省略 */}
    <SessionProvider session={homeReference} empty={() => <BoopLoadingOrError />}>
      {renderSlot('boop.session', {})}
    </SessionProvider>
  </section>
}
function BoopSession(props: ScopeStandardProps<'session'> & PropsRenderFactories) {
  return props.renderFactorySlot('conversation.content', {
    variant: 'embedded', phase: 'active', hero: false,
  }, { slots: { views: BoopConversationViews }, fallback: <BoopUnavailable /> })
}
function BoopConversationViews(props: ConversationViewsProps) {
  return <>
    {/* 空历史时显示自有欢迎，不替换消息引擎 */}
    {props.renderSlot('conversation.session', { view: 'chat' })}
    {/* 候选选择/待处理补充卡放在当前历史之后、原生输入之前 */}
  </>
}
```

注册 root 时声明 `children:{'boop.session':{kind:'single',scope:'session'}}`；注册自有子槽的 occupant 为 `BoopSession`。controller 引用变化通过 BOOP 自有 `HostObservable`/React state 注入 root；页面通过订阅响应 ready、断线与迁移。历史 replay 的真实实现要令 `phase` 随自身 loading 变为 settling/active，不照抄示意固定 active 处理所有状态。

现 BOOP `dsh.client` 仅写 platform；新增 package manifest 的 client inject（官方包名）应包含 `@deepseek-ai/dsh-api-session-controller`、`@deepseek-ai/dsh-client-ui-layout`、`@deepseek-ai/dsh-client-ui-session`、`@deepseek-ai/dsh-client-ui-conversation`、`@deepseek-ai/dsh-client-ui-chat`，以原有宿主插件为依赖。函数服务 inject 使用真实已声明的 `slots`、`layout`、`connection`、`sessions`、`uiSession`、`uiConversation`、`conversation`、`uiWorkspace`；uiChat 是否有同名 service 不作假设，不加一个凭空的 `uiChat` 服务依赖。

### 1.2 草稿持久化为何仍成立（准确区分两个 Views）

`ConversationContent.tsx` L9–10 的默认 factory `views` 是一个极薄的 `ConversationSessionView`，其工作只是 `renderSlot('conversation.session',{})`。我们替换的是**这个局部位置**。

`conversation.session` 的原生 occupant 仍由 `ui-conversation/apply.ts` L382–418 注册为 `DefaultConversationViews`；该注册向它注入 `bindDraftPersistence`。真正持久化 effect 在 `DefaultConversationViews.tsx` L25–30：绑定 `actions.setDraft`，调用 `inputActions.persistDraft()`，卸载时 unbind。

因此 `BoopConversationViews` 继续调用原生 `conversation.session` 时，原生草稿 effect 与历史视图仍执行；不能额外重复绑定。如果完全绕开此槽直接读取 ChatSnapshot 自绘，则确实会丢失这一接线，同时需要自行处理 echo 去重、历史分页、图片、定位等；MVP 不走这条路。

## 2. 本项目新组件、导航与生命周期

`openBoopHome` 先同步选 `boop.home`，立即显示 BOOP 自有 loading shell；随后 home controller 调 `boop/ensureHome`。ready 返回真实 `mainSessionId`/`bindingVersion`，Host 已核实 preset 与自有上下文；`capabilities:{send,readSources,delegate,stop,reasonCodes}` 是能力信号。内部 workspace/cwd/preset 只进入脱敏 diagnostics，不出现在首页。`openBoopHome`、`createHomeController`、`retainHomeReference`、`mapHomeError` 是本项目拟新增函数；DSH 没有这些同名 API。

运行约束：整个 BOOP 首版全局至多一个委托处于派发或运行中；无法排除已经执行的 outcome_unknown 同样占据此槽，其余由 Host 排队。任务资源刷新不得重建 home controller、重新挂载 editor 或释放 Home SessionReference。主聊天与任务执行状态分离，后台有工作不锁主输入。

客户端单次 mount 的顺序：

1. 建立本次 owner AbortController 与 request generation；发 ensureHome（可复用同 tab single-flight）。
2. ready 后 `const ref = ctx.sessions.retain(mainSessionId,{source:'boopHome',signal})`；`await ref.ready`。
3. 再核对本次 mount/generation 仍有效，将 ref 发布给根组件；Provider 内渲染 BOOP session 子槽。bindingVersion 改变时先撤掉旧 editor，再释放旧 ref/接新 ref，同 tab 不同时挂两份可编辑 BOOP editor。
4. 不是 ready：在 BOOP 页面展示 repair/unavailable 与可执行重试，不 create，不跳普通新会话，不使用 localStorage ID 兜底，不按标题猜 session。
5. 离开、插件卸载、generation 失效：停止 UI watcher/轮询，abort 等待，release 一次；清理本地样式/注册。取消 UI 等待不等于取消后端运行任务。晚到 Promise 不得把用户从普通会话抢回 BOOP。
6. 回到 BOOP：重新 ensure/retain 或复用仍有效 owner；Host 的幂等性保证逻辑身份唯一。普通 DSH activeSession 没被主入口改动。

官方 `AppFrame.tsx` L39–42 的 main outlet 只按 `usePanelInfo(info => info.activePanelId)` 渲染一个 `entryKey`，所以从 BOOP 切到别的面板会卸载 BOOP main occupant；该卸载是 release 的实际挂点。`ctx.layout.panelInfo` 是真实 observable，可订阅导航归属；不轮询 DOM。`stores.ts` L81 明确 app 初始 activePanelId=null：若实现“刷新后留在 BOOP”，必须自己保存 tab 级路由意图，在注册 boop.home 后、任何网络 await 前恢复选择；不能声称 DSH 已自动持久化该面板。冷 app 插件加载前的宿主首帧不属于 BOOP 已挂载页面；T07/A01 验收记录实际加载次序，不能靠全局遮罩隐藏宿主来伪造无闪屏。

会话冷启动、历史 replay 未完成时不要展示假空态；先用 BOOP skeleton。原生 `useSession` 的 openState/blank 与 `useConversation` 的投影到位后再判断欢迎。页面 ready 且为空时仍以 `phase:'active',hero:false` 创建 factory，这样输入固定在 BOOP 页面底部、从第一句就可用。`ConversationContent.tsx` L142 明确 inert = 无 session 或 (hero 且无 workspace 标题)，因此 valid ref + hero:false 不会进入“选择 workspace 后才能输入”。这不是绕过 Host 工作上下文；Host 仍创建并验证自己的私有工作上下文。

来源跳转是唯一正常使用 `ctx.uiWorkspace.openSession(sourceSessionId)` 的场景；用户明确点击“打开原会话”才切换普通 DSH。返回 BOOP 通过固定入口，保持自己 drawer/filter/scroll state。直接进入 BOOP 时不调用它。

DSH 原生 right sidebar 只随 conversation panel 显示（ui-layout README.zh L59），BOOP 的工作详情/设置必须用**自有页内 drawer**。内嵌原生 markdown 文件链接不会自动得到可见的 native rightbar；native Chat `ui-chat/apply.ts` L258–262 的文件点击走该 rightbar。MVP 工作结果用后端返回的结构化 result/source reference 在自有结果卡提供“查看结果/打开原会话”；该明确动作切到来源 session 后使用原生资料功能。普通 markdown 文本内本地文件链接的 BOOP 页内预览不属于本 MVP；结果卡必须提供有效的来源入口，不能让用户停在不可见侧栏。

## 3. 输入区：首屏简洁、只做实例内控制

### 3.1 精确规则

**保持原生 InputBar、DraftEditor、发送/停止/附件/输入命令、真实审批/追问的组件实例。** 自定义的是 BOOP 页 wrapper、品牌样式、自有高级开关与 factory 局部 views，而不是另造第二份发送控制器。

| 原生元素 | 默认 BOOP 首页 | 实施方式/锚点 | 必须保留的关系 |
|---|---|---|---|
| 原生 hero / workspace / preset | 不挂载 | factory `hero:false`；`ConversationContent.tsx` L166–167 条件分支 | 无业务 workspace 选择步骤 |
| 普通会话头、标题、View tabs | 不挂载 | 不挂 `main.conversation` / ConversationRoot；用自有头 | 不对普通 DSH 注册任何替换 |
| 模型选择 | 默认折叠，高级展开；模型缺失时主动展开 | `[data-slot="conversation.input.model"]` | 必须能配置/恢复模型，不把 disabled 输入留成无解释死路 |
| 标准/计划模式 | 默认折叠 | `[data-slot="conversation.input.plan"]` | 不改变该 Session 原本设置，仅隐藏选择器 |
| 权限模式菜单 | 默认折叠 | `[data-slot="conversation.input.permission"]` | 只是权限模式选择器，不是真正待批操作 |
| activity 工具活动入口 | 默认折叠 | `[data-slot="conversation.input.activity"]` | 后台 task 状态以自有自然语言 work cards 呈现 |
| token/usage/context meter 等 dock | 默认折叠 | `[data-composer-dock]` | 这是 InputBar 底部统计 dock，不是 `conversation.input.dock` |
| 原生附件与 plus | 保留 | 原生输入路径，`InputBar.tsx` L407–418、L441–469 | 上传/粘贴/文件选择不自绘第二套 |
| 发送/停止 | 保留 | 发送由inputActions；停止由InputBar注入的stop回调，`InputBar.tsx` L481–516，`apply.ts` L259、L547 | InputActions没有stop/cancel；保留native停止，不把它接到boopTasks/stop |
| 真正 approval/question | 保留完整可见 | `conversation.composer` chain，`conversation.input.dock`，`[data-composer-overlay]` | **绝不写隐藏这几项的 CSS**，不能把需要用户操作的审批吞掉 |

具体 CSS 选择器（实现规范，不是已提交代码）：

```css
[data-boop-home][data-boop-advanced="false"] :is(
  [data-slot="conversation.input.model"],
  [data-slot="conversation.input.plan"],
  [data-slot="conversation.input.permission"],
  [data-slot="conversation.input.activity"]
) { display: none !important; }

[data-boop-home][data-boop-advanced="false"] [data-composer-dock] {
  display: none;
}
```

第一条限定 `!important` 是因为 renderer 的 slot anchor 自带内联 `display:contents`（L1089–1097）。不把 important 散布到布局，不做 `body` 改色/全局选择器，不匹配 CSS module 的模糊 class，不扫描 DOM/样式表，不全局 shadow 单槽，不注册新的 `conversation.input.*` occupant。

InputBar 的 `[data-composer-card]`、`[data-composer-seat]`、`[data-conversation-content]`、`[data-conversation-scroll]` 可在 BOOP root 下调整圆角、间距、内容宽度与滚动，不触碰内部 DraftEditor。InputBar 内部有直接绘制的 ContextMeter（L520–524），所以只隐藏 stats 槽不够；本方案折叠整块 **composer dock**。不要误伤名称相似的 **input dock**。

可局部设置的实际尺寸变量包括 `--dsh-chat-content-width`、`--dsh-composer-card-max-width`、`--dsh-composer-side-clearance`、`--dsh-composer-text-max-height`。前两个在 `[data-boop-home] [data-conversation-content]` 上设置，分别对应正文740px与输入容器820px上限，并用百分比减边距适应窄屏；不要修改全局theme。最后一个只限制编辑文字区，不等于整个输入外盒高度；实现时需把原生工具行/内边距计入01的输入高度预算，通过真实DOM测量验收，不能只设text-max-height=200px就宣称整个输入高200px。[嵌入宽度变量](https://github.com/deepseek-ai/deepseek-harness/blob/687f282e8625c6b8d11ff58211a90524be2e4317/packages/client/ui-conversation/src/client/skeleton/ConversationRoot.module.css#L393-L399)；[输入布局变量](https://github.com/deepseek-ai/deepseek-harness/blob/687f282e8625c6b8d11ff58211a90524be2e4317/packages/client/ui-conversation/src/client/skeleton/InputBar.module.css#L1-L54)。

高级开关默认关闭。`BoopConversationViews` 获得 factory 注入的 `useComposerBlock`，在自有 HomeUiContext 中上报 blocked。已有可选模型时展开原生模型选择；尚未配置 provider 时显示下一节的设置指引。高级展开不泄漏 G0/G4/ledger/cwd/version 等工程状态。`conversation.input.left/right` 可能有其他插件扩展，不宣称能任意逐一清理；目标基线实例需截图验收，必要时以白名单评估新增扩展，不默认隐藏所有第三方插件控件。

原生 factory 没有公开 placeholder input prop；MVP 不通过 DOM 改 placeholder。BOOP 语气放在自有欢迎与输入旁引导文案里，不新增全功能输入器。

### 3.2 模型设置与原生错误的兼容边界

本项目新增 `showModelSetupGuide()` 只打开 BOOP 自有设置中的模型指引。没有 provider 时提示用户使用仍然可见的 DSH 设置入口进入模型页，完成后返回 BOOP；已有可选模型但主会话尚未选择时，展开本页原生 `conversation.input.model`。配置结果由 native composerBlock/model directory 更新，不替用户改全局默认模型。

DSH 的 `openSettings` / `openSection` 是 settings.launcher / settings.onboarding 的 owner props，不是对任意插件公开的 `ctx.uiSettings.open('models')`。公开 shortcuts 服务也没有 invoke。MVP不新增宿主settings API、不替换全局launcher、不通过伪造键盘事件或点击未知DOM来打开设置。[Settings owner contract](https://github.com/deepseek-ai/deepseek-harness/blob/687f282e8625c6b8d11ff58211a90524be2e4317/packages/client/ui-settings/src/client/contract/slots.ts#L151-L181)；[SettingsRoot调用位置](https://github.com/deepseek-ai/deepseek-harness/blob/687f282e8625c6b8d11ff58211a90524be2e4317/packages/client/ui-settings-general/src/client/SettingsRoot.tsx#L214-L263)。

BOOP自有 ensureHome/tasks/access 错误通过 `mapHomeError` 转为人话，把原始code/message放进脱敏诊断。原生InputBar对部分未知发送错误仍显示 `message(code)`，Toast又portal到body，Factory没有局部errorPresenter。MVP保留宿主反馈，不承诺捕获并改写全部原生错误，也不以全局CSS隐藏原生Toast。[InputBar错误分支](https://github.com/deepseek-ai/deepseek-harness/blob/687f282e8625c6b8d11ff58211a90524be2e4317/packages/client/ui-conversation/src/client/skeleton/InputBar.tsx#L101-L121)；[Toast实现](https://github.com/deepseek-ai/deepseek-harness/blob/687f282e8625c6b8d11ff58211a90524be2e4317/packages/client/ui-primitives/src/Toast.tsx)。

### 3.3 断线与重连的精确做法

使用真实 `ctx.connection.state.getSnapshot()` / `.subscribe(listener)` 读取 `connected | connecting | disconnected | undefined`，用户点击重试调用 `ctx.connection.reconnect()`；订阅在home controller销毁时解除。不得调用 `connection.start` 或注册另一条 generation source，连接循环属于宿主。[ConnectionHandle](https://github.com/deepseek-ai/deepseek-harness/blob/687f282e8625c6b8d11ff58211a90524be2e4317/packages/client/connection/src/client/index.ts#L143-L180)。

断线时给最后已知工作状态标记“尚未同步”，禁用BOOP自有委托、确认和继续操作；不可达的停止请求显示未送达，不能假报停止。主聊天保留原生输入状态，沿用宿主的提交与失败保留草稿逻辑；BOOP不重发它的未知提交、不清空draft、不重建第二个Session。连接恢复后先对账本/native状态，再恢复动作；重新获取SessionReference仅针对真实generation失效或物理绑定变化，不能每次task刷新都重建editor。

Factory没有独立disabled参数。原生 `phase:'settling'` 会隐藏整个composer seat（含approval chain），所以仅用于真实的首次历史replay/绑定等待；不能为离线去噪而把真实审批一起隐藏。`ctx.conversation.blocks`虽公开，但它是与模型选择共用的单值registry，BOOP不拿它覆盖模型block。离线期间原生按钮是否继续可点击、具体错误提示由宿主决定；本轮验收重点是草稿不丢、不产生插件级自动重发、重连先核对事实，不能写成已新增一个不存在的原生offline禁用API。

## 4. 页面设计与用户状态

### 4.1 视觉

视觉实现遵守《01_产品与交互》5.2–5.3 的最终规格。已有 BOOP 品牌 `boopBlue:#449BCC`、`interactive:#17648B` 继续承担识别与交互强调；画布、正文与表面使用本轮中性色，不能把旧大任务板的蓝底/ink 体系整片搬来，也不改成 DS-Bot 紫色。所有变量只定义在 `[data-boop-home]`。

| 参数 | 实施值 |
|---|---|
| 画布/表面 | 浅色 `#FAFBFC / #FFFFFF`；深色 `#141517 / #1D1F23` |
| 正文/次要文字 | 浅色 `#20242A / #606B78`；深色 `#ECEEF2 / #AFB7C3` |
| 边框/交互色 | 浅色 `#E2E6EC / #17648B`；深色 `#373C44 / #86C9EE` |
| 内容宽度 | 聊天容器最大 820px；正文消息最大 740px；输入同轴 |
| 头部 | 56–64px，32px 头像，16px/600 名称，12–13px 单行状态；只放“工作”“设置”入口 |
| 字体与输入 | 正文 15px/1.65，窄屏14–15px；输入最小64px、最大200px后内部滚动，沿用宿主字体栈 |
| 圆角 | 输入/浮层16px，轻卡12px，小控件8px |
| 工作摘要 | 首层最多3项需留意工作；其余进抽屉；不展示后台状态轴、计数墙或百分比猜测 |
| 抽屉 | 桌面340–380px；内容可用宽度<1000px使用覆盖式；手机全宽sheet，仍局限于BOOP主内容 |
| 点击与焦点 | 点击目标≥40px，移动端建议44px；可访问名称完整；关闭抽屉返回触发焦点 |

根容器 `height:100%;min-height:0;display:flex;flex-direction:column`，正文承担主滚动。嵌入式工厂内部继续拥有消息滚动和输入高度测量，不添加另一层整页滚动。顶部使用宿主 `--dsh-frame-leading-clearance`、`--dsh-frame-top-clearance` 等 chrome tokens，不能写固定 macOS/Windows 避让偏移。主题读取 DSH 已有主题信号；可以通过 `body[data-ds-dark-theme] [data-boop-home]` 匹配本地变量，但不得写 body/html 属性或全局 theme token。正文对比度目标4.5:1，reduced-motion 只影响自有动画。静态头像必需；3D 不进入第一版常驻视图，资产失败有32px静态/字标后备。

### 4.2 用户可观察状态

| 状态 | 首页表现 | 可执行动作/禁止误导 |
|---|---|---|
| 首次打开 loading | 自有 BOOP 标题/小头像 + “正在连接 BOOP…” + 内容/输入骨架 | 不闪原生新会话，不先显示欢迎后又回历史 |
| ready 空历史 | “我是波波。你可以和我聊想法，也可以让我继续推进已有项目。” + 2–3 个可选建议；底部可直接输入 | 不强迫填资料、选 workspace、学习或导入全历史 |
| 正常有历史 | 主要区域就是与同一 BOOP 的对话；轻工作摘要展示待确认/完成结果 | 不再常驻技术状态总览 |
| BOOP 正在答复 | 原生流式正文 + 小状态；原生停止可用 | 不自造第二套 spinner 与 send 请求，不重复 echo |
| 业务工作进行中 | “正在整理 X，完成后告诉你”卡；详情含进度依据 | 保持首页可继续交流，不能把任务 running 当作当前对话无法输入 |
| 待确认/待补充 | 可见可操作卡，清楚说出对象/目的/后果；真实原生 approval/question 不隐藏 | 同一动作禁止双击重复提交，过期/已处理要明确；权限菜单折叠不影响 BOOP 主会话自身的原生交互；受托原会话的审批只提供“打开原会话”，不复制审批中心 |
| 模型未配置 | 自然说明 + 配置指引；已有可选模型时展开原生模型槽 | 身份可为 ready，但能力 send=false；保留草稿 |
| 临时断线 | 轻条“连接断开，恢复后会重新同步进展”；保留最后事实与草稿；BOOP业务动作暂不可用 | 不丢草稿、不重放不确定是否成功的发送、不新建第二个主 Session |
| 身份需修复 | 自有 repair 页面：“BOOP 的连接需要恢复”；重试/查看旧记录/复制诊断（按后端 reason） | 不将内部错误码当正文；不静默迁移运行中的旧 Session |
| 加载/发送失败 | 原文附近错误及可重试动作；详细诊断可展开 | 区分读取失败与发送结果未知，不能 retry 就重复执行工作 |
| 窄屏/键盘 | 输入/发送及待确认卡留在可见区域；抽屉有明确关闭 | 中文 IME composing 时 Enter 不发送；沿用原生 editor 行为 |

本轮取消首次三选一初始化卡。普通聊天直接开始；全量历史学习与导入不进入本 MVP 的可见功能，原数据和排除/遗忘规则保留。设置仅提供模型指引、可访问工作范围、历史入口和折叠诊断。读取项目继承宿主现有授权与 BOOP 排除规则；用户明确点名的既有可访问目标不重复索要许可，确实缺权限时才说明影响并引导现有授权入口。旧 init.tsx 的 G 门槛/ledger/write-lease 文案移出产品界面。

## 5. 候选目标、工作卡与服务端DTO

### 5.1 选择目标：填入原生草稿，用户发送后确认

只扩展现有 `boop_catalog`、`boop_context`；新增执行工具为 `boop_dispatch`、`boop_task_control`。客户端不新增另一套工具名或模型路由。精确唯一命中时不出二次确认卡；本节仅处理同名/多个候选的歧义。

候选卡由真实 `boop_catalog(mode:'work')` 的结构化返回派生，最多5项，显示工作区、自然标题与最近活动时间。结果带 `originUserMessageId`、`sourceSeq`、`generatedAt`；每项包含准确sessionId、workspaceId、title、workspaceTitle、mention、lastActivityAt、preview、selectionKey，最终字段采用03的唯一DTO。preview仅在已有合法摘要时显示，可以为空；为画候选卡不得先读全部候选正文。`selectionKey`只用于关联UI，不是授权凭证。工具输出只采用一个渠道：`output.render = (_args, value) => [{ type:'text', text:JSON.stringify(value) }]`。canonical DTO 顶层为 `{schemaVersion:2,kind:'boop.catalog',ok:true,data:{mode:'work',originUserMessageId,sourceSeq,generatedAt,candidates,truncated}}`；不另设meta通道。

补充卡位于 `BoopConversationViews` 中原生 `conversation.session` **之后**、输入之前，不改变native消息renderer。`TargetCandidates.tsx` 中的纯函数 `readWorkChoice`只读取公开 `useChat(s => s.legacy.nodes)` 的 `ToolResultNode`，要求 `kind==='tool-result' && name==='boop_catalog' && !isError && call!==null`，只接受完整单个text content block，JSON.parse后严格校验schemaVersion/kind/ok/data.mode/candidates≤5和字段类型；不从assistant Markdown/任意JSON或外部网页生成可执行按钮。当前ChatSnapshot的legacy.nodes是公开兼容投影，适配器集中使用并在两版fixture验证；不把它复制为第二套消息缓存。若结果不在已加载窗口、call head缺失、JSON截断或schema无效，就不造卡，保留原生文字结果与重新查询入口。

点击选项只使用公开输入能力把准确原生Session引用插入草稿。Host用 `@deepseek-ai/dsh-session-reference` 根出口公开的 `formatSessionReferenceMention` 生成canonical mention，前端不拼接不可信标题成wire协议；原生chip只显示自然label。[公开export](https://github.com/deepseek-ai/deepseek-harness/blob/687f282e8625c6b8d11ff58211a90524be2e4317/packages/context/session-reference/src/index.ts#L47-L53)；[formatter实现](https://github.com/deepseek-ai/deepseek-harness/blob/687f282e8625c6b8d11ff58211a90524be2e4317/packages/context/session-reference/src/uri.ts#L43-L50)。真实API示意：

```ts
// 这些方法是DSH已有API；insertWorkCandidate是BOOP本项目的新函数。
const actx = ctx.sessions.scope(mainSessionId) // 仅在有效ref仍retain期间调用
if (actx === undefined || input.phase !== 'plain') return { applied: false }
const span = inputActions.captureInsertion()
const facade = ctx.conversation.input.for(actx)
const applied = facade.insertReference({
  source: 'reference',
  ref: candidate.mention,
  label: candidate.title,
  appearance: 'session',
  clipboardText: candidate.mention,
}, { ...span, start: span.end }) // 不覆盖用户选中的已有草稿文字
if (applied) facade.focus()
// 这里绝不调用submit、dispatch或approve。
```

宿主原生ui-reference已注册 `reference` source并把ref序列化为相同canonical mention；把 `@deepseek-ai/dsh-client-ui-reference` 列为本功能client依赖。`insertReference`本身有draftRev和phase保护；失败保留卡片并提示重试，不回退为清空整个draft。已有草稿、附件与限制保持不变；成功填入后卡片提示“已放入输入框，发送后确认选择”。同一候选卡在该引用尚留在草稿时禁重复插入；删除引用后恢复选择，避免一次点击生成多个目标。

用户亲自按原生发送后，才形成新的直接人类消息。Host重新检查工作范围、target身份和fresh context；选择只解决原问题的目标歧义，不扩大之前委托权限。原请求只是查找/讨论时，选择会话本身不能变成执行授权。客户端采用保守的确定规则：本地输入进入新的adjudicating/submitting阶段即收起当前选择卡；发现seq晚于该结果的任何user节点也令旧卡失效。若本地发送失败，原生草稿保留所选引用，用户仍可检查并手动再发；插件不自动重发。最终授权权威仍是Host。失效卡不提供可执行旧动作。

实现依据：[输入公开接口](https://github.com/deepseek-ai/deepseek-harness/blob/687f282e8625c6b8d11ff58211a90524be2e4317/packages/client/ui-conversation/src/client/contract/input.ts#L183-L229)；[revision保护](https://github.com/deepseek-ai/deepseek-harness/blob/687f282e8625c6b8d11ff58211a90524be2e4317/packages/client/ui-conversation/src/client/input/facade.ts#L525-L538)；[原生引用结构/serializer](https://github.com/deepseek-ai/deepseek-harness/blob/687f282e8625c6b8d11ff58211a90524be2e4317/packages/client/ui-reference/src/client/index.ts#L151-L173)；[ToolResultNode](https://github.com/deepseek-ai/deepseek-harness/blob/687f282e8625c6b8d11ff58211a90524be2e4317/packages/client/ui-conversation/src/client/contract/records.ts#L160-L183)；[ChatSnapshot](https://github.com/deepseek-ai/deepseek-harness/blob/687f282e8625c6b8d11ff58211a90524be2e4317/packages/client/ui-chat/src/client/contract/snapshot.ts#L99-L118)。

#### 原生引用自动预读与 BOOP 排除规则

原生引用不是只有显示效果：宿主的session-reference插件在`agent/pre-step`中自动解析canonical mention，并在模型执行前调用`sessionQuery.readSurface`。因此，仅让`boop_catalog`隐藏排除项、仅禁用候选卡，或只在后续`boop_context`检查权限，都不足以保护BOOP排除来源；用户也可能手贴引用。

本方案保留上述原生reference chip，但以03定义的**BOOP主scope引用guard**为必要前置。Host须在任何主输入或恢复执行前安装guard，且确认作用于当前真实主绑定；guard不可用时不把Home作为可发送状态暴露。guard读取Host的有效来源规则，对被排除、无权访问或无法判定的引用，在原生预读之前降为可读的普通文本及未读取说明；保留原人类message、其余正文、附件与先后顺序，不能丢弃整条人类输入。来源策略不可读时应阻断引用预读，而非放行fallback。具体校验及转换代码以03为准，前端不复制这一安全判断。

所需执行顺序已有官方源码证明，未依赖未定义的listener优先级：session-reference使用`prepend:true`，先`await next()`，然后才调用`prepareDirectMessages`；Cordis将prepend监听器`unshift`、默认监听器`push`，scope过滤保序，waterfall按`shift`调用。BOOP主agent scope的普通非prepend guard在下游返回经过检查的decision，外层原生引用处理器随后才读取。rc.2与rc.3的session-reference实现相同，Cordis关键排序与waterfall行为一致。[原生预读入口](https://github.com/deepseek-ai/deepseek-harness/blob/687f282e8625c6b8d11ff58211a90524be2e4317/packages/context/session-reference/src/index.ts#L138-L178)；[scope过滤](https://github.com/deepseek-ai/deepseek-harness/blob/687f282e8625c6b8d11ff58211a90524be2e4317/vendor/cordis/src/events.ts#L165-L174)；[waterfall与注册顺序](https://github.com/deepseek-ai/deepseek-harness/blob/687f282e8625c6b8d11ff58211a90524be2e4317/vendor/cordis/src/events.ts#L234-L258)。

验证必须同时覆盖`@[label](dsh-session:...)`和**裸**`dsh-session:...`，因为官方parser两者都识别；候选chip、手动粘贴、重复引用和混合普通正文须得出一致结论。断言被排除来源的`readSurface`调用次数为0，并检查其它人类正文未丢失、普通DSH Session不受此guard影响。该集成断言属于T03/T10/T13；源码证明不替代实际fixture通过。未满足此门槛不得以“后续工具会拒绝”作为完成依据。[实际解析语法](https://github.com/deepseek-ai/deepseek-harness/blob/687f282e8625c6b8d11ff58211a90524be2e4317/packages/context/session-reference/src/uri.ts#L61-L86)。

### 5.2 业务接口统一表

以下全为BOOP服务端新增/扩展的业务接口，不是DSH宿主原生API，参数和返回以03的TypeScript附录为唯一真源：

| 接口 | 客户端用途 |
|---|---|
| `boop/ensureHome` | 找回真实主身份；消费ready/repair_required/unavailable与capabilities |
| `boopTasks/listV2`、`boopTasks/detailV2` | 首页轻工作摘要、工作抽屉与结果；旧list/detail保留兼容但新界面不混用 |
| `boopTasks/stop` | 明确用户停止任务；独立于native停止当前回复 |
| 继续处理（本页动作） | 把准确task上下文填到原生草稿，用户补充并发送后由`boop_task_control`处理；首版不做另一个确定性表单，也不从UI直接调用需要contextToken的continue Remote |
| `boopTasks/confirm` | 人类确认当前resultId + taskVersion，仅accept，不伪造验证通过 |
| `boopTasks/reconcile` | 未知投递/恢复时先只读核对，不能当重发按钮 |
| `boopSources/access`、`boopSources/setAccess` | 设置中查看/调整既有BOOP范围/排除规则；不叠加通用项目授权流程，不越过宿主权限；只走人类设置入口 |

stop/confirm携带requestId、taskId、expectedTaskVersion，confirm另带resultId；继续处理由新的直接用户消息触发，Host校验准确taskVersion、fresh contextToken、instruction、criteria/exclusions。冲突刷新事实、保留用户草稿，不自动改version重试。UI只显示服务端 `productState`、`confirmation`、`verification` 的业务含义；不会把三条原始内部轴平铺成看板。收到合法结果可显示“已交付”，同时保持confirmation.pending；用户“确认收下”是user acceptance，不等于自动测试通过。

“等待原会话空闲”和“前面还有BOOP工作”均是等待；仅Host决定全局最多一个派发/运行，未排除已经执行的unknown也占槽，前端不自行争锁。受托Session的原生工具审批卡提供“打开原会话”，BOOP不复制approve接口，也不从受托消息中渲染任意action。主BOOP Session自身的原生approval/question继续由嵌入factory展示。

## 6. DS-Bot 定向移植范围

可借的不是它整套入口，而是可局部化的展示代码/交互结构：

- `header.js` L100–114：紧凑身份、名字与一句短状态、短暂轻提示的模式。移植为32px头像的 `BoopHeader`/`BoopNotice`，去掉 body attribute/全局 state 写入；本轮不增加独立记忆入口。
- `composer.js` L9–11：扩展 UI 不另造 native send 的原则；保留附件/发送主路径。不要把全局槽替换搬进来。
- `docs/design/ui-standard.md`：统一图标/焦点/密度/小状态/动效的规则，可整理成局部 tokens；以 BOOP 现色源代替 DS-Bot 主题值。
- 需要的 request-choice/轻结果展示可按逻辑重新整理到 BOOP 自有卡组件，保留来源 NOTICE。无需把 `cells.js` 大套原生消息 renderer 拷来。

明确不搬：`index.js` L788–860 的 installShell/installConversation；L805 sidebar.workspaces 替换；L822–839 全局消息节点 shadows；L840–846 对 permission/plan/model/stats 的全局隐藏；`surface.js` 的全站 bot/plain 模式；`sidebar.js`/`team-actions.js` 多 Bot、多 agent/group 操作；`styles.js` body CSS、class 片段匹配及 L1155–1225 的扫描编译机制。它们和本方案“普通 DSH 保持原状、只有一个 BOOP 身份”的约束相冲突。

## 7. 原仓库文件变更清单

在原 `dsh-boop` 下实施，不另建 DS-Bot 项目：

| 文件 | 本次责任 | 对应主任务 |
|---|---|---|
| `src/client/index.tsx` | MAIN_KEY改为boop.home；注册自有main/boop.session和单一固定入口；退出旧init dock/main header/大任务板注册，保留必要settings附加行与显式来源导航 | T07、T09、T21 |
| `src/client/main-session.ts` | 停用旧client create/fallback及uiWorkspace主导航；仅保留确需兼容的DTO/迁移hint，新的lifecycle唯一归home/controller.ts | T07 |
| **新增** `src/client/home/controller.ts` | typed ensureHome、SessionReference owner、generation与abort、connection订阅、自有错误映射/required capability检查；DSH适配集中于此，不另建第二个home-controller/dsh-adapter | T07、T09 |
| **新增** `src/client/home/index.tsx` | root layout、HomeUiContext、loading/error边界、工作/设置drawer与高级状态，订阅controller | T07 |
| **新增** `src/client/home/BoopSession.tsx` | own boop.session occupant与公开slot type声明；embedded factory；同文件BoopConversationViews保留native conversation.session；保证editor单实例 | T07 |
| **新增** `src/client/home/Header.tsx`、`Welcome.tsx`、`home-styles.ts` | 32px头像身份、自然欢迎、两主题局部token与稳定anchor样式；不复制DS-Bot主题接管 | T08 |
| **新增** `src/client/home/ComposerState.tsx` | 自有高级展开、模型配置指引、断线提示；由BoopConversationViews传入实际block状态，不替换native editor或approval chain | T09 |
| **新增** `src/client/home/WorkDrawer.tsx`、`WorkCard.tsx`、`ResultCard.tsx`、`TargetCandidates.tsx` | 服务端task投影、轻摘要、结果动作、真实catalog候选校验和原生chip插入；readWorkChoice为TargetCandidates内可单测纯函数 | T20 |
| **新增** `src/client/home/SettingsPanel.tsx`、`HistoryList.tsx`、`Diagnostics.tsx` | 模型指引、现有可访问范围/排除规则、旧主历史段入口、脱敏诊断 | T21 |
| `src/client/init.tsx` | 退役首次三选一/dock挂载；不删除既有数据和遗忘规则；历史学习/导入不暴露入口 | T09、T21 |
| `src/client/header.tsx`、`brand.tsx`、`companion.tsx`、`companion3d.tsx` | 复用头像/固定入口必要逻辑，旧native header chip不再注册；真正首页头部只在home/Header.tsx，3D不成为输入依赖 | T08 |
| `src/client/settings.tsx`、`source.tsx` | 保留必要原生settings附加行；明确source click后才进入普通DSH；迁移可复用逻辑到新页内组件 | T20、T21 |
| `src/client/styles.ts`、`interaction-styles.ts` | 清理旧大板与dock样式引用；固定入口样式保持局部；首页规则唯一放home/home-styles.ts | T08、T09 |
| `src/client/board.tsx`、`taskboard/view-model.ts`、`control-model.ts` | 提取纯DTO/formatting；首页不mount旧大板；旧诊断仅按T21/T23引用策略保留或清理 | T20、T21、T23 |
| `build.mjs`、`package.json` | DSH类型/运行依赖声明与external；React外置；新增测试bundle/脚本；发布支持范围与真实验证版本一致 | T07、T23 |
| **新增** `tests/client/mvp-home-lifecycle.test.mjs`、`mvp-composer.test.mjs` | 生命周期、草稿、局部去噪、审批可见、断线；相应测试必须进入实际CI脚本，不能因位于tests/client而未被旧tests/*.test.mjs命令发现 | T07、T09 |

所有新文件路径与《04_开发任务清单》及tasks.json保持同一落点；若内部提取辅助函数，先留在相应模块，不平行建立另一套架构目录。旧约束中“禁止独立页面”等产品假设应更新；普通DSH隔离、唯一主身份、权限与执行归属的有效断言继续保留。

当前 build.mjs 客户端 external 只有 react/react-dom/ui-primitives（L35–56）；若新增运行时 imports 不能任它们被 esbuild 打进插件。优先 type-only imports + ctx/renderer 提供的能力，最小化 runtime module-loader 依赖；需要运行时 module 的部分用宿主正式出口并加入 external。准确 loader 解析是 spike 的一个运行证据项。

## 8. 开发前的短集成验证

时间盒0.5–1工程日，纳入 FDEV01；交付一个最小集成 fixture，验证实际发布包、模块加载和真实渲染，不展开新的平台调研。源码已证明 factory/provider/anchors 存在，未确定的是实际安装环境下的组合行为。

要解决的剩余未知：

1. 当前打包/模块加载环境下 type-only package references 和 factory 宿主依赖顺序可用，两个声明支持版都成功。
2. 真实 DSH 的自有 main/explicit SessionProvider/factory 能在空 Session 发一轮、流式接收、离开返回和刷新保存草稿；有没有只在实际宿主发生的 context/registration 生命周期差异。
3. Scoped composer 去噪在两版实际 DOM 下不藏 approval/question、不残留异常空白；强制缺模型时显示准确配置指引；已有可选模型时能展开恢复。

产物：一个最小 fixture（后续保留作 adapter 集成用例）、两版运行命令/截图/日志、API compatibility 表。通过即冻结上述路径。失败时只对失败点提出实际需要的最小宿主兼容 patch，**不得退回普通新会话换名、全局 CSS takeover 或另造客户端 Session**；若某版本确实不具备必要能力，诚实缩小支持范围或作为显式阻塞，而不是无截止研究。

## 9. 工程拆分与完成条件

FDEV01–07仅用于组织本章实施细节，不新建另一套工单；正式负责人、依赖、状态及编号以《04_开发任务清单》T01–T29为准。对应关系：FDEV01→T03/T07，FDEV02→T07，FDEV03→T08/T09，FDEV04→T20，FDEV05→T21，FDEV06→T09/T25，FDEV07→T23/T24/T27。

### FDEV01｜DSH adapter 与集成 fixture（含上述短 spike）

依赖：后端保证一个真实 BOOP session 的最小 fixture；开发时可用已有真实 session id 参数，不允许生产 client create。

交付：`home/controller.ts` 的宿主适配边界、`home/BoopSession.tsx` 的slot declarations、双版本fixture、构建依赖外置配置。

DoD：rc.2/rc.3 编译/加载成功；自有 main 中显式 Provider + embedded factory 能首发/流式；只有一份 React；没有深导入内部 TSX/全局槽替换；产出实际运行证据，不以 mock 测试冒充集成通过。

### FDEV02｜Home controller、唯一入口与 Session 生命周期

依赖：FDEV01、后端 ensureHome DTO。

交付：index/main-session 重构，旧 openMain/create 导航退出主入口。

DoD：点击 BOOP 第一帧是自有 loading shell；重复/并发点击只认同一个 ready binding；普通 activeSession 不变；repair/unavailable 留在 BOOP；切走后晚到回包不抢页面；20 次来回/插件卸载 retain 计数回到进入前基线，无悬挂 observer。模拟 bindingVersion 迁移，任意时刻只有一个 editable instance。

### FDEV03｜BOOP 页面与精简输入

依赖：FDEV02。

交付：`home/index.tsx`、`BoopSession.tsx`、`Header.tsx`、`Welcome.tsx`、`ComposerState.tsx`、`home-styles.ts`；保留原生session occupant。

DoD：空历史无需选择业务 workspace 即可输入；首屏只有 BOOP 身份、自然欢迎、输入/发送与轻操作，无 DSH hero、model/plan/permission/tool counts；高级可展开；缺模型可恢复；真实 approval/question 始终可见可操作；中文 IME、附件、停止与重试走 native 路径；刷新/来回草稿无丢失；普通 DSH 同控件和样式保持原样。

### FDEV04｜轻工作卡与详情抽屉

依赖：FDEV03、后端 task projection/action contract。

交付：`WorkCard.tsx`、`WorkDrawer.tsx`、`ResultCard.tsx`、`TargetCandidates.tsx`，把旧大板数据投影重组为用户动作，候选仅插原生草稿。

DoD：首页至多 3 张摘要，优先待我处理/新交付/失败；每张说明在做什么、需我做什么、结果在哪里；全局最多1个委托派发/运行，未排除已执行的unknown占槽，其余显示等待，running 不锁主聊天；同一动作双击只发送一次 requestId；pending/result/error/empty 均有确定界面；详情无 cwd/gate/lease/runner 状态墙；未知状态不当作完成；候选card来自校验过的boop_catalog结果，点击不会自动提交或执行，旧卡在后续输入后失效。

### FDEV05｜工作范围、来源与结果回访

依赖：FDEV03/FDEV04、后端 source/access/result contracts。

交付：旧init dock退役、`SettingsPanel.tsx`、`HistoryList.tsx`、`Diagnostics.tsx`，沿用已有权限/排除规则并提供显式source navigation。

DoD：首次不初始化资料也能聊天；不显示学历史/导入入口；已有事实与遗忘/排除规则完整保留；继承已有可访问范围，对用户点名且已可访问的项目不重复询问许可，设置可调整BOOP范围；查看结果有有效reference，打开原会话与返回BOOP保持草稿；不存在source link打开不可见native rightbar却假报成功；用户“确认收下”不自动变成verification=passed。

### FDEV06｜断线、异常、重连与窄屏闭环

依赖：FDEV02–FDEV05。

交付：error mapper、reconnect machine、状态 copy、390px/桌面布局。

DoD：断线保留最后事实/草稿且不自动重发未知结果，BOOP自有业务按钮禁用；原生输入遵守宿主自己的反馈语义；重新连接不新建主 Session；身份冲突不降级到普通会话；长文本/任务名/中文输入、键盘弹出、drawer 多次切换无横向溢出；错误可重试或明确需要人工处理，没有只显示错误码的死端。

### FDEV07｜旧面板退役与双版产品验收

依赖：FDEV01–FDEV06。

交付：移除未使用 board/companion3d 入口，更新旧架构约束和测试、打包清单、MVP 验收记录。

DoD：两版 DSH、浅/暗、1280×800 与 390×844 至少覆盖首次空态/历史态/流式/审批/断线/恢复/禁用卸载；普通 DSH 页面视觉与功能回归通过；只有一个固定 BOOP 入口/一个逻辑身份；打包包含现用头像资源且没有被误带入第二份 DSH/React；用户验收主线从“打开 BOOP → 说出目标 → 给出委托回执 → 原会话实际执行 → 结果回到BOOP → 用户查看、确认或补充”完成，不能用 100% mock 页面当 MVP 完成。

## 10. 固定源码依据

- [BOOP 当前入口](https://github.com/wanyexin1998/dsh-plugin/blob/98991899eecea6c6af1faa158e92cb73e555a5a5/dsh-boop/src/client/index.tsx#L65-L97)
- [BOOP 当前 main 注册](https://github.com/wanyexin1998/dsh-plugin/blob/98991899eecea6c6af1faa158e92cb73e555a5a5/dsh-boop/src/client/index.tsx#L138-L205)
- [BOOP 当前 brand tokens](https://github.com/wanyexin1998/dsh-plugin/blob/98991899eecea6c6af1faa158e92cb73e555a5a5/dsh-boop/baseline/assets/boop-brand-tokens.json)
- [DSH main panel API](https://github.com/deepseek-ai/deepseek-harness/blob/687f282e8625c6b8d11ff58211a90524be2e4317/packages/client/ui-layout/README.zh.md#L32-L59)
- [DSH SessionReference 与 retain](https://github.com/deepseek-ai/deepseek-harness/blob/687f282e8625c6b8d11ff58211a90524be2e4317/packages/api/session-controller/src/client/contract/sessions.ts#L25-L66)
- [DSH injected SessionProvider](https://github.com/deepseek-ai/deepseek-harness/blob/687f282e8625c6b8d11ff58211a90524be2e4317/packages/client/ui-slots/src/index.ts#L348-L401)
- [DSH renderFactorySlot 的真实签名](https://github.com/deepseek-ai/deepseek-harness/blob/687f282e8625c6b8d11ff58211a90524be2e4317/packages/client/ui-slots/src/index.ts#L481-L499)
- [DSH factory/local slots 定义](https://github.com/deepseek-ai/deepseek-harness/blob/687f282e8625c6b8d11ff58211a90524be2e4317/packages/client/ui-conversation/src/client/contract/slots.ts#L301-L322)
- [DSH factory 内输入/hero/chain 挂载](https://github.com/deepseek-ai/deepseek-harness/blob/687f282e8625c6b8d11ff58211a90524be2e4317/packages/client/ui-conversation/src/client/skeleton/ConversationContent.tsx#L137-L203)
- [DSH 保留的草稿持久化 effect](https://github.com/deepseek-ai/deepseek-harness/blob/687f282e8625c6b8d11ff58211a90524be2e4317/packages/client/ui-conversation/src/client/skeleton/DefaultConversationViews.tsx#L13-L41)
- [DSH input 实际 DOM](https://github.com/deepseek-ai/deepseek-harness/blob/687f282e8625c6b8d11ff58211a90524be2e4317/packages/client/ui-conversation/src/client/skeleton/InputBar.tsx#L395-L525)
- [DSH 稳定 data-slot anchor](https://github.com/deepseek-ai/deepseek-harness/blob/687f282e8625c6b8d11ff58211a90524be2e4317/packages/client/ui-renderer/src/client/scoped-slots.tsx#L1088-L1097)
- [DS-Bot 全局 shell/conversation 安装](https://github.com/Fei2411/DS-Bot/blob/4a7b55069ad300eae8be42a74f31bc170b40ead7/ds-bot/src/client/index.js#L788-L860)


---

<a id="c03"></a>

# BOOP v0.2 服务端协议与数据

> 状态：**待实现的工程交付规格**。本文核对了固定版本源码，未实现本方案、未运行新版功能或集成测试，验收状态均为 NOT_RUN。不得将本文的签名、SQL、状态转换或示例作为现成能力/测试通过的证明。产品行为以《01_产品与交互.md》为准；统一工程任务编号由总交付清单维护。
>
> 原仓库、包名和数据目录保持 `wanyexin1998/dsh-plugin/dsh-boop`、`dsh-boop`、`$DSH_HOME/boop/boop.sqlite`。BOOP 源码基线为 `98991899eecea6c6af1faa158e92cb73e555a5a5`；本章实际核对的官方 DSH Host 基线为 `687f282e8625c6b8d11ff58211a90524be2e4317`（rc.2）。完整固定链接见文末来源表。rc.3 不在本章冒充已完成兼容验证。

## 1. 决策和运行边界

1. 一个逻辑 BOOP 主身份；物理主 Session 仅在明确迁移时变更。Host 建立真实 Session、`boop` preset 和 BOOP 专属 cwd，客户端只 retain，不自行 create。
2. 沿用现有 task/action/command_outbox/记忆/遗忘规则；增加的表是身份、请求、观察、结果与投递附属记录。不得另建 DS-Bot roster/task 主库。
3. 一次委托指向一个已有普通 DSH Session；不得把 BOOP 主 Session、子代理所有权 Session、未知或已归档 Session 当目标。目标不属于注册工作区时仍可使用其真实 cwd；不得为适配账本编造 workspaceId。
4. **同一 BOOP 数据域全局最多一个受托动作处于派发、已接收、运行或尚未排除执行的未知状态。** 主聊天、读取、结果回报不占该执行槽。排队按 `(created_at,id)` 选择最早的“当前可执行”动作，忙目标不占槽，其后的空闲目标可以先处理。已取得槽的动作不被后来任务抢占。
5. Busy 时只留在 BOOP outbox，不预先放进目标原生 inbox、不 steer。准备真正派发时再读用户指令水位；用户直接操作优先。
6. 产品只有“停止任务”“继续处理”。内部 lifecycle 可沿用 paused/recovery_required，模型内部可有 resume/revise；这些不是新的用户菜单。停止当前 BOOP 回复与停止受托任务分离。
7. 原生工具审批仍在原 Session。BOOP 仅汇报“需要你在原会话确认”，不接管审批 answerer、不创建第二审批中心、不自动 approve。
8. 重启可自动读取、观察和对账，**默认不自动继续旧业务动作**。无法证明投递/执行情况时保留 unknown，不用重发来猜结果。
9. “已交付”“你已确认”“验证通过”分别记录。人类接受不产生测试通过证据。

## 2. 服务划分与真实可用宿主接口

### 2.1 现有 BOOP 代码的复用边界

| 模块 | 保留 | 本轮必须改变 |
|---|---|---|
| `host/main-session.ts` | 主绑定事实与 source coverage 读取 | 当前 `mainSessionFacts` 只绑定字符串，新增真实 `ensureHome`。[c03-SV-B01] |
| `workspace-api.ts` / `workspace.ts` | `boopWorkspaceRules.listWorkspaces/listSessions/resolveTarget`、真实 registry 与 SessionQuery 目录 | 新工具复用这些真实目录；对新产品 read projection 做权限过滤。不要调用旧同步 `DshAdapter.listSessions`。[c03-SV-B02] |
| `tools.ts` | `boop_catalog`、`boop_context`、只读 `boop_verify` 名称 | 扩展前两者；仅新增 `boop_dispatch`、`boop_task_control`；`boop_workspace_change` 等旧管理工具不进入本轮主 preset 的默认能力。[c03-SV-B03] |
| `dispatch/dispatcher.ts` | stable messageId、payloadHash、未知结果保守对账 | 生产入口、精确 action claim、全局单槽、发送前复核、真实 flush 和 accepted 证据。[c03-SV-B04] |
| `transport/dsh-adapter.ts` | 原生 Agent followup 和 messageId 证据读法 | 单 Session flush 改正确入口；取消旧 `cancelOwned` 的 pending→cancel整turn 推断；授权不可默认全放行。[c03-SV-B05] |
| `persistence/*` | 同一 SQLite、task revision、来源/遗忘、审计 | 修 bootstrap/version/fence；增加 schema 2 附属记录。`task.version` 只表示意图修订。[c03-SV-B06][c03-SV-B07] |
| `observe/*` | sourceGeneration、只读来源解析、记忆观察 | 新增 action 观察游标，不能复用记忆 `source_cursor` 作为执行游标。[c03-SV-B08] |
| `tasks-api` / `control-api` / `verify` | 原 read API 与必要旧保护 | 新增 v2 产品投影、确定性 stop/continue/confirm；旧 API 保持兼容但不能绕过新控制器。[c03-SV-B09] |

### 2.2 已从官方源码核实的 Host 调用

以下是现存官方接口；后文 BOOP façade 是待实现接口，两者不要混淆。

```ts
// 创建：workspaceId 与 cwd 互斥。返回 ID 可能不同于请求 ID。
ctx.sessionController.create({ sessionId?, workspaceId?, cwd?, agentPreset? })
  // Promise<{ sessionId, agentPreset? }>

// 找回已存在的普通 Session；不靠 create 重新打开。
ctx.sessionController.resolveAgent(sessionId) // Promise<{agent} | {error}>

// 只读观察；必须 finally dispose，或使用 using。
ctx.sessionQuery.observeSession(sessionId, { signal, projectionMode: 'all' })
ctx.sessionQuery.listSessions(signal?)
ctx.sessionQuery.listEvents(sessionId)
ctx.sessionQuery.readEvent({ sessionId, seq, before?, after? }, signal?)

// 当前 preset、精确持久化 checkpoint。
ctx.sessionProjections.stateOf(agent.session, 'agentPreset')
ctx.sessions.flush(agent.session) // Promise<boolean>：false = 没有持久 listener

agent.followup(hostOwnedUserRoleMessage) // 非人类来源；只用队列模式
agent.inbox.remove(messageId)            // boolean；精确删除并记 splice
agent.cancel({ kind: 'user' }, { keepInbox: true }) // 请求，不是已停止证明
```

依据 [c03-SV-H01]–[c03-SV-H07]。`create` 对已经 started 的命名 Session 会创建另一个随机 ID，不能拿它当通用 get-or-create。[c03-SV-H02] `sessionPersistence.flush()` 是全服务写 handle barrier，不是 `flush(session)`；`whenIdle()` 不能替代持久 checkpoint。[c03-SV-H04]

模型工具的正式执行签名是 `execute(args, exec: ToolRunContext)`，`exec.agent`、`exec.callId/rootCallId`、`exec.signal` 来自工具运行时；BOOP 必须用这些字段取得调用身份，而不是让模型传 owner/scope/origin。[c03-SV-H08]

候选引用使用公开 `@deepseek-ai/dsh-session-reference` 根导出的 `formatSessionReferenceMention({sessionId,label})`。该名称、参数和 root export 已核实；不手写 mention grammar，不导入不存在的 `/grammar`。[c03-SV-H09]

### 2.3 正式装配

新增一个轻量 `BoopDelegationService`，通过既有 `host/index.ts` 装配，内部协调 repository、dispatcher、native adapter、action observer、result publisher。可以按项目风格拆文件，但只能有一个控制器写任务/动作，不新增平行调度主库。

具体落点与《04_开发任务清单》的 T01–T29 一致：

| 责任 | 唯一计划落点 | 工单 |
|---|---|---|
| Home/task DTO | `src/shared/home-contract.ts`、`src/shared/task-contract.ts` | T05 |
| 主身份与宿主创建适配 | `src/host/home/service.ts`、`src/host/home/native-session.ts` | T06 |
| 主输入引用保护 | `src/host/home/reference-guard.ts`，在 ready.send 前安装/核验 | T06；T10扩展动态策略，T13验边界 |
| 目录/上下文与来源限制 | `src/host/delegation/context.ts`，复用既有 workspace/read 模块 | T10 |
| 工具 schema/可信调用适配 | `src/host/delegation/tool-contract.ts`，注册仍在 `tools.ts` | T11 |
| 单控制器与队列 | `src/host/delegation/service.ts`、`src/host/delegation/controller.ts` | T12 |
| 原生传输/准入 | 修改既有 `transport/*`、`gate/*` | T13 |
| 动作观察/结果快照 | `src/host/observe/action-observer.ts`、`src/host/delegation/result-builder.ts` | T14 |
| 回主会话 | `src/host/delegation/result-publisher.ts` | T15 |
| 精确停止/新意图控制 | `src/host/delegation/task-control.ts` | T16 |
| 人类确认/修订写入 | `src/host/delegation/confirmation.ts` | T17 |
| 恢复 | `src/host/delegation/recovery.ts` | T18 |
| 用户投影 | `src/host/delegation/projection.ts` | T19 |

它不受旧 PoC 按钮是否点击影响。旧 PoC dispatch 入口默认关闭；兼容调用若保留也必须经同一 production service 和全局槽，不能直接 enqueue。旧巡检/记忆任务不得借 scheduler 绕过新委托限流；本轮不新建全库学习任务。

原生工具插件仍保留 DSH 的权限链。BOOP preset 只暴露本章工具和原生聊天所需能力；target Session 的 preset、默认模型与工具配置不被改写。模型缺失只返回 capability/reason，并引导用户打开 DSH 设置，不假设专门的 settings 导航 API。

## 3. 主身份、目录与上下文

### 3.1 `boop/ensureHome` 算法

1. 在本进程 mutex 和当前数据域 writer fence 下读取 `scopes.main_session_id`、`home_binding_history`、`home_provisioning`；并发请求共享同一进行中 promise。Host 服务先装配主 scope 的来源/授权 hooks 和 `agent/created` 初始化监听，再允许任何主 Session create/resume。
2. 已绑定时用 `observeSession` 读取真实 header/projection，核验 Session 存在、非子代理、BOOP preset、规范化 cwd 和原绑定。正确既有 Session 用 `resolveAgent` 找回，不调用 create。
3. 新身份使用 BOOP 专属目录，例如规范化后的 `$DSH_HOME/boop/home`。本轮默认只给主 Session 显式 cwd，不新增用户业务 workspace registration、不改变普通默认工作区。cwd 是内部实现数据，不放进 Home DTO。
4. 先事务写 provisioning：唯一 provisionKey、requestedSessionId、expectedBindingVersion、旧 ID、stage=prepared。然后调用 `sessionController.create({sessionId: requestedSessionId,cwd: internalCwd,agentPreset:'boop'})`。
5. 原生返回后记录实际 ID，重新读取 preset/cwd/header、主 scope reference guard 已安装，`await ctx.sessions.flush(agent.session)` 且结果必须 true，再事务 CAS 绑定并写 history；只有此后返回 ready。
6. create 返回意外 ID、preset 未挂载、原生错误、失租或 attach/flush 中断时，保存 journal 并返回 repair_required/unavailable。重试先核对 requested/returned ID；不反复 create。
7. 已 started 的旧 `boop-main` 配置错误：保留旧历史，受控迁移最多创建一个替代物理 Session。旧 Session 正在工作则先返回 repair_required，不强停。迁移后旧权限/旧审批不能继承；近期上下文只是有来源的非授权交接材料。

原生 Session 与 SQLite 不是一个事务。若 create 结束而 journal 没来得及记录返回 ID，恢复必须先检查持久 requested ID：存在且正确则找回；存在但冲突则 repair；证据不充分则 repair。不得通过扫描相似标题猜主身份，也不得为消除错误再造一条。由 journal 阻止无限创建，不宣称跨存储 exactly-once。

客户端只对 ready 的 `mainSessionId` retain。Home 的 `capabilities.send=false` 可以与 state=ready 同时存在，例如模型未配置；这不是身份创建失败。source 访问未获授权只使 readSources/delegate 不可用，不阻止普通聊天。

### 3.2 目录、候选卡与来源范围

- `boop_catalog(mode='work')` 复用 workspace read façade，先按 BOOP `source_access` 和遗忘/排除规则过滤，再检索/排序/取最多 5 个候选；目录读取不唤醒全部 Agent。
- 每项候选使用真实 Session ID、可空 workspaceId、投影标题、近期活动和至多 160 字的已授权最近内容预览；未取得正文则 preview=null，不编造“最近内容”。
- Host 用公开 formatter 生成 mention。`selectionKey` 只是 UI 关联摘要，不是授权 token。候选外层绑定发起的直接人类 messageId 以及真实 tool/call 的 seq。
- 选择卡只从 `boop_catalog` 的真实 tool/result 完整 JSON 得到；点击填入原生草稿并保留已有文字，不自动发送或派发。新直接用户消息、选择已发送后卡片失效。前端无法可靠区分来源时，可在任何后续 user 节点出现时保守失效。
- 不增加 pending_interaction/candidateSet 数据库。用户发出选择后，`boop_context` 和 dispatch 仍按真实 ID、授权和当前上下文重新验证。
- `source_access` 是 BOOP 的额外限制层，不是重新授予 DSH 权限。新 profile 未配置此层时，继承当前真实 Host owner 已有的可访问范围，写 `mode=all_authorized`；其含义始终是“仅 Host 已授权且未被排除”，不是所有数据无条件开放。普通聊天和明确委托已可访问目标无需先完成通用授权卡。
- 初始化用 `principalOf(ctx.invocation)` 取得真实 Remote principal，结合当前数据域 owner 与宿主访问规则；记录真实的 `granted_by=host-inherited:<owner>`、grant_ref=宿主配置/调用来源。不能伪造“用户点击同意”；也不能把 `remoteAccess.allows()` 在非 Remote context 的默认 true 当成 owner 证明。[c03-SV-H12]
- 旧明确 `none`、`selected`、forget/exclude 原样保留。缺省与用户明确 none 必须区分。继承的 Host 范围不能证明时，readSources/delegate=false 并引导既有访问入口，send 不受影响。明确点名当前已有可访问目标，不重复要求一般授权；实际被排除或权限不足仍拒绝。
- 用户通过来源范围设置直接收窄/扩大 BOOP 限制层时，Remote 更新 `source_access` 并提升 `scopes.policy_epoch`；新范围仍必须是当前 Host 真实权限的子集。模型工具不能更新此表或用一次 target 参数提升全局范围。

原生 Session mention 也必须经过相同限制。官方 `session-reference` 的 listener 使用 `{prepend:true}`，在 `await next()` 返回后解析直接用户 mention 并 `readSurface`。[c03-SV-H13] 官方 vendored Cordis 明确将 prepend listener unshift、普通 listener push，scope过滤不改变顺序，waterfall 按数组顺序进入并按返回链退出。[c03-SV-H14] 因而插件可以在 BOOP 主 Agent 的 `agent.ctx` 注册普通（非prepend）下游 guard，先处理下游返回的消息，再让外层原生 resolver 解析；无需改 DSH core、替换全局 listener 或假设未公开 priority。

```ts
// 待实现的 BOOP scoped hook；只挂在真实 BOOP 主 Agent 的上下文。
agent.ctx.on('agent/pre-step', async ({ agent, signal }, next) => {
  const decision = await next();
  if (decision.kind === 'reject') return decision;
  return { ...decision,
    messages: await gateHomeReferences(decision.messages, agent, signal) };
}, { prepend: false });
```

`gateHomeReferences` 只检查 `source.kind='user'` 的 text block，用公开 `parseSessionReferenceText` 得到精确引用，按当前 Host权限∩BOOP范围∩forget/exclude 验证。parser 同时支持 `@[label](dsh-session:...)` 和裸 `dsh-session:...`；不得只匹配菜单生成的格式。[c03-SV-H16] 全允许时消息原样返回。出现被排除引用时，保留原 messageId、source、可读正文和消息顺序；对该段采用 parser 返回的 `text`（canonical 引用已变成可读label），再用公开 formatter 把允许引用按原出现顺序附回该段，排除引用不附回。不要假设 parser 返回 span，不能删整条用户消息。另以 BOOP 非人类来源附上范围说明。模型工具仍做最终权限检查，不能因标签消失就换目标。

T03/T10/T13 的实际集成证据须验证：被排除或手贴的原生 mention 对目标 `readSurface` 调用为零；同批正常人类正文与允许引用保持；普通 DSH Session 不受影响。该顺序有固定官方源码依据，运行验证仍是 NOT_RUN；对未满足同一契约的宿主版本不声明兼容。客户端继续使用 02 的原生 reference chip，不增加第二种引用协议或新权限中心。

guard 必须在主会话新输入和旧 pending 输入被驱动之前安装。它属于 **T06 的 `src/host/home/reference-guard.ts`**，使用 T05 的来源限制记录与 Host 已有访问事实，不让 M1 主聊天等待后续 T10；T10 扩展动态策略/目录，T13 运行完整边界验收。正式生命周期钩子为 `ctx.on('agent/created', async ({agent,source,signal}) => …)`；官方承诺该 serial 初始化完成前 queued work 不被释放。[c03-SV-H15] 按已绑定/正在provisioning的主ID或已核实boop preset识别主scope，再在 `agent.ctx` 装hook。已经存活的旧主Agent先同步补hook并核对状态，无法证明安全接入则 repair_required，不接收新的BOOP输入。guard模块安装失败时 ready.send 不得为 true，不能仅隐藏候选卡后继续发送；来源事实暂不可读但guard已正常安装时，可把所有原生引用降为可读标签与说明，保留普通无引用聊天，readSources/delegate=false。不得 fail-open 让原生resolver先读排除来源。

### 3.3 `boop_context` 与 contextToken

选中目标后，先读取真实元信息、当前状态、最近直接用户消息与必要事件，再附有效记忆。默认最多给模型 80 条语义事件/24,000 字符；返回 truncated/nextBeforeSeq，允许按引用补读。这个上限是**返回模型的上下文预算**。官方 rc.2 `readEvent` 的输出有界，但其内部会 `_corpus.load` 单个 Session；本文不声称底层磁盘读取也是严格分页。不得扩大为读取所有 Session 的全部历史。[c03-SV-H05]

contextToken 是 `context_snapshot.id`，Host 生成的不可猜 ID，绑定 scope、调用主 Session、originUserMessageId、精确目标、sourceGeneration、headSeq、latestDirectUserSeq、policyEpoch 和 contextHash。有效期默认 5 分钟，创建委托时过期则要求再读；一旦准备入队，后续等待使用已存快照并在派发前主动刷新，不因等待超过 5 分钟丢失任务。

busy 等待期间仅有目标模型输出：刷新 head 与运行事实，保持同一明确目标和限制。最新直接用户指令水位改变：旧动作不能自动派发，转 needs_attention，请用户继续处理时重新读上下文。sourceGeneration 改变/重建、归档、授权撤销也拒绝旧动作。仅看到 Session idle 不代表曾完整读到最近用户要求。

## 4. 模型工具协议

### 4.1 唯一名单及权限

| 工具 | 角色 | 变更范围 |
|---|---|---|
| `boop_catalog` | 真实工作目录、任务状态、能力 | 只读 |
| `boop_context` | 精确目标近期上下文/有效记忆 | 只读；签发 contextToken |
| `boop_dispatch` | 用户明确委托后准备一个新任务和一个动作 | 只向一个既有 Session 计划派发 |
| `boop_task_control` | 精确 task 的 stop/resume/revise | 停止，或按当前用户意图产生新修订/新动作 |
| `boop_verify` | 已有证据的只读解释 | 不能写 passed/waived/accept |

内部 `resume` 对应产品“继续处理”；不提供模型 accept、confirm、approve、release-old-gate、cleanRestart 或 SQL。创建业务工作区、切换目标 preset、自动合并/部署都不属于工具能力。

### 4.2 可直接实现的参数定义

下列使用官方 `defineTool` 参数 DSL：必填是在属性上 `required:true`，不能写 `required:false`；额外长度/组合约束由服务端 validator 执行，不向 DSL 塞不支持的关键字。[c03-SV-B03][c03-SV-H08]

```ts
export const parameters = {
  boop_catalog: {
    mode: { type: 'string', enum: ['work', 'tasks', 'capabilities'] },
    query: { type: 'string' },
    workspaceId: { type: 'string' },
    taskId: { type: 'string' },
    limit: { type: 'integer' },
  },
  boop_context: {
    targetSessionId: { type: 'string' },
    taskId: { type: 'string' },
    question: { type: 'string' },
    beforeSeq: { type: 'integer' },
    limit: { type: 'integer' },
  },
  boop_dispatch: {
    requestId: { type: 'string', required: true },
    targetSessionId: { type: 'string', required: true },
    contextToken: { type: 'string', required: true },
    goal: { type: 'string', required: true },
    instruction: { type: 'string', required: true },
    criteria: { type: 'array', items: { type: 'string' } },
    exclusions: { type: 'array', items: { type: 'string' } },
  },
  boop_task_control: {
    requestId: { type: 'string', required: true },
    taskId: { type: 'string', required: true },
    expectedTaskVersion: { type: 'integer', required: true },
    operation: { type: 'string', required: true, enum: ['stop', 'resume', 'revise'] },
    contextToken: { type: 'string' },
    instruction: { type: 'string' },
    goal: { type: 'string' },
    criteria: { type: 'array', items: { type: 'string' } },
    exclusions: { type: 'array', items: { type: 'string' } },
  },
} as const;
```

validator：拒绝未声明参数；requestId 1–128 字符，goal 1–240 字符，instruction 1–16,000 字符，每个条件/限制 1–1,000 字符、数组各至多 20；limit/work 1–5，context 1–80，taskVersion 正整数；空白字符串不算有效。context 至少有 targetSessionId/taskId/question 之一。stop 不接受 instruction/contextToken 等新执行内容；resume/revise 必须有 fresh contextToken 和非空 instruction。新目标只能先明确选择；继续原任务不能偷偷换目标。

`execute(args,exec)` 用 `exec.agent` 核对真实 BOOP 主绑定和 preset，用原生 tool/call/turn 记录定位本次直接人类输入。普通询问是否属于行动由主 Agent 在当前用户指令中判断；Host 能校验真实来源、版本和范围，不能把任意模型自报“用户已经同意”当作机器证明。结果回执、外部 Session 内容和记忆均不能提供新的派发授权。通过案例必须覆盖“聊想法不建任务”。

取消 `exec.signal` 在准备事务之前中止调用；事务已提交后，该任务是持久的受托工作，停止主回复不撤销它。工具迅速返回 queued，不 await 目标完成。UI/工具重试从 request receipt 找回结果。

### 4.3 唯一输出封装

所有本轮工具使用附录 A 的 `Reply<K,T>`。特别是 catalog：

```ts
output: {
  schema: { type: 'object', additionalProperties: true },
  render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }],
}
```

canonical value 在 execute 返回前按附录 A 严格校验，output renderer 输出**一个完整 JSON text block**。不同时在 meta、assistant 文案或另一事件中再发一份选择协议。前端只解析成功的 `boop_catalog` ToolResultNode、完整单块 JSON、`schemaVersion=2`、`kind='boop.catalog'`、`data.mode='work'` 和最多 5 项候选；截断、spill、缺 call 关联或 schema 不符时不造选择卡，仍保留原生消息。不是任何 assistant JSON 都可触发控件。

## 5. 正式 Remote 与服务 façade

所有 Remote 接受单个结构化对象。`listV2/detailV2` 避免破坏已有 list/detail 返回结构；旧方法保留，但与 v2 共用 repository。来源授权、confirm、continue、stop Remote 挂在 DSH 原生访问控制下，只允许当前 owner 的直接 UI 操作；不能注册为模型可调用的任意 Remote 转发工具。

```ts
// 待实现 BOOP Remote 类型；参数/结果的唯一类型源见附录 A。
interface BoopHomeRemote {
  ensureHome(request: { requestId?: string }): Promise<Reply<'boop.home', HomeView>>;
}
interface BoopTasksRemote {
  listV2(request: { cursor?: string; limit?: number }): Promise<Reply<'boop.tasks', TaskPage>>;
  detailV2(request: { taskId: Id }): Promise<Reply<'boop.task', TaskView>>;
  stop(request: StopArgs): Promise<Reply<'boop.control', ControlReceipt>>;
  confirm(request: ConfirmArgs): Promise<Reply<'boop.confirm', AcceptanceReceipt>>;
  reconcile(request: { taskId: Id }): Promise<Reply<'boop.task', TaskView>>;
}
interface BoopTasksInternalCompatibility {
  // 可选内部兼容；不由本轮前端“继续处理”按钮调用。
  continue(request: ContinueArgs): Promise<Reply<'boop.control', ControlReceipt>>;
}
interface BoopSourcesRemote {
  access(request: Record<string, never>): Promise<Reply<'boop.access', AccessView>>;
  setAccess(request: AccessUpdateArgs): Promise<Reply<'boop.access', AccessView>>;
}
```

`reconcile` 只读原生事实并落观察结论，不发新的业务指令。continue 按人类新意图建立同任务新 revision/action，不把旧 message 重发。MVP 的“继续处理”按钮只把准确 task 引用填到主聊天原生草稿，让用户补充并发送，再由 `boop_context` 与模型 `boop_task_control(resume/revise)` 处理；前端不凭旧 instruction 调 continue，不另建确定性 continue 表单。`boopTasks.continue` 仅是同一 service 的可选内部兼容入口，不列入本轮必需前端 API，不通过按钮自动消费工具 contextToken。

```ts
// 内部 façade：TrustedCall 只能从 ToolRunContext/Remote principal 构造。
interface BoopDelegationService {
  prepareNew(args: DispatchArgs, trusted: TrustedCall): Promise<DispatchReceipt>;
  continueTask(args: ContinueArgs, trusted: TrustedCall): Promise<ControlReceipt>;
  stopTask(args: StopArgs, trusted: TrustedCall): Promise<ControlReceipt>;
  acceptResult(args: ConfirmArgs, trustedHuman: TrustedHumanCall): Promise<AcceptanceReceipt>;
  tick(): Promise<void>;              // 同时最多一个进行中的 tick
  reconcile(taskId?: string): Promise<void>;
}
```

不得把 `TrustedCall` JSON 交给模型。它含 owner/scope、main bindingVersion、origin human message或UI operation、native call/turn、policyEpoch、当前进程 holder/fence，以及 signal。纯 read/status 回调可以没有人类 origin；任何新业务准备没有合法 origin 则拒绝。

## 6. 委托、观察、停止和结果的因果状态

### 6.1 准备与真正派发

**准备事务**：校验 request receipt → 真实当前主身份/授权/context → 创建 task v1、唯一 executor-v2 target、action(planned)、action_runtime、command_outbox(prepared) → 保存 receipt。`message_id=action.id` 在准备时写入；不能到重试时再生成。

**调度选择**：无全局槽与 legacy barrier 时，对 prepared 队列按 `(created_at,id)` 逐项检查。目标 busy/维护中/有 pending 人类输入则只标 waiting_target；其它目标可被选中。source unavailable 不是 idle。每次新 native 状态或 relevant input 唤醒一次 tick；允许低频补扫，不能让主 Agent 轮询。

**发送前事务**：重新检查 task.plan version、stop、policyEpoch、target generation、最新直接用户水位；精确 CAS `claimActionOutbox`，获取全局 slot，action→dispatching。不能使用当前 `claimOutbox(...).find(...)`，它会先 claim 整队列。[c03-SV-B04][c03-SV-B07]

**外部调用**：事务结束后 resolve 精确 Agent，复核当前状态，构造 stable ID + `source.kind='boop-command'`，只 followup。原生消息来源用 BOOP 的 `MessageSourceMap` 扩展及 host-minted ID 双重核验；官方 source 类型可扩展，`createUserMessage` 会生成新 ID，不能用于覆盖 stable ID。[c03-SV-H10]

**接收判定**：原生 followup 返回不等于已持久接收。必须 `ctx.sessions.flush(session)===true`，并按精确 messageId/source/actionId 读取 pending splice 或 user/message 证据，才 action→accepted/outbox→accepted。传输调用已发生但 flush 失败/返回 false/回执不可证实：action→outcome_unknown/outbox→unknown，仍占槽。若有明确的调用前失败、确认未 enqueue，回 planned 或 rejected 并释放槽。

`db.write(fn)` 内只做同步 SQL，不能传 async fn 再 await native 操作；现实现会在 promise 完成前 COMMIT。[c03-SV-B06]

### 6.2 Admission 与人类优先

检查 idle 与 enqueue 不能跨存储原子化，最终 pre-step 还要检查该动作状态/版本/来源/用户水位。现 BOOP gate 的整批 reject 会消耗 claimed 用户消息，必须替换。[c03-SV-B10]

官方 rc.2 会先 claim，再 await pre-step waterfall，最终 decision 才控制 step/start 和真实 user/message。实现：获得 downstream decision；若 reject 则尊重它；若 enter 则只去掉不允许的 BOOP 精确 messageId，保留直接人类消息及下游合法替换的顺序。过滤后只有 runtime-context 时返回空 messages/纯 BOOP reject，不启动空模型调用。混批不等待旧 gate 的 120 秒释放倒计时。[c03-SV-H06]

允许进入的 action 先写持久 admission receipt（target generation+turnId+messageId），再返回最终 decision。receipt 与 native step 之间 crash 时不自动重新 admission；保留 unknown 等对账。一个 receipt 证明“允许进入”，不证明模型已经执行或完成。后续步骤复用同一动作观察，不把同 turn 的正常后续 step 当重复业务派发。

### 6.3 唯一转换表

| 原状态/证据 | 允许变更 | 执行槽 | 用户投影 |
|---|---|---|---|
| 新 action + outbox prepared | planned | 不占 | queued |
| 目标 busy，动作尚未投递 | planned + queueReason=target_busy | 不占 | waiting_target |
| 全局槽被其它动作占用 | planned + queueReason=global_slot | 不占 | queued |
| 已取槽、准备调用原生 | dispatching / sending | 占 | dispatching |
| 精确持久接收证据 | accepted / accepted | 占 | accepted |
| 精确消息进入对应 turn/step | running | 占 | running |
| 本动作 turn 的 `approval/asked` 未配到 decided | running + nativeApprovalPending | 占 | awaiting_native_approval |
| 原生对应 turn terminal + 结果保存 | settled + task_result | 释放 | delivered 或 received_reply |
| 调用可能已发生，结果不可证实 | outcome_unknown / unknown | 未排除执行则占 | needs_attention |
| 未投递 stop，或精确队列删除已持久确认 | stopped / cancelled | 释放 | stopped |
| 对 BOOP 独占 turn 请求 cancel，未见 terminal | 原 action 状态 + stop_requested | 占 | stopping |
| 对应 turn terminal 确认停止 | stopped | 释放 | stopped |
| 用户接管/混合所有权 | 记 user_takeover，禁止未来 BOOP 自动介入 | 仍可能属于该执行则持槽，核对后释放 | needs_attention |

原生审批通过/拒绝只由原审批 UI 处理。observer 依据 `approval/asked` / `approval/decided` 的 id/callId 和本动作 turn 关联显示状态；无匹配事实时不得仅因耗时长猜“等待授权”。官方事件与审批实现已核实。[c03-SV-H11]

### 6.4 停止任务

stop 是不依赖模型的 deterministic service，先持久保存 stop intent 并阻止后续派发，然后处理精确动作：

1. 未派发：cancel 本任务当前/尚未执行的 v2 outbox，不影响其它任务。
2. 原生 pending：只 `inbox.remove(messageId)`，随后 flush/读取精确删除证据；false 表示已不在队列，必须重新判定，不等于已停止。
3. running：只有真实当前 turnId 仍对应本 action，且没有新的直接用户消息/混合 ownership 时，调用 cancel(keepInbox:true)。再观察该 turn terminal。
4. 用户已接管或证据不足：禁止后续 BOOP 工作，但不 cancel 无法归属的当前 turn；返回 disposition=stopped_future_only、productState=needs_attention。界面不能显示整件任务“已停止”。

stop 与 native enqueue/claim 并发时，controller、pre-step 和 observer 都读持久 stop intent；不能只靠 UI 取消 AbortController。正在 stop 的旧动作若以正常 completed terminal 结束，应记录实际结果和“停止前已结束”，不能把真实 completed 改写成用户取消。已发生文件修改不被停止自动回滚。

### 6.5 继续处理与修订

继续必须有本次用户指令、准确 task/version、最新 context；原 task ID 保留，计划 version+1，写完整 revision 快照，新 action 新 messageId。旧 result/evidence/acceptance 不迁到新版本。只改运行状态增加 state_seq，不增加 plan version。

旧动作仍在执行时，revise 可原子记录新 revision/planned action，并请求停止旧动作；新动作 queueReason=previous_action，不得抢槽。旧动作结果仍归旧版本，不能使新版本完成。未知旧动作未排除执行时 continue 返回 OUTCOME_UNKNOWN；不能通过新的 requestId 绕过。

### 6.6 action 观察与结果

链路为 `actionId=messageId → durable splice/user message → native turnId → 对应 terminal → result`。runtime `agent/inbox/claimed` 是低延时线索，不能独立作为持久成功收据。不能把目标 Session 的任意一个 turn/end 或 idle 当成本 action 完成。[c03-SV-B05][c03-SV-H06]

action_runtime 单独存 observedThroughSeq/claimSeq/terminalSeq/ownership。记忆 source_cursor 不改变动作结论。重复事件按 seq/id 去重，旧 sourceGeneration 事件不能推进新 generation。遗留已完成/已停止动作仍可补齐结果证据，但不能再派发。

每个结果快照保存：做了什么、产物/原会话引用、真实执行过的检查、缺失项、terminal reason、证据引用和对应 taskVersion。对原 Agent 的“done/tests pass”等自然语言，authority 只能是 agent_reported；没有可定位工具结果就不能得到 passed。

只读 `boop_verify` 可解释证据；写 verification 的 system 路径只接受 host observer 从实际 tool/call+tool/result、同 action turn、同 taskVersion 组装的检查记录。未识别的工具结果结构、无退出/检查结论、产物版本不明均为 unknown/pending，不能按包含字符串 PASS 判定。MVP 不要求泛化自动验收 Agent；可提供真实检查日志并等待用户接受。

### 6.7 结果投递回主会话

同一事务先写 `task_result`，再 `result_outbox`。logicalKey 为 `actionId:eventSeq:kind`，nativeMessageId 一次产生并持久保存。source.kind=`boop-result`，附 resultId/actionId；不会赋予主 Agent 新的派发授权。

主 Session 忙时结果留在 BOOP result_outbox，前端已能从 detailV2 展示卡片。空闲后 followup；不得 steer 用户正在进行的普通聊天。已观察到相同 durable messageId/pending 时不再发送。

发送后落收据前 crash：按稳定 ID 读取原主会话证据；已经送达就补 receipt，完整证明未投递才允许同 ID 重试，不完整则 unknown。主绑定迁移时，未投递且已证实旧端没有此消息可改投新 binding；已投递不重复播报，未知旧端不猜，结果卡仍可查看。自然回报是否送达与结果本身是否存在独立存储。

blocked/progress 通知仅在有新的可定位事实时生成一个逻辑结果键；无变化不发消息。重复 native approval/状态刷新不能产生多条相同提醒。主自然语言摘要可以由收到的 `boop-result` 生成，但它不改变结果的证据字段。

### 6.8 人类验收幂等

`confirm(decision='accept')` 只允许 authenticated owner UI；模型工具无此操作。要求 result 属于 exact task/current taskVersion，kind=final，具有可关联结果/明确结论；纯“完成了”且无可定位结果的 received_reply 不能自动变成可验收交付。

事务顺序：先查 request_receipt；相同 key+hash 返回原 acceptance；同 key不同 hash 拒绝 REQUEST_ID_CONFLICT。然后核验版本/result，再 INSERT task_acceptance（每 task/version 最多一条）；其它 requestId 对同一 result 重复确认返回同一 acceptance，对同版本另一 result 返回 ACCEPTANCE_CONFLICT。最后 task.lifecycle=completed；已有真实 passed 保留，否则 task.verification=waived，并明确 reason=human_acceptance。**结果快照里的 failed/unknown 检查不被改写成 passed**，DTO confirmation 与 verification 分开。

用户接受旧版本后又修订，旧 receipt 重放只能返回“曾接受版本 N”，不能把当前版本变完成。返回 acceptance 的 appliedTaskVersion，前端再刷新当前 task 投影。accept 与 revise 并发用 task.version CAS，一个事务先成功，另一个必须看到冲突。

## 7. 重启、未知结果与全局单槽

启动顺序：只读识别版本 → 迁移/获取本进程 fence → 恢复主绑定/provenance/admission → 将 sending 标记 unknown → 原生只读对账 → 启动新请求控制器。旧队列默认 task.recovery_required；不按 clean_shutdown=1 自动续跑。clean marker 是 Host 事实，不能由模型/Remote 参数覆盖。

| 发现 | 处理 |
|---|---|
| 精确消息仍在 durable pending | 恢复 accepted；不重发。为符合“不自动续旧动作”，在 Agent 驱动前撤销 BOOP admission；可删除精确 pending 并 flush，等待用户继续处理 |
| 对应消息已进入 turn，但无 terminal | 继续观察/核对，保留 running/unknown 和槽；不能另发第二条 |
| 精确 terminal 可证明结束 | 固化对应结果，释放槽；报告实际 outcome |
| 从未 enqueue 的准备记录 | 保留待恢复，用户继续时生成新 revision/action，不直接 replay旧消息 |
| 截断、源不可读、inbox不可观测、unclean且无足够证据 | 保留 unknown；“没读到”不等于“没执行” |
| 证明不存在任何相关 pending/current execution，但历史结果仍不明 | 可以释放并发槽；该任务仍 recovery_required，结果仍 unknown，不能假称未执行或完成 |

execution_slot 不是“过了 30 秒就可清空”的租约。`command_outbox.lease_until` 仅供定位当前发送者，**不能**作为未执行证明；execution_slot 本身没有 lease_until。失去 writer fence 的旧进程不得继续 native enqueue、cancel 或 SQL mutation。继任者按持久记录与原生事实核对，不借用数据库现任 token 假装仍持有租约。

迁移遇到多个旧 BOOP 在途动作时不挑一个假装唯一，设置 scope 全局 `recovery_barrier`，逐一核对；主聊天和 read/stop 仍可用，新委托只排队。只有所有可能并发的旧执行都排除/结束，才解除 barrier。旧自动化、PoC、scheduler 不能继续从旁路发送。

## 8. Schema 2：字段、表、约束

### 8.1 版本和不可变性

`meta.schema_version=2` 是唯一数据库迁移版本真相，`scopes.schema_version` 同步更新作为域投影。现有 task、fact、fact_version、forget_rule、approval、channel_* 数据全部保留。task.version 语义改为计划版本；新 `state_seq` 表示运行投影变化。旧 `updateTask` 必须拆为 revisePlan 和 transitionState，防每次状态变化使 action/证据过期。[c03-SV-B07]

下列是待实现的 v1→v2 SQL 结构；迁移代码应按第 9 节原子运行。交付前已将此 SQL 草案在内存 SQLite 3.53.1 中做语法、外键完整性与少量旧目标行保留检查；这仅核对文档片段，不是迁移实现测试，也不能证明 DSH 所用 SQLite、WAL、备份或租约行为。实际迁移验收仍为 NOT_RUN。

```sql
ALTER TABLE task ADD COLUMN state_seq INTEGER NOT NULL DEFAULT 0 CHECK(state_seq>=0);
ALTER TABLE task ADD COLUMN engine_version INTEGER NOT NULL DEFAULT 1 CHECK(engine_version IN (1,2));
ALTER TABLE task ADD COLUMN stop_requested INTEGER NOT NULL DEFAULT 0 CHECK(stop_requested IN (0,1));
ALTER TABLE action ADD COLUMN managed_v2 INTEGER NOT NULL DEFAULT 0 CHECK(managed_v2 IN (0,1));

-- task_target 没有其它表外键引用；只放宽真实 workspace 可空，不改 Session ID。
CREATE TABLE task_target_v2 (
  task_id TEXT NOT NULL, scope_id TEXT NOT NULL, workspace_id TEXT,
  session_id TEXT NOT NULL, role TEXT NOT NULL, resource_key TEXT NOT NULL,
  PRIMARY KEY(task_id,scope_id,session_id),
  FOREIGN KEY(task_id,scope_id) REFERENCES task(id,scope_id)
);
INSERT INTO task_target_v2(task_id,scope_id,workspace_id,session_id,role,resource_key)
  SELECT task_id,scope_id,workspace_id,session_id,role,resource_key FROM task_target;
-- 迁移driver此处断言：COUNT、主键集合及六列双向EXCEPT均一致；不一致立即throw/ROLLBACK。
-- 先清点并保留既有索引/FK/trigger；出现未知依赖停止迁移，不猜测删除。
DROP TABLE task_target;
ALTER TABLE task_target_v2 RENAME TO task_target;
CREATE UNIQUE INDEX task_single_executor_v2
  ON task_target(scope_id,task_id) WHERE role='executor-v2';

-- 所有 v2 控制路径必须设置 managed_v2=1；队列初态必须 planned，不能 dispatching。
CREATE UNIQUE INDEX one_active_delegation_v2 ON action(scope_id)
  WHERE managed_v2=1 AND state IN ('dispatching','accepted','running','outcome_unknown');

CREATE TABLE home_binding_history (
  scope_id TEXT NOT NULL, binding_version INTEGER NOT NULL CHECK(binding_version>0),
  session_id TEXT NOT NULL, previous_session_id TEXT, preset_id TEXT NOT NULL,
  cwd_fingerprint TEXT NOT NULL, context_ref TEXT, opened_at TEXT NOT NULL, closed_at TEXT,
  PRIMARY KEY(scope_id,binding_version), UNIQUE(scope_id,session_id),
  FOREIGN KEY(scope_id) REFERENCES scopes(scope_id)
);
CREATE UNIQUE INDEX one_current_home ON home_binding_history(scope_id) WHERE closed_at IS NULL;
CREATE TABLE home_provisioning (
  scope_id TEXT PRIMARY KEY, provision_key TEXT NOT NULL UNIQUE,
  expected_binding_version INTEGER NOT NULL CHECK(expected_binding_version>=0),
  requested_session_id TEXT NOT NULL, returned_session_id TEXT, legacy_session_id TEXT,
  stage TEXT NOT NULL CHECK(stage IN ('prepared','native_created','verified','bound','repair_required')),
  error_code TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
  FOREIGN KEY(scope_id) REFERENCES scopes(scope_id)
);
CREATE TABLE source_access (
  scope_id TEXT PRIMARY KEY, mode TEXT NOT NULL CHECK(mode IN ('none','selected','all_authorized')),
  workspace_ids_json TEXT NOT NULL CHECK(json_valid(workspace_ids_json)),
  session_ids_json TEXT NOT NULL CHECK(json_valid(session_ids_json)),
  granted_by TEXT NOT NULL, grant_ref TEXT NOT NULL, policy_epoch INTEGER NOT NULL CHECK(policy_epoch>0),
  updated_at TEXT NOT NULL, FOREIGN KEY(scope_id) REFERENCES scopes(scope_id)
);
CREATE TABLE request_receipt (
  scope_id TEXT NOT NULL, operation TEXT NOT NULL, origin_ref TEXT NOT NULL, request_id TEXT NOT NULL,
  payload_hash TEXT NOT NULL, task_id TEXT, action_id TEXT, applied_task_version INTEGER,
  response_json TEXT NOT NULL CHECK(json_valid(response_json)), created_at TEXT NOT NULL,
  PRIMARY KEY(scope_id,operation,origin_ref,request_id),
  FOREIGN KEY(scope_id) REFERENCES scopes(scope_id),
  FOREIGN KEY(task_id,scope_id) REFERENCES task(id,scope_id),
  FOREIGN KEY(action_id,scope_id) REFERENCES action(id,scope_id)
);
CREATE TABLE context_snapshot (
  id TEXT NOT NULL, scope_id TEXT NOT NULL, main_session_id TEXT NOT NULL,
  origin_message_id TEXT NOT NULL, target_session_id TEXT NOT NULL,
  source_generation TEXT NOT NULL, head_seq INTEGER NOT NULL CHECK(head_seq>=-1),
  latest_user_seq INTEGER NOT NULL CHECK(latest_user_seq>=-1), latest_user_message_id TEXT,
  policy_epoch INTEGER NOT NULL CHECK(policy_epoch>0), context_hash TEXT NOT NULL,
  refs_json TEXT NOT NULL CHECK(json_valid(refs_json)), created_at TEXT NOT NULL, expires_at TEXT NOT NULL,
  PRIMARY KEY(id,scope_id), FOREIGN KEY(scope_id) REFERENCES scopes(scope_id)
);
CREATE TABLE action_runtime (
  action_id TEXT NOT NULL, scope_id TEXT NOT NULL, context_id TEXT NOT NULL,
  main_session_id TEXT NOT NULL, main_binding_version INTEGER NOT NULL CHECK(main_binding_version>0),
  origin_message_id TEXT NOT NULL, origin_turn_id TEXT NOT NULL, tool_call_id TEXT,
  target_generation TEXT NOT NULL, latest_user_seq INTEGER NOT NULL CHECK(latest_user_seq>=-1),
  dispatch_policy TEXT NOT NULL DEFAULT 'when_idle' CHECK(dispatch_policy='when_idle'),
  queue_reason TEXT CHECK(queue_reason IN ('global_slot','target_busy','previous_action','context_changed','recovery')),
  observed_through_seq INTEGER NOT NULL DEFAULT -1 CHECK(observed_through_seq>=-1),
  claim_seq INTEGER, terminal_seq INTEGER,
  ownership TEXT NOT NULL DEFAULT 'not_started' CHECK(ownership IN ('not_started','exclusive','mixed','user_takeover','unknown','ended')),
  stop_requested INTEGER NOT NULL DEFAULT 0 CHECK(stop_requested IN (0,1)),
  stop_reason TEXT, native_approval_id TEXT, runtime_fence INTEGER, updated_at TEXT NOT NULL,
  PRIMARY KEY(action_id,scope_id),
  FOREIGN KEY(action_id,scope_id) REFERENCES action(id,scope_id),
  FOREIGN KEY(context_id,scope_id) REFERENCES context_snapshot(id,scope_id)
);
CREATE TABLE action_admission (
  action_id TEXT NOT NULL, scope_id TEXT NOT NULL, message_id TEXT NOT NULL,
  target_generation TEXT NOT NULL, turn_id TEXT NOT NULL,
  admitted_at TEXT NOT NULL, evidence_seq INTEGER,
  PRIMARY KEY(action_id,scope_id), UNIQUE(scope_id,message_id),
  FOREIGN KEY(action_id,scope_id) REFERENCES action(id,scope_id)
);
CREATE TABLE execution_slot (
  scope_id TEXT PRIMARY KEY, state TEXT NOT NULL CHECK(state IN ('free','held','recovery_barrier')),
  action_id TEXT, holder TEXT, fencing_token INTEGER, slot_revision INTEGER NOT NULL DEFAULT 0 CHECK(slot_revision>=0),
  reason TEXT, updated_at TEXT NOT NULL,
  CHECK((state='held' AND action_id IS NOT NULL) OR (state!='held' AND action_id IS NULL)),
  FOREIGN KEY(scope_id) REFERENCES scopes(scope_id),
  FOREIGN KEY(action_id,scope_id) REFERENCES action(id,scope_id)
);
CREATE TABLE task_result (
  id TEXT NOT NULL, scope_id TEXT NOT NULL, task_id TEXT NOT NULL, task_version INTEGER NOT NULL,
  action_id TEXT NOT NULL, logical_key TEXT NOT NULL,
  kind TEXT NOT NULL CHECK(kind IN ('progress','blocked','final','stopped')),
  source_generation TEXT NOT NULL, event_seq INTEGER NOT NULL CHECK(event_seq>=0), turn_id TEXT,
  outcome TEXT NOT NULL CHECK(outcome IN ('completed','failed','stopped','inconclusive','blocked','progress')),
  deliverable INTEGER NOT NULL CHECK(deliverable IN (0,1)),
  summary TEXT NOT NULL, artifacts_json TEXT NOT NULL CHECK(json_valid(artifacts_json)),
  evidence_json TEXT NOT NULL CHECK(json_valid(evidence_json)), checks_json TEXT NOT NULL CHECK(json_valid(checks_json)),
  missing_json TEXT NOT NULL CHECK(json_valid(missing_json)), created_at TEXT NOT NULL,
  PRIMARY KEY(id,scope_id), UNIQUE(scope_id,logical_key), UNIQUE(id,scope_id,task_id,task_version),
  FOREIGN KEY(task_id,scope_id,task_version) REFERENCES task_revision(task_id,scope_id,version),
  FOREIGN KEY(action_id,scope_id) REFERENCES action(id,scope_id)
);
CREATE TABLE result_outbox (
  result_id TEXT NOT NULL, scope_id TEXT NOT NULL, native_message_id TEXT NOT NULL,
  target_main_session_id TEXT NOT NULL, target_binding_version INTEGER NOT NULL,
  state TEXT NOT NULL CHECK(state IN ('pending','sending','sent','unknown','suppressed')),
  attempt INTEGER NOT NULL DEFAULT 0 CHECK(attempt>=0), receipt_json TEXT CHECK(receipt_json IS NULL OR json_valid(receipt_json)),
  updated_at TEXT NOT NULL, PRIMARY KEY(result_id,scope_id), UNIQUE(scope_id,native_message_id),
  FOREIGN KEY(result_id,scope_id) REFERENCES task_result(id,scope_id)
);
CREATE TABLE task_acceptance (
  id TEXT NOT NULL UNIQUE, scope_id TEXT NOT NULL, task_id TEXT NOT NULL, task_version INTEGER NOT NULL,
  result_id TEXT NOT NULL, owner_id TEXT NOT NULL, request_id TEXT NOT NULL, origin_ref TEXT NOT NULL,
  accepted_at TEXT NOT NULL, PRIMARY KEY(task_id,scope_id,task_version),
  FOREIGN KEY(result_id,scope_id,task_id,task_version) REFERENCES task_result(id,scope_id,task_id,task_version)
);
CREATE INDEX action_runtime_target ON action_runtime(scope_id,target_generation,observed_through_seq);
CREATE INDEX result_delivery_queue ON result_outbox(scope_id,state,updated_at);
CREATE INDEX result_task_history ON task_result(scope_id,task_id,task_version,created_at);
```

JSON 列再由服务端结构校验，`json_valid` 不证明字段合法。task_result/acceptance/admission 的既有记录不可覆盖；补充结果写新的 logicalKey，不改旧事实。`context_snapshot` 保存引用和摘要 hash，不复制整段原会话；过期记录在无 action 引用后清理，记忆遗忘/排除在每次读取和证据消费时继续生效。

### 8.2 必须在事务内的约束

- `one_active_delegation_v2` 保护全局单并发；execution_slot 是该动作的可恢复控制记录。取得/释放 slot 与对应 action 状态在同一 SQL 事务内更新，并检查 slot_revision。
- outcome_unknown 若只是历史结果不明、已证明无当前/排队执行，则需要先将该 action 改为 terminal rejected/settled 的准确结论或保持历史 unknown 的独立 recovery事实，再释放唯一索引约束；不能在 action 仍为占槽 unknown 时写 free。实现选择：用 action.state=settled、result.outcome=inconclusive 表示“执行已结束但结果不明”，保留审计，不表示成功。
- legacy managed_v2=0 动作不受新 partial index 假约束；存在可能在途 legacy 时 execution_slot=recovery_barrier 阻止新 v2 派发。不能通过把新动作 managed_v2=0 绕过索引。
- 每个新 task 只插一条 role=executor-v2 target；用户继续不换目标。旧多 target 数据保留，v2 projection 标 recovery_required，不能静默按第一条派发。
- 请求 receipt 与其业务写入原子提交。native 调用永远不放在事务里；调用前和调用后分别事务，并通过稳定 ID 对账。
- receipt.response_json 保存原操作实际应用的不可变关联/版本。重放不再执行业务，但返回中的 productState/允许操作应从当前投影重算，并标 replayed=true；不能把旧“已派发”快照冒充现在仍在运行。acceptance 重放只说明 appliedTaskVersion 的历史接受，当前任务状态另读。
- canonical payloadHash 包含目标、goal/instruction、条件、限制、计划版本、policyEpoch；不接受模型提供的 hash。UTC 时间使用 ISO-8601；ID 用随机 UUID/crypto，不沿用 `Math.random()` 生成生产幂等键。

## 9. v1→v2 迁移算法

现 `BoopStorage` 构造先 bootstrap，而 bootstrap 无条件写当前 SCHEMA_VERSION，之后才运行 migrate；单纯把常量改为 2 会把旧版本掩盖。[c03-SV-B06] 必须修改启动顺序。

1. 打开 DB 后先只读识别文件、`sqlite_schema` 中的 BOOP 业务表与 `meta.schema_version`。只有文件不存在，或已确认没有任何 BOOP 业务表，才可按空库初始化。**有 task/action/fact/scopes 等业务表但 meta 缺失、无法解析或版本记录损坏时，返回 repair_required/MIGRATION_FAILED，保留原文件且不写入；不能把版本缺失当成空库。** 大于 2 返回 VERSION_UNSUPPORTED，只读，不执行任何 downgrade DDL。
2. 阻止该数据域其它 BOOP writer/定时器进入；用当前进程 holder+fencingToken 获取迁移控制权，并通过 SQLite 写锁保护版本复查。旧 runtime 不得在迁移期间继续写。锁失效不继续迁移。
3. 使用 SQLite 一致备份 API 制作备份并记录 schema/行数/关键 hash；不能只复制仍有 WAL 的主文件。备份成功才迁移。备份应可由恢复说明定位，UI 不直接展示本机路径。
4. `BEGIN IMMEDIATE` 后再次核对旧版本和 writer fence；空库先建 v1 基础表再顺序执行 migration，旧库只执行未跑版本。DDL、数据补写、meta/scopes 版本更新在**同一个事务**。
5. 运行第 8 节 DDL；旧字段数据原样保留。`task_target` 换表只用于放宽 workspace_id 可空，必须在同一事务中逐列完整复制，并在 DROP 旧表前核对行数、主键集合及每列值一致；不得删除任何历史业务行，更不得重建整个数据库。新 task.engine_version 默认 1；新 runtime 从此只创建 version2任务。对旧潜在在途动作设置恢复标记/全局 barrier；不 cancel/重发原生动作，不迁移旧审批为可用新授权。
6. 初始化来源范围按第 3.2 节：保留旧明确 none/selected/exclude，未配置时继承当前真实 Host owner 可证明的已有范围；没有可信宿主授权事实则不创建伪造 grant，等正确 Host principal 建立后再初始化。主会话只创建 provisioning/待核验记录，不能在 SQL 迁移中调用原生 API。
7. 在事务内做 foreign_key_check、唯一性、旧记录关键值和版本一致性检查，再写 `meta.schema_version=2` 与 scopes.schema_version=2、迁移审计，COMMIT。任一步失败 ROLLBACK，旧版本保留，runtime 不启动 writer。
8. COMMIT 后读回 integrity/关键对象和当前 fence，再启动只读恢复，最后开放新业务。若读回失败返回 repair_required，不假称迁移成功。

`BoopDatabase.write(fn)` 保留同步事务形式；新增 `reviseTaskPlan`、`transitionTaskState`、`claimActionOutbox`、`claimExecutionSlot`、`recordNativeReceipt`、`recordResultAndOutbox`、`acceptTaskResult` repository 方法，统一在 controller 的 SQL 事务中使用。旧 markActionState 任意赋值接口不能被 v2 调用路径直接使用。

回滚不是把 schema_version 改回 1。需要停 writer，恢复一致备份及其版本匹配的旧包；迁移后产生的新数据不得被默默丢弃。正式交付的恢复说明必须明确备份选择和数据差异，旧数据保留规则见迁移/验收文档。

## 10. 错误码与可恢复行为

请求/操作失败返回 Reply.ok=false；用户 message 是自然语言，诊断标识用于复制详情。busy/正常全局排队是成功 queued，不作为工具失败。成功读取到了 Home 的 unavailable/repair_required 状态时可返回 ok=true + 对应 HomeView；这是明确的状态投影，不表示身份已经 ready。

| code | 触发条件 | 行为 |
|---|---|---|
| INVALID_ARGUMENT | 字段/长度/组合不合法 | 不写业务、不派发 |
| REQUEST_ID_CONFLICT | 同幂等键 payload 不同 | 返回原关联信息供读取，不替换原任务 |
| WRITER_HELD / WRITER_FENCE_LOST | 他进程持锁/本进程失租 | 可读、可展示；本进程不写不派发 |
| VERSION_UNSUPPORTED / MIGRATION_FAILED | DB或宿主版本不匹配/迁移失败 | 只读，显示恢复说明 |
| HOME_REPAIR_REQUIRED | 主 ID/preset/cwd/provisioning 不一致 | 不 fallback create，普通 DSH 可继续用 |
| PRESET_UNAVAILABLE | boop roster/preset 无法挂载 | 不以默认编码 preset 代替 |
| MODEL_UNAVAILABLE | 所需模型不可用 | 不静默换供应商；已建任务可 read/stop |
| SOURCE_ACCESS_REQUIRED / SCOPE_DENIED | 未授权/已撤销/来源被排除 | 普通聊天保留，不扩大读取范围 |
| TARGET_AMBIGUOUS | 无唯一目标 | 返回最多5真实候选，不创建动作 |
| TARGET_NOT_FOUND / TARGET_ARCHIVED / TARGET_NOT_ORDINARY | 目标不存在/归档/子代理/主Session | 拒绝，不创建替代 Agent |
| CONTEXT_REQUIRED / CONTEXT_EXPIRED / CONTEXT_CHANGED | 没读/过期/用户或generation改变 | 再读或需要用户继续处理 |
| TASK_VERSION_CONFLICT / TASK_STATE_CONFLICT | 旧计划或不允许的状态转换 | 刷新 task，不沿用旧验收/权限 |
| NATIVE_UNAVAILABLE / NATIVE_DURABILITY_UNAVAILABLE | 宿主能力/持久 listener 不可用 | 调用前拒绝；调用后改 unknown并核对 |
| OUTCOME_UNKNOWN / RECOVERY_REQUIRED | 无法排除旧执行/重启待恢复 | 只读对账，不重发旧动作 |
| STOP_OWNERSHIP_CHANGED | 当前 turn 已属用户/混合 | 停后续BOOP，不cancel用户turn |
| RESULT_NOT_CONFIRMABLE / RESULT_VERSION_CONFLICT | 无可关联交付/结果属于旧版 | 不完成任务 |
| ACCEPTANCE_CONFLICT | 同版本已接受另一result | 返回已有acceptance，刷新显示 |

原生审批待处理是产品状态 awaiting_native_approval，提示打开原会话；不是 BOOP 新 approval token。旧 approval 表保留历史且遵守旧撤销规则，不接入新授权中心。

## 11. 模块交付清单与验收证据

工程任务编号采用总清单 T01…，本章不另建 Bxx 工单体系。每模块完成的必要证据如下；所有证据现在均为 NOT_RUN。

| 模块 | 必交代码/行为 | 验收证据 |
|---|---|---|
| Host adapter | 官方 create/resolve/preset/flush/inbox/cancel 调用，保留稳定 ID | 原生 header、preset、messageId、turnId/seq；实际 rc.2 运行记录 |
| Home | journal、CAS、旧 started迁移、ready与capabilities分离 | 两窗口/重载/重启仍一主绑定；旧历史可查；普通 activeSession不变 |
| 来源与工具 | scopes/forget过滤、最多5候选、fresh context、两个新写工具 | 普通聊天0任务；同名不派发；目标计数不增加；选择只填草稿 |
| 存储/单槽 | schema2、请求receipt、state_seq、精确claim、fence | v1 fixture保留关键值；并发20次同请求仅一动作；busy A不阻止idle B；无两个active |
| 派发/gate | queue only、用户水位复核、混批保用户 | busy用户不中断；新用户指令阻止旧动作；拒BOOP不吞用户输入 |
| Observer/result | 精确action→turn→terminal、结果/证据/投递分开 | 无关turn结束不完成；只有done文本不passed；结果回主一次 |
| Stop/continue/confirm | 无模型停止，精确ownership，新修订，人类accept幂等 | pending BOOP stop不cancel human；terminal前不显示已停；accept不制造passed |
| Recovery | 启动先恢复、unknown持槽、旧任务不自动续 | enqueue前、enqueue后flush前、flush后receipt前、result发送后receipt前故障窗口 |

不能用 MockAgent、手改数据库、PoC端点、UI toast 或旧截图替代真实闭环。测试模型、stub模型、真实模型的运行必须清楚标记。最终最小成功案例须在既有原生 Session 修改指定临时项目、执行真实检查、主聊天持续可用、回报有来源并可人工确认。

## 附录 A：唯一 DTO 与状态命名

本附录是本交付中服务端/前端共用的字段源；其它文档只引用，不另造 send/chat、status/state、completed/delivered 等别名。字段可用于协议，界面不得直接显示内部 ID、版本、水位或错误码。

```ts
type Id = string;
type ISODate = string;
type Reply<K extends string, T> =
  | { schemaVersion: 2; kind: K; ok: true; requestId?: string; replayed?: boolean; data: T }
  | { schemaVersion: 2; kind: K; ok: false; requestId?: string;
      error: { code: string; message: string; retryable: boolean; diagnosticId?: string;
        taskId?: Id; actionId?: Id; appliedTaskVersion?: number } };

type HomeView =
  | { state: 'ready'; mainSessionId: Id; bindingVersion: number;
      capabilities: { send: boolean; readSources: boolean; delegate: boolean; stop: boolean; reasonCodes: string[] };
      migration?: { legacySessionId: Id; carriedContextRef: string | null } }
  | { state: 'repair_required' | 'unavailable'; reasonCode: string; message: string;
      retryable: boolean; mainSessionId?: Id };

type EvidenceRef = { sessionId: Id; sourceGeneration: string; seq: number;
  hash?: string; label?: string };
type ArtifactRef = { kind: 'file' | 'url' | 'session'; label: string; ref: string;
  evidence: EvidenceRef; contentHash?: string };
type WorkCandidate = { sessionId: Id; workspaceId: Id | null; title: string;
  workspaceTitle: string | null; mention: string; selectionKey: string;
  activity: 'idle' | 'running' | 'unknown'; lastActivityAt: ISODate | null; preview: string | null };
type WorkCatalog = { mode: 'work'; originUserMessageId: Id | null;
  sourceSeq: number | null; generatedAt: ISODate; candidates: WorkCandidate[]; truncated: boolean };
// sourceSeq 是主 Session 的本次 tool/call seq，不伪称尚未写出的 tool/result seq。
type CatalogValue = WorkCatalog | { mode: 'tasks'; tasks: TaskView[]; truncated: boolean }
  | { mode: 'capabilities'; capabilities: Extract<HomeView,{state:'ready'}>['capabilities'] };

type ContextView = { targetSessionId: Id | null; taskId: Id | null;
  contextToken: Id | null; sourceGeneration: string | null; headSeq: number | null;
  latestDirectUserSeq: number | null; body: string; evidence: EvidenceRef[];
  truncated: boolean; nextBeforeSeq: number | null; memoryFreshness: 'current' | 'stale' | 'unknown' };

type ProductState = 'queued' | 'waiting_target' | 'dispatching' | 'accepted' | 'running'
  | 'awaiting_native_approval' | 'received_reply' | 'delivered' | 'needs_attention' | 'stopping' | 'stopped';
type ExecutionState = 'planned' | 'dispatching' | 'accepted' | 'running' | 'settled'
  | 'stopped' | 'outcome_unknown' | 'rejected';
type DeliveryState = 'pending' | 'sending' | 'sent' | 'unknown' | 'suppressed';
type VerificationView = { state: 'not_checked' | 'pending' | 'passed' | 'failed' | 'partial' | 'unknown';
  summary: string; checks: { criterion: string; state: 'passed' | 'failed' | 'unknown';
    evidence: EvidenceRef[] }[] };
type ConfirmationView = { state: 'unavailable' | 'pending' | 'accepted';
  acceptanceId?: Id; acceptedAt?: ISODate; appliedTaskVersion?: number };
type ResultView = { resultId: Id; taskVersion: number; actionId: Id;
  kind: 'progress' | 'blocked' | 'final' | 'stopped';
  outcome: 'completed' | 'failed' | 'stopped' | 'inconclusive' | 'blocked' | 'progress';
  summary: string; artifacts: ArtifactRef[]; evidence: EvidenceRef[]; missing: string[];
  verification: VerificationView; confirmation: ConfirmationView; deliveryState: DeliveryState;
  createdAt: ISODate };
type TaskView = { taskId: Id; taskVersion: number; stateSeq: number; title: string;
  target: { sessionId: Id; workspaceId: Id | null; sessionTitle: string; workspaceTitle: string | null };
  productState: ProductState; statusText: string; needsAttentionReason: string | null;
  latestAction: { actionId: Id; executionState: ExecutionState; stopRequested: boolean } | null;
  latestResult: ResultView | null;
  confirmation: ConfirmationView; verification: VerificationView;
  availableActions: ('view' | 'open_session' | 'stop' | 'continue' | 'confirm')[];
  updatedAt: ISODate };
type TaskPage = { items: TaskView[]; nextCursor: string | null; syncedAt: ISODate };

type DispatchArgs = { requestId: string; targetSessionId: Id; contextToken: Id;
  goal: string; instruction: string; criteria?: string[]; exclusions?: string[] };
type StopArgs = { requestId: string; taskId: Id; expectedTaskVersion: number };
type ContinueArgs = StopArgs & { contextToken: Id; instruction: string;
  goal?: string; criteria?: string[]; exclusions?: string[] };
type TaskControlArgs = (StopArgs & { operation: 'stop' })
  | (ContinueArgs & { operation: 'resume' | 'revise' });
type ConfirmArgs = StopArgs & { resultId: Id; decision: 'accept' };
type DispatchReceipt = { taskId: Id; actionId: Id; appliedTaskVersion: number;
  disposition: 'queued' | 'dispatched'; productState: ProductState; reasonCode: string | null };
type ControlReceipt = { taskId: Id; appliedTaskVersion: number; actionId: Id | null;
  operation: 'stop' | 'continue'; disposition: 'queued' | 'stop_requested' | 'stopped' | 'stopped_future_only';
  productState: ProductState; reasonCode: string | null };
type AcceptanceReceipt = { acceptanceId: Id; taskId: Id; resultId: Id;
  appliedTaskVersion: number; acceptedAt: ISODate; verificationChangedToPassed: false };
type AccessView = { mode: 'none' | 'selected' | 'all_authorized';
  workspaceIds: Id[]; sessionIds: Id[]; policyEpoch: number };
type AccessUpdateArgs = { requestId: string; expectedPolicyEpoch: number;
  mode: AccessView['mode']; workspaceIds: Id[]; sessionIds: Id[] };
```

### 状态投影的优先级

停止尚未证实 → stopping；未知/用户接管/恢复/上下文冲突 → needs_attention；真实原生审批待决 → awaiting_native_approval；运行 → running；接收 → accepted；派发 → dispatching；目标忙 → waiting_target；其它队列 → queued；终止且有可关联结果 → delivered；仅收到无充分内容的回复 → received_reply；确实停止/结束且不再派发 → stopped。

确认接受后 productState 仍为 delivered，confirmation=accepted，文案“你已确认”；不另造一个把交付与验证混为一谈的 completed 产品状态。task.lifecycle 可为 completed，技术字段不直接显示。verification 永远反映真实检查证据，不从 confirmation 反推。

`HomeView.state`、`TaskView.productState`、`latestAction.executionState`、`ResultView.deliveryState` 与两个 `*.state` 各有固定含义；任何缓存/事件不得用一个笼统 status 覆盖它们。

## 附录 B：固定源码依据

以下链接全部绑定完整提交 SHA。它们支持“现有代码/官方API事实”，不证明本重构已实现或运行通过。

- **[c03-SV-B01] 主绑定只写ledger与旧client创建/导航**：[Host](https://github.com/wanyexin1998/dsh-plugin/blob/98991899eecea6c6af1faa158e92cb73e555a5a5/dsh-boop/src/host/main-session.ts#L135-L206)、[Client](https://github.com/wanyexin1998/dsh-plugin/blob/98991899eecea6c6af1faa158e92cb73e555a5a5/dsh-boop/src/client/main-session.ts#L300-L394)。
- **[c03-SV-B02] 真实目录与facade**：[workspace-api](https://github.com/wanyexin1998/dsh-plugin/blob/98991899eecea6c6af1faa158e92cb73e555a5a5/dsh-boop/src/host/workspace-api.ts#L137-L288)、[service接口](https://github.com/wanyexin1998/dsh-plugin/blob/98991899eecea6c6af1faa158e92cb73e555a5a5/dsh-boop/src/host/workspace-api.ts#L570-L587)、[目标解析](https://github.com/wanyexin1998/dsh-plugin/blob/98991899eecea6c6af1faa158e92cb73e555a5a5/dsh-boop/src/host/workspace.ts#L1250-L1313)。
- **[c03-SV-B03] 模型工具和parameter DSL**：[tools.ts](https://github.com/wanyexin1998/dsh-plugin/blob/98991899eecea6c6af1faa158e92cb73e555a5a5/dsh-boop/src/host/tools.ts)、[boop preset](https://github.com/wanyexin1998/dsh-plugin/blob/98991899eecea6c6af1faa158e92cb73e555a5a5/dsh-boop/presets/boop.patch.yml)。
- **[c03-SV-B04] Dispatcher 与 claim/flush行为**：[dispatcher.ts](https://github.com/wanyexin1998/dsh-plugin/blob/98991899eecea6c6af1faa158e92cb73e555a5a5/dsh-boop/src/host/dispatch/dispatcher.ts#L216-L397)。
- **[c03-SV-B05] 当前DSH适配和durable trace**：[adapter](https://github.com/wanyexin1998/dsh-plugin/blob/98991899eecea6c6af1faa158e92cb73e555a5a5/dsh-boop/src/host/transport/dsh-adapter.ts)、[来源envelope](https://github.com/wanyexin1998/dsh-plugin/blob/98991899eecea6c6af1faa158e92cb73e555a5a5/dsh-boop/src/host/transport/command-envelope.ts)。
- **[c03-SV-B06] bootstrap、同步事务、fence**：[database.ts](https://github.com/wanyexin1998/dsh-plugin/blob/98991899eecea6c6af1faa158e92cb73e555a5a5/dsh-boop/src/host/persistence/database.ts#L89-L156)、[storage.ts](https://github.com/wanyexin1998/dsh-plugin/blob/98991899eecea6c6af1faa158e92cb73e555a5a5/dsh-boop/src/host/persistence/storage.ts#L90-L189)、[migrate.ts](https://github.com/wanyexin1998/dsh-plugin/blob/98991899eecea6c6af1faa158e92cb73e555a5a5/dsh-boop/src/host/persistence/migrate.ts)。
- **[c03-SV-B07] v1 schema与repository约束**：[schema.ts](https://github.com/wanyexin1998/dsh-plugin/blob/98991899eecea6c6af1faa158e92cb73e555a5a5/dsh-boop/src/host/persistence/schema.ts)、[task更新](https://github.com/wanyexin1998/dsh-plugin/blob/98991899eecea6c6af1faa158e92cb73e555a5a5/dsh-boop/src/host/persistence/repository.ts#L325-L418)、[action/outbox](https://github.com/wanyexin1998/dsh-plugin/blob/98991899eecea6c6af1faa158e92cb73e555a5a5/dsh-boop/src/host/persistence/repository.ts#L527-L648)。
- **[c03-SV-B08] 来源读取实际边界**：[host-reader.ts](https://github.com/wanyexin1998/dsh-plugin/blob/98991899eecea6c6af1faa158e92cb73e555a5a5/dsh-boop/src/host/observe/host-reader.ts#L72-L225)。
- **[c03-SV-B09] 既有任务、控制与验证**：[tasks-api](https://github.com/wanyexin1998/dsh-plugin/blob/98991899eecea6c6af1faa158e92cb73e555a5a5/dsh-boop/src/host/tasks-api.ts#L236-L267)、[control stop](https://github.com/wanyexin1998/dsh-plugin/blob/98991899eecea6c6af1faa158e92cb73e555a5a5/dsh-boop/src/host/control.ts#L1295-L1488)、[verifier](https://github.com/wanyexin1998/dsh-plugin/blob/98991899eecea6c6af1faa158e92cb73e555a5a5/dsh-boop/src/host/verify/verifier.ts)。
- **[c03-SV-B10] 当前整批pre-step拒绝**：[pre-step.ts](https://github.com/wanyexin1998/dsh-plugin/blob/98991899eecea6c6af1faa158e92cb73e555a5a5/dsh-boop/src/host/gate/pre-step.ts#L195-L260)。
- **[c03-SV-H01] 官方Host创建/resolve和类型**：[commands.ts](https://github.com/deepseek-ai/deepseek-harness/blob/687f282e8625c6b8d11ff58211a90524be2e4317/packages/api/session-controller/src/commands.ts#L111-L149)、[resolveAgent](https://github.com/deepseek-ai/deepseek-harness/blob/687f282e8625c6b8d11ff58211a90524be2e4317/packages/api/session-controller/src/index.ts#L238-L245)、[types](https://github.com/deepseek-ai/deepseek-harness/blob/687f282e8625c6b8d11ff58211a90524be2e4317/packages/api/session-controller/src/types.ts#L288-L305)。
- **[c03-SV-H02] create命名复用条件**：[agent.ts](https://github.com/deepseek-ai/deepseek-harness/blob/687f282e8625c6b8d11ff58211a90524be2e4317/packages/api/session-controller/src/agent.ts#L458-L577)。
- **[c03-SV-H03] preset查询与实际mount**：[agent.ts](https://github.com/deepseek-ai/deepseek-harness/blob/687f282e8625c6b8d11ff58211a90524be2e4317/packages/api/session-controller/src/agent.ts#L361-L398)。
- **[c03-SV-H04] 单Session flush与全服务flush**：[SessionStore](https://github.com/deepseek-ai/deepseek-harness/blob/687f282e8625c6b8d11ff58211a90524be2e4317/packages/core/session/src/index.ts#L1306-L1335)、[SessionPersistence](https://github.com/deepseek-ai/deepseek-harness/blob/687f282e8625c6b8d11ff58211a90524be2e4317/packages/session/session-persistence/src/index.ts#L169-L180)。
- **[c03-SV-H05] 只读observe与窗口实际实现**：[observeSession](https://github.com/deepseek-ai/deepseek-harness/blob/687f282e8625c6b8d11ff58211a90524be2e4317/packages/session-query/session-query/src/index.ts#L134-L145)、[list/filter/readEvent](https://github.com/deepseek-ai/deepseek-harness/blob/687f282e8625c6b8d11ff58211a90524be2e4317/packages/session-query/session-query/src/index.ts#L264-L405)。
- **[c03-SV-H06] pre-step先于模型与claim行为**：[agent loop](https://github.com/deepseek-ai/deepseek-harness/blob/687f282e8625c6b8d11ff58211a90524be2e4317/packages/core/agent-loop/src/agent.ts#L267-L340)、[真实message写入](https://github.com/deepseek-ai/deepseek-harness/blob/687f282e8625c6b8d11ff58211a90524be2e4317/packages/core/agent-loop/src/agent.ts#L425-L435)、[inbox claim](https://github.com/deepseek-ai/deepseek-harness/blob/687f282e8625c6b8d11ff58211a90524be2e4317/packages/core/agent-loop/src/inbox.ts#L103-L113)。
- **[c03-SV-H07] 精确remove与cancel请求**：[inbox](https://github.com/deepseek-ai/deepseek-harness/blob/687f282e8625c6b8d11ff58211a90524be2e4317/packages/core/agent-loop/src/inbox.ts#L147-L165)、[cancel](https://github.com/deepseek-ai/deepseek-harness/blob/687f282e8625c6b8d11ff58211a90524be2e4317/packages/api/session-controller/src/commands.ts#L492-L510)。
- **[c03-SV-H08] ToolRunContext及DSL**：[execute](https://github.com/deepseek-ai/deepseek-harness/blob/687f282e8625c6b8d11ff58211a90524be2e4317/packages/core/tools/src/index.ts#L224-L237)、[调用身份](https://github.com/deepseek-ai/deepseek-harness/blob/687f282e8625c6b8d11ff58211a90524be2e4317/packages/core/tools/src/index.ts#L327-L352)、[context](https://github.com/deepseek-ai/deepseek-harness/blob/687f282e8625c6b8d11ff58211a90524be2e4317/packages/core/tools/src/index.ts#L419-L435)、[schema](https://github.com/deepseek-ai/deepseek-harness/blob/687f282e8625c6b8d11ff58211a90524be2e4317/packages/core/tools/src/schema.ts#L24-L105)。
- **[c03-SV-H09] canonical mention公开入口**：[root export](https://github.com/deepseek-ai/deepseek-harness/blob/687f282e8625c6b8d11ff58211a90524be2e4317/packages/context/session-reference/src/index.ts#L39-L53)、[formatter](https://github.com/deepseek-ai/deepseek-harness/blob/687f282e8625c6b8d11ff58211a90524be2e4317/packages/context/session-reference/src/uri.ts#L43-L50)、[package exports](https://github.com/deepseek-ai/deepseek-harness/blob/687f282e8625c6b8d11ff58211a90524be2e4317/packages/context/session-reference/package.json)。
- **[c03-SV-H10] 消息source扩展与构造**：[MessageSourceMap](https://github.com/deepseek-ai/deepseek-harness/blob/687f282e8625c6b8d11ff58211a90524be2e4317/packages/llm/llm/src/message.ts#L103-L147)、[createUserMessage](https://github.com/deepseek-ai/deepseek-harness/blob/687f282e8625c6b8d11ff58211a90524be2e4317/packages/llm/llm/src/message.ts#L246-L252)。
- **[c03-SV-H11] 原生审批记录与真实处理链**：[事件类型](https://github.com/deepseek-ai/deepseek-harness/blob/687f282e8625c6b8d11ff58211a90524be2e4317/packages/interaction/user-approval/src/types.ts#L35-L91)、[request实现](https://github.com/deepseek-ai/deepseek-harness/blob/687f282e8625c6b8d11ff58211a90524be2e4317/packages/interaction/user-approval/src/index.ts#L215-L233)。
- **[c03-SV-H12] 真实Host principal与访问规则**：[principalOf公开导入及服务](https://github.com/deepseek-ai/deepseek-harness/blob/687f282e8625c6b8d11ff58211a90524be2e4317/packages/api/remote-access/src/index.ts#L10-L48)、[owner与allows语义](https://github.com/deepseek-ai/deepseek-harness/blob/687f282e8625c6b8d11ff58211a90524be2e4317/packages/api/remote-access/src/index.ts#L200-L243)。
- **[c03-SV-H13] 原生引用在pre-step读取快照**：[监听与解析顺序](https://github.com/deepseek-ai/deepseek-harness/blob/687f282e8625c6b8d11ff58211a90524be2e4317/packages/context/session-reference/src/index.ts#L138-L179)、[实际readSurface](https://github.com/deepseek-ai/deepseek-harness/blob/687f282e8625c6b8d11ff58211a90524be2e4317/packages/context/session-reference/src/index.ts#L317-L345)。
- **[c03-SV-H14] 官方Cordis顺序与scope过滤**：[filter不重排](https://github.com/deepseek-ai/deepseek-harness/blob/687f282e8625c6b8d11ff58211a90524be2e4317/vendor/cordis/src/events.ts#L159-L175)、[waterfall与prepend/push](https://github.com/deepseek-ai/deepseek-harness/blob/687f282e8625c6b8d11ff58211a90524be2e4317/vendor/cordis/src/events.ts#L234-L258)、[scopeTarget](https://github.com/deepseek-ai/deepseek-harness/blob/687f282e8625c6b8d11ff58211a90524be2e4317/packages/core/scope/src/index.ts#L159-L180)。
- **[c03-SV-H15] 原生queued work等待初始化**：[agent/created契约](https://github.com/deepseek-ai/deepseek-harness/blob/687f282e8625c6b8d11ff58211a90524be2e4317/packages/core/agent/src/runtime-types.ts#L245-L261)、[AgentFactory创建顺序](https://github.com/deepseek-ai/deepseek-harness/blob/687f282e8625c6b8d11ff58211a90524be2e4317/packages/core/agent/src/index.ts#L171-L181)。
- **[c03-SV-H16] 原生引用parser输出和裸URI支持**：[parseSessionReferenceText](https://github.com/deepseek-ai/deepseek-harness/blob/687f282e8625c6b8d11ff58211a90524be2e4317/packages/context/session-reference/src/uri.ts#L54-L86)。

## 附录 C：与产品规格的一致性

本章按 01 实现全局单并发、主聊天持续、busy不入原生队列、人类验收独立、原生审批留原会话、来源未授权不阻止聊天，没有另增产品中心。

未知状态对用户表述为“先核对，避免重复执行”，不另露暂停/恢复操作。来源未配置时继承当前 Host 真实授权，已有有效范围不反复确认；明确点名可访问目标可以直接进入读取/委托，实际被排除或权限不足仍如实说明。需要变更来源限制时由人类操作既有范围入口，不由模型自动扩权。

已交付与等待用户确认不冲突：同一结果可以 productState=delivered、confirmation=pending。确认后 verification 仍可为 pending/failed/unknown；不得为视觉简化改成 passed。


---

<a id="c04"></a>

# BOOP MVP 开发任务清单

29 个可独立领取的工单。每项明确前置任务、已有与新增文件、实施步骤、完成标准及证据。全部初始状态 `TODO`。本文的 T01–T29 是唯一正式任务编号，其他章节的模块拆分只用于解释实现。

## 工单总览

| 工单 | 交付 | 负责人 | 依赖 | 里程碑 |
|---|---|---|---|---|
| [T01](#task-T01) | 固定重构基线与替换旧产品约束 | 技术负责人 | — | M0 |
| [T02](#task-T02) | 让构建和回归工具可以在另一台机器运行 | 构建/测试工程师 | T01 | M0 |
| [T03](#task-T03) | 验证真实 DSH 公开接入契约 | 宿主集成工程师 | T02 | M0 |
| [T04](#task-T04) | 修复数据库启动迁移与自身写租约校验 | 后端工程师 | T03 | M1 |
| [T05](#task-T05) | 实现 schema 2 和幂等仓储原语 | 后端工程师 | T04 | M1 |
| [T06](#task-T06) | 创建和找回真实 BOOP 主身份 | 后端/宿主集成工程师 | T05 | M1 |
| [T07](#task-T07) | 接入独立 BOOP 页面和原生聊天实例 | 前端工程师 | T03, T06 | M1 |
| [T08](#task-T08) | 落地 BOOP 视觉外壳与欢迎态 | 前端/设计工程师 | T07 | M1 |
| [T09](#task-T09) | 完善原生输入、草稿和断线状态 | 前端工程师 | T07, T08 | M1 |
| [T10](#task-T10) | 扩展真实目录和有预算的近期上下文 | 后端工程师 | T03, T05, T06 | M2 |
| [T11](#task-T11) | 注册正式委托工具与主助理行为 | 后端/Agent工程师 | T05, T06, T10 | M2 |
| [T12](#task-T12) | 实现正式派发控制器与全局单活动槽 | 后端工程师 | T05, T10, T11 | M2 |
| [T13](#task-T13) | 修复原生传输、持久收据和准入混批 | 宿主集成工程师 | T03, T05, T12 | M2 |
| [T14](#task-T14) | 观察精确执行并保存带证据的结果 | 后端工程师 | T13 | M2 |
| [T15](#task-T15) | 可靠地把结果送回 BOOP 主聊天 | 后端工程师 | T06, T14 | M2 |
| [T16](#task-T16) | 实现确定性停止且不误停用户工作 | 后端/宿主集成工程师 | T13, T14 | M2 |
| [T17](#task-T17) | 实现人类验收和继续处理的新修订 | 后端/前端接口工程师 | T14, T16 | M2 |
| [T18](#task-T18) | 完成崩溃恢复和未知结果的核对 | 后端工程师 | T06, T13, T14, T15, T16, T17 | M2 |
| [T19](#task-T19) | 提供面向用户的工作与错误投影 | 后端/前端接口工程师 | T05, T14, T16, T17 | M3 |
| [T20](#task-T20) | 实现轻工作卡、工作抽屉和来源选择 | 前端工程师 | T08, T09, T10, T15, T16, T17, T19 | M3 |
| [T21](#task-T21) | 收敛设置、历史与诊断入口 | 前端/后端工程师 | T06, T08, T10, T19 | M3 |
| [T22](#task-T22) | 清理默认日程与无关后台工作 | 后端工程师 | T06, T12, T15, T18 | M3 |
| [T23](#task-T23) | 完成定向复用、移除无关打包与来源记录 | 前端/集成工程师 | T07, T08, T09, T20, T21, T22 | M3 |
| [T24](#task-T24) | 跑通自然语言真实产物闭环 | QA/集成工程师 | T09, T15, T16, T17, T18, T20, T21, T22, T23 | M4 |
| [T25](#task-T25) | 验证故障、审批并发与精确控制 | QA/后端工程师 | T18, T19, T20, T24 | M4 |
| [T26](#task-T26) | 演练旧数据升级与真正跨版本回滚 | QA/后端工程师 | T04, T05, T06, T18, T21, T23 | M4 |
| [T27](#task-T27) | 验收视觉、可访问性与宿主隔离 | 产品/设计/QA | T09, T20, T21, T22, T23, T24 | M4 |
| [T28](#task-T28) | 验证兼容矩阵并生成可安装候选包 | QA/发布工程师 | T02, T23, T24, T25, T26, T27 | M4 |
| [T29](#task-T29) | 完成交付审查与发布说明 | 技术负责人/产品/QA | T28 | M4 |

## 实施节奏与并行边界

先完成 T01–T03 的基线和真实宿主契约；schema/DTO 在 T05 定义后，主身份、目录、页面可以分工。T12/T13 是委托能否落地的关键链；没有真实传输，不应开始宣称“已派发”。前端 T08/T09 可用契约 fixture 开发，但业务验收要等 T15–T20 接通。

T24 是完整真实流程，不等于所有故障已经覆盖；T25 补故障与并发，T26 补旧数据，T27 补可用性，T28 验所声明兼容范围；T29 汇总证据。各项测试以具体风险为目标，不要求为纯样式变化编造镜像单元测试。

不承诺凭源码推算的固定工期。T03 完成后才能可靠评估宿主接入与环境成本；排期应按里程碑可演示成果安排，不能先设一天换皮的期限再删减恢复与数据保护。若只能交付 M1，应命名为“聊天页面预览”，不能称已完成本 MVP。

## 需求覆盖

| 产品需求 | 实施工单 | 核心验收 |
|---|---|---|
| F01 | T01、T03、T06、T07、T08、T21、T23、T24、T27 | A01、A02、A34 |
| F02 | T03、T06、T07、T09、T24、T27 | A03、A04、A05、A06 |
| F03 | T10、T11、T20、T24 | A07、A08 |
| F04 | T10、T11、T21、T24 | A08、A11、A12 |
| F05 | T03、T05、T11、T12、T13、T24、T25 | A09、A13、A22、A37 |
| F06 | T05、T12、T14、T15、T19、T20、T22、T24 | A10、A14、A15、A16、A17、A37 |
| F07 | T03、T09、T11、T12、T13、T16、T17、T18、T20、T24、T25 | A06、A18、A21、A23、A38 |
| F08 | T05、T11、T14、T15、T17、T19、T20、T24、T25 | A14、A15、A40 |
| F09 | T04、T05、T06、T18、T21、T22、T26 | A25、A26、A27、A28、A29、A30、A31、A32 |
| F10 | T01、T03、T07、T09、T13、T21、T22、T23、T27、T28 | A33、A39、A41 |
| F11 | T08、T09、T16、T18、T19、T21、T25、T27 | A17、A19、A20、A21、A22、A23、A24 |
| F12 | T01、T02、T04、T23、T26、T28 | A27、A28、A29、A30、A31、A32、A33、A34、A35、A36、A42 |

## 逐项实施

<a id="task-T01"></a>

## T01 · 固定重构基线与替换旧产品约束

里程碑：M0 · 建议负责人：技术负责人 · 状态：TODO

前置任务：无。需求：F01、F10、F12。

### 修改已有文件或目录

无。

### 计划新增文件

- `docs/refactor/boop-mvp-v0.2/ADR-0001-boop-home.md`
- `docs/refactor/boop-mvp-v0.2/evidence/baseline.json`

### 只读依据，不修改冻结历史

- `package.json`
- `manifests/FROZEN_BASELINE.json`
- `baseline/docs/04_前端设计方案.md`
- `handoff/00_冻结说明与文档优先级.md`

所有路径相对于 `dsh-boop/`；新增路径是本方案建议的实现落点，尚不存在。目录项表示仅修改本任务实际涉及文件，不能据此批量重写。

### 实施步骤

1. 确认实际 Git 顶层、当前提交、未提交修改以及 dsh-boop 是否存在本地独立提交关系；保留用户改动。
2. 记录原包、锁文件、DSH Web/Desktop、Node/pnpm 与模型路由基线；现有两种 DSH engine 声明保持到兼容性审查。
3. 纳入本目录文档并记录新 ADR，明确只替换入口、首屏、初始化和任务板产品假设；保留未被替换的归属、权限、证据与恢复规则。
4. 约定分支和评审批次；将29个工单、42个用例初始化，不沿用旧版 PASS。

### 完成标准

- 有可回溯的基线清单和文件哈希；本地与方案基准的差异逐项说明。
- 旧文档仍完整，新 ADR 可明确判定冲突，不需要工程师再猜产品方向。

### 验收与证据

关联用例：A01、A33、A36。用例详情见 `06_验收用例.md`；这不是已有通过记录。
- baseline.json
- ADR diff
- 实际 checkout 状态记录；敏感配置不入证据

<a id="task-T02"></a>

## T02 · 让构建和回归工具可以在另一台机器运行

里程碑：M0 · 建议负责人：构建/测试工程师 · 状态：TODO

前置任务：T01。需求：F12。

### 修改已有文件或目录

- `package.json`
- `pnpm-workspace.yaml`
- `pnpm-lock.yaml`
- `build.mjs`
- `tools/run-regression.mjs`
- `tools/build-test-payload.mjs`
- `tools/web-e2e.mjs`
- `tools/web-e2e-control.mjs`
- `tools/desktop-gui-probe.mjs`
- `tools/rehearse-install.mjs`
- `tests/helpers/test-host.mjs`
- `tests/host/`

### 计划新增文件

- `tools/test-env.mjs`

### 只读依据，不修改冻结历史

无。

所有路径相对于 `dsh-boop/`；新增路径是本方案建议的实现落点，尚不存在。目录项表示仅修改本任务实际涉及文件，不能据此批量重写。

### 实施步骤

1. 按05文档核对 Node、支持 allowBuilds 的确切 pnpm、registry 可用性和锁文件完整性，再做冻结安装；不删锁重解全图。
2. 修正 test script 指向实际 tests/unit、tests/client；先构建再跑读取 lib 产物的客户端测试。记录 typecheck 既有失败，不用 ts-nocheck 掩盖。
3. 把个人 pnpm/EXE/payload 路径、固定端口与历史 fixture 路径替换为显式参数。定义 DSH_PNPM 是可执行文件路径，若需要 pnpm.cjs 则单独通过 Node+参数数组调用。
4. 从实际 payload/app 读取宿主版本和提交；无法读到写 unknown，不能在 rc.3 测试里沿用 rc.2 提交。
5. 隔离 DSH_HOME 和临时项目；未配置真实模型时明确 SKIPPED，不请求旧内网默认地址。输出结构化 PASS/FAIL/BLOCKED/NOT_RUN/SKIPPED。

### 完成标准

- 在一份新的隔离工作目录中按文档可完成冻结安装、build、list、offline 和打包，或准确报告外部阻塞。
- 所有测试进程只能操作 fixture；没有作者个人绝对路径依赖。
- 环境与类型基线有记录，构建成功不被描述成类型检查通过。

### 验收与证据

关联用例：A27、A31、A36。用例详情见 `06_验收用例.md`；这不是已有通过记录。
- toolchain.json
- offline-baseline.json
- 锁文件前后哈希
- 构建与类型检查日志

<a id="task-T03"></a>

## T03 · 验证真实 DSH 公开接入契约

里程碑：M0 · 建议负责人：宿主集成工程师 · 状态：TODO

前置任务：T02。需求：F01、F02、F05、F07、F10。

### 修改已有文件或目录

- `tests/host/e00-01-plugin-load.test.mjs`
- `tests/host/e00-02-pre-step-gate.test.mjs`
- `tests/host/e00-02-proxy-gate.test.mjs`

### 计划新增文件

- `tests/host/mvp-native-contract.test.mjs`
- `tests/client/mvp-embedded-contract.test.mjs`

### 只读依据，不修改冻结历史

无。

所有路径相对于 `dsh-boop/`；新增路径是本方案建议的实现落点，尚不存在。目录项表示仅修改本任务实际涉及文件，不能据此批量重写。

### 实施步骤

1. 依据02/03核对并在真实 Host 运行 create、resolveAgent、preset projection、sessions.flush、inbox.remove、cancel 与事件序列。
2. 运行独立 main → 自有 session 子槽 → 注入 SessionProvider → embedded Factory；验证 type-only import 与宿主 module loader，不导入未导出的 InputBar。
3. 验证 pre-step await next 后精确过滤 BOOP 消息、保留人类消息的顺序；纯 runtime-context 不触发空转；queued remove 后持久证据真实可读。
4. 记录候选目标 reference chip 的 captureInsertion/insertReference 与原生草稿持久性，确认不自动提交；按03核验主scope非prepend guard先于官方reference的readSurface，排除引用正文读取次数为0。
5. 将能力结果写入候选构建证据；未通过的委托能力明确 unavailable，不能回退危险旧实现。

### 完成标准

- 真实事件能给出 sessionId/messageId/turnId/seq；mock不能替代本任务。
- 切入 BOOP 不更改普通 activeSession，离开后无残留 retain/全局覆盖。
- 拒绝一条 BOOP 消息不会吞掉同批人类消息；flush false 不被当作 durable。

### 验收与证据

关联用例：A01、A02、A05、A07、A12、A18、A37、A38、A39、A41。用例详情见 `06_验收用例.md`；这不是已有通过记录。
- native-contract.json
- 两版本源码差异说明
- 真实 Host 事件片段与最小页面截图

<a id="task-T04"></a>

## T04 · 修复数据库启动迁移与自身写租约校验

里程碑：M1 · 建议负责人：后端工程师 · 状态：TODO

前置任务：T03。需求：F09、F12。

### 修改已有文件或目录

- `src/host/persistence/database.ts`
- `src/host/persistence/migrate.ts`
- `src/host/persistence/storage.ts`
- `src/host/persistence/lease.ts`

### 计划新增文件

- `tests/unit/mvp-migration-boot.test.mjs`
- `tests/host/mvp-writer-fence.test.mjs`

### 只读依据，不修改冻结历史

无。

所有路径相对于 `dsh-boop/`；新增路径是本方案建议的实现落点，尚不存在。目录项表示仅修改本任务实际涉及文件，不能据此批量重写。

### 实施步骤

1. 先只读识别旧版本；禁止 bootstrap 在 migrate 前把 schema_version 改成当前常量。
2. 建立迁移互斥，确认无活动 writer；做一致快照备份并记录哈希、版本、关键计数，备份失败中止升级。
3. 迁移 DDL/backfill/meta version 同一事务；失败回滚；完成 integrity/FK 检查后才启动正常 writer/runtime。
4. 每个写事务校验本进程持有的 holder/fencingToken，失租停止写入和派发；不得使用数据库现任 owner 的 token 冒充自身。
5. future schema 只读拒绝；不要强夺仍活着的 owner；SQL transaction 内没有外部异步 native 操作。

### 完成标准

- v1中途失败版本不前移、数据不丢，磁盘/备份失败不启动半迁移运行时。
- 第二 Host 只读；旧 holder 在租约被合法接替后无法继续 mutation。
- 同版本打开不产生重复迁移或改写旧语义。

### 验收与证据

关联用例：A24、A27、A28、A29、A30、A31、A32。用例详情见 `06_验收用例.md`；这不是已有通过记录。
- 迁移故障注入断言
- 备份 manifest
- 双 Host fence 事件

<a id="task-T05"></a>

## T05 · 实现 schema 2 和幂等仓储原语

里程碑：M1 · 建议负责人：后端工程师 · 状态：TODO

前置任务：T04。需求：F05、F06、F08、F09。

### 修改已有文件或目录

- `src/host/persistence/schema.ts`
- `src/host/persistence/repository.ts`
- `src/shared/types.ts`

### 计划新增文件

- `src/shared/home-contract.ts`
- `src/shared/task-contract.ts`
- `tests/unit/mvp-repository.test.mjs`

### 只读依据，不修改冻结历史

无。

所有路径相对于 `dsh-boop/`；新增路径是本方案建议的实现落点，尚不存在。目录项表示仅修改本任务实际涉及文件，不能据此批量重写。

### 实施步骤

1. 按03的表/索引/约束新增主绑定 journal、请求收据、观察/准入记录、结果快照及结果 outbox；复用原 task/action/command_outbox。
2. 将 task 计划版本与运行状态水位分开；运行状态转换不使现行 action 和证据失效。
3. 实现 request receipt+task+target+action+outbox 原子准备；同 scope/origin/request 同内容返回原关联，不同内容报冲突。
4. 把 claimOutbox(...).find 改为 action 精确 CAS；定义全局活动槽的事务占用、持有与有证据释放规则。
5. 结果快照不可变，唯一 result 逻辑键和原生消息 ID 可持久恢复；定义 read-model 和错误 DTO，不暴露数据库行对象给 UI。

### 完成标准

- 20次并发同请求只有一套业务记录；claim A 不改变 B；状态更新不变更 task planVersion。
- 旧task/fact/approval/forget/exclusion关键值保留；外键/唯一性验证通过。
- DTO分别标注已有字段与本轮新增字段；使用统一契约而非前后端各造状态。

### 验收与证据

关联用例：A02、A13、A14、A15、A16、A22、A24、A27、A32、A40。用例详情见 `06_验收用例.md`；这不是已有通过记录。
- schema migration diff
- 仓储并发与CAS断言
- DTO审查记录

<a id="task-T06"></a>

## T06 · 创建和找回真实 BOOP 主身份

里程碑：M1 · 建议负责人：后端/宿主集成工程师 · 状态：TODO

前置任务：T05。需求：F01、F02、F09。

### 修改已有文件或目录

- `src/host/main-session.ts`
- `src/host/api-service.ts`
- `src/host/api.ts`
- `src/host/remote.ts`
- `src/host/index.ts`
- `presets/boop.patch.yml`

### 计划新增文件

- `src/host/home/service.ts`
- `src/host/home/native-session.ts`
- `src/host/home/reference-guard.ts`
- `tests/host/mvp-home-identity.test.mjs`

### 只读依据，不修改冻结历史

无。

所有路径相对于 `dsh-boop/`；新增路径是本方案建议的实现落点，尚不存在。目录项表示仅修改本任务实际涉及文件，不能据此批量重写。

### 实施步骤

1. 实现03定义的 boop/ensureHome；读取原绑定和原生header/projection，正确旧Session走 resolveAgent，不反复 create。
2. 仅明确不存在时以持久 provisioning key 创建；显式 BOOP preset 与内部工作上下文，核验实际返回 ID/preset/cwd，再 flush 和绑定 CAS。
3. 把创建后绑定前崩溃作为恢复窗口；记录实际 native ID，禁止点击重试产生无限新 Session。
4. 旧 started Session 不兼容preset时保留历史关联和受限交接摘要；运行中的旧Session先待修复，不强停、不搬旧审批。
5. 把身份 ready、模型可用、委托能力分开；错误返回自然原因和 retryable，不让客户端fallback create。
6. 任何主会话输入/恢复前安装仅主agent scope的reference guard；按03真实waterfall次序在官方预读前降级无权限/排除/未知引用，保留人类正文附件。guard未安装不能开放可发送Home。

### 完成标准

- 并发打开、刷新、Host重启仍只有一个活动绑定；每个ready有真实原生事实。
- 旧聊天可打开；主入口不要求选择业务workspace；失败不会静默覆盖绑定。
- 用户普通 activeSession 和工作内容没有被主身份初始化改写。

### 验收与证据

关联用例：A01、A02、A07、A25、A26、A27、A39。用例详情见 `06_验收用例.md`；这不是已有通过记录。
- 主绑定/原生header关联
- 创建中断恢复记录
- 旧历史迁移演示

<a id="task-T07"></a>

## T07 · 接入独立 BOOP 页面和原生聊天实例

里程碑：M1 · 建议负责人：前端工程师 · 状态：TODO

前置任务：T03, T06。需求：F01、F02、F10。

### 修改已有文件或目录

- `src/client/index.tsx`
- `src/client/main-session.ts`
- `package.json`
- `build.mjs`

### 计划新增文件

- `src/client/home/index.tsx`
- `src/client/home/controller.ts`
- `src/client/home/BoopSession.tsx`
- `tests/client/mvp-home-lifecycle.test.mjs`

### 只读依据，不修改冻结历史

无。

所有路径相对于 `dsh-boop/`；新增路径是本方案建议的实现落点，尚不存在。目录项表示仅修改本任务实际涉及文件，不能据此批量重写。

### 实施步骤

1. 注册 boop.home 主面板与自有 boop.session 子槽，按02使用注入的 SessionProvider、显式 SessionReference 与 embedded Factory。
2. 统一页脚/侧栏/原任务板入口为 BOOP · 波波；进入先选择自有面板再异步ensure，不调用openSession主导航。
3. 在自有factory views中保留原生 conversation.session，让草稿、消息与历史绑定继续执行；不创建另一聊天控制器。
4. 以 generation/AbortController 控制过期请求，切走release，绑定变化先卸旧editor；tab级保存路由意图。
5. 声明实际宿主依赖，运行时能力由ctx/props提供；保持React外置，不深导入宿主内部TSX。

### 完成标准

- 冷启动、再次进入、刷新显示BOOP自有shell，历史加载不闪假空态。
- 打开来源才离开BOOP；普通activeSession不被入口替换。
- 反复切换和卸载无重复retain、订阅、editor、迟到导航。

### 验收与证据

关联用例：A01、A02、A05、A25、A33、A39、A41。用例详情见 `06_验收用例.md`；这不是已有通过记录。
- 组件生命周期断言
- 独立页面录像/截图
- loader及单React检查

<a id="task-T08"></a>

## T08 · 落地 BOOP 视觉外壳与欢迎态

里程碑：M1 · 建议负责人：前端/设计工程师 · 状态：TODO

前置任务：T07。需求：F01、F11。

### 修改已有文件或目录

- `src/client/brand.tsx`
- `src/client/header.tsx`
- `src/client/companion.tsx`
- `src/client/companion3d.tsx`
- `src/client/styles.ts`

### 计划新增文件

- `src/client/home/Header.tsx`
- `src/client/home/Welcome.tsx`
- `src/client/home/home-styles.ts`

### 只读依据，不修改冻结历史

无。

所有路径相对于 `dsh-boop/`；新增路径是本方案建议的实现落点，尚不存在。目录项表示仅修改本任务实际涉及文件，不能据此批量重写。

### 实施步骤

1. 按01的宽度、字号、色彩、间距、头像和抽屉规格实现；整页用可用高度，聊天居中。
2. 自有头部只保留波波身份、短状态、工作与设置；欢迎没有技术状态和三选一记忆卡。
3. 准备中、无模型、ready空态、有历史、需要恢复分别有明确文案和动作；有模型才显示可发送。
4. 缺模型时引导打开保留的DSH设置入口；不得调用不存在的uiSettings.open；已有模型可展开原生selector。
5. 静态BOOP头像可独立工作，3D按需增强，资源失败不阻断输入；所有样式局限data-boop-home。

### 完成标准

- 满足01视觉规格；深浅色可读，不出现窄列任务表和满屏工程字段。
- 1440/1280/768/390宽度均可访问内容和主操作；没有要求先选业务工作区。
- 无模型、无历史、绑定错误都不是无解释的禁用输入。

### 验收与证据

关联用例：A01、A17、A21、A34、A35、A41。用例详情见 `06_验收用例.md`；这不是已有通过记录。
- 各关键宽度与两主题截图
- 颜色对比测量
- 空/错态验收记录

<a id="task-T09"></a>

## T09 · 完善原生输入、草稿和断线状态

里程碑：M1 · 建议负责人：前端工程师 · 状态：TODO

前置任务：T07, T08。需求：F02、F07、F10、F11。

### 修改已有文件或目录

- `src/client/init.tsx`
- `src/client/interaction-styles.ts`
- `src/client/index.tsx`

### 计划新增文件

- `src/client/home/ComposerState.tsx`
- `tests/client/mvp-composer.test.mjs`

### 只读依据，不修改冻结历史

无。

所有路径相对于 `dsh-boop/`；新增路径是本方案建议的实现落点，尚不存在。目录项表示仅修改本任务实际涉及文件，不能据此批量重写。

### 实施步骤

1. 仅用稳定data-slot隐藏4个高级选择器和统计dock；更多入口可展开，真实审批/question/composer链始终保留。
2. 保留原生中文IME、附件、发送、停止本次回复和草稿持久化；不额外重复bindDraftPersistence。
3. 根据已验证connection信号进入断线态，保持草稿、显示未同步并禁用BOOP自己的派发/确认按钮；保留原生composer与审批链，不抢宿主conversation.blocks写权，不以settling隐藏审批。
4. 停止回复保留当前BOOP原生InputBar已绑定的停止回调；如另设按钮，只用该retain Session scope的conversation.cancel()，公开InputActions没有stop方法。工作卡停止走确定性任务接口，两者文字不同。
5. 清理旧新会话dock与全局入口；原生未知toast不假装能全部拦截，自有错误提供可读说明。

### 完成标准

- 中文组合键不误发送；切页/刷新草稿保留；附件原生链路有效。
- 长流可停止；委托任务不会随停止主回复一起取消。
- 断线重连无重复发送，无隐藏审批卡，无全站CSS影响。

### 验收与证据

关联用例：A04、A05、A06、A19、A20、A21、A33、A39、A41。用例详情见 `06_验收用例.md`；这不是已有通过记录。
- 原生输入交互记录
- 断线重连测试
- 普通Conversation前后对照

<a id="task-T10"></a>

## T10 · 扩展真实目录和有预算的近期上下文

里程碑：M2 · 建议负责人：后端工程师 · 状态：TODO

前置任务：T03, T05, T06。需求：F03、F04。

### 修改已有文件或目录

- `src/host/tools.ts`
- `src/host/workspace-api.ts`
- `src/host/workspace.ts`
- `src/host/observe/host-reader.ts`
- `src/host/memory/retrieval.ts`
- `src/host/home/reference-guard.ts`

### 计划新增文件

- `src/host/delegation/context.ts`
- `tests/host/mvp-context.test.mjs`

### 只读依据，不修改冻结历史

无。

所有路径相对于 `dsh-boop/`；新增路径是本方案建议的实现落点，尚不存在。目录项表示仅修改本任务实际涉及文件，不能据此批量重写。

### 实施步骤

1. 扩展现有boop_catalog与boop_context，复用真实异步目录/目标解析，不再走旧flat sync listSessions。
2. 以真实SessionID解析；同名返回候选；先metadata再选中目标正文，排除来源不出可用正文。
3. 只读选中目标，使用官方readEvent窗口和续读cursor；严格限制返回模型80条语义事件/24000字符预算，截断明确。rc.2内部可能加载此Session全日志，不宣称底层IO严格分页；禁止全库扫描。
4. Host签发contextToken，绑定scope、target、generation、head和最新直接用户指令水位；直接用户、代理、模型总结和事实来源区分。
5. 已有授权与明确点名范围不重复弹确认；访问排除范围返回可解释拒绝，不用模型意图修改scope。
6. 与T06已安装的主scope reference guard共享最新策略；撤销权限或排除后立即生效。官方外层reference读取前降级无权限canonical token，保留人类正文与顺序；不注册全站拦截、不修改DSH core。

### 完成标准

- 3个原会话含两个同名可正确区分；查询不会启动/新建所有会话。
- 旧摘要不能覆盖新直接指令；新指令使旧token失效；输出预算及续读来源正确，记录大Session实际读取成本。
- 记忆不足如实表达，不声称已读全部历史或底层IO已分页。

### 验收与证据

关联用例：A07、A08、A11、A12、A32、A42。用例详情见 `06_验收用例.md`；这不是已有通过记录。
- 目录前后计数
- 上下文预算与来源断言
- token新旧水位案例

<a id="task-T11"></a>

## T11 · 注册正式委托工具与主助理行为

里程碑：M2 · 建议负责人：后端/Agent工程师 · 状态：TODO

前置任务：T05, T06, T10。需求：F03、F04、F05、F07、F08。

### 修改已有文件或目录

- `src/host/tools.ts`
- `presets/boop.patch.yml`
- `src/host/index.ts`
- `src/host/api-service.ts`

### 计划新增文件

- `src/host/delegation/tool-contract.ts`
- `tests/host/mvp-model-tools.test.mjs`

### 只读依据，不修改冻结历史

无。

所有路径相对于 `dsh-boop/`；新增路径是本方案建议的实现落点，尚不存在。目录项表示仅修改本任务实际涉及文件，不能据此批量重写。

### 实施步骤

1. 新增boop_dispatch、boop_task_control；扩展既有catalog/context，名称与03唯一契约一致。
2. 按可信调用上下文取得mainSession、originUserMessage、scope和权限；这些信息不接受模型参数伪造。
3. 普通讨论只回答，明确行动才调用dispatch；唯一目标直接做，模糊目标先选择；候选卡不执行任意模型生成action。
4. 记录本次目标、限制和验收标准，原子准备任务/动作后快速返回queued；失败返回结构化原因。
5. 主preset说明来源优先级、结果回执不可授权、缺证据不宣称完成；模型工具无accept/approve/waive分支。

### 完成标准

- 正式工具注册及真实调用上下文校验成立；service由T12/T16接通后在T24联合验收。未接通返回unavailable，不用PoC伪装成功。
- 普通闲聊不生任务；相同工具重试不重复创建；来源消息无法伪造人类委托。
- 人类确认与原生审批不由模型自行完成。

### 验收与证据

关联用例：A03、A08、A09、A11、A13、A40。用例详情见 `06_验收用例.md`；这不是已有通过记录。
- 工具schema和注册记录
- 普通讨论/委托对照trace
- 伪造授权拒绝案例

<a id="task-T12"></a>

## T12 · 实现正式派发控制器与全局单活动槽

里程碑：M2 · 建议负责人：后端工程师 · 状态：TODO

前置任务：T05, T10, T11。需求：F05、F06、F07。

### 修改已有文件或目录

- `src/host/dispatch/dispatcher.ts`
- `src/host/index.ts`
- `src/host/persistence/repository.ts`

### 计划新增文件

- `src/host/delegation/service.ts`
- `src/host/delegation/controller.ts`
- `tests/host/mvp-queue.test.mjs`

### 只读依据，不修改冻结历史

无。

所有路径相对于 `dsh-boop/`；新增路径是本方案建议的实现落点，尚不存在。目录项表示仅修改本任务实际涉及文件，不能据此批量重写。

### 实施步骤

1. 业务入口正式装配控制器，不依赖PoC开关。准备事务与native调用、回写收据分别执行。
2. 按created_at/actionId选择最早满足条件者；busy等待不占全局槽，派发/已接收/运行/未知占槽。
3. 每次发送前精确claim并复核生命周期、计划版本、policy、目标和最新用户水位；新用户指令使旧动作转待处理。
4. 只空闲且无待处理用户输入时followup；禁止steer；queued只在BOOP outbox，主聊天不占此槽。
5. 未知发送不能按超时释放槽或发第二目标；只有证据settled/未发出/已撤回才释放。

### 完成标准

- 用真实账本与受控transport验证两目标队列和单槽，busy不阻塞其它可执行项；真实native派发在T13/T24联合验收，T13未通过前能力不放开。
- 手动修改计划/停止与dispatcher竞争时，旧action不越过最后复核。
- 没有将所有outbox条目提前claim的副作用。

### 验收与证据

关联用例：A09、A10、A11、A12、A13、A22、A37。用例详情见 `06_验收用例.md`；这不是已有通过记录。
- 双目标队列轨迹
- 精确claim断言
- 修改/停止竞争测试

<a id="task-T13"></a>

## T13 · 修复原生传输、持久收据和准入混批

里程碑：M2 · 建议负责人：宿主集成工程师 · 状态：TODO

前置任务：T03, T05, T12。需求：F05、F07、F10。

### 修改已有文件或目录

- `src/host/transport/dsh-adapter.ts`
- `src/host/transport/command-envelope.ts`
- `src/host/gate/pre-step.ts`
- `src/host/gate/pre-step-api.ts`
- `src/host/gate/recovery-gate.ts`

### 计划新增文件

- `tests/host/mvp-dispatch-admission.test.mjs`

### 只读依据，不修改冻结历史

无。

所有路径相对于 `dsh-boop/`；新增路径是本方案建议的实现落点，尚不存在。目录项表示仅修改本任务实际涉及文件，不能据此批量重写。

### 实施步骤

1. 以稳定messageId/actionId和boop-command来源构造消息，目标授权使用真实规则，不用默认allow-all。
2. 调用ctx.sessions.flush(agent.session)，false/异常区别处理；删除whenIdle充当flush的回退。
3. 区分pending、claimed、user/message持久化、运行和终止；claimed不冒充durable接收。
4. await downstream decision后只过滤被拒BOOP精确ID，保留人类及顺序；没有有效消息仅runtime-context时不空转，不等待120秒吞混批。
5. 准入记录可持久恢复，检查task版本、fence与停止意图；旧内存consumed Set不是唯一去重依据。
6. 与T10主scope引用guard分别验证：手贴被排除Session mention和过期候选不得触发原生readSurface；允许的引用和非BOOP普通会话按宿主原行为工作。

### 完成标准

- 真实现有Session收到一次正确指令，模型尚未执行前能阻止失效动作。
- 拒绝BOOP不吞同批用户消息；主会话之外的用户正常工作不中断。
- flush不可确认时保留unknown，不写durable-success。

### 验收与证据

关联用例：A07、A09、A12、A13、A22、A23、A24、A37、A38。用例详情见 `06_验收用例.md`；这不是已有通过记录。
- 真实native消息/事件
- 混批准入用例
- flush故障与收据断言

<a id="task-T14"></a>

## T14 · 观察精确执行并保存带证据的结果

里程碑：M2 · 建议负责人：后端工程师 · 状态：TODO

前置任务：T13。需求：F06、F08。

### 修改已有文件或目录

- `src/host/observe/observer.ts`
- `src/host/observe/host-reader.ts`
- `src/host/verify/verifier.ts`
- `src/host/tasks.ts`

### 计划新增文件

- `src/host/observe/action-observer.ts`
- `src/host/delegation/result-builder.ts`
- `tests/host/mvp-result-evidence.test.mjs`

### 只读依据，不修改冻结历史

无。

所有路径相对于 `dsh-boop/`；新增路径是本方案建议的实现落点，尚不存在。目录项表示仅修改本任务实际涉及文件，不能据此批量重写。

### 实施步骤

1. 用action/message→native turn→terminal事件关联执行，单独保存观察游标，不复用memory source_cursor。
2. 观测用户接管、失败、原生approval、已停止及真实terminal；乱序重复事件单调处理。
3. 生成不可变task_result：做了什么、产物引用、实际检查、未完成项、来源和对应版本。
4. 原生idle或一条completed文案不能完成任务；证据缺失/截断明确pending。
5. 验证器只消费对应版本真实证据；主Agent整理可作为摘要，不能自己签发通过。

### 完成标准

- 无关用户turn结束不会settle该action；结果能定位原始日志和产物。
- 有输出无测试记录不标passed；旧版本证据不能验新修订。
- 重复terminal不生成多个result。

### 验收与证据

关联用例：A12、A14、A15、A16、A17、A19、A38。用例详情见 `06_验收用例.md`；这不是已有通过记录。
- action→turn→result证据链
- 重复乱序事件测试
- 验收证据正反例

<a id="task-T15"></a>

## T15 · 可靠地把结果送回 BOOP 主聊天

里程碑：M2 · 建议负责人：后端工程师 · 状态：TODO

前置任务：T06, T14。需求：F06、F08。

### 修改已有文件或目录

- `src/host/transport/dsh-adapter.ts`
- `src/host/tasks-api.ts`
- `src/host/index.ts`

### 计划新增文件

- `src/host/delegation/result-publisher.ts`
- `tests/host/mvp-result-delivery.test.mjs`

### 只读依据，不修改冻结历史

无。

所有路径相对于 `dsh-boop/`；新增路径是本方案建议的实现落点，尚不存在。目录项表示仅修改本任务实际涉及文件，不能据此批量重写。

### 实施步骤

1. 先保存result再写同库result_outbox，确定唯一逻辑键和稳定nativeMessageId。
2. 向真实mainSession以boop-result来源followup；无执行授权，主聊天忙时等待，不steer。
3. 卡片从持久结果立即可读；聊天回报投递与结果本身分开，模型不可用不丢结果。
4. 发送后断线/崩溃通过精确pending/持久日志对账；证明已发补收据，证明未发才重发同ID，未知不盲发。
5. 避免同一结果自动重复通知；日常只在关键变化汇报，不轮询刷屏。

### 完成标准

- 同一完成事件重复10次只产生一份结果和一条有效主会话回执。
- 主聊天忙时不被打断；已知结果可在工作抽屉先查看。
- 回执不能成为新的dispatch授权来源；不宣称跨库天然exactly-once。

### 验收与证据

关联用例：A10、A14、A16、A17、A21、A22、A23、A40。用例详情见 `06_验收用例.md`；这不是已有通过记录。
- 回执ID与native收据
- 投递后收据前crash记录
- 主聊天不中断演示

<a id="task-T16"></a>

## T16 · 实现确定性停止且不误停用户工作

里程碑：M2 · 建议负责人：后端/宿主集成工程师 · 状态：TODO

前置任务：T13, T14。需求：F07、F11。

### 修改已有文件或目录

- `src/host/control.ts`
- `src/host/control-api.ts`
- `src/host/transport/dsh-adapter.ts`
- `src/host/tasks-api.ts`

### 计划新增文件

- `src/host/delegation/task-control.ts`
- `tests/host/mvp-exact-stop.test.mjs`

### 只读依据，不修改冻结历史

无。

所有路径相对于 `dsh-boop/`；新增路径是本方案建议的实现落点，尚不存在。目录项表示仅修改本任务实际涉及文件，不能据此批量重写。

### 实施步骤

1. 停止先持久化任务停止意图，所有后续gate/dispatcher读取；不依赖LLM回答。
2. 未投递取消精确outbox；已queued仅inbox.remove(messageId)并flush核对；不得因队列有BOOP就cancel当前用户turn。
3. running只有当前turn独占属于本action才native cancel；用户接管/混合/unknown只停未来BOOP动作并解释。
4. 取消请求返回不是已停；收到真实terminal或撤回收据后才更新stopped。
5. 保留停止前已产生的文件和证据，不暗示撤销已发生修改。

### 完成标准

- 模型不可用仍能停；queuedBOOP与runninghuman并存不误伤human。
- 独占BOOP运行能请求停止，pending阶段显示真实未完成停止。
- 已有新人工run不会被旧卡片停止；版本与动作归属校验有效。

### 验收与证据

关联用例：A06、A18、A21、A22、A23、A38。用例详情见 `06_验收用例.md`；这不是已有通过记录。
- 三种停止分支证据
- 人工接管回归
- 停止中UI投影

<a id="task-T17"></a>

## T17 · 实现人类验收和继续处理的新修订

里程碑：M2 · 建议负责人：后端/前端接口工程师 · 状态：TODO

前置任务：T14, T16。需求：F07、F08。

### 修改已有文件或目录

- `src/host/tasks-api.ts`
- `src/host/tasks.ts`
- `src/host/control-api.ts`
- `src/host/tools.ts`
- `src/host/verify/verifier.ts`

### 计划新增文件

- `src/host/delegation/confirmation.ts`
- `tests/host/mvp-confirmation.test.mjs`

### 只读依据，不修改冻结历史

无。

所有路径相对于 `dsh-boop/`；新增路径是本方案建议的实现落点，尚不存在。目录项表示仅修改本任务实际涉及文件，不能据此批量重写。

### 实施步骤

1. 人类confirm Remote绑定scope/taskVersion/resultId/requestId和真实UI动作；不注册为模型可approve的工具。
2. 接受当前结果记录user acceptance；测试通过与人类接受分别保留，用户接受不能写成test passed。
3. 继续处理通过明确反馈/新的原生主聊天指令形成同task新revision与action；旧证据与旧结果不可变。
4. 旧卡、双端重复、过期nonce或版本冲突返回已处理/需刷新，不重复完成或扩大权限。
5. 原生工具approval依旧在原Session批准/拒绝，BOOP只显示状态和入口。

### 完成标准

- 用户确认能完成所见版本；模型自称用户同意不能确认。
- 继续处理沿用任务身份并增加修订，派发仍按最新上下文和全局槽。
- 测试已通过不自动伪造用户确认；用户确认不伪造验证通过。

### 验收与证据

关联用例：A14、A15、A18、A19、A20、A40。用例详情见 `06_验收用例.md`；这不是已有通过记录。
- 人类接受记录
- 旧卡/双端/模型伪造测试
- revision来源与旧结果保留

<a id="task-T18"></a>

## T18 · 完成崩溃恢复和未知结果的核对

里程碑：M2 · 建议负责人：后端工程师 · 状态：TODO

前置任务：T06, T13, T14, T15, T16, T17。需求：F07、F09、F11。

### 修改已有文件或目录

- `src/host/gate/recovery-gate.ts`
- `src/host/dispatch/dispatcher.ts`
- `src/host/persistence/storage.ts`
- `src/host/control.ts`
- `src/host/index.ts`

### 计划新增文件

- `src/host/delegation/recovery.ts`
- `tests/host/mvp-crash-windows.test.mjs`

### 只读依据，不修改冻结历史

无。

所有路径相对于 `dsh-boop/`；新增路径是本方案建议的实现落点，尚不存在。目录项表示仅修改本任务实际涉及文件，不能据此批量重写。

### 实施步骤

1. 启动先恢复fence、来源身份、已知action/准入记录和主绑定，再允许新派发。
2. sending转unknown并从稳定ID追平原生证据；不完整日志/unclean/不可观测inbox不能推导未执行。
3. 覆盖enqueue前、enqueue后flush前、flush后账本收据前、result入主会话后收据前四窗。
4. unknown若无法排除当前执行继续占活动槽；用户可读核对和打开原会话，不提供盲重试按钮。
5. 重启只读恢复事实，继续旧业务需当前用户明确意图并满足新上下文，不照搬DS-Bot自动续跑。

### 完成标准

- 所有四窗都能解释恢复状态，不盲重复命令、不假完成。
- 真正不可判定者保持unknown并给出可操作入口，本身符合验收。
- 主身份恢复不增生，结果和旧指令不会作为新授权重放。

### 验收与证据

关联用例：A02、A18、A22、A23、A24、A26、A42。用例详情见 `06_验收用例.md`；这不是已有通过记录。
- 四窗fault报告
- 恢复前后native/DB对照
- 全局活动槽核对

<a id="task-T19"></a>

## T19 · 提供面向用户的工作与错误投影

里程碑：M3 · 建议负责人：后端/前端接口工程师 · 状态：TODO

前置任务：T05, T14, T16, T17。需求：F06、F08、F11。

### 修改已有文件或目录

- `src/host/tasks-api.ts`
- `src/host/tasks.ts`
- `src/host/control-api.ts`
- `src/host/api.ts`
- `src/shared/types.ts`
- `src/shared/task-contract.ts`

### 计划新增文件

- `src/host/delegation/projection.ts`

### 只读依据，不修改冻结历史

无。

所有路径相对于 `dsh-boop/`；新增路径是本方案建议的实现落点，尚不存在。目录项表示仅修改本任务实际涉及文件，不能据此批量重写。

### 实施步骤

1. 按03 DTO生成标题、目标简称、业务状态、最新结果、允许动作、来源；统一schemaVersion=2、taskVersion与stateSeq，不另造projectionVersion。
2. 允许动作由Host状态和归属决定，前端不从raw字符串猜是否可以stop/confirm/resume。
3. 技术错误码映射为影响、原因和下一步，原始信息留诊断；不把未知状态显示为失败或成功。
4. 列表有界分页与变更水位，离线保留旧事实但标未同步；刷新不创建任务。
5. 确定目标/结果链接只使用可信原生ID和结构化产物引用，不执行模型输出HTML或任意动作。

### 完成标准

- 01每种业务状态有唯一可解释投影，结果待确认与验证状态可同时表达。
- 失效卡操作在Host被拒并刷新；同一result与task版本一致。
- 首层DTO无必须给普通用户显示的scope/SQLite/门禁字段。

### 验收与证据

关联用例：A14、A15、A17、A18、A19、A21、A22、A34、A40。用例详情见 `06_验收用例.md`；这不是已有通过记录。
- DTO契约fixture
- 错误→文案映射
- 分页与版本冲突断言

<a id="task-T20"></a>

## T20 · 实现轻工作卡、工作抽屉和来源选择

里程碑：M3 · 建议负责人：前端工程师 · 状态：TODO

前置任务：T08, T09, T10, T15, T16, T17, T19。需求：F03、F06、F07、F08。

### 修改已有文件或目录

- `src/client/board.tsx`
- `src/client/taskboard/view-model.ts`
- `src/client/control-model.ts`
- `src/client/source.tsx`

### 计划新增文件

- `src/client/home/WorkDrawer.tsx`
- `src/client/home/WorkCard.tsx`
- `src/client/home/ResultCard.tsx`
- `src/client/home/TargetCandidates.tsx`

### 只读依据，不修改冻结历史

无。

所有路径相对于 `dsh-boop/`；新增路径是本方案建议的实现落点，尚不存在。目录项表示仅修改本任务实际涉及文件，不能据此批量重写。

### 实施步骤

1. 以19投影接真实工作列表，按需要处理/进行中/已交付或停止组织；无任务展示正常空态。
2. 首层卡展示工作目标、一句进度、关键结果与可用动作；隐藏任务版本/nonce/原始三轴状态。
3. 候选仅来自本主Session可信catalog结果；选择用02验证的reference chip写入原生草稿，用户发送后继续，不自动执行。
4. 结果包含做了什么、成果、实际验证和未完成项；确认收下/继续处理/停止任务接Host接口。
5. 来源按钮显式open精确原Session；BOOP页自有抽屉承载详情，不假称宿主rightbar在该页总可见。

### 完成标准

- 无需理解内部字段即可说明正在做什么、该不该操作、成果在哪。
- 卡片没有假百分比；点击不重复派发或确认旧版结果。
- 候选引用可读，普通唯一匹配不用再确认；打开来源后可回BOOP继续。

### 验收与证据

关联用例：A07、A08、A10、A14、A15、A17、A18、A19、A34、A35、A40。用例详情见 `06_验收用例.md`；这不是已有通过记录。
- 完整工作卡状态截图
- 原生候选chip交互
- 实际来源导航与返回

<a id="task-T21"></a>

## T21 · 收敛设置、历史与诊断入口

里程碑：M3 · 建议负责人：前端/后端工程师 · 状态：TODO

前置任务：T06, T08, T10, T19。需求：F01、F04、F09、F10、F11。

### 修改已有文件或目录

- `src/client/settings.tsx`
- `src/client/init.tsx`
- `src/client/index.tsx`
- `src/client/board.tsx`
- `src/host/memory/host-init.ts`
- `src/host/main-session.ts`

### 计划新增文件

- `src/client/home/SettingsPanel.tsx`
- `src/client/home/HistoryList.tsx`
- `src/client/home/Diagnostics.tsx`

### 只读依据，不修改冻结历史

无。

所有路径相对于 `dsh-boop/`；新增路径是本方案建议的实现落点，尚不存在。目录项表示仅修改本任务实际涉及文件，不能据此批量重写。

### 实施步骤

1. 设置只含模型引导、可访问工作范围、历史和可折叠诊断，范围读写沿用实际权限/排除规则。
2. 废止三选一记忆起点作为必要步骤；日常不展示source cursor/gate/sqlite/内部ID。
3. 旧主Session保留历史段入口，明确当前活动段；不将旧消息重放成新指令。
4. 复制诊断只含排查所需版本和ID等事实，过滤密钥、token、敏感本机路径与不必要正文。
5. 旧board仅从高级诊断可达或按引用清理；普通DSH新会话页不再插BOOP初始化卡。

### 完成标准

- 新用户可先聊；旧用户找得到历史、范围与现有记忆规则。
- 遗忘/排除规则升级后仍有效；重新打开页面不会扫描全部历史。
- 普通会话无BOOP欢迎卡或强制绑定。

### 验收与证据

关联用例：A01、A07、A25、A26、A32、A33、A34、A41、A42。用例详情见 `06_验收用例.md`；这不是已有通过记录。
- 设置/历史截图
- 脱敏示例
- 普通DSH新会话对照

<a id="task-T22"></a>

## T22 · 清理默认日程与无关后台工作

里程碑：M3 · 建议负责人：后端工程师 · 状态：TODO

前置任务：T06, T12, T15, T18。需求：F06、F09、F10。

### 修改已有文件或目录

- `src/host/scheduler.ts`
- `src/host/scheduler-api.ts`
- `src/host/patrol.ts`
- `src/host/memory/host-init.ts`
- `src/host/memory/lifecycle.ts`
- `src/host/index.ts`
- `cordis.patch.yml`

### 计划新增文件

- `tests/host/mvp-background-scope.test.mjs`

### 只读依据，不修改冻结历史

无。

所有路径相对于 `dsh-boop/`；新增路径是本方案建议的实现落点，尚不存在。目录项表示仅修改本任务实际涉及文件，不能据此批量重写。

### 实施步骤

1. 只跟踪本次受托工作；目录按需查、正文按需读；无活跃任务时停止无意义的高频轮询。
2. 识别并停用可证明由旧BOOP创建的默认9点日程绑定；不按时间/标题批量删除用户或其他插件日程。
3. 本轮不新增每日摘要、全量历史初始化、全库记忆提取和自动续跑任务。
4. 主页面关闭只释放UI订阅，不中断合法在途委托；插件卸载正确释放自己后台句柄，保留可恢复事实。
5. 回执只在关键状态变化发布，用户问进度时读账本，不让主Agent长轮询等待。

### 完成标准

- 退出页面后在途结果仍可持久保存；不影响普通宿主工作。
- 重启没有新9点任务、隐式全量扫描或旧命令自动重放。
- 用户自己的同时间计划原样保留。

### 验收与证据

关联用例：A10、A16、A23、A33、A41、A42。用例详情见 `06_验收用例.md`；这不是已有通过记录。
- 后台句柄与调度对照
- 只停BOOP自有日程案例
- 重启空闲观察

<a id="task-T23"></a>

## T23 · 完成定向复用、移除无关打包与来源记录

里程碑：M3 · 建议负责人：前端/集成工程师 · 状态：TODO

前置任务：T07, T08, T09, T20, T21, T22。需求：F01、F10、F12。

### 修改已有文件或目录

- `src/client/index.tsx`
- `src/client/styles.ts`
- `src/client/taskboard/`
- `build.mjs`
- `package.json`
- `cordis.patch.yml`

### 计划新增文件

- `docs/refactor/boop-mvp-v0.2/reuse-ledger.json`

### 只读依据，不修改冻结历史

无。

所有路径相对于 `dsh-boop/`；新增路径是本方案建议的实现落点，尚不存在。目录项表示仅修改本任务实际涉及文件，不能据此批量重写。

### 实施步骤

1. 按07白名单逐文件适配DS-Bot identity/header、轻状态、详情抽屉和native delivery思路；记录copied/adapted/design-reference。
2. 不导入DS-Bot shell/conversation全局shadow、themes全局CSS、web.searchProvider默认、Bot roster或app壳。
3. 删除确实失去引用的旧业务入口和产物；保留必要diagnostics与旧数据读法；不要为瘦身删有效恢复保护。
4. React及宿主公开运行时模块仍external；检查产物没有另一套React、DS-Bot已打包client.js或不需要资源。
5. 移植文件保留Apache署名/许可证/修改声明；旧taskboard来源记录仅在对应代码确实全部移除时调整。

### 完成标准

- 每个复制或改写文件有来源SHA、路径、目的、改动与验收映射。
- 停用插件恢复普通DSH界面、默认模型/搜索/主题不被改写。
- 包内无未用大资产、秘密、证据日志或测试profile。

### 验收与证据

关联用例：A33、A36、A39、A41。用例详情见 `06_验收用例.md`；这不是已有通过记录。
- 复用ledger
- 构建产物清单
- 许可证与全局副作用审查

<a id="task-T24"></a>

## T24 · 跑通自然语言真实产物闭环

里程碑：M4 · 建议负责人：QA/集成工程师 · 状态：TODO

前置任务：T09, T15, T16, T17, T18, T20, T21, T22, T23。需求：F01、F02、F03、F04、F05、F06、F07、F08。

### 修改已有文件或目录

- `tools/web-e2e.mjs`
- `tests/host/e05-00-real-gold.test.mjs`
- `tools/qwen-gold.mjs`

### 计划新增文件

- `tests/host/mvp-golden-flow.test.mjs`
- `tools/mvp-e2e.mjs`

### 只读依据，不修改冻结历史

无。

所有路径相对于 `dsh-boop/`；新增路径是本方案建议的实现落点，尚不存在。目录项表示仅修改本任务实际涉及文件，不能据此批量重写。

### 实施步骤

1. 在隔离profile创建两个既有workspace和至少三个Session，再从BOOP首页自然语言发出01第8节任务。
2. 实际修复临时演示项目窄屏问题并运行检查；保存产物diff、执行日志和action/turn关联；不提交不部署。
3. 演示同名选择、上下文更新、原Session忙时等待、主聊天继续、结果回来一次、用户确认和下一轮补改。
4. 分别报告可控模型fixture与真实已配置模型路由；真实模型缺配为SKIPPED，不能替代最终发布所需演示。
5. 新增mvp-e2e CLI后才记录真实flags，--help与文档一致，不在方案中提前编造现成命令。

### 完成标准

- 用户仅在页面操作即可完成，不能直接种一条done任务替代委托。
- 目标确实是既有Session，产物可定位，已交付与验证/确认区别可见。
- 整个过程中普通DSH可继续用。

### 验收与证据

关联用例：A01、A02、A03、A04、A05、A06、A07、A08、A09、A10、A11、A12、A13、A14、A15、A16、A17、A18、A37、A40。用例详情见 `06_验收用例.md`；这不是已有通过记录。
- 端到端录像/截图索引
- 真实项目diff与检查结果
- native+ledger关联清单

<a id="task-T25"></a>

## T25 · 验证故障、审批并发与精确控制

里程碑：M4 · 建议负责人：QA/后端工程师 · 状态：TODO

前置任务：T18, T19, T20, T24。需求：F05、F07、F08、F11。

### 修改已有文件或目录

- `tests/host/e07-01-fault-approval-concurrency.test.mjs`
- `tests/host/e07-01-fault-kill-restart.test.mjs`
- `tests/host/e07-01-fault-model-down.test.mjs`

### 计划新增文件

- `tests/host/mvp-fault-matrix.test.mjs`

### 只读依据，不修改冻结历史

无。

所有路径相对于 `dsh-boop/`；新增路径是本方案建议的实现落点，尚不存在。目录项表示仅修改本任务实际涉及文件，不能据此批量重写。

### 实施步骤

1. 执行A19–A24、A37–A40，包括原生批准/拒绝/过期/双端、模型不可达、响应丢失、杀Host、第二Host和人工接管。
2. 故障注入覆盖03定义四个跨存储窗口；验证每种未知保留和全局槽占位。
3. 验证混批过滤、queued删除与running独占cancel，必须有native terminal及用户消息保留证据。
4. 确认模型不能验收、不能批准，旧卡和旧版本不能操作新结果。
5. 真实不可判定保留unknown记为正确行为，不把测试目标设成所有状态都绿色。

### 完成标准

- 没有重复业务执行、吞用户消息或误停后来的人工turn。
- 每个故障能定位最后已确认阶段与用户下一步。
- FAIL必须修复并只重跑受影响链；不改预期掩盖问题。

### 验收与证据

关联用例：A12、A13、A15、A18、A19、A20、A21、A22、A23、A24、A37、A38、A40。用例详情见 `06_验收用例.md`；这不是已有通过记录。
- fault-matrix.json
- 关键时窗原生事件
- 并发/双Host/模型不可用证据

<a id="task-T26"></a>

## T26 · 演练旧数据升级与真正跨版本回滚

里程碑：M4 · 建议负责人：QA/后端工程师 · 状态：TODO

前置任务：T04, T05, T06, T18, T21, T23。需求：F09、F12。

### 修改已有文件或目录

- `tools/rehearse-install.mjs`
- `tools/package-boop.mjs`
- `tests/host/e01-01-storage-in-host.test.mjs`

### 计划新增文件

- `tests/host/mvp-upgrade-rollback.test.mjs`

### 只读依据，不修改冻结历史

无。

所有路径相对于 `dsh-boop/`；新增路径是本方案建议的实现落点，尚不存在。目录项表示仅修改本任务实际涉及文件，不能据此批量重写。

### 实施步骤

1. 使用真实0.1.0包建立v1 fixture，保存主会话、任务、事实、审批历史、遗忘与排除规则；保留原生Session日志。
2. 安装新包执行迁移，检查旧数据、历史入口与新schema；模拟DDL中断、备份失败/磁盘不足、future schema。
3. 按05先停进程、保留新数据与日志、用一致备份回旧包；不要把旧主DB与新WAL拼接。
4. 验证回滚不撤销已执行的项目文件和原生消息；不自动重放升级后已做过的动作。
5. 同版本重装另记，不能代替old.tgz→new.tgz→old.tgz。

### 完成标准

- 升级前后关键数据可比较，故障原子性成立；回滚包与备份版本配套。
- 保留新版本期间产生的数据归档，告知需核对的任务，不造成静默遗失。
- 原生历史和用户自定义日程不被回滚脚本批量覆盖。

### 验收与证据

关联用例：A02、A25、A26、A27、A28、A29、A30、A31、A32、A42。用例详情见 `06_验收用例.md`；这不是已有通过记录。
- old/new包SHA256
- 备份/迁移/回滚manifest
- 数据计数与关键值对照

<a id="task-T27"></a>

## T27 · 验收视觉、可访问性与宿主隔离

里程碑：M4 · 建议负责人：产品/设计/QA · 状态：TODO

前置任务：T09, T20, T21, T22, T23, T24。需求：F01、F02、F10、F11。

### 修改已有文件或目录

- `tools/web-e2e.mjs`
- `tools/web-e2e-control.mjs`
- `tests/client/`

### 计划新增文件

- `docs/refactor/boop-mvp-v0.2/evidence/ui-review.md`

### 只读依据，不修改冻结历史

无。

所有路径相对于 `dsh-boop/`；新增路径是本方案建议的实现落点，尚不存在。目录项表示仅修改本任务实际涉及文件，不能据此批量重写。

### 实施步骤

1. 按01在两主题、不同宽度、空/错/工作/结果状态逐屏验收；测文字与焦点对比度。
2. 键盘遍历、抽屉焦点回归、中文IME、减少动画、长消息与消息到达时滚动行为。
3. 从BOOP切普通会话、设置、插件停启，检查样式/事件/编辑器实例和草稿没有相互污染。
4. 检查缺模型的真实引导、未知原生toast限制、文件来源导航和离线保留状态，没有虚构按钮能力。
5. 让非开发角色说明当前做什么、是否要操作、结果在哪；若必须读工程术语才理解，该项不通过。

### 完成标准

- A34/A35按具体断言通过；首屏没有技术任务表，符合全部关键布局规格。
- 切换/停用后宿主默认模型、搜索、主题和其他插件功能保持。
- 证据含已知宿主限制，不把截图当功能正确证明。

### 验收与证据

关联用例：A01、A04、A05、A06、A17、A21、A33、A34、A35、A39、A41、A42。用例详情见 `06_验收用例.md`；这不是已有通过记录。
- 两主题多尺寸截图
- 键盘与读屏命名检查
- 宿主前后对照和用户理解记录

<a id="task-T28"></a>

## T28 · 验证兼容矩阵并生成可安装候选包

里程碑：M4 · 建议负责人：QA/发布工程师 · 状态：TODO

前置任务：T02, T23, T24, T25, T26, T27。需求：F10、F12。

### 修改已有文件或目录

- `package.json`
- `build.mjs`
- `tools/package-boop.mjs`
- `tools/verify_package.py`
- `tools/desktop-gui-probe.mjs`

### 计划新增文件

- `docs/refactor/boop-mvp-v0.2/evidence/compatibility.json`
- `docs/refactor/boop-mvp-v0.2/evidence/package-manifest.json`

### 只读依据，不修改冻结历史

无。

所有路径相对于 `dsh-boop/`；新增路径是本方案建议的实现落点，尚不存在。目录项表示仅修改本任务实际涉及文件，不能据此批量重写。

### 实施步骤

1. 在明确实际版本的rc.2 Web/Desktop和rc.3 Web/Desktop执行05的最小必测组合，记录OS/Node/app/payload真实来源。
2. 声称支持的范围必须有对应证据；环境缺失记录BLOCKED，不把rc.2 Web通过外推rc.3 Desktop。
3. 从同一候选SHA构建原包名的tgz；验证文件白名单、依赖、React external、assets和许可证。
4. 干净安装、旧包升级、禁用恢复普通DSH；记录包哈希与报告SHA对应。
5. 同时核对engines与四项当前精确rc.2的peerDependencies；声明rc.3支持须验证其安装不额外混装另一份DSH。按实际证据设置engine/peer范围，不偷偷更换用户宿主。
6. 冻结包内README、版本和许可证后再生成最终候选包；任何后续包内修改都重新构建、打包并按影响重验，更新SHA关联。

### 完成标准

- 候选包可追溯到已验SHA；包内不含用户profile/密钥/临时报告。
- 兼容矩阵没有把未运行写PASS；所声明环境均符合发布条件。
- 用户安装说明明确版本、备份和已知限制。

### 验收与证据

关联用例：A01、A02、A09、A18、A25、A27、A31、A33、A36、A39、A41。用例详情见 `06_验收用例.md`；这不是已有通过记录。
- 四组合矩阵
- 包文件清单和哈希
- 干净安装/禁用记录

<a id="task-T29"></a>

## T29 · 完成交付审查与发布说明

里程碑：M4 · 建议负责人：技术负责人/产品/QA · 状态：TODO

前置任务：T28。需求：F01、F02、F03、F04、F05、F06、F07、F08、F09、F10、F11、F12。

### 修改已有文件或目录

无。

### 计划新增文件

- `docs/refactor/boop-mvp-v0.2/evidence/release-review.md`
- `docs/refactor/boop-mvp-v0.2/evidence/acceptance-results.json`

### 只读依据，不修改冻结历史

- `README.md`
- `package.json`
- `manifests/FROZEN_BASELINE.json`

所有路径相对于 `dsh-boop/`；新增路径是本方案建议的实现落点，尚不存在。目录项表示仅修改本任务实际涉及文件，不能据此批量重写。

### 实施步骤

1. 核对29个工单交付、42项验收状态、候选包SHA、兼容矩阵及问题清单；证据必须来自本次候选构建。
2. 审查已在T28打包前冻结的用户README：进入BOOP、委托已有会话、结果、两种停止、历史和回滚。若需再改包内README/package/许可证，返回T28重建重验并刷新包哈希。
3. 完成包外工程说明与证据索引：接口/schema/实际命令/来源ledger/已知宿主限制；包内文件遵守T28冻结规则，不把草稿规范当已实现文档。
4. 既有G01–G09按变更影响重验；G07 IM在本MVP未启用，不为了全绿引入IM范围。任何阻塞项不能手工改PASS。
5. 将可安装包、证据索引、迁移与回滚说明交付审阅；是否推送、合并或发布按实际项目授权执行。

### 完成标准

- 产品成功闭环、工程可靠性和升级路径都可由第三人复核。
- 没有“仅UI完成”的冒充版本；所有限制和未支持环境写清。
- 发布状态由证据决定；BLOCKED项没有被当作已交付。

### 验收与证据

关联用例：A01、A02、A03、A04、A05、A06、A07、A08、A09、A10、A11、A12、A13、A14、A15、A16、A17、A18、A19、A20、A21、A22、A23、A24、A25、A26、A27、A28、A29、A30、A31、A32、A33、A34、A35、A36、A37、A38、A39、A40、A41、A42。用例详情见 `06_验收用例.md`；这不是已有通过记录。
- release-review.md
- 验收结果台账
- 版本说明与完整交付清单


---

<a id="c05"></a>

# BOOP v0.2 MVP 迁移与发布验收

> 类型：实施规格与发布门槛。实现位置：原 `dsh-plugin/dsh-boop/`。  
> BOOP 基线：`98991899eecea6c6af1faa158e92cb73e555a5a5`；DS-Bot 复用基线：`4a7b55069ad300eae8be42a74f31bc170b40ead7`。  
> 本交付没有运行安装、构建、测试、迁移或用户验收。四种宿主组合和 42 条用例的新版状态均为 **NOT_RUN**。命令核对表示调用形式存在，不表示已执行成功。

## 1. 仓库边界与版本管理

保留原包名 `dsh-boop`、原 bundle 关系、BOOP 品牌及 `$DSH_HOME/boop/boop.sqlite` 数据目录。源码重构在原目录内完成，不建立一个与旧插件平行的 DS-Bot 产品或第二套任务账本。

固定父提交把 `dsh-boop` 保存为普通目录快照，提交说明明确父仓按文件存储插件；GitHub tree 中它不是 gitlink。该事实不能证明用户本地没有嵌套 `.git`，不能据此替用户选择真实工作仓。[父提交说明][c05-S00]

在现有 `dsh-plugin` checkout 根目录执行以下只读检查，记录真实顶层、当前修改和父仓追踪方式：

```powershell
git rev-parse --show-toplevel
git status --short
git log -1 --oneline
git -C dsh-boop rev-parse --show-toplevel
git -C dsh-boop status --short
git ls-files --stage dsh-boop
```

两个 `show-toplevel` 不同则记录嵌套关系，在真正拥有源码的现有仓库建立工作分支。不能擅自初始化新仓、删除 `.git`、改变子模块关系或覆盖用户未提交修改。

本次文档、ADR 和新版验收记录放在 `dsh-boop/docs/refactor/boop-mvp-v0.2/`。旧 `baseline/`、`handoff/`、历史 STATUS 与 evidence 保留历史事实；新规格只覆盖本轮明确改变的产品和实现约束，不把旧记录改写成新版通过证明。

## 2. 兼容范围与证据边界

### 2.1 四种最小目标组合

现包 `engines.dsh` 声明 rc.2 与 rc.3，四项 DSH peer 却精确固定 rc.2。版本声明与完整运行验收分开处理。[包声明][c05-S01]

| Windows x64 组合 | 旧基线证据的准确含义 | v0.2 必须验证 | v0.2 状态 |
|---|---|---|---|
| DSH 0.2.1-rc.2 / Web | 旧支持矩阵记录隔离 Host、存储、控制与部分浏览器结果；载荷提交 `332895e0f7c9d4dbfb29729f5eb367fa263ff986` | 独立主页、真实聊天/委托/结果、停止、原生审批导航、宿主共存、安装与恢复 | NOT_RUN |
| DSH 0.2.1-rc.2 / Desktop | 用 Desktop 提取载荷运行 Web 的记录不等同于此版本 Electron GUI 验收 | 实际该版本 Desktop 窗口中的相同主路径及启停/重启 | NOT_RUN |
| DSH 0.2.1-rc.3 / Web | 包声明允许；旧材料没有此 standalone Web 组合的完整运行矩阵 | 实际 rc.3 Web Host 的适配器与主路径 | NOT_RUN |
| DSH 0.2.1-rc.3 / Desktop | 旧 GUI 报告覆盖私有窗口、主题、旧任务板、停启和单 React；载荷提交 `be72761ee1a6736ebcdf4f3739363b083ae53c98` | 新独立页的完整闭环、升级、停止和恢复，不能仅证明页面出现 | NOT_RUN |

历史依据以 [当前支持矩阵][c05-S09] 和 [rc.3 Desktop GUI 报告][c05-S10] 为准。旧日期报告可保留为背景，不能从不同日期拼接出“新版全部支持”。

缺少对应二进制、真实模型或宿主能力时，该格记录 BLOCKED 或 NOT_RUN 及具体原因；不得借另一格通过替代。macOS、Linux、其他架构不在本次已声明验收结果内。Web 与 Desktop 同时访问同一数据域的单写者与输入所有权须单独留证，不能以 Web 双 Host 测试等同证明。

### 2.2 运行事实必须自动采集

每份报告记录 candidate commit/dirty、包版本和 SHA-256、宿主真实版本/commit、OS/架构、开发 Node、宿主 Node、pnpm、浏览器/Desktop 版本、fixture、模型可控或真实、caseId 和证据地址。commit 获取不到则写 `unknown` 并注明来源；禁止沿用脚本内硬编码的旧 rc.2 commit。

主流程须从实际 BOOP 页面输入自然语言，经过正式模型工具与精确目标 Session 执行，再回到主聊天。直接种任务、PoC 派发或截图不构成此闭环。

## 3. 工程机准备与现有执行命令

### 3.1 已知阻塞与修正范围

| 项目 | 基线实际情况 | 实施要求 |
|---|---|---|
| Node | 包声明 `^22.19.0 || >=24.0.0`；锁定的 jsdom 30.1.3 等开发依赖要求 `^22.22.2 || ^24.15.0 || >=26.0.0` | 开发验证先使用旧证据中的 Node 24.18.0 或 24.21.0；固定实际选用版本，开发 Node 与宿主 Node 分开记录 |
| pnpm | `package.json` 没有固定 `packageManager`；workspace 使用 `allowBuilds` | 选择确实支持配置与 lock 的确切 pnpm 版本，验证后固定；不能默认机器上的任意 pnpm 可用 |
| lock 可移植性 | 固定文件中未发现 `file:`、`link:`、`workspace:`、Windows 绝对路径、目录或 tarball 路径依赖；主 importer 有四项 rc.2 DSH peer，`autoInstallPeers=true` | registry/store 必须提供锁定版本及 integrity；不要把完整宿主依赖图当作只含 React 的安装 |
| npm test | 指向 `tests/*.test.mjs`，实际测试在 unit/client/host 子目录 | 修正脚本或明确使用已有 regression 编排器；不能把旧 npm test 当全套验收入口 |
| 客户端测试 | 依赖 build 生成的 `lib/client.js` 与测试 bundle | build 在客户端测试之前；esbuild 成功不等于 TypeScript 检查通过 |
| typecheck | 现命令是 `tsc --noEmit`；旧 STATUS 承认尚未全绿 | 记录真实基线及具体错误；修复本次触及接口和新增错误，不添加 `@ts-nocheck` 掩盖，不把已有失败写成 PASS |
| Host helper | `DSH_NODE`、`DSH_PAYLOAD` 可覆盖；pnpm 脚本路径硬编码到作者个人 Windows 目录 | 提取统一环境模块，参数化 pnpm 路径，使用参数数组启动，不拼 shell 字符串 |
| payload 路径 | 提取脚本默认目的地与 helper 默认目录不同 | 显式指定提取目的地和 `DSH_PAYLOAD`，每版本使用新的独立目录 |
| 宿主事实 | helper 和 regression runner 的 `pinnedCommit` 固定 rc.2 | 从实际载荷/App 元数据读取，不能在 rc.3 报告填 rc.2 值 |
| Web E2E | 旧页面选择器、rc.2 常量及历史内网模型默认值 | 更新到新主页；测试模型显式配置或本地可控响应，缺配置不访问历史内网地址 |
| Desktop probe | 固定 EXE、端口 9333、历史运行 fixture 目录 | 参数化实际 EXE，创建新隔离 profile，动态分配端口；不得要求工程机存在作者旧目录 |
| 升级演练 | 旧脚本安装并再次安装同一 tarball | 新增两个真实版本的 old→new→old 演练；不能把同包重装当版本迁移通过 |

依据：[package.json][c05-S01]、[build.mjs][c05-S02]、[workspace][c05-S03]、[lock][c05-S04]、[STATUS][c05-S18]、[Host helper][c05-S12]、[回归入口][c05-S11]、[Desktop probe][c05-S14]、[同包重装声明][c05-S15]。`allowBuilds` 自 pnpm 10.26.0 支持，版本选择须兼顾项目实际工具链。[pnpm 官方设置][c05-P01]

依赖修复限于已定位问题。不得删除 lock、全量 `pnpm update`、无范围 `--no-frozen-lockfile`，或全选批准构建脚本来换取通过。保留现有构建脚本许可约束。确需修改依赖时，明确包、原因、版本和 lock 差异，其余依赖保持。

### 3.2 安装前检查与候选冻结安装：现有命令

进入原仓的 `dsh-boop`。先选择 Node/pnpm，核对实际版本与 registry 是否可访问；以下是 **待执行** 的 PowerShell 命令，不是安装成功记录。不要导出全部环境或 pnpm 认证配置。

```powershell
node --version
pnpm --version
pnpm config get registry
$boopDependencyFiles = @('package.json', 'pnpm-workspace.yaml', 'pnpm-lock.yaml')
$boopBeforeInstall = Get-FileHash -LiteralPath $boopDependencyFiles -Algorithm SHA256
pnpm install --frozen-lockfile
if ($LASTEXITCODE -ne 0) { throw 'Install failed. Record the error and diagnose without rewriting the lockfile.' }
$boopAfterInstall = Get-FileHash -LiteralPath $boopDependencyFiles -Algorithm SHA256
$boopInstallDiff = Compare-Object -ReferenceObject $boopBeforeInstall -DifferenceObject $boopAfterInstall -Property Path, Hash
if ($boopInstallDiff) { throw 'Dependency files changed during installation. Review the scoped diff before building.' }
```

`--frozen-lockfile` 是验证可复现安装的候选方式；它会在 lock 与清单不一致或需要更新时失败，并不保证任何机器一定安装成功。[pnpm 官方安装说明][c05-P02] 失败后保留错误码、Node/pnpm 版本、依赖文件哈希，先区分 engine、工具版本、registry、网络或清单问题；后续 build 暂停，不能静默重生成全部依赖。

### 3.3 构建、离线回归与打包：现有命令

依赖准备完成后逐项执行，前一步失败先处理，不把后续结果覆盖失败。输出目录是本次交付下的新 evidence，不改写历史证据。

```powershell
node build.mjs
pnpm run typecheck
node tools/run-regression.mjs --list
node tools/run-regression.mjs --only=offline --label=boop-mvp-v0.2-baseline --out=docs/refactor/boop-mvp-v0.2/evidence/offline-baseline.json
node tools/package-boop.mjs --out dist/boop-mvp-v0.2 --json
```

这里 `run-regression` 的参数写法是 `--out=path`，`package-boop` 是 `--out path`。offline 枚举 unit 和 client 测试；打包器按运行导出和 bundle 白名单生成 tarball/manifest，不自动安装或发布。[回归入口][c05-S11]、[打包器][c05-S17]

TypeScript 错误必须独立记录。若先采集其他基线结果，报告中保留 typecheck 失败项；发布时不能宣称“所有检查通过”。

### 3.4 提取与 Host/真实模型编排：入口存在，须先修环境

当前提取器已有 `DSH_ASAR`、`DSH_UNPACKED` 环境覆盖和位置参数目的目录。由工程师设置真实的同版本安装载荷位置；目的地使用新目录。当前提取器会处理其目标目录，不能随意指向已有工作数据。[提取器][c05-S13]

```powershell
node tools/build-test-payload.mjs .work/test-host/payload-rc2-candidate
$env:DSH_PAYLOAD = (Resolve-Path .work/test-host/payload-rc2-candidate/dsh).Path
```

上例只有在 `DSH_ASAR`、`DSH_UNPACKED` 指向实际 rc.2 文件时才代表 rc.2；不能靠目录名称声称版本正确。rc.3 使用另一个新目录与对应实际载荷。`DSH_NODE` 也必须指向合格可执行文件。pnpm 硬编码和事实采集修正前，这些环境变量不足以使 Host 套件可移植。

完成前置改造后，以下原编排入口仍可复用：

```powershell
node tools/run-regression.mjs --only=host --label=boop-mvp-v0.2-host --out=docs/refactor/boop-mvp-v0.2/evidence/host.json
node tools/run-regression.mjs --only=host --host-filter=e07-01 --label=boop-mvp-v0.2-fault --out=docs/refactor/boop-mvp-v0.2/evidence/fault.json
node tools/run-regression.mjs --only=real --label=boop-mvp-v0.2-real --out=docs/refactor/boop-mvp-v0.2/evidence/real.json
```

real 组要求 `BOOP_QWEN_BASE_URL` 与 `BOOP_QWEN_MODEL`；密钥由测试环境配置传入，不输出值。缺配置为 SKIPPED。旧 Host/real 运行器按单并发运行，不能把多个共享测试 profile 的套件同时启动。

现有 Web 命令只说明旧入口存在。更新选择器、模型默认值、目标宿主事实采集后，才能证明新主页：

```powershell
node tools/web-e2e.mjs --edge-channel msedge --out docs/refactor/boop-mvp-v0.2/evidence/web
node tools/web-e2e-control.mjs --edge-channel msedge --out docs/refactor/boop-mvp-v0.2/evidence/control
```

此处要求实际可用的 Edge；不能把 jsdom 结果当作真实浏览器证据。Desktop 原脚本存在个人目录硬编码，现阶段不提供一个虚假的“跨机器可执行”命令。

### 3.5 必须新增或改造的工具契约

下表是 **待实现能力，不是基线已有命令或参数**。实现任务须同时补 CLI 帮助、失败退出码和实际调用示例，之后才把新命令纳入工程手册。

| 能力 | 必需输入 | 行为与输出 |
|---|---|---|
| 统一测试环境模块 | 现有 `DSH_NODE`/`DSH_PAYLOAD`；新增可配置 pnpm、Desktop EXE、目标版本 | pnpm 路径契约明确到 `.cjs` 或可执行文件类型；使用 argv 数组；校验路径和版本；不依赖个人目录；缺项明确 BLOCKED |
| 新 Desktop 验收入口 | 真实 EXE、新 fixture、动态端口、输出路径 | 自建隔离 profile；仅清理自己启动的进程；记录真实 App/载荷版本与 GUI 证据 |
| 迁移维护入口 | 原数据域、目标 schema、备份目录、旧新包哈希 | inspect/backup/apply/report 分步能力；不能启动模型、派发器或历史学习；失败有可恢复现场 |
| 受控恢复入口 | 升级前快照及 manifest、升级后现场、旧包 | 校验数据域与包/库组合；要求全部同域 Host 停止；保留升级后事实，禁止盲回放 |
| 双版本升级演练 | 两个不同版本的 tarball、fixture、目标宿主 | 真正 old→new→old；结果保留两包 SHA、迁移/回滚报告、原生历史及未重放证明 |
| 新主路径 E2E | 实际 BOOP UI、模型路由、精确目标、临时项目 | 走用户语言到执行再回报，不依赖 PoC-only/直接种库捷径 |

## 4. 数据迁移实施方案

### 4.1 当前实现必须先纠正的顺序

当前数据库使用 WAL、`foreign_keys=ON`、`synchronous=FULL`，schema 常量为 1。`bootstrap()` 执行 DDL、可能无版本 `ALTER subject_key`，然后无条件写当前 `schema_version`；storage 构造时立即调用它，而 `migrateNow()` 是独立方法。现迁移备份为可选、每一步与最终版本写入分别事务。这些行为不能直接承载 v1→v2 的原子升级。[数据库初始化][c05-S05]、[storage 接线][c05-S06]、[迁移函数][c05-S07]

先修打开顺序，再添加新 schema。仅 UI 修改阶段不必提前升版；本轮确实新增持久字段时，使用正式版本迁移，不再增加无版本 ALTER。v1 的 `subject_key` 有/无两种历史结构必须进入 fixture。

### 4.2 新的启动和迁移顺序

| 阶段 | 具体操作 | 不满足时的处理 |
|---|---|---|
| 0. 冻结业务写入 | 禁止 BOOP 派发/自动恢复；升级窗口停止同一数据域所有旧 Host，并禁止旧进程自动重启 | 保留旧版本运行，不开始结构迁移；不能靠覆盖租约强行升级 |
| 1. 无副作用探测 | 用不执行 bootstrap 的连接读取数据库存在性、meta、schema 形态、scope 及必要完整性信息 | 缺失或不支持版本走明确分支；损坏库进入恢复说明 |
| 2. 版本守卫 | 仅文件不存在或确认没有BOOP业务表时走新库初始化；旧 v1 走迁移；高版本或有业务表但版本元数据缺失/损坏时拒绝写入并进入恢复说明 | 不把缺meta当空库，不把高版本改回常量；不能继续执行DDL、缓存回填或业务writes |
| 3. 迁移互斥 | 取得独立于待迁移表结构的同域互斥；重新核对无活动写者及实际版本 | 第二进程只读或报告正在维护；不能一边旧版写一边新版迁移 |
| 4. 备份 | 生成一致性 SQLite 快照和 manifest，独立打开快照验证，再计算 SHA-256 | 备份失败、不可写、磁盘不足则在任何结构变更前终止 |
| 5. 原子迁移 | 一个 `BEGIN IMMEDIATE` 事务包含此次全部 DDL、回填、校验和 schema_version 更新 | 任一失败执行 ROLLBACK；版本仍为旧值，业务数据无半迁移 |
| 6. 提交后验证 | `integrity_check`、`foreign_key_check`、主键/行数/引用核对、旧数据可定位 | 不启动调度；保留失败现场，从升级前备份受控恢复 |
| 7. 切换正常持有者 | 通过正常单写者服务取得新运行租约；第二 Host 只读；不由析构逻辑释放他人租约 | 未持有租约的进程不能迁移、写任务或派发 |
| 8. 恢复为可观察态 | 只读核对旧 task/action/outbox 与原 Session 事实，建立当前投影 | 旧 active/unknown 保持待核对；不自动重放，不继承旧危险授权 |

迁移互斥的实现必须同时覆盖本次新版本的全部写入口；旧版本并不认识新的互斥，因此“所有旧 Host 已停止”是前提。运行期租约心跳和 fencing 检查仍作用于业务写事务；失租旧进程不能完成迟到写入。数据库事务内不等待宿主 RPC 或模型。

### 4.3 一致备份与 manifest

现有 `snapshotBackup()` 使用 `VACUUM INTO`，可作为一致快照能力的起点；调用它之前必须走新的无 bootstrap 打开路径。不能只复制活动中的 `.sqlite` 主文件而漏掉 WAL 中已提交数据。[数据库快照实现][S05B]

备份使用唯一名称，位于同数据域的专用备份目录或明确配置的位置，例如 `boop/backups/<timestamp>-v1-to-v2/`。manifest 至少包括：

- 原包版本、tarball SHA-256、源码 commit；目标包对应字段。
- 旧/新 schema 目标、备份文件 SHA-256、开始/结束时间、实际 Node/SQLite 版本。
- 数据域规范化路径和 scopeId、主 Session 精确 ID、各业务表行数及关键主键集合摘要。
- `integrity_check` 结果、外键检查结果、遗忘/排除规则数量、业务写入已停止的证据。
- 快照是否含租约记录、原持有者和升级窗口进程状态；敏感内容不直接写入报告。

先独立打开备份，检查完整性和外键，再进行结构迁移。备份校验失败不能仅记录警告继续升级。升级后保留备份和 manifest，不用新快照覆盖旧快照。

### 4.4 数据保留与变更边界

保留既有 scope、任务/修订/目标、动作、outbox、事实、证据、来源游标、遗忘规则、用户纠错、旧审批和审计记录。旧 BOOP 审批数据只作历史，不据此建立新的审批中心或继续使用旧批准。新原生审批仍由目标 Session 的 DSH 管理。

新增字段优先通过新增表或可空列迁移。不删除业务记录、不重编号主键、不重写原 Session 事件、不移动工作区。新约束回填完并验证后才启用。原生消息与附件继续由 DSH 保存，BOOP 保存精确引用及必要结果，不复制全量历史形成第二份会话真相。

**本轮唯一允许的旧业务表替换是 `task_target` 的等价重建**：为允许真实目标没有注册 workspace，把 `workspace_id` 放宽为可空。按03的schema 2迁移，在同一个 `BEGIN IMMEDIATE` 事务内建立新表，显式按 `task_id, scope_id, workspace_id, session_id, role, resource_key` 六列复制；先核对行数、复合主键集合和全部原字段值，再删除旧表并将新表改名。原主键、外键与既有索引/触发器语义必须保留，新增v2唯一索引另行校验。出现基线以外的依赖对象或数据不满足约束时中止并回滚，不能丢行、改ID或删除未知对象来强行成功。整个过程有升级前一致快照；任何复制、约束、改名或提交检查失败均整事务回滚。此例外不授权删去其他业务表或业务数据。

FTS 和缓存可以重建，但必须先应用遗忘 tombstone、排除范围和纠错规则，不能从旧 source 重新学回被用户遗忘的信息。schema 高于当前代码时，不允许通过“重建缓存”变相写入。

来源范围迁移遵循“Host权限上限＋BOOP明确限制”：没有旧 `source_access` 记录不等于用户明确禁用。若Host可证明当前owner已经可访问目标，继承该有效范围，用户已明确点名时不再要求重复授权；旧显式 `none`、`selected` 和排除规则原样保留。Host不能证明权限时才给出范围/连接引导，不能把缺记录当作全库授权，也不能一律写成none阻断原本可访问工作。模型不能扩大权限。

上下文80条语义事件/24,000字符是给模型的输出预算，实际值以03契约为准；返回截断标记和续读引用，不遍历全部Session正文。官方单Session读取内部可能加载该Session全文，因此本轮不承诺底层磁盘IO严格分页；验收检查授权目标、模型窗口预算和没有全库后台扫描，不用最终切片大小伪造底层分页能力。

scopeId 由规范化 `DSH_HOME` 派生，Windows 会统一路径大小写；移动到另一个 home 不保证 scope 连续。跨机器或跨数据目录迁移不混入本轮升级。[storage][c05-S06]

## 5. 旧主身份、计划和运行任务的接续

### 5.1 主 Session 继承

账本 `scopes.main_session_id` 是绑定依据；原代码会先读它，另有 `boop-main` 回退与客户端实际创建的分离行为。[原身份代码][c05-S08]

1. 按账本精确 ID 查询原生 Session，并验证归属和可读性。有效则继续使用，不复制消息、不重新发送最后一条指令。
2. 没有绑定但存在可证明属于同一 BOOP 的历史 Session 时，按持久来源证据修复绑定；不能只凭标题、头像或 localStorage 推断。
3. 无绑定且无可证明的旧身份时，通过正式宿主 API 创建一次，记录 create intent/实际返回 ID，再 CAS 绑定。宿主返回不同 ID 必须采用真实结果并核对；不能假设 create 是幂等 get-or-create。
4. 创建请求送达后进程崩溃、绑定尚未落账时，先找回可证明关联的 Session；证据不足进入修复态，不反复创建。
5. 旧绑定缺失、不可读或冲突时，保留旧记录，显示恢复选择。客户端缓存不能覆盖账本。
6. 已启动旧 Session 的 preset 不可安全改动时，保留逻辑 BOOP 身份及旧历史段，建立明确的旧段→新活动段映射，记录原因。只带必要近期上下文，不继承旧操作授权；不篡改原生事件或全局 preset。

读取历史不唤醒旧 Agent，不恢复旧委托。新页面使用原生会话 Factory，但显式管理同一 Session 的 retain/release、输入根及草稿持久化；离页不取消独立后端任务，迟到的页面请求不得把用户从原生界面拉回 BOOP。

### 5.2 待执行、运行中及未知任务

升级和重启后只读核对原生 message/run 与 BOOP action/outbox 的对应关系。按证据区分尚未派发、已接收、实际运行、已结束和 outcome unknown；不能由过期时间推定“未执行”。

同一 BOOP 数据域全局至多一个受托执行槽：已派发、运行中、以及无法排除已经执行的 unknown 占槽。队列中等待 busy 目标的任务不占槽；选择最早满足有效授权、最新修订、目标 idle、无冲突条件的任务。主聊天不占此槽，可继续普通问答。单槽不能通过多个 Host、标签或第二条工具调用绕开。

停止任务先禁止该任务后续派发，再核对当前 run 所有权。仅精确关联当前 BOOP run 可请求取消；如果原 run 已结束、用户接管或宿主无法确认归属，不能无条件 stop 整个 Session。界面如实显示已停止后续安排、正在确认、已结束或人工接管；只有终态可证明时显示“已停止”。用户动作统一为“停止任务／继续处理”，主输入区“停止当前回复”另行处理。首版“继续处理”只把准确任务上下文放入原生草稿，用户补充并发送后由 `boop_task_control` 读取最新上下文、建立新修订；按钮本身不调用前端continue Remote、不用旧instruction自动续跑。

### 5.3 旧每日 9 点计划

新 MVP 不注册新的每日主动问候、摘要或自动群聊。升级时只停用有可靠证据证明由 BOOP 自己创建的旧 9 点计划：要求精确 planId 及创建审计/owner 关联，而不是标题包含 BOOP 或时间恰为 9 点。

用户自建、其他插件及归属不明计划保持。归属不明时留存记录并输出诊断，不猜测删除。停用 BOOP 自有计划保留旧配置和操作审计，不清空日程表。必须移除其启动时再次注册路径，并以重启及跨 9 点的受控时钟验收确认不会重新出现。来源读取仍只在授权范围按需进行，不附带全量历史扫描。

## 6. 回滚操作与失败处理

### 6.1 两类回滚

| 情形 | 可采用的路径 |
|---|---|
| 仅页面改变，schema 与旧包兼容 | 停止本轮派发和 UI 注册，恢复旧包/旧页面，保留当前账本；仍核对在途任务 |
| 已升级 schema 或兼容性无法证明 | 所有同域 Host 停止后，保存新现场，恢复升级前一致快照与配套旧包；旧包不能直接打开新库 |

现旧版 bootstrap 会写 schema 常量，所以“直接安装旧包看看是否能打开新库”不是有效回滚方法。先恢复匹配的库，再启动旧包。[旧初始化顺序][c05-S05]

### 6.2 实际恢复顺序

1. 阻止 BOOP 新派发，记录当前 task/action/outbox/run 关联和外部执行状态；停止同数据域所有 Host，确认没有进程仍打开数据库。
2. 保留升级后现场：新库及 WAL/SHM、当前配置、候选包、故障日志、迁移报告、升级后 action/原生消息/结果证据。外部原 Session 可能仍有已发送任务，必须保留其真实状态。
3. 校验升级前快照和旧包 SHA-256、数据域、schema 与 manifest 一致；不得随意选择别的数据域备份。
4. 将失败主文件及相关 WAL/SHM 整体归档，再恢复一致旧快照到原路径。不能把旧主文件与新 WAL 混放。只有确认所有连接关闭后才处理这些文件。
5. 安装匹配旧包，先保持 BOOP 插件停用或经过演练证明的业务派发关闭状态。原生 DSH Session 日志、用户项目文件不随 BOOP 快照覆盖。
6. 在不派发模式下检查旧 schema、完整性、外键、主 Session 绑定、关键行数、遗忘规则和证据引用。快照中的租约可能仍有效；确认旧持有进程已停，等待其自然过期或使用有进程核验的受控恢复工具，不无条件抢活跃租约、不手改 fencing 值。
7. 对照升级后现场与原生历史，列出快照之后已发生的实际操作；未知项保持待核对，不将旧 outbox 全量重放。用户确认恢复业务前，报告中明确哪些任务仍需处理。
8. 记录恢复报告：旧/新包、快照与失败现场哈希、时间、原因、核对结果、未完成事项及是否允许重新启用。

**恢复账本不撤销外部效果。** 新版本已经发给原 Session 的指令、写过的项目文件或已完成的操作，不会因恢复旧数据库消失。保留新现场和原生日志以避免重复执行；本回滚流程不自动回滚用户项目文件。

### 6.3 必须演练的失败窗口

至少覆盖：备份失败/磁盘不足、第二步 DDL 或回填失败、提交后校验失败、高版本 schema 被旧代码探测、派发已接收但回执丢失、运行中 Host 被终止、结果已送达但 receipt 未落账、旧主绑定缺失/冲突、双 Host 租约争用。测试结束后断言错误没有被伪装成成功，旧数据和原会话证据仍可定位，原生人工工作未被停止。

## 7. 打包、来源与普通 DSH 回归

### 7.1 产物检查

使用原白名单打包器并按新增导出更新白名单。包中包含新主页所需运行模块、头像及实际使用资产、preset/patch、README、LICENSE、NOTICE；不包含测试 profile、个人数据、模型凭据、临时 fixture 或第二套完整 DSH/React。React/react-dom 继续走宿主平台 external，不直接塞入 DS-Bot 已打包的 client.js。[构建][c05-S02]、[打包][c05-S17]

普通 DSH 回归比较安装前后默认模型、搜索 provider、默认 persona/preset、主题、工作区与 Session 使用；进入/退出 BOOP、停用/再启用均须正常。CSS 只作用于 BOOP 根及明确所属 portal；监听、计时器和 retain/release 计数回到原基线。未知第三方输入扩展不能被 BOOP 全局隐藏。

### 7.2 DS-Bot 移植登记

每个移植文件维护以下记录，不用“参考过 DS-Bot”一行代替：

| 字段 | 内容 |
|---|---|
| upstream | 仓库、完整固定 SHA、原路径和链接 |
| destination | 原 `dsh-boop` 内最终路径 |
| reuseType | copied / adapted / design-reference |
| license/notice | 原文件实际许可、版权归属及保留的 NOTICE |
| modifications | 本项目改动：单 BOOP、局部主页、宿主适配、状态文案、功能删减 |
| removed behavior | 全局 shell 接管、搜索覆盖、多 Bot 群聊、独立存储与自动更新等不采用行为 |
| acceptance | 对应 caseId、实际状态和证据；初始 NOT_RUN |

保留 Apache-2.0 许可及适用归属，在修改文件标注来源与修改；原 BOOP 的 dashi-taskboard 等归属随仍保留的代码继续存在。只在确认对应内容全部移除后调整其记录，不整份清空 NOTICE。[DS-Bot LICENSE][D03]、[NOTICE][D04]

不整体照搬 DS-Bot 的 patch 和 surface。其搜索 provider 覆盖及全局 Bot surface 与本轮局部主页方案不同；当前 BOOP 的单一 SQLite 和原生 Session 历史继续为权威来源。[DS-Bot patch][D01]、[surface][D02]

## 8. 发布门槛与提交证据

验收详表见 [06_验收用例.md](#c06) 和 `acceptance.json`（配套ZIP内）。42 项初始状态全为 NOT_RUN；本文件不生成假执行报告。

| 门槛 | 必须提供的结果 |
|---|---|
| 工程基线 | 真实仓库关系、工具版本、冻结安装结果、lock差异、typecheck与构建结果；已知失败不隐去 |
| 适配器 | 两版本的身份、嵌入会话、读源、派发、run关联、精确停止能力有真实宿主证据 |
| 用户主路径 | 独立主页→普通交流→已有目标→原生执行→结果返回→用户确认/继续，含可控与真实模型标记 |
| 状态边界 | busy队列、全局单槽、unknown保守占槽、重复请求、原生审批、验收/验证分离、人工接管 |
| 迁移与回滚 | 原子升级、先备份、租约隔离、旧身份继承、两版本真实演练、无自动重放 |
| 宿主共存 | 普通DSH默认配置、用户会话和日程不受影响；CSS及资源释放通过 |
| 兼容矩阵 | 四格分别记录适用用例及状态；不存在以旧PASS或另一形态截图代替的格子 |
| 产物与归属 | 运行白名单、tarball/manifest SHA、安装与卸载保留数据、DS-Bot逐文件移植记录及NOTICE |

每个用例保留实际结果与缺陷。缺环境可以完成工程文档或局部实现交付，但不能宣称对应组合已通过发版验收。用户“确认收下”是产品行为，与工程验收负责人是否同意发布、以及自动测试结果分别记录。

## 9. 固定源码与文档依据

所有项目源码链接固定完整 SHA，避免分支变化影响交接。以下为基线依据，不是新版执行证据。

[c05-S00]: https://github.com/wanyexin1998/dsh-plugin/commit/98991899eecea6c6af1faa158e92cb73e555a5a5
[c05-S01]: https://github.com/wanyexin1998/dsh-plugin/blob/98991899eecea6c6af1faa158e92cb73e555a5a5/dsh-boop/package.json
[c05-S02]: https://github.com/wanyexin1998/dsh-plugin/blob/98991899eecea6c6af1faa158e92cb73e555a5a5/dsh-boop/build.mjs
[c05-S03]: https://github.com/wanyexin1998/dsh-plugin/blob/98991899eecea6c6af1faa158e92cb73e555a5a5/dsh-boop/pnpm-workspace.yaml
[c05-S04]: https://github.com/wanyexin1998/dsh-plugin/blob/98991899eecea6c6af1faa158e92cb73e555a5a5/dsh-boop/pnpm-lock.yaml#L3731-L3733
[c05-S05]: https://github.com/wanyexin1998/dsh-plugin/blob/98991899eecea6c6af1faa158e92cb73e555a5a5/dsh-boop/src/host/persistence/database.ts#L77-L120
[S05B]: https://github.com/wanyexin1998/dsh-plugin/blob/98991899eecea6c6af1faa158e92cb73e555a5a5/dsh-boop/src/host/persistence/database.ts#L172-L190
[c05-S06]: https://github.com/wanyexin1998/dsh-plugin/blob/98991899eecea6c6af1faa158e92cb73e555a5a5/dsh-boop/src/host/persistence/storage.ts
[c05-S07]: https://github.com/wanyexin1998/dsh-plugin/blob/98991899eecea6c6af1faa158e92cb73e555a5a5/dsh-boop/src/host/persistence/migrate.ts
[c05-S08]: https://github.com/wanyexin1998/dsh-plugin/blob/98991899eecea6c6af1faa158e92cb73e555a5a5/dsh-boop/src/host/main-session.ts#L130-L205
[c05-S09]: https://github.com/wanyexin1998/dsh-plugin/blob/98991899eecea6c6af1faa158e92cb73e555a5a5/dsh-boop/docs/development/release/support-matrix.md
[c05-S10]: https://github.com/wanyexin1998/dsh-plugin/blob/98991899eecea6c6af1faa158e92cb73e555a5a5/dsh-boop/docs/development/evidence/desktop-gui/report.md
[c05-S11]: https://github.com/wanyexin1998/dsh-plugin/blob/98991899eecea6c6af1faa158e92cb73e555a5a5/dsh-boop/tools/run-regression.mjs#L109-L170
[c05-S12]: https://github.com/wanyexin1998/dsh-plugin/blob/98991899eecea6c6af1faa158e92cb73e555a5a5/dsh-boop/tests/helpers/test-host.mjs#L19-L84
[c05-S13]: https://github.com/wanyexin1998/dsh-plugin/blob/98991899eecea6c6af1faa158e92cb73e555a5a5/dsh-boop/tools/build-test-payload.mjs
[c05-S14]: https://github.com/wanyexin1998/dsh-plugin/blob/98991899eecea6c6af1faa158e92cb73e555a5a5/dsh-boop/tools/desktop-gui-probe.mjs#L15-L25
[c05-S15]: https://github.com/wanyexin1998/dsh-plugin/blob/98991899eecea6c6af1faa158e92cb73e555a5a5/dsh-boop/tools/rehearse-install.mjs#L209-L241
[c05-S17]: https://github.com/wanyexin1998/dsh-plugin/blob/98991899eecea6c6af1faa158e92cb73e555a5a5/dsh-boop/tools/package-boop.mjs
[c05-S18]: https://github.com/wanyexin1998/dsh-plugin/blob/98991899eecea6c6af1faa158e92cb73e555a5a5/dsh-boop/docs/development/STATUS.md
[D01]: https://github.com/Fei2411/DS-Bot/blob/4a7b55069ad300eae8be42a74f31bc170b40ead7/ds-bot/cordis.patch.yml
[D02]: https://github.com/Fei2411/DS-Bot/blob/4a7b55069ad300eae8be42a74f31bc170b40ead7/ds-bot/src/client/surface.js
[D03]: https://github.com/Fei2411/DS-Bot/blob/4a7b55069ad300eae8be42a74f31bc170b40ead7/LICENSE
[D04]: https://github.com/Fei2411/DS-Bot/blob/4a7b55069ad300eae8be42a74f31bc170b40ead7/NOTICE
[c05-P01]: https://pnpm.io/10.x/settings#allowbuilds
[c05-P02]: https://pnpm.io/cli/install#--frozen-lockfile

- [BOOP 基线目录](https://github.com/wanyexin1998/dsh-plugin/tree/98991899eecea6c6af1faa158e92cb73e555a5a5/dsh-boop)
- [DS-Bot 复用基线目录](https://github.com/Fei2411/DS-Bot/tree/4a7b55069ad300eae8be42a74f31bc170b40ead7)


---

<a id="c06"></a>

# BOOP v0.2 MVP 验收用例

> 类型：开发与发布验收规格。状态：42 项全部 **NOT_RUN**。本文没有声称已经运行安装、构建、测试、迁移或用户验收。  
> 实施位置：原 `dsh-plugin/dsh-boop/`。结构化用例：`acceptance.json`（配套ZIP内）。迁移和执行环境见 [05_迁移与发布验收.md](#c05)。

## 1. 验收口径

以下规则适用于全部用例，不能用局部测试成功替代：

- **产品主路径必须从真实 BOOP 页面开始。** 直接写数据库、调用 PoC 派发端点、纯 mock 页面只能证明局部逻辑，不能证明自然语言委托闭环已经完成。
- **原生审批在目标 Session 的 DSH 原生界面完成。** BOOP 只解释为何需要用户、打开正确原会话、反映最新状态；不建设第二个审批中心，不替用户批准。
- **用户确认与验证事实独立。** 点击“确认收下”只记录真实用户对当前结果的接受；检查脚本通过只记录对应版本的验证事实。两者都不能自动生成另一者。
- **同一数据域全局只有一个 BOOP 受托执行槽。** 已派发、运行中、无法排除已经执行的 unknown 都占槽；主聊天不占槽。busy 目标仅在 BOOP 队列等待、不占 active 槽；从队列中选择最早满足执行条件者。两个独立任务可以排队，不形成多代理编排。
- **停止绑定精确所有权。** 用户停止一项任务，只阻止该任务后续动作并尝试停止属于它的当前 run；不能取消后来人工操作或目标 Session 上的其他工作。主输入区“停止回复”另有独立范围。
- **升级不自动恢复业务。** 历史读取、状态核对可以自动进行，原任务重新派发或恢复必须重新满足有效授权及恢复条件；unknown 不能按超时直接当作未执行。
- **来源范围沿用实际权限。** 无BOOP范围记录不等于明确none；继承可证明的Host owner有效范围，用户已点名可访问目标不重复授权。显式none/selected/排除规则保留，Host权限不可证明才给引导。
- **宿主保持原状。** 普通会话、工作区、默认模型、搜索、全局 preset、用户日程和其他插件不受 BOOP 改动影响。旧每日 9 点计划只允许停用有可靠归属证据的 BOOP 自有计划。

### 1.1 状态定义

| 状态 | 使用条件 |
|---|---|
| NOT_RUN | 尚未执行，本交付全部为此状态 |
| PASS | 在记录的候选构建与环境上完成全部步骤，预期均满足，证据可查 |
| FAIL | 已执行且至少一项预期不满足；附实际结果和可复现步骤 |
| BLOCKED | 环境或前置能力缺失使该用例无法执行；写明具体阻塞及影响组合 |
| SKIPPED | 按执行计划跳过，例如真实模型凭据未提供；不得计入通过数 |

退出码为 0 不足以证明 PASS。运行器缺模型配置返回 SKIPPED，仍然不能称真实模型主路径通过。不得先填 PASS 再补证据。

### 1.2 统一 fixture

| Fixture | 内容与约束 |
|---|---|
| F0 | 干净隔离 `DSH_HOME`、真实 DSH Host、现成测试模型路由；可控模型与用户已配置真实模型分别记录。准备有模型与无模型变体 |
| F1 | 用旧 BOOP 0.1.0 建立的 v1 账本：已绑定主 Session、2 个工作区、3 个原 Session（其中 2 个同标题）、旧任务、只读旧审批历史、事实、遗忘规则、排除来源、附件引用；schema v1 的 `subject_key` 存在/不存在变体各保留一份 |
| F2 | 可控目标 Session：人工运行、BOOP运行、idle、长流、失败、等待原生审批、接收后失联等可重复状态；可观察真实原生事件与 BOOP 账本 |
| F3 | 独立临时项目，业务操作只作用于该目录；旧包和新包真实 tarball 及 SHA-256；受控文件修改和可验证检查命令 |

fixture 若直接种库或注入事件，报告必须标明。A09 的用户委托不得通过种库代替。A34 的 390×844 为浏览器视口适配验收，不据此宣称有独立移动客户端。

### 1.3 每次运行的公共证据

每份执行报告必须保存：候选源码 commit、dirty 状态和补丁摘要、包版本及 tarball SHA-256、宿主版本与真实 commit（取不到则 `unknown`）、Web/Desktop、OS/架构、开发 Node 与宿主 Node、pnpm 版本、浏览器或 Desktop 版本、fixture ID、模型可控/真实标记、caseId、时间、实际结果、证据位置。凭据与完整个人会话内容不写入报告。

截图证明可见行为；原生 Session 事件证明接收和执行；账本记录证明状态关联；文件与实际检查日志证明产物。不同证据相互对应，不能只凭一张“成功”截图判定全流程。

### 1.4 最小宿主矩阵

| 宿主组合 | 新版本状态 |
|---|---|
| Windows x64 · DSH 0.2.1-rc.2 · Web | NOT_RUN |
| Windows x64 · DSH 0.2.1-rc.2 · Desktop | NOT_RUN |
| Windows x64 · DSH 0.2.1-rc.3 · Web | NOT_RUN |
| Windows x64 · DSH 0.2.1-rc.3 · Desktop | NOT_RUN |

每个声称支持的组合均须覆盖安装、独立页面、流式对话、自然语言委托、结果返回、停止、重连、原生审批导航、原生页面共存、停用与重启。共用存储算法的纯故障 fixture 可以复用证据，但须标明 Node/SQLite 与实现版本；宿主适配器和真实 GUI 的结论不能跨组合直接复制。

## 2. 用例索引

| ID | 用例 | 分层 | 当前状态 |
|---|---|---|---|
| A01 | 首次使用与模型未配置 | E2E | NOT_RUN |
| A02 | 主身份幂等 | E2E | NOT_RUN |
| A03 | 普通聊天不生任务 | E2E | NOT_RUN |
| A04 | 流式回复、附件与重连 | E2E | NOT_RUN |
| A05 | 中文输入与草稿 | UI_E2E | NOT_RUN |
| A06 | 停止当前回答 | E2E | NOT_RUN |
| A07 | 继承有效访问范围，保留显式限制 | E2E | NOT_RUN |
| A08 | 同名目标选择只填草稿，用户发送后执行 | E2E | NOT_RUN |
| A09 | 自然语言委托主闭环 | E2E | NOT_RUN |
| A10 | 全局单槽调度与主聊天可继续 | E2E | NOT_RUN |
| A11 | 更新限制 | INTEGRATION | NOT_RUN |
| A12 | 用户直接介入原Session | REGRESSION | NOT_RUN |
| A13 | 同目标重复交代 | INTEGRATION | NOT_RUN |
| A14 | 接收、交付、用户确认与验证结果分离 | INTEGRATION | NOT_RUN |
| A15 | 证据版本不匹配 | INTEGRATION | NOT_RUN |
| A16 | 完成结果恰好通知一次 | INTEGRATION | NOT_RUN |
| A17 | 失败/阻塞的可理解表达 | FAULT | NOT_RUN |
| A18 | 停止任务与继续处理 | E2E | NOT_RUN |
| A19 | 原生审批批准与拒绝 | E2E | NOT_RUN |
| A20 | 原生审批过期与双端并发 | INTEGRATION | NOT_RUN |
| A21 | 模型不可达 | FAULT | NOT_RUN |
| A22 | 派发后响应丢失 | FAULT | NOT_RUN |
| A23 | 杀Host后恢复 | FAULT | NOT_RUN |
| A24 | 第二Host只读 | INTEGRATION | NOT_RUN |
| A25 | 旧主Session继承 | E2E | NOT_RUN |
| A26 | 旧绑定缺失/冲突 | FAULT | NOT_RUN |
| A27 | v1→新版迁移 | INTEGRATION | NOT_RUN |
| A28 | 迁移故障原子性 | FAULT | NOT_RUN |
| A29 | 备份失败/磁盘不足 | FAULT | NOT_RUN |
| A30 | 版本守卫：高版本或元数据缺失 | FAULT | NOT_RUN |
| A31 | 真正跨版本回滚 | COMPATIBILITY | NOT_RUN |
| A32 | 记忆遗忘保持 | INTEGRATION | NOT_RUN |
| A33 | 插件停启回归 | REGRESSION | NOT_RUN |
| A34 | 可读性与布局 | UI_E2E | NOT_RUN |
| A35 | 键盘、焦点与动效 | UI_E2E | NOT_RUN |
| A36 | 安装产物与双端范围 | COMPATIBILITY | NOT_RUN |
| A37 | 原Session忙碌时等待 | E2E | NOT_RUN |
| A38 | 停止不误伤后来人工run | FAULT | NOT_RUN |
| A39 | 独立页面与原生页输入根所有权 | REGRESSION | NOT_RUN |
| A40 | 模型工具不能替用户验收或批准 | INTEGRATION | NOT_RUN |
| A41 | 页面CSS与监听资源释放 | REGRESSION | NOT_RUN |
| A42 | 重启无隐式日程、只处理BOOP自有旧计划 | REGRESSION | NOT_RUN |


## 3. 详细用例

<a id="case-A01"></a>

### A01 · 首次使用与模型未配置

状态：**NOT_RUN** · 分层：E2E。

关联工单：T01、T03、T06、T07、T08、T21、T24、T27、T28。

前置环境：F0：干净隔离数据域；分别准备有可用模型与未配置模型两种状态

**操作步骤**

1. 启用插件，点击BOOP固定入口；记录首个可交互页面。
2. 有可用模型时，不选择业务工作区，直接输入普通问题并等待首答。
3. 未配置模型时进入BOOP，按照页面指引打开DSH已有设置入口并配置测试模型，再回到BOOP。
4. 已有模型时展开高级区的原生模型选择器，检查可选择且不修改其他Session默认值。

**预期结果**

- 入口进入独立BOOP页面；初始化留在BOOP自己的准备态，不要求用户先选择业务工作区。
- 主身份只创建或绑定一次；有可用模型时可完成首轮。
- 无模型时有可理解的说明与现有设置入口指引；不依赖尚未核验的直接open-settings API；返回后可继续。
- 只在有可用模型时按产品约定展开原生选择器；普通DSH默认模型和其他Session设置不改变。

**需要保存的证据**

- 准备态、无模型态与首答截图
- session/create计数及最终主SessionId
- DSH现有设置入口到返回BOOP的录像
- 模型选择前后Session级与宿主默认配置差异


<a id="case-A02"></a>

### A02 · 主身份幂等

状态：**NOT_RUN** · 分层：E2E。

关联工单：T03、T05、T06、T07、T18、T24、T26、T28。

前置环境：F0

**操作步骤**

1. 双击入口、重复刷新、开第二标签同时进入

**预期结果**

- 绑定同一主身份
- 不重复创建
- 第二个输入根按owner策略处理

**需要保存的证据**

- 2标签截图
- scopes记录
- 创建次数


<a id="case-A03"></a>

### A03 · 普通聊天不生任务

状态：**NOT_RUN** · 分层：E2E。

关联工单：T11、T24。

前置环境：F0

**操作步骤**

1. 说“我在想以后做个三分屏，你怎么看”

**预期结果**

- 正常讨论
- 没有自动建执行委托或向原Session派发

**需要保存的证据**

- 聊天记录
- task/action增量=0


<a id="case-A04"></a>

### A04 · 流式回复、附件与重连

状态：**NOT_RUN** · 分层：E2E。

关联工单：T09、T24、T27。

前置环境：F0：可控长流模型；一个无敏感内容的测试文本附件；真实DSH消息持久化

**操作步骤**

1. 在BOOP主输入区添加测试附件并发送一条要求读取该附件的消息，记录附件和消息引用。
2. 开始可控长流回复，已经接收部分内容后刷新页面并重连。
3. 待该轮结束后重新进入BOOP并查看这条消息与附件。
4. 在流式过程中另一次导航离开、返回，核对最新输出及阅读位置。

**预期结果**

- 附件发送沿用原生路径，发送成功后引用可回查；不把未上传完成的附件假报为已发送。
- 已经持久化的消息和附件引用保留；断线前尚未持久化的片段不承诺逐字恢复。
- 重连不重复整条用户消息或助理回复，最终轮次状态与原生记录一致。
- 附件相关任务的引用保持可定位；返回后不抢夺用户正在阅读的历史位置。

**需要保存的证据**

- 附件提交前后截图与引用ID
- 消息Id/seq及原生持久化记录
- 刷新和重连录像、连接日志
- 最终主聊天与原Session记录对照


<a id="case-A05"></a>

### A05 · 中文输入与草稿

状态：**NOT_RUN** · 分层：UI_E2E。

关联工单：T03、T07、T09、T24、T27。

前置环境：F0：真实中文输入法与浏览器

**操作步骤**

1. IME输入“波波”
2. 选词Enter
3. Shift+Enter换行
4. 发送
5. 导航离开再返回

**预期结果**

- 选词不误发
- 快捷键正确
- 未发送草稿和阅读位置保留

**需要保存的证据**

- 实际IME录屏/事件记录
- 返回截图


<a id="case-A06"></a>

### A06 · 停止当前回答

状态：**NOT_RUN** · 分层：E2E。

关联工单：T09、T16、T24、T27。

前置环境：F0 + F2：主回答和独立执行任务同时运行

**操作步骤**

1. 点击主输入区停止

**预期结果**

- 只停当前主回答
- 其他已授权任务按明确控制范围继续，UI不称全部停止

**需要保存的证据**

- 主/子Session事件
- 任务状态与截图


<a id="case-A07"></a>

### A07 · 继承有效访问范围，保留显式限制

状态：**NOT_RUN** · 分层：E2E。

关联工单：T03、T06、T10、T13、T20、T21、T24。

前置环境：F0/F1：无source_access但Host可证明owner可访问W1/S1；显式none、selected(W1)、排除S1、Host权限不可证明等变体；一个超长但合法可读Session

**操作步骤**

1. 在无source_access记录、Host权限可证明的变体中，用户明确点名S1要求读取近期上下文。
2. 在显式selected(W1)变体中读取W1，再询问不在范围内的W2；在排除S1变体中点名S1。
3. 在显式none变体中尝试读取项目，核对系统没有因Host原有权限而自动解除用户禁用。
4. 在Host权限无法证明的变体中提出读取请求，检查引导和普通主聊天。
5. 对可读的超长Session请求近期上下文，检查给模型的预算、截断和续读引用；检查没有遍历所有Session正文。
6. 在BOOP主聊天手贴被排除Session的canonical mention与裸dsh-session URI，并保留同条消息中的普通正文和附件；另在普通DSH会话对照合法引用。

**预期结果**

- 无BOOP范围记录不被当成明确none；可证明的Host owner权限被继承，已明确点名的可访问目标不重复要求授权。
- 显式none、selected和排除规则继续有效，实际读取不越过Host权限或BOOP明确限制；未知内容如实说明。
- Host权限不可证明时才给范围/连接引导；不能通过模型参数扩大权限，也不阻断无关普通聊天。
- 模型上下文符合03约定的事件/字符预算并标记截断和续读来源；不把这个输出预算宣称为底层严格分页。
- 不因为目录查询、打开设置或缺范围记录而扫描全部Session正文。
- 主scope引用guard在官方预读前处理，排除或无法判定来源的readSurface次数为0；普通正文、附件、顺序与人类消息不被吞掉，普通DSH合法引用保持宿主行为。

**需要保存的证据**

- Host owner权限判定与继承依据
- 各scope变体及读取请求对照
- 无重复授权弹窗与权限不明时的实际引导录像
- 模型收到的事件/字符计数、truncated和续读引用
- 目录与正文读取目标集合、无全库扫描记录
- 主scope guard顺序、readSurface调用次数与保留消息对照


<a id="case-A08"></a>

### A08 · 同名目标选择只填草稿，用户发送后执行

状态：**NOT_RUN** · 分层：E2E。

关联工单：T10、T11、T20、T24。

前置环境：F1：两个同标题原Session，工作区或最近活动不同；可观察原生草稿与派发计数

**操作步骤**

1. 在BOOP说“继续那个SQL修复”，使目录查询命中两个同名Session。
2. 检查候选卡只显示允许的元信息，点击其中一个候选。
3. 在不发送草稿的状态等待，修改或撤销该reference chip；检查任务和派发记录。
4. 重新选择明确目标并由用户在原生输入框发送，随后观察任务和目标Session。

**预期结果**

- 候选显示可区分的工作区、标题和近期活动等元信息，不先展开候选正文；只展示可信catalog返回的候选。
- 点击候选只用原生reference insertion接口写入可读草稿，不自动发送、不创建委托或派发。
- 用户可检查、编辑或撤销草稿引用；未发送前task/action和目标接收记录无新增。
- 只有用户发送后才继续读取选中目标必要上下文并派发，精确targetSessionId正确，另一同名会话没有BOOP输入。

**需要保存的证据**

- 候选元信息与原生reference chip截图
- captureInsertion/insertReference和实际发送时序
- 未发送及撤销阶段task/action增量为0
- 用户发送消息Id、contextToken与targetSessionId
- 另一个同名Session无BOOP事件证明


<a id="case-A09"></a>

### A09 · 自然语言委托主闭环

状态：**NOT_RUN** · 分层：E2E。

关联工单：T11、T12、T13、T24、T28。

前置环境：F1 + F2 + F3：真实UI委托，受控临时项目，另记录真实模型路由结果

**操作步骤**

1. 告诉Boop在已有Session完成小文件变更并验证
2. 等待结束

**预期结果**

- 主聊天生成明确工作承诺
- 真正交给原Session
- 结果自动回主聊天
- 有产物/验证证据

**需要保存的证据**

- 用户输入到回报完整录像
- task/action/原Session串联ID
- 文件及测试结果


<a id="case-A10"></a>

### A10 · 全局单槽调度与主聊天可继续

状态：**NOT_RUN** · 分层：E2E。

关联工单：T12、T15、T20、T22、T24。

前置环境：F1 + F2：两个已有目标Session；S1被人工任务占用，S2空闲；可延迟完成及制造结果未知

**操作步骤**

1. 在BOOP分别明确委托Q1到S1、Q2到S2；两项均保留为独立任务，观察调度。
2. S1仍忙时，确认Q1仅在BOOP队列等待；观察Q2在满足执行条件后进入派发。
3. Q2运行期间让S1恢复idle，并在BOOP主聊天询问另一件普通事情。
4. 完成Q2后核对Q1才可进入派发，主聊天继续可用。
5. 在独立重复场景中，使Q2处于无法排除已经送达或正在执行的unknown，再让Q1满足执行条件；执行只读对账并观察是否误发。

**预期结果**

- 同一BOOP数据域跨所有Host和标签页，已派发、正在运行、以及无法排除已执行的unknown合计最多占用一个受托执行槽；同一target也不并发。
- busy等待只占BOOP等待队列，不占active槽；调度按创建顺序选最早满足当前执行条件的任务，Q1忙碌不阻塞可执行Q2。
- 槽位claim和任务状态变化是有围栏的原子操作；第二项不得在第一项结束或明确未执行前进入派发。
- 主聊天不占此槽，普通问答可以继续；不通过主聊天忙等或自动创建子代理来推进队列。
- unknown未排除执行之前继续占槽，系统如实显示需要核对；有持久证据后按有效状态释放，不能按超时直接释放后盲发。

**需要保存的证据**

- Q1/Q2创建时间、资格判断、槽位claim/release及fencing记录
- 各target的接收和run起止事件时间线
- 任一时点active槽占用计数及两个queued记录
- 主聊天问答录像与消息ID
- unknown对账前后状态和零误派发证据


<a id="case-A11"></a>

### A11 · 更新限制

状态：**NOT_RUN** · 分层：INTEGRATION。

关联工单：T10、T11、T12、T24。

前置环境：F2：尚未派发任务

**操作步骤**

1. 创建委托
2. 实际派发前补充“这次先别改移动端”

**预期结果**

- 待发动作使用新版本限制
- 旧版本动作撤销/失效
- 执行者收到最新约束

**需要保存的证据**

- task_revision
- payload摘要
- 原Session输入


<a id="case-A12"></a>

### A12 · 用户直接介入原Session

状态：**NOT_RUN** · 分层：REGRESSION。

关联工单：T03、T10、T12、T13、T14、T24、T25。

前置环境：F2：已派发的原Session

**操作步骤**

1. Boop委托后用户到原Session明确改目标/叫停

**预期结果**

- 最新有效人工指令优先
- Boop不反复发旧命令覆盖

**需要保存的证据**

- 原消息序列
- 后续action记录
- 回报


<a id="case-A13"></a>

### A13 · 同目标重复交代

状态：**NOT_RUN** · 分层：INTEGRATION。

关联工单：T05、T11、T12、T13、T24、T25。

前置环境：F2：可观察requestId与原生接收事件

**操作步骤**

1. 双击发送或刷新重发同一requestId

**预期结果**

- 同请求只建一任务/一次派发
- 不同有效目标可独立建任务
- 不同有效委托可以形成独立排队任务，但不能突破A10规定的全局单槽。

**需要保存的证据**

- 请求ID
- action数量
- 原Session接收计数


<a id="case-A14"></a>

### A14 · 接收、交付、用户确认与验证结果分离

状态：**NOT_RUN** · 分层：INTEGRATION。

关联工单：T05、T14、T15、T17、T19、T20、T24。

前置环境：F2：有接收但无结果、仅自述完成、有真实测试证据、未跑测试四种独立结果场景

**操作步骤**

1. 让执行者只返回“已接受”，随后只自述“我做完了”，检查任务展示。
2. 生成与当前版本相符的真实检查日志，结束关联执行并保存结果，但暂不点击“确认收下”。
3. 在未执行测试的独立场景中，用户查看合法结果后点击“确认收下”。
4. 对已确认结果提出补充修改，检查新revision上的确认和验证状态。

**预期结果**

- 接收回执不等于运行结束，自述完成不等于验证通过；缺证据时显示结果需要核对。
- 已交付要求关联执行已结束、结果或明确结论可定位、回报已保存；中间产物不提前生成已交付。
- 真实test passed只更新对应版本的验证事实，不自动生成用户确认。
- 用户确认记录当前taskRevision和resultId及真实用户操作；未测试时verification仍为未验证，不因用户确认变为passed。
- 新revision不继承旧用户确认或旧版本的验证结果，历史记录保留。

**需要保存的证据**

- 四场景用户界面截图
- 原生接收/运行/结束与结果持久化记录
- 真实检查命令、退出码、日志和产物版本
- 用户确认记录与verification状态前后对照
- 新旧taskRevision/resultId及历史证据


<a id="case-A15"></a>

### A15 · 证据版本不匹配

状态：**NOT_RUN** · 分层：INTEGRATION。

关联工单：T05、T14、T17、T19、T20、T24、T25。

前置环境：F2：新旧两个产物版本

**操作步骤**

1. 提供旧版本测试结果作为新修改验收

**预期结果**

- 标记证据过期/需重验
- 不自动通过

**需要保存的证据**

- artifact版本
- 验证记录
- 用户可读原因


<a id="case-A16"></a>

### A16 · 完成结果恰好通知一次

状态：**NOT_RUN** · 分层：INTEGRATION。

关联工单：T05、T14、T15、T22、T24。

前置环境：F2：可重投完成事件与模拟重连

**操作步骤**

1. 同一完成事件重复投递
2. 重连
3. 刷新

**预期结果**

- 同一工作结果只有一次持久汇报，可更新同卡，不重复刷屏

**需要保存的证据**

- 事件去重键
- 主Session消息ID列表


<a id="case-A17"></a>

### A17 · 失败/阻塞的可理解表达

状态：**NOT_RUN** · 分层：FAULT。

关联工单：T08、T14、T15、T19、T20、T24、T27。

前置环境：F2：可控缺文件或工具错误

**操作步骤**

1. 注入缺文件或工具失败

**预期结果**

- 展示具体工作、原因、可选下一步
- 首页不暴露schema/nonce/门禁编号
- 不假完成

**需要保存的证据**

- 失败截图
- 原执行错误与用户文案对应


<a id="case-A18"></a>

### A18 · 停止任务与继续处理

状态：**NOT_RUN** · 分层：E2E。

关联工单：T03、T16、T17、T18、T19、T20、T24、T25、T28。

前置环境：F2：分别准备待发、运行、停止后任务

**操作步骤**

1. 在待发状态点击“停止任务”，核对不再派发。
2. 在运行状态重复试验，核对只停止当前BOOP所属run，未知或人工接管时不误停。
3. 点击停止后的“继续处理”，检查准确任务上下文被放入原生草稿。
4. 尚未发送时编辑或撤销草稿，核对没有新任务修订、action或派发。
5. 用户补充本任务新要求或限制并主动发送；观察boop_task_control按fresh context建立新revision和action。

**预期结果**

- 界面只有“停止任务”和停止后的“继续处理”两种对应状态动作，不并列展示暂停与停止。
- 停止阻止后续派发，并仅取消可确认属于BOOP的当前run；未证实停止时如实显示正在停止或需要核对。
- 继续按钮只填草稿，不直接调用前端continue Remote，不凭旧instruction自动续跑。
- 用户发送后才采用最新要求产生同任务新revision/action，原目标Session不被偷偷替换；旧结果和证据保留。
- 旧执行仍不明时保持unknown和槽位限制，不能用新requestId绕过；未发送草稿不复活旧动作。

**需要保存的证据**

- 停止、继续填草稿和用户发送全过程截图或录像
- 用户发送前taskVersion/action/原生接收计数不变
- 停止对象runId与owner及terminal证据
- 新直接用户messageId、fresh contextToken、taskVersion及新action关联
- 派发计数与旧证据保留


<a id="case-A19"></a>

### A19 · 原生审批批准与拒绝

状态：**NOT_RUN** · 分层：E2E。

关联工单：T09、T14、T17、T19、T20、T25。

前置环境：F2 + F3：原生DSH审批可触发的受限操作

**操作步骤**

1. 让BOOP委托的原Session触发DSH原生审批
2. 在BOOP看到“需要你确认”
3. 点击“打开原会话”
4. 在原生界面拒绝
5. 返回BOOP核对
6. 独立场景在原生界面批准
7. 返回BOOP核对

**预期结果**

- BOOP只解释原因并提供打开原会话入口，不建立审批中心或替用户批准
- 拒绝后对应动作不执行且BOOP如实汇报
- 批准受DSH原生授权范围限制
- 批准不被BOOP误报为任务已完成

**需要保存的证据**

- BOOP提示截图
- 正确sessionId导航记录
- 原生审批界面与状态事件
- 动作执行计数
- 返回BOOP状态


<a id="case-A20"></a>

### A20 · 原生审批过期与双端并发

状态：**NOT_RUN** · 分层：INTEGRATION。

关联工单：T09、T17、T25。

前置环境：F2：同一原生审批的双标签、过期与run终止变体

**操作步骤**

1. 两端打开同一原Session原生审批
2. 一端处理后另一端处理同一请求
3. 另建审批并使其过期或对应run终止
4. 从BOOP旧提示进入
5. 返回BOOP

**预期结果**

- 由原生DSH判定已处理或已失效
- BOOP不复刻批准接口、不重复触发动作
- BOOP旧提示刷新为当前状态且仍可回到正确原会话
- 失效授权不能用于新run

**需要保存的证据**

- 两端原生审批结果
- 原生requestId/runId
- 实际执行计数
- BOOP更新截图与事件序列


<a id="case-A21"></a>

### A21 · 模型不可达

状态：**NOT_RUN** · 分层：FAULT。

关联工单：T08、T09、T15、T16、T19、T25、T27。

前置环境：F0 + F2：可配置关闭端口的测试模型，已有执行任务

**操作步骤**

1. 配置测试模型到关闭端口
2. 提问
3. 此时点击“停止任务”

**预期结果**

- 明确模型连接失败
- 停止控制无需模型响应仍可用
- 不静默切到其他供应商

**需要保存的证据**

- 网络目的地
- 错误文案
- 停止控制请求与结果


<a id="case-A22"></a>

### A22 · 派发后响应丢失

状态：**NOT_RUN** · 分层：FAULT。

关联工单：T05、T12、T13、T15、T16、T18、T19、T25。

前置环境：F2：控制面响应可丢失但原生输入已持久

**操作步骤**

1. 原Session接收命令后断开控制面响应
2. 重新连接

**预期结果**

- 先查durable证据
- 不盲目再次派发
- 未知期间如实显示

**需要保存的证据**

- messageId/actionId
- 原接收计数=1
- 对账报告


<a id="case-A23"></a>

### A23 · 杀Host后恢复

状态：**NOT_RUN** · 分层：FAULT。

关联工单：T13、T15、T16、T18、T22、T25。

前置环境：F2：独立测试Host，可在sending/running终止进程

**操作步骤**

1. running/sending时终止测试Host
2. 重启

**预期结果**

- 原任务保留
- 未知动作对账
- 不自动重放/恢复业务
- 用户可选择继续

**需要保存的证据**

- kill/restart记录
- outbox变化
- 零重放证据


<a id="case-A24"></a>

### A24 · 第二Host只读

状态：**NOT_RUN** · 分层：INTEGRATION。

关联工单：T04、T05、T13、T18、T25。

前置环境：F1：同一隔离数据域的两个Host进程

**操作步骤**

1. 两个隔离进程打开同一测试域
2. 等过一个TTL
3. 关闭第二个

**预期结果**

- 第一个持续持有
- 第二个不能迁移/写任务
- 关闭第二个不释放第一个租约

**需要保存的证据**

- fencing token
- 心跳时间
- 写拒绝结果


<a id="case-A25"></a>

### A25 · 旧主Session继承

状态：**NOT_RUN** · 分层：E2E。

关联工单：T06、T07、T21、T26、T28。

前置环境：F1：旧主Session含消息和附件，旧包/新包

**操作步骤**

1. 安装新包
2. 进入Boop
3. 翻历史
4. 继续问

**预期结果**

- 原ID或明确段映射延续
- 旧消息/附件可读
- 不重复最后一条指令

**需要保存的证据**

- 升级前后ID映射
- 消息/附件引用
- 截图


<a id="case-A26"></a>

### A26 · 旧绑定缺失/冲突

状态：**NOT_RUN** · 分层：FAULT。

关联工单：T06、T18、T21、T26。

前置环境：F1变体：旧绑定不存在、不可读或与本地缓存冲突

**操作步骤**

1. 账本指向不可读旧ID、localStorage另有ID
2. 打开

**预期结果**

- 不按标题猜/不悄悄覆盖
- 给恢复说明
- 旧记录保留

**需要保存的证据**

- 绑定与缓存对照
- 恢复UI
- 无隐式写


<a id="case-A27"></a>

### A27 · v1→新版迁移

状态：**NOT_RUN** · 分层：INTEGRATION。

关联工单：T02、T04、T05、T06、T26、T28。

前置环境：F1副本：固定旧v1数据库，分别覆盖subject_key存在/不存在的旧结构变体；记录旧包和库哈希

**操作步骤**

1. 记录旧包哈希、旧库版本、业务表主键/行数和scopes.main_session_id；分别准备两种v1结构变体。
2. 停止同一数据域所有旧Host，运行新版本迁移入口并核对先备份后变更顺序。
3. 检查迁移后业务记录、主Session关联、完整性与外键；重复启动并检查无二次回填。

**预期结果**

- 一致性备份先生成并独立校验；版本仅在全部DDL和回填成功的同一事务内提升。
- 两种旧v1结构均能按显式兼容路径迁移；不再无版本地偷偷ALTER。
- 原行数、主键、原Session证据引用、事实及遗忘/排除规则保留；新增字段按约定回填。
- 迁移后重新启动不重复迁移、回填、创建主Session或派发旧任务。

**需要保存的证据**

- 备份sha
- 迁移报告
- integrity/FK
- 字段差异


<a id="case-A28"></a>

### A28 · 迁移故障原子性

状态：**NOT_RUN** · 分层：FAULT。

关联工单：T04、T26。

前置环境：F1副本：可在第2个DDL/回填注入故障

**操作步骤**

1. 第2个DDL/回填处注入失败
2. 重启旧版

**预期结果**

- 所有本次改动回滚，版本仍v1
- 旧包可读
- 无半迁移

**需要保存的证据**

- 故障点
- 前后schema/行数
- 旧版读取结果


<a id="case-A29"></a>

### A29 · 备份失败/磁盘不足

状态：**NOT_RUN** · 分层：FAULT。

关联工单：T04、T26。

前置环境：F1副本：不可写备份目录或受控不足容量

**操作步骤**

1. 备份目录不可写或容量不足
2. 升级

**预期结果**

- 在任何结构变更前停止
- 旧库可读
- UI/日志明确原因

**需要保存的证据**

- 备份错误
- 数据库哈希/版本未变


<a id="case-A30"></a>

### A30 · 版本守卫：高版本或元数据缺失

状态：**NOT_RUN** · 分层：FAULT。

关联工单：T04、T26。

前置环境：F1副本：分别准备合法高版本schema、已有业务表但meta/schema_version缺失或损坏的库；另有真正空库作为对照

**操作步骤**

1. 启动当前候选读取高于其支持范围的合法schema fixture。
2. 在独立副本移除或破坏版本元数据，保留原业务表和记录，再启动候选。
3. 以真正空库或不存在的数据库文件启动对照场景。

**预期结果**

- 高版本不被bootstrap覆写或降写，不执行迁移和业务写入。
- 有业务表但版本元数据缺失/损坏时进入恢复或unsupported，不当成空库初始化，不覆盖旧数据。
- 只有不存在或确认无BOOP业务表时才按新库路径初始化；对照场景能建立有效新库。

**需要保存的证据**

- 三种fixture的原schema、meta和业务记录摘要
- 启动后的版本/数据对照及错误说明
- DDL和业务写入记录，异常库无初始化覆盖
- 真正空库初始化结果


<a id="case-A31"></a>

### A31 · 真正跨版本回滚

状态：**NOT_RUN** · 分层：COMPATIBILITY。

关联工单：T02、T04、T26、T28。

前置环境：F1 + F3：old.tgz、new.tgz及哈希，受控升级后新事件

**操作步骤**

1. old.tgz
2. new.tgz
3. 产生受控新事件
4. 回滚演练

**预期结果**

- 保存新现场
- 旧包+旧快照可启动
- 已执行外部动作不重放
- 新事件证据可追查

**需要保存的证据**

- 两包sha
- 恢复报告
- 原Session日志
- 无二次动作


<a id="case-A32"></a>

### A32 · 记忆遗忘保持

状态：**NOT_RUN** · 分层：INTEGRATION。

关联工单：T04、T05、T10、T21、T26。

前置环境：F1：旧版遗忘规则、tombstone、旧索引均存在

**操作步骤**

1. 旧版遗忘某事实
2. 升级
3. 索引重建
4. 提问

**预期结果**

- 不从旧fact、FTS或来源重建中复活已遗忘内容
- 明确排除范围持续

**需要保存的证据**

- tombstone/forget_rule
- 检索结果
- 回复


<a id="case-A33"></a>

### A33 · 插件停启回归

状态：**NOT_RUN** · 分层：REGRESSION。

关联工单：T01、T07、T09、T21、T22、T23、T27、T28。

前置环境：F0 + F1：可记录普通DSH设置与执行行为

**操作步骤**

1. 普通DSH里记录主题/工作区/preset/search配置
2. 启Boop
3. 停用
4. 再启

**预期结果**

- 普通会话仍可发送和用工具
- search/default persona/preset不被改
- Boop样式/事件完全撤销再挂载

**需要保存的证据**

- 合成配置diff
- 普通会话测试
- style/event计数


<a id="case-A34"></a>

### A34 · 可读性与布局

状态：**NOT_RUN** · 分层：UI_E2E。

关联工单：T08、T19、T20、T21、T27。

前置环境：F0 + F2：空态、长聊、进行中、失败、结果态；三个尺寸和200%缩放

**操作步骤**

1. 1280×800、1440×900、390×844、200%缩放，明暗各检查

**预期结果**

- 主输入与关键动作可达
- 无横向遮挡
- 中文正文/状态清晰
- 不出现工程字段洪泛

**需要保存的证据**

- 每状态截图
- 尺寸
- 对比度与触控目标实测


<a id="case-A35"></a>

### A35 · 键盘、焦点与动效

状态：**NOT_RUN** · 分层：UI_E2E。

关联工单：T08、T20、T27。

前置环境：F0 + F2：键盘操作、减少动画设置、3D资源故障

**操作步骤**

1. 仅Tab操作输入、工作详情、打开原会话、返回
2. 开启减少动画
3. 模拟3D加载失败

**预期结果**

- 焦点可见且可返回
- 焦点不被消息抢走
- 动效遵从设置
- 角色失败有静态fallback且聊天可用

**需要保存的证据**

- 键盘录像
- 焦点轨迹
- fallback截图


<a id="case-A36"></a>

### A36 · 安装产物与双端范围

状态：**NOT_RUN** · 分层：COMPATIBILITY。

关联工单：T01、T02、T23、T28。

前置环境：F3：实际tgz；Windows rc.2/rc.3 Web/Desktop四组合隔离安装

**操作步骤**

1. pack校验
2. 在四格隔离组合按矩阵安装
3. 主流程
4. 卸载

**预期结果**

- 运行模块/资产完整，无测试fixture/密钥打入包
- 卸载保留用户数据
- 四格结果分开

**需要保存的证据**

- tgz manifest/sha
- 配置diff
- 4份报告与卸载检查


<a id="case-A37"></a>

### A37 · 原Session忙碌时等待

状态：**NOT_RUN** · 分层：E2E。

关联工单：T03、T12、T13、T24、T25。

前置环境：F1 + F2：目标原Session已有人工长run，可控制idle时点

**操作步骤**

1. 先让目标原Session执行用户已有长任务
2. 从BOOP委托到该精确Session
3. 观察忙碌期
4. 用户原任务结束变idle
5. 观察BOOP首次派发

**预期结果**

- 忙碌时BOOP显示等待当前工作完成，不停止或插入抢占原run
- 未idle前派发计数为0
- idle后重新核对目标与任务revision再派发一次
- 目标再次忙碌则继续等待

**需要保存的证据**

- 原Session原run开始/结束时间
- BOOP等待截图
- 派发时间与计数
- 派发前idle和revision核对记录


<a id="case-A38"></a>

### A38 · 停止不误伤后来人工run

状态：**NOT_RUN** · 分层：FAULT。

关联工单：T03、T13、T14、T16、T25。

前置环境：F2：R1为BOOP run，R2为后来用户run，可延迟停止请求

**操作步骤**

1. 启动BOOP委托run R1
2. 延迟其停止请求
3. R1先结束
4. 用户在原Session启动新run R2
5. 送达延迟停止请求
6. 再做R1仍在运行的对照试验

**预期结果**

- 停止作用域绑定BOOP当前任务、action、run R1
- 延迟请求不得停止R2
- 无法由宿主确认当前run所有权时不发无条件stop_session，返回已经结束或无法安全停止
- 对照场景只停止R1

**需要保存的证据**

- 请求taskId/actionId/runId与owner
- R1/R2时间线
- R2继续执行结果
- 宿主停止调用参数及拒绝原因


<a id="case-A39"></a>

### A39 · 独立页面与原生页输入根所有权

状态：**NOT_RUN** · 分层：REGRESSION。

关联工单：T03、T06、T07、T09、T23、T27、T28。

前置环境：F0 + F1：独立BOOP页、同主Session原生页和双标签

**操作步骤**

1. 在BOOP独立页输入未发送草稿
2. 打开同一主Session原生页
3. 在两个标签页来回导航
4. 尝试同时发送
5. 关闭当前owner
6. 另一端重新进入

**预期结果**

- 同一主Session在同一客户端挂载范围只保留一个有效输入根
- 跨标签页按明确owner或幂等策略工作
- 草稿不串到其他Session
- 不同时挂两套Session输入生命周期
- owner释放后可重新取得
- 不同原Session仍可正常输入

**需要保存的证据**

- DOM输入根与retain/release计数
- owner变更记录
- 两端截图与草稿
- 消息requestId和实际发送计数


<a id="case-A40"></a>

### A40 · 模型工具不能替用户验收或批准

状态：**NOT_RUN** · 分层：INTEGRATION。

关联工单：T05、T11、T15、T17、T19、T20、T24、T25。

前置环境：F2 + F3：模型工具通道、用户命令通道及原生审批

**操作步骤**

1. 通过真实模型工具通道尝试调用用户验收动作
2. 伪造actor=user或approved=true重试
3. 尝试调用原生批准
4. 再由用户经真实界面处理相同事项

**预期结果**

- 工具注册面不暴露用户专属验收或批准动作
- 服务端在独立用户命令通道验证来源，不能信任模型参数自报身份
- 拒绝请求不改变验收/授权状态且不执行受限动作
- 真实用户通道仍有效

**需要保存的证据**

- 模型可见工具清单
- 被拒绝请求与错误
- 状态前后对照
- 受限动作计数为0
- 真实用户处理证据


<a id="case-A41"></a>

### A41 · 页面CSS与监听资源释放

状态：**NOT_RUN** · 分层：REGRESSION。

关联工单：T03、T07、T08、T09、T21、T22、T23、T27、T28。

前置环境：F0 + F2：普通DSH页面与BOOP页面，可统计资源生命周期

**操作步骤**

1. 记录普通DSH页面计算样式和监听/retain基线
2. 进入/退出BOOP十次
3. 主题切换
4. 停用插件
5. 再启用

**预期结果**

- CSS作用域限定BOOP页面及其明确portal根，不污染普通DSH输入框、布局、按钮
- 离页和停用释放订阅、监听、计时器和Session retain
- 反复进入不累积资源或重复消息
- 重新进入能正常挂载

**需要保存的证据**

- 普通页面样式前后diff
- 挂载/卸载计数
- 监听和retain计数
- 消息回调计数
- 控制台及截图


<a id="case-A42"></a>

### A42 · 重启无隐式日程、只处理BOOP自有旧计划

状态：**NOT_RUN** · 分层：REGRESSION。

关联工单：T10、T18、T21、T22、T26、T27。

前置环境：F0 + F1：BOOP自有旧9点计划、用户自建和其他插件同时间计划、归属不明计划；Host有效权限且无BOOP范围记录、显式none、selected三种来源变体；受控时钟

**操作步骤**

1. 记录原生schedule清单、创建者/持久归属证据、来源授权和游标。
2. 升级并打开BOOP，核对旧计划处理；退出后重启Host及Desktop，再次检查计划清单。
3. 推进测试时钟经过每日9点，观察四种计划和BOOP消息。
4. 分别观察Host有效权限且无BOOP范围记录、显式none、selected场景中的历史读取；对可访问目标由用户明确点名后再读取。

**预期结果**

- 只停用能由持久planId与创建审计/owner证据证明由BOOP自己创建的旧9点计划；保留原记录供追溯，不按时间、标题或关键词批量停用。
- 用户自建、其他插件与归属不明计划不被删除或改写；归属不明时保留并给诊断，不自动猜测。
- 新安装及重启不会重新创建每日9点主动任务、自动群聊或主动提醒；用户其他日程仍按原设置运行。
- 打开或重启不触发全量历史扫描；在继承的Host有效范围或明确selected范围内，用户点名目标可按需读，显式none和排除规则保留。模型窗口按预算截断并可续读，不宣称宿主底层IO严格分页，不新增后台全量学习。
- 重启只核对原有任务事实，不自动恢复业务派发或重放历史指令。

**需要保存的证据**

- schedule升级前后及重启后diff
- BOOP自有计划的planId、owner或创建审计证据
- 用户/其他插件/归属不明计划保持证据
- 受控9点触发日志与BOOP消息记录
- 来源读取请求、授权与游标、任务零重放证据



---

<a id="c07"></a>

# 源码依据与 DS-Bot 定向复用清单

## 1. 证据边界

本方案依据原仓库和参考项目的固定提交、用户截图及DSH官方源码。源码可证明接口存在和实现分支，不能证明新组合已在实际宿主运行。本轮所有42项验收均未运行；版本更新后必须重新比较相关差异。

原仓库与DS-Bot的完整提交分别为 `98991899eecea6c6af1faa158e92cb73e555a5a5` 与 `4a7b55069ad300eae8be42a74f31bc170b40ead7`。DSH官方rc.2为 `687f282e8625c6b8d11ff58211a90524be2e4317`，rc.3为 `1f81c047fc48fa190a683e469daa699857e9afe8`。运行环境中的payload提交与这些官方tag SHA不是同一概念，必须分别记录。

## 2. 固定源码索引

| 编号 | 原始源码 | 与方案的关系 |
|---|---|---|
| B01 | [现有客户端注册与入口](https://github.com/wanyexin1998/dsh-plugin/blob/98991899eecea6c6af1faa158e92cb73e555a5a5/dsh-boop/src/client/index.tsx) | main:boop.tasks、普通会话导航、旧初始化与任务板入口需收敛。 |
| B02 | [现有任务板](https://github.com/wanyexin1998/dsh-plugin/blob/98991899eecea6c6af1faa158e92cb73e555a5a5/dsh-boop/src/client/board.tsx) | 用户截图中的技术字段/来源清单由此产品结构承载；保留必要诊断，退出默认入口。 |
| B03 | [主身份 Host 实现](https://github.com/wanyexin1998/dsh-plugin/blob/98991899eecea6c6af1faa158e92cb73e555a5a5/dsh-boop/src/host/main-session.ts) | 当前主绑定主要写账本身份，MVP要补真实原生Session/preset核验。 |
| B04 | [已注册模型工具](https://github.com/wanyexin1998/dsh-plugin/blob/98991899eecea6c6af1faa158e92cb73e555a5a5/dsh-boop/src/host/tools.ts) | 已有catalog/context/verify可扩展；正式dispatch/control需新增。workspace工具另在workspace-api注册。 |
| B05 | [现有派发器](https://github.com/wanyexin1998/dsh-plugin/blob/98991899eecea6c6af1faa158e92cb73e555a5a5/dsh-boop/src/host/dispatch/dispatcher.ts) | 保留稳定action/message与任务版本检查；修精确claim、生产装配及发送前复核。 |
| B06 | [原生DSH适配器](https://github.com/wanyexin1998/dsh-plugin/blob/98991899eecea6c6af1faa158e92cb73e555a5a5/dsh-boop/src/host/transport/dsh-adapter.ts) | 修异步目录、正确flush、queued与running取消归属；不能原样当闭环完成。 |
| B07 | [SQL与版本](https://github.com/wanyexin1998/dsh-plugin/blob/98991899eecea6c6af1faa158e92cb73e555a5a5/dsh-boop/src/host/persistence/schema.ts) | 保留原task/action/fact/approval/outbox为业务主库，只作最小增量。 |
| B08 | [数据库bootstrap](https://github.com/wanyexin1998/dsh-plugin/blob/98991899eecea6c6af1faa158e92cb73e555a5a5/dsh-boop/src/host/persistence/database.ts) | bootstrap会写当前schema_version，升级前必须先修启动次序。 |
| B09 | [持久层与租约装配](https://github.com/wanyexin1998/dsh-plugin/blob/98991899eecea6c6af1faa158e92cb73e555a5a5/dsh-boop/src/host/persistence/storage.ts) | 原构造bootstrap先于显式migration；写租约要校验本进程持有token。 |
| B10 | [原生来源读取](https://github.com/wanyexin1998/dsh-plugin/blob/98991899eecea6c6af1faa158e92cb73e555a5a5/dsh-boop/src/host/observe/host-reader.ts) | 可作为真实异步事件入口；补选中目标的近期输出预算；宿主底层仍可能加载该Session全日志。 |
| B11 | [既有品牌颜色提案](https://github.com/wanyexin1998/dsh-plugin/blob/98991899eecea6c6af1faa158e92cb73e555a5a5/dsh-boop/baseline/assets/boop-brand-tokens.json) | version1.1/status design-proposal；本轮局部色板引用其品牌色，其余按01新规格。 |
| B12 | [旧前端方案](https://github.com/wanyexin1998/dsh-plugin/blob/98991899eecea6c6af1faa158e92cb73e555a5a5/dsh-boop/baseline/docs/04_前端设计方案.md) | 保留历史；本轮ADR覆盖原生Conversation入口与默认任务板假设。 |
| B13 | [包清单与兼容声明](https://github.com/wanyexin1998/dsh-plugin/blob/98991899eecea6c6af1faa158e92cb73e555a5a5/dsh-boop/package.json) | 当前0.1.0、DSH rc.2/rc.3 engine、rc.2 peer及错误test路径均需按实际修订验证。 |
| B14 | [构建与宿主外置](https://github.com/wanyexin1998/dsh-plugin/blob/98991899eecea6c6af1faa158e92cb73e555a5a5/dsh-boop/build.mjs) | 保持React/宿主公开运行时外置；不另打一套聊天引擎。 |
| B15 | [准入处理](https://github.com/wanyexin1998/dsh-plugin/blob/98991899eecea6c6af1faa158e92cb73e555a5a5/dsh-boop/src/host/gate/pre-step.ts) | 旧混批拒绝会影响用户消息；精确过滤必须成为正式派发前置。 |
| B16 | [正式工作区目录facade](https://github.com/wanyexin1998/dsh-plugin/blob/98991899eecea6c6af1faa158e92cb73e555a5a5/dsh-boop/src/host/workspace-api.ts) | 复用真实registry/query/resolveTarget及工作区规则，不另造Bot目录。 |
| B17 | [现有回归编排](https://github.com/wanyexin1998/dsh-plugin/blob/98991899eecea6c6af1faa158e92cb73e555a5a5/dsh-boop/tools/run-regression.mjs) | 保留offline/host/real分组；修环境依赖并给本轮真实证据。 |
| B18 | [现有安装演练](https://github.com/wanyexin1998/dsh-plugin/blob/98991899eecea6c6af1faa158e92cb73e555a5a5/dsh-boop/tools/rehearse-install.mjs) | 原先同版本重装不足以证明跨schema回滚；新增真实old→new→old。 |
| D01 | [DS-Bot surface组](https://github.com/Fei2411/DS-Bot/blob/4a7b55069ad300eae8be42a74f31bc170b40ead7/ds-bot/src/client/surface.js) | 默认bot模式装配shell/conversation替换；本轮不整体搬入。 |
| D02 | [DS-Bot客户端装配](https://github.com/Fei2411/DS-Bot/blob/4a7b55069ad300eae8be42a74f31bc170b40ead7/ds-bot/src/client/index.js) | 包含全站槽替换；仅参考组件/生命周期，BOOP限定自己main下。 |
| D03 | [DS-Bot详情抽屉](https://github.com/Fei2411/DS-Bot/blob/4a7b55069ad300eae8be42a74f31bc170b40ead7/ds-bot/src/client/details-drawer.js) | 作为层级和轻交互参考；去掉team/group/multiBot特有状态。 |
| D04 | [DS-Bot轻活动行](https://github.com/Fei2411/DS-Bot/blob/4a7b55069ad300eae8be42a74f31bc170b40ead7/ds-bot/src/client/activity-row.js) | 适配为一句自然状态，实际值来自BOOP投影。 |
| D05 | [DS-Bot消息投递](https://github.com/Fei2411/DS-Bot/blob/4a7b55069ad300eae8be42a74f31bc170b40ead7/ds-bot/src/host/delivery.js) | 确有resolveAgent/followup/flush；入口toId仍是Bot目录，不能直接当已有DSH Session桥。 |
| D06 | [DS-Bot模型工具](https://github.com/Fei2411/DS-Bot/blob/4a7b55069ad300eae8be42a74f31bc170b40ead7/ds-bot/src/host/tools.js) | message_bot/内部handoff须适配目标身份与授权；不照搬为BOOP工具名。 |
| D07 | [DS-Bot分段上下文](https://github.com/Fei2411/DS-Bot/blob/4a7b55069ad300eae8be42a74f31bc170b40ead7/ds-bot/src/host/parts.js) | 长期身份概念参考；MVP沿用原生压缩，仅必要迁移保存历史关联。 |
| D08 | [DS-Bot重启恢复](https://github.com/Fei2411/DS-Bot/blob/4a7b55069ad300eae8be42a74f31bc170b40ead7/ds-bot/src/host/resume.js) | 不移植自动续跑策略；BOOP先事实核对、当前用户意图再执行。 |
| D09 | [DS-Bot宿主默认配置](https://github.com/Fei2411/DS-Bot/blob/4a7b55069ad300eae8be42a74f31bc170b40ead7/ds-bot/cordis.patch.yml) | 不移植全局搜索/默认设置和自更新绑定。 |
| D10 | [DS-Bot许可证](https://github.com/Fei2411/DS-Bot/blob/4a7b55069ad300eae8be42a74f31bc170b40ead7/LICENSE) | 来源为Apache-2.0；复制/改写保留相关归属与修改声明。 |
| D11 | [DS-Bot NOTICE](https://github.com/Fei2411/DS-Bot/blob/4a7b55069ad300eae8be42a74f31bc170b40ead7/NOTICE) | 逐文件核对第三方归属；不能只换品牌后删除原说明。 |
| H01 | [公开Conversation Factory](https://github.com/deepseek-ai/deepseek-harness/blob/687f282e8625c6b8d11ff58211a90524be2e4317/packages/client/ui-conversation/src/client/contract/slots.ts) | conversation.content有embedded形态，局部override只有views/widthControls，没有composer替换。 |
| H02 | [会话retain契约](https://github.com/deepseek-ai/deepseek-harness/blob/687f282e8625c6b8d11ff58211a90524be2e4317/packages/api/session-controller/src/client/contract/sessions.ts) | SessionReference retain/ready/release是客户端真实生命周期。 |
| H03 | [Provider注入和Factory调用](https://github.com/deepseek-ai/deepseek-harness/blob/687f282e8625c6b8d11ff58211a90524be2e4317/packages/client/ui-slots/src/index.ts) | SessionProvider由子槽声明触发注入，不存在任意import的组件捷径。 |
| H04 | [原生内容组件](https://github.com/deepseek-ai/deepseek-harness/blob/687f282e8625c6b8d11ff58211a90524be2e4317/packages/client/ui-conversation/src/client/skeleton/ConversationContent.tsx) | hero/phase/embedded的行为需真实运行验证。 |
| H05 | [Host Session创建命令](https://github.com/deepseek-ai/deepseek-harness/blob/687f282e8625c6b8d11ff58211a90524be2e4317/packages/api/session-controller/src/commands.ts) | Host create/queue remove/cancel真实签名；cancel接受不等于terminal。 |
| H06 | [Host命名Session复用](https://github.com/deepseek-ai/deepseek-harness/blob/687f282e8625c6b8d11ff58211a90524be2e4317/packages/api/session-controller/src/agent.ts) | started Session可能另mint身份，create不能作为无条件get-or-create。 |
| H07 | [真实Session持久化](https://github.com/deepseek-ai/deepseek-harness/blob/687f282e8625c6b8d11ff58211a90524be2e4317/packages/core/session/src/index.ts) | ctx.sessions.flush(session):Promise<boolean>；whenIdle不能替代。 |
| H08 | [pre-step执行顺序](https://github.com/deepseek-ai/deepseek-harness/blob/687f282e8625c6b8d11ff58211a90524be2e4317/packages/core/agent-loop/src/agent.ts) | waterfall最终decision后才进入模型步骤、写入对应消息。 |
| H09 | [原生队列](https://github.com/deepseek-ai/deepseek-harness/blob/687f282e8625c6b8d11ff58211a90524be2e4317/packages/core/agent-loop/src/inbox.ts) | remove按精确messageId；claimed尚不是全部持久执行事实。 |

## 3. 原仓库保留、重构和退出默认产品的范围

| 范围 | 处置 | 对应工单 |
|---|---|---|
| persistence、task/action、fact/evidence、forget/exclusion | 保留为唯一账本；修迁移/fence/版本语义并新增必要表 | T04、T05 |
| host/main-session、client/main-session | 重构为Host真实ensure和client retain；旧导航仅供来源打开 | T06、T07 |
| host/workspace-api、host-reader | 复用真实对象目录；补有预算的近期上下文、token和来源 | T10 |
| host/tools、preset | 扩展两个read工具，新增两个write/control工具，连入正式runtime | T11 |
| dispatcher、dsh-adapter、pre-step | 保留骨架，修精确claim/flush/归属/混批再启用生产委托 | T12、T13、T16 |
| client/index、header、settings、styles | 入口与布局收敛到boop.home；仅局部样式；设置人话化 | T07–T09、T20、T21 |
| board/taskboard/init | 默认页面退场；必要诊断保留；按真实引用清理不用代码 | T20、T21、T23 |
| scheduler/patrol/history init | 不新建默认日程或全量扫描；仅清理BOOP自有旧日程 | T22 |
| tests/tools/package | 修可移植性、旧产品断言、故障窗口和跨版本演练 | T02、T24–T28 |

## 4. DS-Bot 复用决策

本轮默认以“参考设计或调用方式后适配”为主；是否复制代码由每项工单的实际实现决定。不能在还没有复制之前就声称移植已完成，也不能为了证明用了DS-Bot而搬入无关模块。
| 参考来源 | 本轮复用内容 | 在BOOP的落点 | 必须去掉或改写 |
|---|---|---|---|
| ds-bot/src/client/header.js、member-status.js、activity-row.js | 身份层级、短状态和轻活动反馈 | home/Header、WorkCard及projection | Bot团队、群聊计数与内部名词；状态改读BOOP账本 |
| ds-bot/src/client/details-drawer.js | 按需展开详情与分层信息 | home/WorkDrawer、SettingsPanel | 全站right-panel依赖，Bot roster/store引用 |
| ds-bot/src/client/composer.js、bot-draft.js | 草稿、上下文连续与清爽输入的体验参考 | 保留DSH原生InputBar，本地ComposerState | 第二套输入控制器、全局composer替换；不直接复制整文件 |
| ds-bot/src/client/surface.js | 注册/卸载资源成组释放的思想 | home/controller生命周期 | shell/conversation全局替换及默认bot模式 |
| ds-bot/src/host/delivery.js | resolveAgent→followup→sessions.flush的真实路径 | BOOP dsh-adapter/result-publisher | rt.botOf/roster目标、steer、原state exchanges；增加稳定ID、授权和durability检查 |
| ds-bot/src/host/parts.js | 逻辑身份与物理历史段区分 | BOOP home历史迁移映射 | 全套分段runtime与自动轮换；首版沿用原生压缩 |
| ds-bot/src/host/roster/store/groups/handoffs | 暂不复用 | 无 | 保持一个助理与原任务库，不产生第二套数据真相 |
| ds-bot/src/client/themes/styles、cordis.patch.yml、host/update/resume | 不整体引入 | 无 | 全局CSS/搜索默认、自动更新及自动续跑 |
| app/ 与已构建 ds-bot/client.js | 不引入 | 无 | 独立Electron壳、历史遗留前端和第二套bundle |

## 5. 来源台账与许可证交付

`reuse-ledger.json` 已预置计划项，状态全部为 PLANNED。执行时逐文件填入真实目标路径、复制范围、修改说明和验收证据；没复制的标 design-reference 或 not-used，不冒报。复制/改写Apache代码保留适用的许可证与署名；是否需要额外NOTICE按实际被移植代码逐项核对。

现BOOP对旧dashi-taskboard的归属记录不能一并清空；只有对应代码全部移除才有依据调整那一项。新的BOOP品牌资产沿用当前用户认可素材，不把DS-Bot标志替换为用户品牌后当成原创。

## 6. 本轮已确认的重点工程缺口

1. ledger里的主会话ID不等于原生Session已创建并匹配preset。create还可能在旧Session已started时返回新的随机ID，因此必须先核查/resolve。
2. 已存在任务表、dispatcher、gate和测试文件，不代表自然语言生产路径已经接通；新工具与正式controller要共同完成。
3. 全队列claim后再find目标会改变其它任务，必须改action精确CAS。
4. whenIdle不是durable flush；cancel接受不是已停止；Session idle不是该委托结果已完成。
5. 原pre-step整批拒绝与pending BOOP触发整轮cancel会影响用户自己的输入/执行，必须先修再放开正式委托。
6. schema_version在迁移前被覆盖会隐藏升级，不能直接改常量发布。
7. 旧脚本依赖个人路径、固定rc.2证据或同版本重装；新版本不能原样沿用为发布证明。

每项缺口都已进入具体工单与验收，工程师不需要先重新猜测产品方向再决定要修哪一块。


---

<a id="c08"></a>

# 开工与交付说明

## 1. 从哪里开工

将交付包中的 `dsh-boop/docs/refactor/boop-mvp-v0.2/` 放入现有仓库的同名目录。交付包只包含规格、任务、用例和来源记录，不包含替换源代码的快照。不要覆盖现有 `src/`、`lib/`、数据或用户配置。

首先领取 T01 和 T02；通过后领取 T03。随后按 `tasks.json` 的依赖执行。T03 有源码依据和明确探针目标，作用是证明当前真实宿主能承载这组调用，不是重新讨论是否要独立页面。

默认实施位置是现有 `dsh-boop/`，不创建另一个生产仓库，不修改整个 DSH 客户端，不复制 DS-Bot `app/`。允许在现仓库使用隔离开发分支和测试 profile；不得重置其他人未提交的修改。

## 2. 给工程师或编码 Agent 的完整开工指令

以下内容可以连同本目录一起交给执行者：

> 在现有 `wanyexin1998/dsh-plugin/dsh-boop` 内实施 BOOP v0.2 MVP。先读 `00_工程师先读.md`、`01_产品与交互.md`、`ADR-0001-boop-home.md`，再按 `04_开发任务清单.md` 与 `tasks.json` 执行。
>
> 产品必须有自己的 `main:boop.home` 页面。Host 确保真实 BOOP 主Session；客户端显式retain/provider并嵌入公开conversation Factory。保留原生消息、草稿、输入与审批，入口不能再带用户到普通 DSH 新会话页。
>
> 真实工作闭环是：查找已有Session、读最新上下文、用户明确委托、正式工具创建任务与action、单槽调度到原Session、观察真实turn、持久结果、回主对话、用户确认或继续处理。一次任务一个已有Session。busy只留在BOOP队列，未知发送不盲重试；停止不能误停用户自己的工作。
>
> 保留现有SQLite为唯一任务/动作/事实主库，先修迁移启动次序与自身fence再增加schema。扩展`boop_catalog`和`boop_context`，新增`boop_dispatch`和`boop_task_control`，人类accept/approve不放进模型工具。
>
> DS-Bot按`07_源码依据与复用清单.md`定向适配。页面只控制自己范围，不引入全站surface/global CSS/默认搜索设置，不新增Bot roster、群聊或第二份React，不移植自动重启续跑。
>
> 不把旧手册要求“只能普通Conversation”当作本轮阻塞；新ADR明确覆盖该产品约束。其他归属、权限、证据、原宿主不受影响等规则仍有效。
>
> 首先记录实际Git根、分支/提交、dirty状态、Node/pnpm/DSH版本及基线错误；不要重置用户修改。用隔离DSH_HOME和临时项目进行测试，不能读取或迁移真实个人profile来图省事。
>
> 每次交付一个可审阅的小批次，包含文件变化、实际行为、验收证据和未解决项。全部命令实际执行后才记录结果，缺环境写BLOCKED/NOT_RUN/SKIPPED。当前文档中的42项用例均未运行，不得复制为PASS。未接通的能力显式unavailable，不用mock/toast伪装实现。
>
> 在当前明确授权的开发范围内完成代码与验证；不要仅返回下一步计划。推送、合并、发版、改生产数据等操作依照项目实际授权，不因本开工指令自动获得对外发布权限。

## 3. 代码组织边界

| 层 | 放什么 | 不放什么 |
|---|---|---|
| `src/client/home/` | 页面、状态订阅、轻卡、抽屉、输入外层与来源导航 | 第二套消息协议、任意模型HTML执行、SQL业务逻辑 |
| `src/shared/*-contract.ts` | 版本化DTO、允许动作、公开错误code与字段类型 | 数据库连接、宿主私有对象、凭据 |
| `src/host/home/` | ensureHome、原生主身份核验、历史关联与恢复 | 用户业务项目创建、全历史复制 |
| `src/host/delegation/` | 可信工具入口、上下文、调度、结果、控制与投影 | 另一个任务主库、DS-Bot roster |
| `src/host/transport/`、`gate/` | 原生消息/持久证据/准入/精确停止适配 | UI猜测状态、凭pending消息取消无关turn |
| `src/host/persistence/` | 原子SQL、迁移、幂等、租约和唯一索引 | 事务内等待native调用或模型输出 |
| `tests/`、`tools/` | 隔离fixture、可重放测试、环境记录 | 真实个人profile、写死个人路径/内部地址 |

这些新增路径是本轮建议落点。若现有风格更适合相邻模块，可以最小调整文件组织，但必须同时更新tasks.json与接口文档；不能藉此扩大产品范围或绕过验收。

## 4. 每一批怎么提交给代码审查

推荐批次依里程碑分组；单批可以含多个紧密相关任务，不要求29次强制独立提交。每批说明必须回答：

1. 用户现在能完成什么，为什么需要这次改动。
2. 修改了哪些已有模块，新增接口与schema是否兼容。
3. 实际跑过哪些验收，环境、候选SHA和证据在哪。
4. 哪些内容还未实现或缺环境，不把未运行项写成通过。
5. 如果出错，如何停用本批UI或恢复配套版本/数据。

建议首批只做T01–T03；第二批先完成持久化与主身份，再形成可聊天页面；第三批跑通真实委托和结果；最后补完整用户操作与故障/升级/安装验证。可按依赖并行，但必须共享同一套DTO和状态语义。

## 5. 证据目录与命名

实际执行后新增 `docs/refactor/boop-mvp-v0.2/evidence/<candidate-id>/`。`candidate-id`建议包含短SHA与构建标签；主清单保存完整SHA、dirty状态、package hash和环境。证据目录中的日志不能包含密钥或无关个人内容。

| 文件 | 应包含 |
|---|---|
| `environment.json` | OS、Node/pnpm、实际DSH app/payload版本与提交、Web/Desktop、模型真假与来源 |
| `cases.json` | caseId、实际步骤、实际结果、status、时间、关联截图/日志/DB断言 |
| `native-refs.json` | 精确主/目标Session、message/action/turn/result关联，必要事件seq |
| `migration-manifest.json` | 旧/新schema、备份方式/哈希、关键计数、完整性检查和回滚产物 |
| `package-manifest.json` | 候选SHA、tgz哈希、包内文件清单、许可证和兼容矩阵引用 |
| `known-issues.md` | 当前缺口、影响、替代步骤、是否阻塞声称的发布范围 |

文档中描述的成功路径属于验收预期。只有真实执行证据可以将某个case改成PASS。生成截图、模型mock或直接插数据库能验证对应层，但不能取代自然语言→原会话→真实产物的端到端演示。

## 6. 发布判定

必须同时具备M1独立聊天、M2真实闭环、M3可理解操作、M4迁移和故障/兼容证据。只完成界面可作为预览交付，但不能称本MVP完成。

若所声明的某个宿主组合不可用，可先完成其他开发工作，明确该组合BLOCKED；正式发布要么补齐证据，要么据实际验证收紧engine与peer范围并说明限制。不能让最终包与最后验证的SHA分离；包内文档、版本、许可证若在验收后修改，重新构建并按影响重验。

第一次真实验收请从01第8节的临时项目任务开始。它将同时暴露目标识别、模型工具、传输、结果、来源与用户确认是否真正接上，是最有效的整体检查。


---

<a id="c09"></a>

# ADR-0001：以独立 BOOP 页面承载持续助理体验

日期：2026-10-28。状态：本轮重构采用；等待工程实现与验收。

## 背景

用户明确要求 BOOP 有自己的页面；普通 DSH 对话入口与以账本/门禁/水位为主的任务板无法让用户理解助理正在做什么。当前代码还有主会话实际创建与 preset 核验、自然语言正式委托和结果回传接线的缺口。本轮须同时完成产品入口和最小工作闭环。

旧产品假设来自 `baseline/docs/04_前端设计方案.md`、`handoff/` 对旧方案的承接，以及客户端按原生 Conversation 导航的实现。它们记录历史决策，不再决定本轮用户入口。

## 决策

- 新增 `main:boop.home`，正文内嵌 DSH 官方 `conversation.content` Factory；Host 确保真实主 Session，客户端显式 retain/provider。
- 继续使用原生消息、输入、草稿与工具权限交互；主页结构、欢迎态、工作抽屉、设置和错误说明由 BOOP 持有。
- 入口不设置普通 DSH activeSession；只有用户点击来源时才导航原会话。
- 保留单一 SQLite 业务账本和一个 BOOP 逻辑身份；每任务一个已有 Session；委托全局单活动槽。
- DS-Bot 采用逐文件定向适配，不安装其整套全站界面或 Bot/群聊运行时。
- 旧任务板退出默认产品入口。诊断可留在高级设置，不作为聊天前置条件。

## 本次覆盖的旧约束

| 旧约束/假设 | 新规则 | 处理 |
|---|---|---|
| 主入口必须打开普通 Conversation | 打开 `boop.home` | 替换相应旧测试；保留单一主身份断言 |
| 普通新会话页上放初始化 dock | BOOP 自有欢迎态 | 移除全站默认 dock 注册；不删旧记忆数据 |
| 日常入口为任务板 | 聊天为主、工作抽屉为辅 | 旧 board 可作为诊断或历史代码，按引用分析清理 |
| 首次必须选择记忆起点 | 先聊，使用项目时按需读取 | 不再触发全量历史学习或默认新日程 |
| 默认暴露账本/门禁等状态 | 自有业务状态文案 | 技术字段仅进入可折叠诊断 |

用户权限、目标归属、来源可追溯、用户直接指令优先、未知结果保守恢复、原宿主不受污染等工程约束继续有效。不能引用本 ADR 为绕过这些约束的理由。

## 代价与边界

需要实现正确的 SessionProvider 生命周期和独立页面状态。Factory 没有局部 composer 全替换接口，因此保留原生编辑器，通过稳定数据槽进行实例内简化。模型设置不虚构公开导航 API；缺模型时引导用户打开保留的 DSH 设置入口。结果卡主动提供原会话入口，不承诺独立页能直接打开宿主所有右侧文件预览。

旧主 Session 不能安全改变 preset 时，以保留历史关联的方式迁移到新的物理 Session，逻辑身份保持；不重写旧原生事件。数据库新增结构前先修启动迁移顺序并验证回滚。

## 验证

A01/A02/A25/A26 验证专属入口和身份；A09/A16/A18 验证委托闭环；A27–A31 验证数据；A33/A39/A41 验证宿主隔离。所有用例当前为 NOT_RUN。

