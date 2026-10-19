# E04-00 · Taskboard 组件提取兼容性 Spike

> 上游：`chuspeeism/dashi-taskboard`，固定提交 `723c400eec86c454c1ffa56ee1b500746d41e142`
> （本机以 `--filter=blob:none --no-checkout` 克隆后按 tag/提交检出到 `.work/taskboard-src`，未修改）。
> 宿主：Spike 时 DSH 0.2.0-rc.2；**rc.2.1 对齐后复核（2026-10-18）**：宿主 0.2.1-rc.2 的 React 仍为 **18.3.1**
> （web shell 静态模块表），Chrome 126 目标与 root `main` keyed slot 均不变。上游 `package.json` 声明 `react: ^19.2.7`。
> 本 Spike 只做静态核对与提取面界定；**尚未移植任何代码到 BOOP**。

## 1. 结论

| 问题 | 结论 | 依据 |
|---|---|---|
| 上游许可 | **Apache-2.0**，可在保留许可与归属、标明修改的前提下提取 | 根 `LICENSE` 首行 `Apache License Version 2.0` |
| React 19 → 18 兼容 | **提取候选组件只使用经典 hooks**（`useState`/`useEffect`/`useMemo`/`useRef`/`useCallback`），未使用 `useEffectEvent`/`useOptimistic`/`useActionState`/`<Activity>` 等 React 19 专属 API | 扫描 `BoardColumn.tsx`/`TaskCard.tsx`/`IssueListView.tsx` |
| 是否可整体拷贝 | **不可**。`TaskCard.tsx` 直接依赖 `../api`（Codex API）、`../actors`、`../taskConversations` 与整条 Markdown 管线 | 导入清单见下 |
| 宿主渲染方式 | 使用 rc.2 已核验的 root `main` keyed slot（BOOP 已注册 `boop.tasks`），**不**沿用上游 iframe + `_centerCol` DOM 扫描 + fixed 覆盖 | 冻结 06§02 与第 04 册；本仓库 `src/client/index.tsx` |
| 依赖体量 | 上游 23 个运行时依赖；v1 只需要其子集 | `package.json` 依赖清单 |

## 2. 提取面界定（源码实测）

| 文件 | 体量 | 直接依赖 | 处置 |
|---|---:|---|---|
| `web/src/components/BoardColumn.tsx` | 5.99 KB | `react`(type)、`../useTaskCardDragPreview`、`../types`、`../i18n`、`./TaskCard`、`./SemanticIcons` | **优先提取**；列由 BOOP 三轴状态投影驱动 |
| `web/src/components/TaskCard.tsx` | 22.99 KB | `remark-gfm`/`remark-parse`/`unified`（Markdown 管线）、`../api`（Codex API）、`../actors`、`../labels`、`../taskConversations`、`ActorAvatar`、`LinearIcon`、`SemanticIcons`、`LabelPicker`、`TaskPropertyPicker`、`TaskConversationMenu`、2 个 SVG 资源 | **裁剪提取**：去 Codex actor/API/thread，保留布局、时间、标签、拖拽 |
| `web/src/components/IssueListView.tsx` | 9.71 KB | `../i18n` 等 | 选择性复用，与看板共用同一 view model |
| `web/src/taskFilters.ts` | 4.11 KB | 无 React | 字段映射为 BOOP 工作区/受托范围/待决原因 |
| `web/src/types.ts` | 13.32 KB | — | 只取 BOOP 需要的字段 |

## 3. 需要在 E04-02 处理的兼容性点

1. **`document.startViewTransition`**：`TaskCard` 的完成动效直接调用该浏览器 API。宿主目标为 Chrome 126（支持），但必须做特性检测并降级，不得让动画缺失导致功能失败。
2. **Markdown 渲染**：`TaskCard` 内嵌 `unified().use(remarkParse).use(remarkGfm)`。第 04 册要求模型 Markdown 必须走宿主安全渲染；提取时**不得**自带这套渲染器，改为宿主已授权渲染能力（TB07）。
3. **状态映射**：上游单 `status`（backlog/todo/in_progress/in_review/blocked/done/canceled）必须映射为 BOOP 三轴投影；跨列拖拽首版关闭，同列排序只改优先级。
4. **第二 React 风险**：BOOP 客户端构建把 `react`/`react-dom` 标为 external（宿主平台模块），提取组件必须保持该约束（TB02）。
5. **不引入**：上游独立服务、`.data/taskboard.sqlite`、Codex AI Chat、CDP 注入器、Tauri 启动器、`dhtmlx-gantt` 甘特图（v1 不引入；其 v10+ Community 已为 MIT，仍以实际锁定版本为准）。

## 4. 状态

- 上游源码已在固定提交上取得并核对 ✅
- 组件移植：**未开始**（E04-02）— 需先有 BOOP 任务账本接口（E02-01）与 Board Adapter（E04-02）
- TB01—TB10：**全部 NOT_RUN**，本 Spike 不构成任何 TB 通过
- 许可与归属台账：见 `handoff/templates/SOURCE_REUSE_LEDGER.json`，实际导入文件在 E04-02 落地时逐文件登记
