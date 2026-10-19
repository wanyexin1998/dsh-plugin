# dsh-split

DSH 插件：一份**工作台**里并排展示**多个原生会话**（每个 Panel 是一个完整会话，含原生消息流、原生 composer、原生 Sidebar），分屏唯一入口是左侧逐会话菜单的「向右分屏 / 向下分屏」。

冻结基线：`DSH-SPLIT-V5-FROZEN-20261015` · 宿主 `dsh-v0.2.0-rc.2` / `639ed015397290b3745d163aafe02ffee4aa3f84` · Dockview 8.5.1（W005 锁定）。

当前本机安装为独立重构版 `0.5.0-rebuild.2`，源码、验证和安装回退以 [rebuild-v5/README.md](rebuild-v5/README.md) 为准。2026-10-16 已修复重构版宿主依赖路径导致的启动失败，并通过 99 项测试和五种真实宿主启动场景。下面是根目录旧实现的历史说明，不作为当前安装依据。

## 架构（当前实现）

- **一份外层 Dockview**（F02）：每个 Panel 一个会话、每个 Group 一个会话；新 Group 创建即 `locked:'no-drop-target'` + `hideHeader:true`；`hideBorders:true` + `theme.gap:12`（F06/V01 无分割线、12px 透明间距）。
- **唯一可编辑根**（F12）：`place()/deserialize()` 数据层拒绝同一会话重复出现；每个会话只经 `conversation.content` 工厂渲染一次。
- **主内容宿主**：插件注册自己的 `main` 键位（`dsh-split-workbench`）并在分屏期间选中它；期间在 `<html>` 上设 `data-dsh-plugin-main-host`，进入和离开时通知侧栏同步持有。
- **每会话原生 Sidebar**（F03）：`[data-dsh-sidebar-host="<sessionId>"]` 宿主 + `dsh-sidebar-host-change` 事件；宿主补丁把该会话的原生 Sidebar portal 进宿主并按宿主宽度下发几何；标题栏开关控制显隐（F07，收起不卸载，F13）。
- **状态与持久化**：`src/layout.ts` 纯状态机（16+ 项单测）；`dsh.split.workbench.v1` 持久化面板表与焦点（schemaVersion 校验、防御性反序列化、pagehide 刷盘）。

详见 `docs/architecture.md`、`docs/alignment-review.md`（两轮多 agent 对抗审查结论）、`docs/host-change-decision.md`（原生补丁授权与 M-A1 交付记录）。

## 宿主补丁（M-A1，已授权）

`patches/patched/**` 由 `node tools/apply-patches.mjs` 从原件（SHA-256 锁定）逐条重建，共 24 处锚定编辑。`--output dist/host-patches-fix` 先生成候选，`--check --output dist/host-patches-fix` 在内存重建并逐字节比对，验证期间不改 profile 链接目标。原生安装包未改动；本轮回退应同时恢复插件和宿主补丁，使用 [本机安装记录](docs/local-install-20261016.md) 中的专用备份。

## 工程

```text
src/            TypeScript 源码（layout / client / workbench / styles / index）
dist/           构建产物（esbuild）；lib/ 是唯一被加载的产物
tools/          产物守卫、补丁生成器、安装器（默认干跑，--yes 才写，永不重启）
patches/        originals（哈希清单）+ patched（M-A1 补丁副本）+ PATCHES.md
tests/          布局、真实 rc.2 renderer、附件/侧栏集成及 Chrome 几何回归
probe/          P0 探针（验证用，独立包 dsh-split-probe）
```

命令：`node build.mjs`（构建）· `node node_modules/typescript/bin/tsc -p tsconfig.json --noEmit`（类型）· `node tools/check-client-bundle.mjs dist/client.js dsh-split`（产物守卫）· `node tools/apply-patches.mjs --check`（补丁比对）。

## 状态

本轮 7 项故障修复与本机安装完成。临时放大、四边停靠、整会话拖动、几何持久化等 v5 功能仍未完整实现或验收；当前事实以 `docs/bug-report-20261016.md` 和本轮测试证据为准，历史审查见 `docs/alignment-review.md`。

---

> 历史说明：本 README 早前描述的是已退役的 `shell.overlay` 覆盖层实现（generation 交接、`Ctrl+Alt+S` 等），与冻结 Dockview 路线冲突，已于 2026-10-16 多 agent 审查后废止；旧产物保存在 `lib.bak-install-*` / `lib.legacy/`。
