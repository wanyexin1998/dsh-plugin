# E04-02 · Taskboard 组件提取来源与许可登记

> 状态：已登记（2026-10-18，E04-02 客户端半）
> 上游：`chuspeeism/dashi-taskboard`，**固定提交** `723c400eec86c454c1ffa56ee1b500746d41e142`
> （本机检出 `.work/taskboard-src`，未修改上游工作树；`git rev-parse HEAD` 复核一致）。
> 上游许可：根 `LICENSE` 为 **Apache License 2.0**（11,558 bytes）；上游根目录**没有** `NOTICE` 文件，因此无可继承的 NOTICE 文本。
> 本文是 E04-02 交付的逐文件复用台账（TB10 的本地证据）。引用章节：04§06–07、06§03–08、`handoff/issues/E04-02.md`、`docs/development/E04-00-taskboard-spike.md`。

## 0. 结论（先读）

- **没有整体拷贝任何上游组件**；没有整包运行上游 App / 独立 HTTP 服务 / SQLite 任务库。
- 只按 E04-00 的提取面，**改写式提取**布局与交互思路（BoardColumn 的列结构、TaskCard 的卡片信息层级、IssueListView 的分组折叠行、taskFilters 的筛选形状）；所有文件按 BOOP 三轴任务契约（Host 半 `src/host/tasks.ts`，契约 by task-6）重写，并保留 Apache-2.0 归属与修改标记。
- **不引入**：上游 Markdown 管线（`remark-parse`/`remark-gfm`/`unified`）、Codex `api`/`actors`/`taskConversations`、附件 URL 解析、独立服务/DB、CDP/Tauri、AiChat、Gantt、全局 `styles.css`、Codex 品牌资源、React 19 专属 API。
- BOOP 客户端 bundle 仍 `external: ['react','react-dom']`（宿主 React 18.3.1 单实例，TB02）；本批新增运行时依赖 = **0**。
- 新增文件均带来源/许可/修改点头注释；`src/client/taskboard/**` 的样式只在 `[data-boop-taskboard]` 作用域内生效，并以 `data-plugin-css="boop/taskboard"` 注入、卸载即移除（FE-12）。

## 1. 逐文件登记

