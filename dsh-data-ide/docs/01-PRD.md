# 01-PRD — dsh-data-ide 产品需求文档

> 状态：草案（待 G0 范围冻结签认）｜版本：0.1｜日期：2026-10-17
> 上游：`00-README.md`｜下游：02/03/05/07 均引用本文的范围与验收标准

---

## 1. 背景与问题

数据团队日常在 Doris（`doris.shcell.com:9030`，Doris 2.1.10，MySQL 协议）与 Oracle DW（`172.26.200.92:1521`）上做取数、验证、脚本迭代，当前工具链存在三个断点：

1. **DataGrip 重量级且游离于 agent 工作流之外**——SQL 验证结果要手动搬回对话，agent 无法直接查数；
2. **SQL 脚本无版本管理习惯**——临时脚本散落，无 pull/commit/push 闭环；
3. **多工具切换成本**——连接管理在一个工具、编辑执行在另一个、git 在第三个。

**机会**：dsh 是 "everything is a plugin" 的 agent harness，右栏具备原生 pane/tab 扩展点（`session.pane.right`），且自带 MCP client 与插件自动安装链路。把轻量 SQL 工作台做成 dsh 插件，可让人与 agent 共享同一套连接、执行与版本管理能力。

## 2. 目标用户与场景

| 用户 | 核心场景 |
|---|---|
| 数据 PM/分析师（人） | 在右栏 tab 管理 Doris/Oracle 连接 → 写 SQL → 看网格结果 → 翻页/排序 → 脚本 git 提交 |
| dsh agent（机器） | 通过 `mcp__sql__*` 工具列数据源、执行 SQL、拉取分页、读写脚本、git 提交推送 |
| 二者协同 | 人验证过的 SQL 与结果，agent 可直接引用；agent 跑的查询，人在 tab 里可见历史 |

## 3. 产品形态

- **UI**：dsh（0.1.7-rc.2）右栏新**页面类型 tab**——插件注册 `sidebarRightTabs` 页面类型 + `sidebar.right.pane.tab` 两个 keyed seat，与内置 tab（工作区文件 / 新建终端 / 浏览器）并列共存，不替换任何内置页面；
- **服务**：同插件附带 MCP server（stdio 子进程），`dsh plugin add` 安装后自动进入 profile bundles，下次启动 agent 即可见 `mcp__sql__*` 工具；
- **范围**：恰好四项——数据连接、SQL 编辑、查询结果呈现、git 拉取/提交/推送。

## 4. 范围定义（R1-R4）

### R1 数据连接管理

| 能力 | 行为 | DataGrip 锚点 |
|---|---|---|
| 连接 CRUD | 新增/编辑/删除/复制连接；字段：名称、DBMS、host、port、database、用户名、驱动属性、备注 | `LocalDataSource` 字段子集（SPEC §2.4） |
| 连接测试 | 一键测试，三态反馈（成功/失败/不确定+原因），写入 `database-info` 式缓存（product/version/driver-version/dbms） | ThreeState + ErrorInfo（SPEC §4） |
| 凭据 | 密码存 dsh 凭据 seam（`ctx.credentials`），配置文件只有引用；支持"仅本次会话" | secret-storage=master_key / MEMORY / SESSION（SPEC §2.3） |
| Doris 支持 | MySQL 协议，默认端口 9030，默认驱动 mysql2 | RUNTIME-FINDINGS §2.2 |
| Oracle 支持 | **2026-10-17 决定：移出当前范围（降级为 P1）**，现网基本不用 Oracle；如需恢复见 08-RISKS R4 与 07-MILESTONES M4 | 混合后端决策 |

### R2 SQL 编辑

| 能力 | 行为 |
|---|---|
| 编辑器 | 多 SQL tab（tab 内 sub-tab）；SQL 高亮（复用 ui-primitives CodeBlock/shiki 或轻量编辑器）；执行选中语句或全部 |
| 执行控制 | 执行/取消；执行状态与耗时展示；语句级错误定位（行号） |
| 脚本文件 | SQL 可保存为脚本目录内文件（`.sql`），与 git 联动 |

### R3 查询结果呈现

