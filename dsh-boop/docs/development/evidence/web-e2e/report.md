# Web 真机 UI 回归（浏览器自动化环境）

> 目的：用**真实浏览器**（不是 jsdom）验证 BOOP 在 DSH Web UI 里的渲染与接入，产出 G05/G09 所需的截图与可复跑证据。
> 结论：环境已就绪，**19/19 步骤 PASS**；本工具能自动启动隔离 Host、驱动已安装 Edge、截图并断言真实 DOM。G05/G09 仍为 NOT_RUN——交互式审批/停止/恢复点击流程、IME、Desktop 端尚未纳入。

## 0. 环境与隔离

| 项 | 值 |
|---|---|
| 浏览器 | 已安装 Microsoft Edge **155.0.4283.62**（Playwright `channel: 'msedge'`，headless；**不下载 Chromium**） |
| 驱动 | `playwright-core@1.64.1`（devDependency，约 10MB 级；无浏览器二进制） |
| 宿主 | DSH **0.2.1-rc.2**，测试 payload `.work/test-host/payload-0.2.1/dsh` |
| Host 数据 | 私有 `$DSH_HOME`：`.work/test-runs/web-e2e-*/dsh-home`（**绝不触碰用户 `~/.dsh`**） |
| profile | 私有 web profile（从 `web` 模板初始化）+ `link:` BOOP + hand-declared `qwen-local` 本地模型路由 + `credentialOnboarding:false` |
| 证据 | `docs/development/evidence/web-e2e/2026-10-18T10-24-21-256Z/`（JSON + screens） |

首次运行踩到并已固化进脚本的 shell 事实：新 profile 需要先选工作区；首次启动有"预览版说明/开始使用"对话框（带 mask，会拦截所有点击）；声明本地模型路由并关闭云账号 onboarding 后页面可用。

## 1. 复现命令

```powershell
# 需要本机已安装 Edge；qwen 路由仅用于让 shell 有默认模型（不参与 UI 断言）
$env:BOOP_QWEN_KEY='placeholder'
node tools/web-e2e.mjs
```

工具只写 `.work/` 与 `docs/development/evidence/web-e2e/`；`--keep` 可保留浏览器窗口便于人工检查。

## 2. 实测步骤（19/19 PASS）

| # | 断言 | 结果 |
|---|---|---|
| 1 | 私有 web profile + BOOP bundle + 本地模型路由准备完成 | PASS |
| 2 | 真实 web Host 启动（127.0.0.1 私有端口） | PASS |
| 3 | 首次运行对话框被关闭（无点击拦截 mask） | PASS |
| 4 | 选择默认工作区，会话可用 | PASS |
| 5 | 真实 Edge 渲染 DSH shell（title/非空） | PASS |
| 6 | `BOOP 任务板` 入口在真实侧边栏注册 | PASS |
| 7 | 打开面板 → **真实 Host 事实**：恢复门禁已装备 / 写模式关闭 / 账本在位（单写者）/ 主会话 `boop-main` 已绑定 / 来源计数 / 数据域 | PASS |
| 8 | 任务看板四组（待开始/进行中/待我处理/已结束）真实渲染 | PASS |
| 9 | 人工控制区（待决审批、Stop、重启恢复核查）真实渲染，审批 0、服务端确认文案如实 | PASS |
| 10 | 面板下方只读设置/数据域/验证门账本/宿主能力矩阵真实渲染（G01–G09 与真实账本一致：G05 NOT_RUN、G06 PASS、G07 BLOCKED…） | PASS |
| 11 | 真实深色主题：`emulateMedia(dark)` → body `data-ds-dark-theme`、背景 `rgb(21,21,23)`，BOOP 面板跟随；浅色恢复 | PASS |
| 12 | 390×844 移动视口截图 | PASS |
| 13 | 回到 BOOP 主聊天 → 初始化卡真实渲染（三种模式文案） | PASS |
| 14 | 选择"从现在开始" → 真实只读结果：写模式关闭、`G05 NOT_RUN · G06 PASS`、已发现会话 2、`已执行：否（0 写入）`、`reason: write-mode-disabled`，无成功伪装 | PASS |
| 15 | 深色主会话截图 | PASS |
| 16 | 新建普通会话：无 BOOP panel / init dock；仅 2 个 scoped style 标签（additive，不替换原生 UI） | PASS |
| 17 | 真实浏览器无 console/page error | PASS |
| 18 | 截图与 JSON 证据落盘 | PASS |
| 19 | 全流程结束、Host/浏览器干净退出 | PASS |