| 上游文件（固定 SHA 下） | 体量 | BOOP 目标文件 | 处置与修改点 |
|---|---:|---|---|
| `web/src/components/BoardColumn.tsx` | 6,048 B | `src/client/taskboard/BoardColumn.tsx` | **改写提取**。保留：列头（标签+计数）、可折叠列体、列内卡片序列、空列文案的结构思路；列按 BOOP `DisplayGroup`（todo/in_progress/needs_me/finished）驱动。删除：`useTaskCardDragPreview`、HTML5 drag/drop 全部事件、上游 `TaskStatus` 映射、i18n、`onCreate`、ContextMenu、`SemanticIcons`/SVG。新增：`aria-expanded`/`aria-controls` 列折叠按钮、列内 roving focus（↑/↓）。跨列拖拽首版关闭（TB05）。 |
| `web/src/components/TaskCard.tsx` | 23,126 B | `src/client/taskboard/TaskCard.tsx` | **裁剪改写**，非拷贝。保留：卡片信息层级（标题、单行状态、属性/元信息行、动作区）、两行省略+完整文本入口的思路。删除：`remark-gfm`/`remark-parse`/`unified` Markdown 管线、`../api`（Codex API）、`../actors`、`../labels`、`../taskConversations`、`resolvePersistedAttachmentUrl`、封面图/图片解析、`ActorAvatar`/`LinearIcon`/`SemanticIcons`/`LabelPicker`/`TaskPropertyPicker`/`TaskConversationMenu`、2 个 SVG 资源、`document.startViewTransition` 完成动效（本版根本没有"完成"动作）。新增：BOOP 三轴状态行（Host 派生 `statusLine` 优先）、待决原因、`data-boop-lifecycle/-verification/-authorization` 只读事实、同列"上移/下移"语义按钮、写回状态如实显示（pending/rejected/error/confirmed）。全部任务文本用 React 纯文本渲染（TB07 停靠方案）。 |
| `web/src/components/IssueListView.tsx` | 9,782 B | `src/client/taskboard/IssueListView.tsx` | **选择性改写**。保留：按状态分组、组头折叠按钮、行布局（标题+元信息+时间）思路。删除：`actors`/`TaskPropertyPicker`/`TaskConversationMenu`/`ActorAvatar`/`LinearIcon`/`LabelPicker` 等 Codex 写入与身份控件、优先级/负责人/截止日期内联写、`onUpdate`（本版只读）。新增：使用与看板同一 `view-model`（不生成第二份任务状态）、`role="button"` 行 + Enter/Space 打开详情 + ↑/↓ roving focus、已结束组默认折叠。 |
| `web/src/taskFilters.ts` | 4,111 B | `src/client/taskboard/view-model.ts`（筛选段） | **思路提取**。保留：筛选计数（`filterCount`）、搜索匹配（`matchesTaskSearch`）的形状。删除：URL query 读写（`readTaskFilters`/`writeTaskFilters`，BOOP 面板不写宿主 URL）、上游 status/priority/label 字段。映射为 BOOP 字段：`displayGroup`、`workspaceId`、`pendingReason`、标题/ID/工作区/会话的文本搜索；筛选仅本地视图，不改任务。 |
| `web/src/types.ts` | 13,324 B | `src/client/taskboard/view-model.ts`（类型段） | **字段思路参考**，不拷贝类型。BOOP 类型以 Host 半 `src/host/tasks.ts` 的 `TaskCardFacts`/`TasksListFacts`/`TaskDetailFacts`/`TasksCapabilitiesFacts`/`TasksWriteRefusalFacts` 为准（契约 by task-6，2026-10-18 用 `.work/contract-fixtures.json` 复核）。 |
| `web/src/useTaskCardDragPreview.ts` | 2,667 B | **未引入** | 跨列拖拽首版关闭（TB05，04 册末尾规则优先于 06 册条件式描述）；同列排序改为纯本地视图 order + “上移/下移”语义命令。 |
| `web/src/i18n.tsx`、`labels.ts`、`actors.ts`、`api.ts`、`taskConversations.ts` | — | **未引入** | Codex 身份/任务对话/独立 API 不在 BOOP 契约内；文案直接用中文常量。 |
| `web/src/components/SemanticIcons.tsx`、`LinearIcon.tsx`、`ActorAvatar.tsx`、`TaskboardIcon.tsx` 及 `assets/figma-taskboard/*` | — | **未引入** | 图标/头像/SVG 资源为上游品牌资产，不进入 BOOP；本版不新增图标依赖。 |
| `web/src/App.tsx`、`web/src/main.tsx`、`server/database.mjs`、`server/*` | — | **未引入** | BOOP 不运行上游独立服务/第二任务库；任务唯一权威是 BOOP 账本。 |
| `web/src/styles.css`（205 KB 全局样式） | — | **未引入** | BOOP 看板样式重写为 `[data-boop-taskboard]` 作用域、主题/reduced-motion 适配（FE-09/FE-12）；没有 body/reset/`.dsw-` 污染。 |
| `integrations/deepseek-harness/*`（iframe + `_centerCol` DOM 扫描） | — | **未引入** | BOOP 使用 rc.2.1 root `main` keyed slot（`boop.tasks`），不扫描宿主 DOM、不覆盖窗口控件（TB03）。 |
| `src-tauri/*`、`inject/*`、`cloud/*`、`gantt/dhtmlx-gantt`、`AiChat` | — | **未引入** | 不启动第二桌面壳、不开 CDP、不引入云/Jira/甘特图/第二聊天。 |

## 2. 新增文件（本仓库原创/改写）

| 文件 | 说明 |
|---|---|
| `src/client/taskboard/view-model.ts` | 纯展示逻辑：Host fact 归一化、四组投影（Host `displayGroup` 优先，缺省按三轴回退）、同列本地排序、请求序号/`projectionSeq`/`taskVersion` 旧响应保护、筛选、详情行投影、诚实文案与 tone。 |
| `src/client/taskboard/commands.ts` | 语义命令映射：读端点 `boopTasks/list|detail|capabilities`、唯一写端点 `boopTasks/setPriority`（必拒，显示 code/message/blockedByGates/audit）、本地排序/筛选命令、`request` 单参数 wire 封装。 |
| `src/client/taskboard/styles.ts` | `[data-boop-taskboard]` 作用域样式 + `installTaskboardStyles()`；无全局选择器。 |
| `src/client/taskboard/index.tsx` | `TaskboardPanel`：状态机（loading/ready/unavailable/error/partial）、看板/列表切换、筛选工具栏、详情抽屉、能力/写回说明、样式注入与卸载清理。 |
| `tests/client/e04-02-taskboard.test.mjs` | jsdom 16 项：四组渲染、TB04 验收区分、列表共用 view model、同列排序+写回拒绝、键盘替代、空/错/断线/部分覆盖、旧响应（请求序号/projectionSeq/taskVersion）、纯文本无 Markdown、作用域样式与卸载清理、能力与拒绝审计、详情 found/unavailable、筛选、bundle 静态约束。 |