| 能力 | 行为 | DataGrip 锚点 |
|---|---|---|
| 网格 | 表格式结果；列宽调整；NULL/日期/数字格式化；复制为 TSV/CSV | Formatter 分发（SPEC-sql §6） |
| 分页 | 页大小默认 500 可调；**首页取 `pageSize+1` 行探针**；独立 COUNT 取总数；翻页/跳页走 OFFSET | LIMIT 501 + COUNT + OFFSET 51786（RUNTIME-FINDINGS §4） |
| 大值保护 | 单单元格默认上限 1MB，预览截断 32KB，超限标记"值过大" | Constraints.maxLobLength（SPEC §4） |
| 排序 | 点击列头 = 服务端 ORDER BY（重新执行，非本地排序） | 决策：服务端排序 |
| 查询历史 | 每连接最近 N 条（默认 200）：SQL/状态/耗时/行数/时间 |

### R4 git（作用于隔离的 SQL 脚本目录）

| 能力 | 行为 |
|---|---|
| 目录 | 插件自有脚本目录（`<dshHome>/data-ide-scripts/`，`git init`，与 dsh 宿主仓库隔离） |
| 工具栏 | status / diff 预览 / commit（message 输入）/ pull / push |
| agent 侧 | 同能力经 MCP 工具暴露（`git_*`） |

## 5. 非目标（N1-N6，每条附理由）

| # | 非目标 | 理由与依据 |
|---|---|---|
| N1 | 单元格编辑回写（INSERT/UPDATE/DELETE 生成） | DataGrip 该能力=MutationsStorage+DML 生成器（评估 #11，中难度）；MVP 聚焦只读分析场景；P1 候选 |
| N2 | schema 树/introspection | 评估 #12 中难度；2026-10-19 落地窄版（表 → 列，可筛选、点击插入），同日**升级为层级化对象树**：数据源 → 库 → 表/视图 分组 → 对象 → 列，表右键可 打开数据 / 复制引用 / 查看 DDL（`SHOW CREATE` 走 `raw` 执行模式）/ 刷新，跨库浏览已支持；**仍不做**：键/索引/触发器节点、结构比对、拖拽生成 JOIN |
| N3 | SSH/SSL 隧道 | SPEC §5 有完整设计，但当前数据源均内网直连（doris.shcell.com/172.26.200.92 无需隧道）；P1 |
| N4 | SQL 智能补全/解析器 | 评估 #14 很高难度（JetBrains PSI 级十年积累）；**2026-10-19 落地「可用的一半」，2026-10-20 换内核**：补全与高亮改由 CodeMirror 6 的 `@codemirror/lang-sql`（MySQL 方言 + schema 命名空间）承担，表/列/别名补全与语法高亮都开箱可用，`src/host/metadata.ts` 的 introspection（按连接 5 分钟缓存）为其供数据。**仍然不做**：PSI 级作用域/CTE 推导、语义校验、跨库同名表的智能前缀 |
| N5 | 多结果集对比/图表 | 超出"轻量"定位；网格插件（grid-plugin）已有图表能力，不重复 |
| N6 | 远程执行（WSL/Docker/Eel 类似物） | 评估 P2；dsh 自身远程能力就绪后再评估 |
| N7 | **Oracle 连接与 Java 桥**（原 M4） | 2026-10-17 用户决定：基本不用 Oracle，整块降级 P1；不做桥即不必分发 ojdbc11，也就没有 OTN 许可负担 |

## 6. 用户故事

**人的故事**
- US-1 作为分析师，我要在右栏新建一个 Doris 连接并测试通过，以便开始查数。（验收：AC-1）
- US-2 我要写 SQL 并执行，看到前 500 行和总行数，以便判断数据规模。（AC-2）
- US-3 我要翻到第 100 页并改页大小为 1000，以便浏览不同范围。（AC-3）
- US-4 我要把 SQL 存成脚本并 commit/push，以便版本沉淀。（AC-4）
- US-5 我要在连接表单点"测试连接"后立即看到成功/失败原因。（AC-1）

**agent 的故事**
- US-6 作为 agent，我要列出所有数据源并执行只读 SQL，以便回答用户的数据问题。（AC-5）
- US-7 作为 agent，我要读取/写入脚本并 commit/push，以便沉淀查询资产。（AC-4）
- US-8 作为 agent，默认不能执行写操作，除非连接显式开启 writeEnabled。（AC-6）

