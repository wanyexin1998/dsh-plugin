# W006 · 交付形态决策与原生变更授权单（草案，**未获授权，未实施**）

**冻结基线**：`DSH-SPLIT-V5-FROZEN-20261015`　**宿主**：`dsh 0.2.0-rc.2`
**相关冻结规则**：F02、F03、F07、F08、F12、F15
**状态**：草案。**本文档不构成授权，也未改动任何原生文件。** 需用户逐项批准后方可实施（W006 验收条件）。

## 1. 可由正式扩展面完成的部分（无需任何原生改动）

| 能力 | 路径 | 证据 |
| --- | --- | --- |
| 分屏唯一入口：左侧会话行菜单「向右/向下分屏」 | `ctx.slots.inject('sidebar.workspaces.session.menu.item')` | `ui-workspace/README.zh.md:98,100,163` |
| 每格原生正文 + View + Composer + 附件/审批/菜单 | `sessions.retain` → `SessionProvider` → `renderFactorySlot('conversation.content', { variant: 'embedded' })`（不替换 `views`） | `ui-conversation/README.zh.md:63`、`renderer:1040-1050` |
| 让原生会话呈现**卸载**（不是盖住） | 注册自建 `main` keyed 槽 + `ctx.layout.selectPanel(key)` | `ui-layout/lib/client.js:117-119`、`renderer:1154-1156` |
| 外层布局（一份 Dockview，一 Group 一会话） | `dockview@8.5.1`（MIT，React 走 peer） | `E:/wyx_code/_v5-frozen/evidence/w005-dockview-offline.md` |
| 会话标题栏的 Sidebar 显隐入口 | 复用原生 `conversation.session.header.corner`（已被 ExpandButton 占用，**勿抢**） | `conversation:18276-18279`、`sidebar-right:9187-9192` |
| 展开/收起不结束资源、显式关闭才清理 | 原生语义已正确 | `sidebar-right:6435,6439-6442,6488`、`README.zh.md:108` |
| 按 Session 寻址的上传 | `ctx.fileUpload.upload(sessionId, …)` | `file-upload/README.zh.md:28,45,59` |
| 命令→会话的表达 | `commandUi.available(session)/run(session)` + `inputTriggers.sessionOf(scope)` + 捕获身份复核 | `conversation:18111-18125`、`ui-input-trigger:929-952`、`sidebar-right:6537-6563` |

## 2. 无法由正式扩展面完成的部分（W002 判定为「需改原生」）

| # | 缺口 | 现状证据 | 不修的后果 |
| --- | --- | --- | --- |
| G1 | 自建主内容宿主期间**右栏被关**（`visible = activePanelId === null`） | `sidebar-right:5873-5880` | F03 直接失败：网格一开，每会话 Sidebar 消失 |
| G2 | Sidebar 只有 **single/root 一个可见宿主**，前台由全局 current 决定 | `sidebar-right:9138-9149`、`:9029-9045`、`README.zh.md:61` | 无法「每个会话面板内一块 Sidebar 且同时可见」 |
| G3 | 无左/上/下停靠契约（只有 push/fullscreen，分栏只接受 `axis==="row"`） | `sidebar-right:4951,4976,6652-6673`；`layout:595-627` | F03 的四边停靠无处落地 |
| G4 | 标题栏右上两个控件无席位可摘 | `sidebar-right:5628-5661,5703-5709`、`README.zh.md:88` | V02/F07 视觉要求无法达成 |
| G5 | 文件拖放 intake 是 document 级、每挂载视图一份、不看落点/`defaultPrevented` | `ui-attachment:539-590,568-577,621-623` | 两格同时挂载时一次放下进两处（N12 失败） |
| G6 | 命令/快捷键无会话维度 | `shortcuts:588-612,660-709,784-788` | 「只命中所属会话」只能靠自律（见 §1 末行），真正的按会话快捷键不可得 |

## 3. 补丁范围（拟）与影响面

