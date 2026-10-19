# W005 版本决策记录（Dockview 受限适配）

**冻结基线**：`DSH-SPLIT-V5-FROZEN-20261015`　**宿主**：`dsh 0.2.0-rc.2`
**状态**：离线验证完成（Node 侧真库 10/10）；**真机几何/DnD/iframe 待应用内探针（W005 剩余部分）**。
**相关冻结规则**：F02（一份外层 Dockview，一 Group 一会话）

## 1. 锁定版本

| 包 | 版本 | 许可 | 角色 | 是否进 lockfile |
| --- | --- | --- | --- | --- |
| `dockview` | `8.5.1` | MIT（含 `package/LICENCE.md`） | 外层布局（React 绑定层） | ✅ 已在 `pnpm-lock.yaml` |
| `dockview-core` | `8.5.1` | MIT | 引擎本体（探针/Node 夹具直接用） | ✅ 显式固定（避免依赖提升的不确定性） |
| `esbuild` | `0.28.2` | MIT | 构建（`lib/` 为产物） | ✅ |
| `typescript` | `7.0.2` | Apache-2.0 | 类型检查 | ✅ |
| `jsdom` | `30.1.2` | MIT | W005 的 Node 侧真库夹具（仅开发依赖） | ✅ |

选择理由：方案 §04.1 要求"一份 Dockview、一 Group 一会话、禁中心合并/浮动/popout、不显示 IDE 式标签栏"，
且 §09 要求只用明确许可的 MIT 包并保留许可声明（**不引入同仓库的 Enterprise 包**）。
`dockview` 的 React 走 peer（`^16.8 || ^17 || ^18 || ^19`），宿主单例即可满足；构建把 `react` 置为 external。

## 2. 受限配置（源码级结论）

| 需求 | 配置 | 证据 |
| --- | --- | --- |
| 一 Group 一会话 | 每个 panel 落入各自 group；不暴露 tab 合并 | 团队约定 + `locked` 强制 |
| 禁中心/标签合并落点 | 组级 `locked: 'no-drop-target'` | `dockviewGroupPanelModel.d.ts:119` |
| 不显示 IDE 式标签栏 | 组级 `hideHeader: true`（另有 `headerPosition` 四向） | `dockviewGroupPanelModel.d.ts:27-35` |
| 禁浮动 | `disableFloatingGroups: true` | `options.d.ts:311` |
| 禁 popout | 无布尔开关：不暴露右键菜单项、不配置 `popoutUrl` | `options.d.ts:31,62-65` |
| 移动不重建内容 | `panel.api.moveTo({ group })`（公开 API） | 见 §3 |

## 3. 验证结果

**Node 侧（jsdom + 真 `dockview-core@8.5.1`，`probe/tools/dockview-node-check.mjs`）**：10 项全过，退出码 0。
关键三项：受限选项集被接受；`addGroup({referenceGroup, direction, locked:'no-drop-target', hideHeader:true})` 生效且
`api.locked` 读回、`header.hidden === true`、元素带 `dv-locked-groupview`；**`moveTo` 后同一个组件 DOM 节点存活**
（证明不是 remove+add）。

**仍待应用内探针**（jsdom 无布局）：真实几何与落点、`maximizeGroup`/`exitMaximizedGroup`、指针 DnD 的预览与取消、
iframe 生命周期、标签条"视觉上确实不见"。

## 4. 使用约束（写进 P1）

- 只使用 §2 的受限配置；不使用 popout、浮动、标签合并、edge group。
- 普通操作绝不 `fromJSON` 重建页面：恢复仅用于初次加载、明确重置或错误恢复（方案 §04.1）。
- 移动一律走公开 API；组件 key 不由 Group、方向或焦点派生（方案 §06.1）。
- 产物保留 dockview 的 MIT 许可声明（构建脚本 `legalComments: 'inline'` 已保证）。