## 3. 依赖与许可清单（TB02/TB10）

- **新增第三方运行时依赖：无**。未引入 `remark-*`/`unified`/`markdown-it`、无图标库、无拖拽库、无第二 React。
- 客户端构建：`build.mjs` 现有 esbuild-wasm；`lib/client.js` 保持 `external: ['react','react-dom',…]`，React 来自宿主平台模块（18.3.1）；测试 bundle `lib/taskboard.test.bundle.cjs` 同样 external React。
- Apache-2.0 合规：保留上游许可与提交号归属（本文 + 各文件头注释“source & licence”），逐个文件标明修改点；上游无 NOTICE 需保留。BOOP 本仓库自身 `package.json` 声明 `Apache-2.0`。
- 上游许可 URL：<https://github.com/chuspeeism/dashi-taskboard/blob/723c400eec86c454c1ffa56ee1b500746d41e142/LICENSE>

## 4. 与任务书“契约 by task-6”的差异记录（2026-10-18 适配）

任务书初稿契约与 Host 半最终实现（`src/host/tasks.ts` + `.work/contract-fixtures.json`，Host 已在真实 rc.2.1 宿主验证 11/11）存在以下差异，客户端**以 Host 实际为准**并已适配：

1. 组键：任务书写“待开始”组，Host 实际 key 为 **`todo`**（而非 `pending`）；固定顺序 `todo → in_progress → needs_me → finished`，客户端使用 Host `displayGroup`（每卡）+ 固定顺序渲染，缺省才本地回退推导。
2. 端点：Host 实际另有**唯一写端点** `boopTasks/setPriority`（必回 `CAPABILITY_UNAVAILABLE` + audit），任务书只列了三个读端点；客户端已接入该端点并显示拒绝事实，未虚构成功。
3. wire 形状：每个方法一个 `request` 参数 → `{ args: { request: {...} } }`；`{ args: {} }` 也允许（`request=undefined`）。客户端在 `commands.ts` 的 `TASKBOARD_ARG_KEY` 一处封装。
4. list 返回比任务书更丰富：`writeMode`、`filter`、`ignoredFilters`、`orderBy/orderDir`、`groups:[{key,label,order,count}]`、`page`、`scan`、`projectionSeq`、`generatedAt`；客户端使用 `projectionSeq`（单调序号）+ 请求序号 + 每卡 `taskVersion` 三层旧响应保护（AT-19/FE-04）。
5. card 字段：Host 提供 `displayGroup/displayGroupLabel/pendingApproval/primarySessionId/targetCount/dependencyCount/latestAction/statusLine/createdAt`；`authorization` 为执行/授权轴（latest action state，`none`=未派发），不是布尔授权。客户端按此显示，不另造字段。
6. detail 返回 `found/notFoundReason/snapshot/revisions/targets/dependencies/actions/approvals/evidence/coverage/limitations`；客户端已按 04§07 顺序渲染，并对 `found:false`（`task-not-found`/`invalid-request`）单独给“没有找到任务”，不当作错误也不当作空详情。
7. write refusal 事实（`accepted:false/executed:false/code/reason/message/blockedByGates/localViewOnly/audit{recorded,sink,id}`）原样显示在卡片上（含审计 sink），状态只能是 `rejected`；`confirmed` 必须同时 `accepted:true && executed:true`（当前 Host 不可能）。

## 5. 证据与未完成项

- 本批可复现：`node build.mjs`；`node --test --test-force-exit tests/client/e04-02-taskboard.test.mjs`（16/16）。
- **fixture 边界**：jsdom 测试的 Host 数据全部为按契约生成的 fixture（`.work/contract-fixtures.json` 形状），**不构成真实宿主集成证据**。
- TB 可证项（客户端静态/组件级）：TB02（bundle external React、无第二 React）、TB04（四组/验收区分）、TB05（无跨列拖拽、写回必经服务端且拒绝可见）、TB06（旧响应保护）、TB07（纯文本、无 Markdown 管线/附件解析）、TB08（作用域样式、键盘/非拖拽路径）。**NOT_RUN**：TB01/TB03（真实 Web/Desktop 安装、窗口/分屏）、TB06 的真实宿主重连、TB09 的真实宿主端拒绝（Host 侧已有 real-host 证据，客户端联调待 E04-03/一体化回归）、TB10 的发布检查。
- 来源字段复核命令：`git -C .work/taskboard-src rev-parse HEAD` → `723c400eec86c454c1ffa56ee1b500746d41e142`。