| 补丁 | 拟改位置 | 契约目的 | 影响范围 | 不得触碰 |
| --- | --- | --- | --- | --- |
| **P-1** | `ui-layout`（`panelInfo` 选中态 → 右栏 `visible` 判定、轨道报告）× Conversation 宿主组合；**加**：`ui-workspace` 的 `reveal`/`clearMain` 不得强制 `selectPanel(null)`（`ui-workspace/lib/client.js:969,993`），否则插件占用 `main` 键位时被用户导航踢出 | 唯一生效主内容宿主；自建宿主期间右栏仍可按会话显示；**导航不再改写呈现宿主归属** | 面板选中语义、右栏可见性、中列轨道 | Agent 执行、服务端协议、会话数据格式、`mainView` 保活（`ui-workspace:973,991` 已按导航持有，无需改） |
| **P-2** | `ui-sidebar-right`：① 可见性改为**逐宿主**（现行 `active = visible && view.selected`，`visible = panelInfo.activePanelId === null` 是全局门，`client.js:5873-5880`）；② 几何改为**逐宿主**（`width/viewportWidth/canShow` 来自帧右轨，`:5849-5866`）；③ 让**任意宿主**能承载某会话的 Sidebar（现行 `rightbar` 是 single/root，`:9138-9149`，只渲染一次）。另按 V02/F07 移除标题栏两个控件 | 每会话 Sidebar 独立可见 + 四边停靠 + F07/V02 视觉 | 面板可见性判定、几何来源、席位宿主 | **已经存在、不得重做**：每会话子树与 `SessionProvider`（`:5875-5879`）、逐会话 store（`dsh.sidebar-right.v1.<sessionId>`）、Tab 域/occurrence、`keepMounted` 保活、关闭 handler 语义（`:6435,6439-6442,6488`）、provider 与终端 controller |
| **P-3** | `ui-attachment`（命中判定 + 尊重 `defaultPrevented`，或 intake 提升为带 session 参数的服务） | 一次拖放只命中所属会话（N12） | 仅接收端 | 上传/审批/附件编码路径 |
| **A-1** | （无需改原生）插件侧命令作用域纪律：`commandUi` + `inputTriggers.sessionOf` + `isTargetCurrent` 式复核；Esc 观察者注册顺序让位 | F12、N13 | 插件内部 | — |

可行方案校验：`conversation.view` 等 single 席位不得抢占；不得用 DOM 注入/私有 import/monkey patch 替代契约（W002 步骤 4）。

## 4. 交付机制：三种可选形态

| 方案 | 做法 | 可回滚性 | 升级安全 | 结论 |
| --- | --- | --- | --- | --- |
| **M-A（推荐）profile 链接补丁副本 + 行补丁** | 把受影响的 shipped 客户端包做**最小差异副本**放在工作区，profile 里以 `link:` 覆盖同名依赖，并用 `cordis.patch.yml` 禁用/重指原 bundle 行 | 删链接 + 还原 patch 文件即恢复 | 好（asar 不动；升级后重放 patch） | 待验证解析优先级后采用 |
| M-B asar 手术 | 解包/改/重打包 `app.asar`（121,348,951 B） | 需整份备份 + 手工还原 | 差（任何更新覆盖），风险高 | 不建议 |
| M-C 纯插件降级 | 不补丁，接受 G1–G6：右栏在网格期间关闭、无每会话 Sidebar、拖放命中多格 | 无需回滚 | 好 | **超出冻结范围**，需 CR 改产品（方案 §5.3 明确：P0 若不成立则不进入视觉集成） |

机制事实（已核实，用于 M-A 的可行性判断）：
- 客户端行形状：`- id: ui-sidebar-right` + `name: '@deepseek-ai/dsh-client-ui-sidebar-right'`（`dsh-web-app/cordis.patch.yml:264-266`；`ui-layout` `:248-249`、`ui-conversation` `:308-309`、`ui-attachment` `:321-322`）。
- patch 语义：**按 id 覆盖行**，且「profile 自己的 `cordis.patch.yml` 最后应用」（`dsh-web-app/cordis.patch.yml:1-5`）；行支持 `disabled: true`（同文件 `:448,451` 用例）；行选项含 `id`/`name`/`config`/`group`/`disabled`/`inject`（`cordis-plugin-loader/README.md:25-34`）。
- 解析基座：条目按 `name` 导入，基座是**该条目上下文的 `baseUrl`**（`cordis-plugin-loader/lib/index.js:214-225`）→ profile 层声明的行从 profile 目录解析，因此 **profile 里 `link:` 的同名包可被该行取用** ✔。

