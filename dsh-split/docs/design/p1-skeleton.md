# P1 目标骨架设计（设计稿，**G0 通过前不落代码**）

**冻结基线**：`DSH-SPLIT-V5-FROZEN-20261015`　**宿主**：`dsh 0.2.0-rc.2`
**依据**：方案 §04（三个职责边界）、§06（生命周期不变量）、§07（保存与迁移）、§09（阶段门槛与目录建议）
**前置**：W007（G0 放行）。本文只写结构、职责、不变量与验收映射，**不含实现**。
**接口级规格见 [`p1-interfaces.md`](p1-interfaces.md)**（模块签名、状态形状、硬约束与验收映射）。

## 1. 目录（遵循方案 §09 的建议，保持小而明确）

```
src/
  index.ts                宿主半边：能力探针 + 不兼容版本拒绝（保持空实现直到需要）
  client.ts               浏览器半边入口：注册 overlay / 菜单 / 快捷键，装配下面各模块
  workbench/              外层：一份 Dockview、面板目录、方向动作、外层快照
    host.ts               Dockview 实例与受限配置（一 Group 一会话、禁浮动/popout/中心合并）
    panels.ts             add/move/resize/maximize/close 的命令层（只调公开 API）
    snapshot.ts           toJSON/fromJSON 的封装与校验（普通操作绝不 fromJSON 重建）
  session-surface/        内层：每会话「轻量标题 + 会话内 CSS 分栏」
    surface.ts            宿主元素与生命周期（panelId ↔ sessionId ↔ bindingEpoch）
    layout.ts             正文/分隔条/Sidebar 的 Grid 区域分配（换边只改区域，不搬 DOM 父节点）
    focus.ts              轻灰遮罩与「明确激活会话」的呈现状态（不是 React 状态）
  dsh-adapter/rc.2/       与宿主契约的唯一接触面（版本锁定在此目录内）
    sessions.ts           retain/release、SessionReference、bindingEpoch
    conversation.ts       SessionProvider + conversation.content（variant:'embedded'，不替换 views）
    sidebar.ts            Sidebar 宿主与可见性/尺寸报告（含补丁期与无补丁期的两条实现路径）
    slots.ts              shell.overlay / main keyed slot / 行菜单席位的注册与释放
    commands.ts           commandUi + inputTriggers 的会话归属与捕获复核
    attachments.ts        拖放定向（补丁前：捕获阶段拦截 + createDrafts 旁路；补丁后：原生路由）
  persistence/            只保存「外层布局 + 逐会话 Sidebar 停靠/比例」
    schema.ts             schemaVersion、宿主基线、引擎版本、体积/深度/去重校验
    migrate.ts            旧 dsh.split.v1 的一次性迁移（只迁移可验证且去重的会话引用）
    store.ts              防抖提交、结束时 flush、失败内存兜底
  theme/                  会话/Sidebar 共享 token（--session-radius 等）与插件自有宿主样式
tests/
  workbench.test.mjs      外层状态与命令（纯逻辑，无 DOM）
  surface.test.mjs        区域分配与换边的纯函数部分
  persistence.test.mjs    schema/迁移/去重/畸形数据
  adapter-checks.mjs      针对 dsh-adapter 的契约断言（宿主替身）
```

**构建**：`src/` → `lib/`（`lib/client.js`、`lib/index.js`）。esbuild 打包，`react`/`@deepseek-ai/cordis` 等**保持外部**（禁止第二份 React）；`legalComments: 'inline'` 保留随包 MIT 声明；产物头部写明「生成文件，勿手改」。
**过渡协议**：新实现先构建到 `dist/`；只有冒烟通过后才把产物路径切到 `lib/`，避免开发期破坏用户正在使用的旧插件（`lib/client.js` 在此之前保持可用）。

## 2. 三个职责边界与状态归属（照 §04.3 落位）

| 状态 | 唯一所有者 | 模块 | 是否入快照 |
| --- | --- | --- | --- |
| 会话消息、草稿、模型、运行状态 | DSH 原生 | — | 不复制 |
| Sidebar Tab、内容地址、导航、终端身份、关闭流程 | DSH 原生 | `dsh-adapter/sidebar`（只读+驱动） | 不复制 |
| 哪些会话窗口打开、当前明确目标 | 插件工作台 | `workbench/panels` | 保存可恢复引用 |
| 会话间位置/尺寸/分割关系 | Dockview | `workbench/host` | 引擎快照 |
| Sidebar 外部停靠方向、横纵比例 | 插件逐会话呈现状态 | `session-surface/layout` | 单独保存 |
| pointer 坐标、拖动候选、预览、取消 | 当前手势 | `session-surface`（临时） | 不保存 |
| 窄窗临时单视图 | 呈现投影 | `workbench` | 不覆盖桌面几何 |
| 最大化 | 临时呈现状态 | `workbench` | 默认不恢复 |