## 3. 截图证据（screens/）

| 文件 | 内容 |
|---|---|
| `01-shell-1280x800.png` | 真实 Edge：DSH shell + 侧边栏（BOOP 任务板入口、BOOP·波波 状态） |
| `02-board-1280x800.png` | BOOP 面板（3D 角色渲染、真实身份/账本/来源/任务板首屏） |
| `02b-board-full.png` / `02e-board-middle-1280x800.png` / `02d-board-scrolled-1280x800.png` | 面板中/下段：任务看板、人工控制（审批/停止/恢复）、设置（只读）、数据域（0.2.1-rc.2 + 固定提交 + schema v1）、验证门账本、宿主能力矩阵 |
| `02c-board-dark-full.png` | 深色主题下同一面板（跟随宿主主题） |
| `03-main-session-1280x800.png` | BOOP 主聊天：初始化 dock（三种记忆起点） |
| `04-init-card-result-1280x800.png` | 选择"从现在开始"后的真实只读结果（不伪造写入） |
| `05-main-session-workspace-1280x800.png` | 主会话选择工作区后的状态 |
| `06-main-session-390x844.png` | 390×844 移动视口 |
| `07-main-session-dark-1280x800.png` | 深色主会话 |
| `08-ordinary-session-1280x800.png` | 普通 Session：无 BOOP 面板/初始化卡，样式仅 scoped |

原始证据 JSON：`web-e2e-2026-10-18T10-24-21-256Z.json`（步骤、URL、浏览器版本、截图路径、面板/初始化文本样本）。

## 4. 观察到的真实事实（对产品的意义）

1. BOOP 面板在真实浏览器里**完整可用**：3D 角色、真实账本身份、来源覆盖、任务看板、审批/停止/恢复界面、只读设置与门账本全部渲染，数据来自真实 Host（不是 mock）。
2. 初始化卡在写模式关闭时**如实拒绝**，文案与门账本一致（G05 NOT_RUN · G06 PASS），没有假装执行。
3. 主题跟随真实：宿主切深色后 BOOP 面板颜色随之变化，无独立主题开关。
4. BOOP 没有污染普通 Session：面板/初始化 dock 都不出现，只有 scoped `<style>` 标签（符合 FE-09/FE-12 的 additive 约束）。
5. 3D 角色在真实 Edge/WebGL 下正常渲染（GLB 资产路由 + 播放器），这是 jsdom 无法证明的。

## 5. 未覆盖 / 下一步

- **交互式审批 / 停止 / 恢复点击流程**：当前隔离账本无 task/approval/action fixtures，界面显示的是真实"0 待决"状态。下一步在私有 DSH_HOME 里种入 fixtures（与宿主测试同法）后，用真实点击断言：审批只落账不派发、Stop 三桶结果、恢复显式释放与审计。
- **IME 中文输入**：用 CDP `Input.imeSetComposition` 模拟真实输入法组合，验证输入不丢字/不重复。
- **三视口 × 深浅主题矩阵**：目前 1280×800 + 390×844 + 深色；按 G05 清单补齐。
- **键盘焦点/无障碍**：Tab 顺序、aria、reduced-motion。
- **Desktop Electron（G08/G09）**：用 Playwright Electron 或人工真机回归（未做）。
- **IM 规则（G07/M2）**：渠道未配置，不在本工具范围。

> 因此本报告只把「Web UI 真机渲染与接入」标为 **PASS（工具级）**；G05（真实浏览器 UI/IME E2E + IM 规则）与 G09（Desktop GUI）**仍为 NOT_RUN**，门账本未改动。