据此 M-A 的最小形态（推荐 **M-A1**）：
1. profile 依赖里以 `link:` 指向**打了最小差异的四个客户端包副本**（仅 P-1/P-2/P-3 涉及的 `ui-layout`、`ui-sidebar-right`、`ui-conversation`、`ui-attachment`，其余不动）；
2. profile 的 `cordis.patch.yml` 里 `- id: <原行 id>` 置 `disabled: true`，再 `insert` 同名 specifier 的行，使其从 profile 解析到补丁副本；
3. 重启 DSH 生效；页面刷新后新客户端包接管（`dsh-client-modules/README.zh.md:132`：替换包代码及其消费者不属于普通启停同步）。

**仍需在实施前验证**：
- ① ✅ **已答（静态）**：包间耦合走的是 **Cordis 服务名**，不是私有模块 —— 四个目标包只被其它客户端包的 `dsh.client.inject` 列表（与 `dsh-web-app` 的花名册）引用：`ui-layout` 被 8 个包 inject、`ui-conversation` 8 个、`ui-sidebar-right` 5 个（Sidebar 各 Tab provider）、`ui-attachment` 仅 `dsh-web-app`。→ 补丁副本**必须保持同名服务与 API 形状**，不存在需要一并处理的私有 import。
- ② ✅ **已答（一手实现）**：patch 语义在 `dsh-app-boot/lib/index.js:61-110` 的 `applyEntryPatches`——
  `const { id, insert, name, ...overrides } = patch`（`:73`）：**`name` 只作校验守卫**（不一致则 warn 并跳过，`:100-103`），
  **不会**进入被写入的 `overrides`（`:104-107`）⇒ **不能用 patch 改行的 specifier**；
  `disabled: true` 走 `overrides` ⇒ 可以禁用原行；`insert` 新增的是字面新条目（`name` 由我们写），同批次后续 patch 能命中刚插入的行（`:53-55,88`）。
  客户端模块扫描要求 `entry.options.name === entryName` 并跳过 `disabled` 行（`dsh-client-modules/lib/index.js:836`）。
  ⇒ **M-A1 的正确写法**：`- id: <原行> disabled: true` + `- insert: [{ id: <新行>, name: '<同一 specifier>' }]`，
  同一 specifier 由 profile 的 `link:` 解析到补丁副本，客户端半边随之替换。
- ③ ✅ **已答（静态）**：客户端包不打包 React —— `dsh.client.platform = 'web'`，external 精确解析到外壳冻结的平台模块表（React/Cordis 等）；补丁副本必须沿用同一条外部化规则（`react` 保持 external），禁止第二份 React。

**构建/重载要求**：Node 侧行变更需**重启 DSH**；浏览器侧 `client.js` 变更可热替换，但「替换包代码及其所有现有消费者不属于普通启停同步」（`README.zh.md:132`）→ 补丁生效按“重启一次 + 刷新页面”处理，并写入安装说明。

## 5. 回退路径（任选其一即完整还原）

1. **M-A**：删除 profile 的 `link:` 依赖与 `node_modules` 链接 → 还原 `cordis.patch.yml` 到本包冻结版本 → 重启。原生 asar 从未被修改。
2. **profile 仅加插件（当前状态）**：删除 `dsh-split-probe` 的 junction 与 `package.json` 中的两处条目（备份：`~\.dsh\profiles\desktop\package.json.bak-probe-20261015-195813`）。
3. **旧插件**：`dsh-split` 保持原样可用（W001 记录），不因本方案被卸载或覆盖。

## 6. 明确不触及

Agent 推理与模型调用、服务端协议、终端执行语义、会话数据格式、原生资源存档（`dsh.sidebar-right.v1.<sessionId>` 等）、上传/审批路径、`conversation.view` 等 single 席位的占用关系。

## 7. 授权记录

**用户于 2026-10-15 21:07（UTC+08:00）明确批复：「探针：装；补丁：全批」。** 逐项对应如下：

- [x] **A. 交付形态**：同意「插件主体 + 锁定 rc.2 的最小前端契约补丁」，按 **M-A1** 交付（profile `link:` 补丁副本 + `- id: <原行> disabled: true` + 同 specifier 的 insert 行）。
- [x] **B. P-1**（唯一生效主内容宿主；面板选中态与右栏可见性解耦；`ui-workspace` 的 `reveal`/`clearMain` 不得强制 `selectPanel(null)`）
- [x] **C. P-2**（Sidebar 每会话可见宿主：逐宿主可见性 + 逐宿主几何 + 任意宿主承载；移除标题栏两控件）
- [x] **D. P-3**（拖放只命中所属会话：`ui-attachment` 命中判定 + 尊重 `defaultPrevented`）
- [x] **E. A-1 保持纯插件实现**（命令作用域自律，不改原生快捷键服务）
- [x] **F. 安装与重载方式**：接受「补丁生效需重启 DSH 一次由用户自己执行」；不把可停用/热卸载/零原生改动混为一谈
- [x] **G. 探针**：已装（2026-10-15 21:13，经 `tools/probe-install.mjs --install --yes`，含格式守卫与备份），P0 结束后由同一脚本卸载