## 3. 每个模块必须守住的不变量（§06）

1. **唯一编辑根**（F12）：`session-surface` 保证一个 `sessionId` 在窗口内只有一个可编辑呈现；`dsh-adapter/conversation` 不做「第二份可编辑镜像」；`workbench` 在移动/换边时不重挂内容（移动 DOM 宿主，不重建组件）。
2. **目标不漂移**（F12/F15）：一切异步动作携带 `{panelId, bindingEpoch, sessionId, direction}`；`commands`/`attachments` 在提交前用捕获值复核（对齐原生 `commandTarget()`/`isTargetCurrent()` 的形态）。
3. **移动 ≠ 销毁**（F13）：`workbench` 只调公开移动/尺寸 API；`session-surface` 换边只改 Grid 区域；**不得**用 remove+add 伪造移动。
4. **隐藏 ≠ 结束**（F13）：收 Sidebar、隐藏会话视图、放大、窗口隐藏都不触发原生关闭/结束路径；只有显式关闭走原生清理（终端例外按原生意义）。
5. **事务化切换**（§06.2）：`{捕获来源 → 准备引用 → 校验未被占用 → 复核仍有效 → 释放旧绑定 → 提交新绑定 → 更新明确焦点}`；异步期间的关闭/换绑使旧动作过期。
6. **图层与手势隔离**（§06.3）：内容区不引入中间堆叠上下文；拖动用捕获事件的临时屏障，结束/取消均释放；系统拖窗区与内容拖动区分离。
7. **快照纪律**（§07.1）：不复制原生状态；不写进原生 key；`dsh.sidebar-right.v1.<sessionId>` 等原生存档只读不动。

## 4. 与工程任务的映射

| 任务 | 落点 |
| --- | --- |
| W008 干净源码工程 | `src/` + `build.mjs` + lint/类型/测试脚本；`lib/` 仅产物 |
| W009 单一主内容宿主 | `workbench/host` + `dsh-adapter/slots`（自建 `main` key；补丁期由 P-1 解除右栏耦合） |
| W010 唯一会话呈现 | `dsh-adapter/conversation`（embedded factory）+ `session-surface` |
| W011–W013 菜单/生命周期/放大关闭 | `workbench/panels` + `dsh-adapter/slots`（行菜单席位）+ `persistence` |
| W014/W017/W018 Sidebar | `dsh-adapter/sidebar` + `session-surface/layout`（四边停靠、比例、换边不换 DOM 父节点） |
| W015/W016 整会话移动与透明 resize | `workbench/panels` + `session-surface/layout`（命中区与光标，不画分割线） |
| W019/W020 v5 视觉与轻灰聚焦 | `theme/` + `session-surface/focus`（独立伪元素、pointer-events:none、禁根 opacity/filter/inert） |
| W021–W022 手势与窄屏 | `session-surface`（屏障/取消）+ `workbench`（窄屏投影不覆盖桌面几何） |
| W023–W029 兼容与恢复 | `dsh-adapter/*` 全量 + `persistence/*` |
| W030–W036 发布验证 | `docs/evidence/<commit>/<case>/` 与 N01–N21/V01–V03 逐项证据 |

## 5. 测试策略（承接 §09「旧测试中保护用户行为的可以转写」）

- **退役**：验证 overlay 覆盖、generation 抢编辑器、双 bump、空面板交接的旧断言（其机制已被本设计淘汰）。
- **转写**：滚动/草稿/焦点不丢、菜单不导航、唯一会话不重复、存档去重与畸形数据回退。
- **新增**：`workbench` 状态机（移动/关闭/放大/窄屏投影）、`session-surface` 区域分配（换边不改父节点）、`persistence` schema 与迁移、`adapter-checks` 的契约断言（宿主替身）。
- **证据**：原生相关结论一律附真实环境证据（引擎/视口/缩放/步骤/预期/实际），不以截图证明原生兼容。