## 7. 信息架构

```
右栏 pane（session.pane.right，仅 split 时可见）
├─ pane 工具栏：[-SQL 工作台-] [执行] [取消] [页大小▾] [git: branch↯] [关闭]
├─ 视图区（单滚动多区，非 sub-tab）
│   ├─ 连接条：连接选择器（dropdown）+ 测试按钮 + 状态点
│   ├─ 编辑器区：SQL sub-tab × N + 执行/保存
│   ├─ 结果网格：列头/行/分页条（首页/上页/页码/下页/末页 + COUNT）
│   └─ git 面板（可折叠）：status + diff 预览 + commit message + pull/push
└─ 底部状态条：行数/耗时/页范围/错误摘要
```

（详细线框与 token 映射见 `03-UIUX-SPEC.md`）

## 8. 验收标准（可测，供 07 里程碑引用）

| # | 标准 |
|---|---|
| AC-1 | 新建 Doris 连接（mysql2 默认参数）测试连接 ≤3s 返回三态之一；失败时展示可读原因（如认证失败/网络不可达） |
| AC-2 | 执行 `SELECT` 于内网大表：首页（500+1 行）≤2s 返回；总数 COUNT 与首页探针一致（不差 1） |
| AC-3 | 翻页/跳页/改页大小均走 `LIMIT n+1 OFFSET m`；连续翻 3 页无重复行无漏行 |
| AC-4 | 脚本保存→commit→push 全流程在 UI 完成；diff 预览可见增删；agent 经 `mcp__sql__git_*` 完成同样流程 |
| AC-5 | 插件安装后（无需手工配置 MCP），agent 工具列表出现 `mcp__sql__list_datasources` 等工具 |
| AC-6 | 默认策略下 agent 执行非 SELECT 被拒绝并返回明确错误；连接开启 writeEnabled 后放行 |
| AC-7 | 全部界面使用 `--dsw-alias-*` token；亮/暗主题切换无硬编码色残留 |
| AC-8 | per-file 100% coverage 通过；Agent Note 随 PR 提交 |

## 9. DataGrip 能力对照表

| DataGrip 能力 | 我们 | 依据 |
|---|---|---|
| 多 DBMS 连接管理 | ✅（Doris/MySQL M1，Oracle M4） | 评估 §4 #2 |
| 驱动声明+下载（Aether/Maven 仓库） | ⚠️ 简化：驱动内置于 MCP server（mysql2 内置；Oracle 桥带 ojdbc） | 评估 §4 #5 降级 |
| URLClassLoader 隔离 | ⚠️ 仅 Java 桥需要（Oracle），mysql2 无隔离问题 | SPEC §3.3 |
| XStream 双文件存储 | ✅ 等价物：storage-json 全量 + 凭据 seam 分离 | SPEC §2.1 设计含义 |
| KeePass 凭据 | ✅ 等价物：`ctx.credentials` | SPEC §2.3 |
| SSH/SSL 隧道 | ❌ N3 | SPEC §5 |
| 连接测试三态 | ✅ | SPEC §4 |
| LIMIT n+1 分页 + COUNT | ✅ | RUNTIME-FINDINGS §4 |
| 三层索引/排序过滤 | ⚠️ 简化：服务端排序；本地过滤仅当前页 | SPEC-sql §6 |
| 单元格图像/格式缓存 | ❌（轻量化，显式不做） | SPEC-sql §5 |
| 编辑回写 | ❌ N1 | 评估 #11 |
| introspection/schema 树 | 🟡 N2（窄版对象树已上） | 评估 #12 |
| SQL 补全/检查 | 🟡 N4（启发式补全已上，语义检查未做） | 评估 #14 |

## 10. 开放问题（指向 08-RISKS 与 G0 评审）

1. agent 写权限默认值（建议默认只读，G0 终审）——见 05 §安全边界；
2. Oracle 是否进 MVP（建议 M4 独立，不阻塞）；
3. 右栏入口：右栏收起或当前 tab 未打开时，用户如何直达 SQL 工作台（建议：`sidebarRight.openTab(kind)` 的 footer action / 命令入口，不依赖任何容量协商）；
4. 页大小默认值 500 是否对所有 DBMS 一致（Oracle 桥侧需验证）。