### 补丁实施进度（2026-10-15）

| 补丁 | 状态 | 足迹 |
| --- | --- | --- |
| **P-1**（主内容宿主 × 右栏可见性 × 导航不夺宿主） | ✅ 暂存版已生成 | `ui-workspace` 2 行原地替换 + `ui-sidebar-right` 2 行原地替换；`ui-layout` **无需改动**（实测确认） |
| **P-3**（拖放只命中所属会话） | ✅ 暂存版已生成 | `ui-attachment` 插入 3 行 `if (event.defaultPrevented) return;` |
| **P-2**（每会话 Sidebar 可见宿主 + 四边停靠） | ✅ 暂存版已生成（**加法式**，非结构重写） | `ui-sidebar-right`：`SessionView` 接受 `hosted`（`:5849,5851`）、`RightbarRoot` 把每个会话的侧栏 **portal** 进 `[data-dsh-sidebar-host="<sessionId>"]` 宿主并响应 `dsh-sidebar-host-change`（`:5873-5881`，+12 行）。无宿主时行为与官方**逐字一致**。dockkit / Tab 域 / provider / keepMounted / 关闭语义**一律未动** |

**生成方式**：`node tools/apply-patches.mjs` —— 每次都从 `patches/originals/**` 重建 `patches/patched/**`：
先校验 28 个原件的 SHA-256、再逐条锚点替换（缺失即中止）、再用 esbuild 解析校验、最后写出
`patches/patched/MANIFEST.json` 与 `patches/PATCHES.md`（逐条差异 + 回退说明）。

**标记契约**：插件占用主内容宿主期间，在 `<html>` 上设 `data-dsh-plugin-main-host`；补丁只认这个标记，不认插件名。
P1 的 `workbench/host.ts` 负责设置/清除它。

**回退**：删除 `patches/patched/**` + 移除 profile 的 `link:` 依赖与 patch 行 + 重启；DSH 原文件从未被修改。

### 安装记录（2026-10-15 15:13，用户指令「装」）

执行：`node tools/workbench-install.mjs --install --yes --patches` + `node tools/probe-install.mjs --install --yes`。

| 项 | 结果 |
| --- | --- |
| 产物切换 | `dist/` → `lib/`（新 lib/client.js 749076 B，sha256 `A21D8C430ED5…`（多 agent 审查第二轮修复后构建））；旧产物备份 `lib.bak-install-20261015151349.` |
| 补丁链接 | profile `node_modules/@deepseek-ai/` 下链接 3 个补丁副本（sidebar-right / workspace / attachment） |
| 补丁行 | 插件 `cordis.patch.yml` 追加 disable ×3 + insert ×3（M-A1） |
| profile bundles | `…、dsh-split、dsh-split-probe`（插件与探针均已启用；`package.json.bak-install-20261015151349.` 为备份） |
| 回滚 | `node tools/workbench-install.mjs --uninstall --yes` + `node tools/probe-install.mjs --uninstall --yes`，然后重启 |
| 旧测试套件 | 归档为 `tests/legacy/old-implementation.test.mjs`（它测的是退役实现，行为转移见 `tests/layout.test.mjs`） |

**生效需用户自己重启一次。**

### 授权之后的执行顺序（本文件即工作令）

1. 用户在应用内跑探针（7 个动作）→ 报告存 `E:/dsh-plugin/dsh-split/docs/evidence/p0-probe-report.json` → `node tools/p0-report.mjs <报告>` 出 G0 证据结论。
2. 按 M-A1 制作三处补丁副本（P-1/P-2/P-3）与 profile patch，**在用户自己的重启时机生效**。
3. G0 通过后进入 P1（`docs/design/p1-skeleton.md`、`docs/design/p1-interfaces.md`）。

**边界不变**：不碰 Agent 推理、模型调用、服务端协议、终端执行语义、会话数据格式、原生资源存档。
