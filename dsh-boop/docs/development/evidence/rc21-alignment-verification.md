# rc.2.1 对齐独立核验（QA / 安全审查视角）

> 角色：独立核验员（不采信 Lead 结论先做实验，再对照）。
> 日期：2026-10-18 02:03–02:15（+08）。宿主：DSH Desktop **0.2.1-rc.2**（asar `dshBuildCommit=332895e0…`）。
> 实验位置：`.work/qa-align-20261018-0203/**`（全新独立 DSH_HOME；用户真实 `~/.dsh` 只做 stat，未读内容、未写）。
> 仓库状态：核验基于 `HEAD = 1481418`（对齐提交 `2c99dc2` + 文档提交）；两个功能 teammate 正在改 `src/**`，本核验不依赖其工作树改动。
> 结论标记：**确认 / 有保留 / 不确认**。

---

## 0. 取证基础（先独立确认“跑在什么宿主上”）

### 0.1 安装包版本（不通过仓库文档）

直接按 asar 头部格式读 `E:/deepseek-harness/resources/app.asar` 根 `package.json`（只读）：

```powershell
node -e "const fs=require('fs');const ASAR='E:/deepseek-harness/resources/app.asar';const fd=fs.openSync(ASAR,'r');const head=Buffer.alloc(16);fs.readSync(fd,head,0,16,0);const n=head.readUInt32LE(12);const j=Buffer.alloc(n);fs.readSync(fd,j,0,n,16);const root=JSON.parse(j.toString());const base=8+head.readUInt32LE(4);const e=(p=>{let x=root;for(const s of p.split('/').filter(Boolean))x=x?.files?.[s];return x})('package.json');const b=Buffer.alloc(e.size);fs.readSync(fd,b,0,e.size,base+Number(e.offset));console.log(JSON.parse(b.toString()).version, JSON.parse(b.toString()).dshBuildCommit, JSON.parse(b.toString()).dshBuildDirty);fs.closeSync(fd)"
```

实际输出：`@deepseek-ai/dsh-desktop` = **0.2.1-rc.2**，`dshBuildCommit = 332895e0f7c9d4dbfb29729f5eb367fa263ff986`，`dshBuildDirty = false`。
→ 与 `STATUS.md` §0 一致（确认）。

### 0.2 测试 payload 的忠实性

- `payload.json`：`version=0.2.1-rc.2`、`asar=E:/deepseek-harness/resources/app.asar`、`cli=…/payload-0.2.1/dsh/node_modules/@deepseek-ai/dsh/lib/bin.js`。
- `dsh/desktop-runtime.json`（asar 内提取的运行时清单）：`release.version=0.2.1-rc.2`、`hostProtocolVersion=4`、`nodeVersion=24.21.0`、17,261 个文件、304 个 sharedPackages。
- 完整性抽样：按 `desktop-runtime.json` 中记录的 sha256 重算前 500 个文件 → **500/500 匹配，0 缺失 0 不符**。
- 旧对照 payload：`.work/test-host/payload/dsh`，`@deepseek-ai/dsh` = **0.2.0-rc.2**。

→ payload 提取可信（确认，抽样局限：未全量 17,261 个文件逐一重算）。

---

## 1. 实验 1 · 插件兼容门（对齐最关键机制，独立复现）

### 方法（不动仓库 `package.json`）

1. `git archive HEAD -- package.json build.mjs tsconfig.json cordis.patch.yml presets src assets | tar -x -C <临时目录>/pkg` 得到临时复制件；
2. 在临时复制件内 `node build.mjs` 生成 `lib/**`（esbuild-wasm，3s，输出正常；**共享仓库未 build**）；
3. 独立 `DSH_HOME = .work/qa-align-20261018-0203/home`，profile `boop-test`：bundles = `@deepseek-ai/dsh-base` + `@deepseek-ai/dsh-web-app` + `dsh-boop`，`dependencies.dsh-boop = link:<临时复制件>`（pnpm link，非仓库路径）；
4. 只改**临时复制件**的 `package.json`，用安装 payload 的 CLI 跑 `dsh --profile … --dump-config` 和真实 `dsh web` 启动。

命令（可重跑）：`node .work/qa-align-20261018-0203/exp1.mjs`（原始输出见同目录 `exp1.log.txt` / `exp1-result.json` / `dump-*.std{out,err}.txt`）。

### 实测结果

| 状态 | 清单 | `--dump-config` | BOOP 顶层行数 | stderr 跳过行 | 真实启动（boot） |
|---|---|---|---|---|---|
| B0 | 原清单（`engines.dsh=0.2.1-rc.2`） | exit **0** | `dsh-boop`1 / `boop-tools`2 / `boop-api`1 / `boop-assets`1 / `preset-boop`1 | 无 | 未启动 |
| **A** | `engines.dsh=9.9.9`（错误值） | exit **0**（stdout 无任何提示） | **全部 0** | 1 行：`dsh: skipping profile bundle "dsh-boop": Error: Plugin dsh-boop@0.1.0 is incompatible with dsh 0.2.1-rc.2: requirements {"engines.dsh":"9.9.9"}. …` | 34.3s 启动成功；`POST /api/boop/bootstrap` → **404**；受权 index 中 **无 dsh-boop** 客户端模块 |
| **C** | 对齐前清单（`git show 3717637:package.json`，peers 钉 `0.2.0-rc.2`、无 `engines.dsh`） | exit **0** | **全部 0** | 1 行，requirements 列出 4 个 peer：`@deepseek-ai/dsh`、`-client-ui-primitives`、`-tools`、`-typert-protocol` 均 `0.2.0-rc.2` | 未启动 |
| **B1** | 恢复原清单 | exit **0** | 恢复 1/2/1/1/1 | 无 | 34.6s 启动成功；bootstrap **200**；`scope.dshProfileVersion=0.2.1-rc.2`；`capabilities.schedule=true`；客户端模块图回含 `dsh-boop` |

> `boop-tools` 计数 2 是预期：顶层一行 + `preset-boop` 的 `plugins:` 内一行；`e00-01` 用例按“行首 `- id:`”只数顶层，一致。

### 结论：**确认**

- 错误/旧清单 → bundle 被**跳过**：`--dump-config` 不装配 BOOP 行、退出码仍 0（“静默”指不中断、stdout 无提示），stderr 恰有一行含 `incompatible` —— 与 `STATUS.md` A1 描述一致。
- 下游后果同样复现：BOOP 行零装配、`/api/boop/*` 404、客户端模块图无 `dsh-boop`。
- 正确清单恢复后装配与端点全部恢复。
- 独立实现佐证：新 payload `dsh-app-boot/lib/index.js` 的 `unmetRequirements()` 有 `engines.dsh` 单独决定分支、`loadProfileDirectory()` 把不兼容 bundle 收进 `skippedBundles`、`reportSkippedBundles()` 打单行 stderr；旧 payload 同文件**无** `engines.dsh` 字符串。
- 附带实测：本 profile 宿主启动 34–37s（A5 “rc.2.1 启动更慢 ~40s+” 量级一致）。

### 补充发现（A1 措辞不准确，见 §4.2）

rc.2.0 的 `dsh-app-boot` **已经有** peer 版兼容门：旧 `lib/index.js`（181,850 B）里 `evaluatePluginCompatibility` / `pluginCompatibilityWarning` / `skippedBundles` / `reportSkippedBundles` / `PROFILE_COMPATIBILITY_FILENAME` 均存在，仅**没有** `engines.dsh`。rc.2.1 新增的是“`engines.dsh` 单独决定（忽略 peers）”这一层，而非整个兼容门。

---

## 2. 实验 2 · web shell 冻结静态模块表（字符串取证）

### 方法

新 payload 的 `dsh-web-frontend/dist/assets/index-CN7NIWNw.js`（921,071 B，单行压缩，无 `PLATFORM_MODULES` 标识符）。独立做法：定位 shell 里 `staticModules:` 的消费点，向上找供应它的 `function <minified>(){return{…}}` 字面量，并用同一方法对旧 payload `index-5SrrfWpU.js`（633,245 B）做 diff。脚本：`node .work/qa-align-20261018-0203/exp2-static.mjs`（结果 `exp2-static-result.json`）。

消费点原文（offset 918,624 附近）：`const r=globalThis.__ModuleLoader__; … this.modules=r.create({boot:t.__DSH_BOOT__,staticModules:SZ(),…})`
→ 该表就是 `__ModuleLoader__.create` 的 **platform/static modules**，即任务所称 `PLATFORM_MODULES`（压缩后函数名 `SZ`）。

### 实测

新表（`SZ()`，11 项）：`react`、`react/jsx-runtime`、`react-dom`、`react-dom/client`、**`@deepseek-ai/cordis`**（注意不是裸 `cordis`）、`zod`、`@tanstack/react-virtual`、`@deepseek-ai/dsh-client-store`、`@deepseek-ai/dsh-client-ui-slots`、`@deepseek-ai/dsh-client-ui-primitives`、`@deepseek-ai/dsh-client-ui-dockkit`。

旧表（`rM()`，9 项）：同上但**无** `zod`、无 `@tanstack/react-virtual`；`@deepseek-ai/dsh-client-ui-dockkit` **已存在**。
diff：新增 = `zod`、`@tanstack/react-virtual`；删除 = 无。

`MenuItemButton`（原语导出）：
- 新 shell 全文件**只出现 1 次**（offset 865,065），位于 `const zU=Object.freeze(Object.defineProperty({__proto__:null,…` 起的命名空间（859,053–866,403）内，而表把 `zU` 映射到 `"@deepseek-ai/dsh-client-ui-primitives"`；
- 旧 shell 同样只出现 1 次（offset 577,364），在 `sE` 命名空间内，`sE → @deepseek-ai/dsh-client-ui-primitives`。

包集合侧核对：`node_modules/@deepseek-ai` 目录数 **旧 289 → 新 306**（与 STATUS A2 “289→306” 一致）；`dsh-client-store` / `-ui-slots` / `-ui-primitives` 在旧 payload 存在、新 payload **不存在**（“不再单独发货”确认）；`dsh-client-ui-dockkit` 在两版 payload 中都**不是**独立包。

### 结论：**确认（附两处更正）**

1. 任务要求的 9 个 id 全部在新表中（`cordis` 需按实际 id `@deepseek-ai/cordis` 理解；另有 `react/jsx-runtime`、`react-dom/client`）。`MenuItemButton` 仍由 primitives 模块命名空间导出 —— 确认。
2. **更正 A2**：“rc.2.1 新增 `dsh-client-ui-dockkit`”不成立：它在 rc.2.0.0 的 shell 静态表里同样存在；rc.2.1 真正新增的表项是 `zod` 与 `@tanstack/react-virtual`。
3. 局限：纯字符串/offset 取证，未在浏览器执行，未证运行时 `require()` 行为；`MenuItemButton` 的组件实现未做渲染验证（结论限于“命名空间内仍导出该符号”）。

---

## 3. 实验 3 · Live 交叉核验（当前 GUI = 0.2.1-rc.2）

### 3.1 host Service（成功）

`cordis_inspect_query(platform=host, provider=Service, method=listService)` 返回 live 目录。逐项 grep 确认 12/12 存在：
`agentLoop`、`approval`、`connection`、`llm`、`profileContext`、**`schedule`**、`sessionController`、`sessionProjections`、`sessionQuery`、`tools`、`typertGateway`、`workspaceRegistry`（另观察到 `clientModules`、`webServer`、`webApp` 等）。
→ host 服务面核对 **确认**；`schedule` 在 live web 组合中存在，独立佐证 A3。

### 3.2 client Slots / Service（未能复现，如实记录）

共尝试 4 次，全部失败：
1. `Slots.listSubTree` → `Client inspect query Slots.listSubTree timed out after 10000ms. Open or reconnect the Harness page, then retry.`
2. `Service.listService` → `Client inspect query Service.listService has no connected Harness page. …`
3. 重试 `Slots.listSubTree` → `has no connected Harness page. …`
4. 重试 `Service.listService` → `timed out after 10000ms. …`

结论：本会话无法独立复现 Lead 的“live Inspector 确认 client slot 面”；**保留**，不以静态结果冒充 live 结论。

### 3.3 静态替代取证（支持 A4 的结论，但不是 live）

新 payload 客户端包里可见：
- `dsh-client-ui-conversation/lib/client.js:20024-20031`：`slots.inject("main", function*(){ yield slots.register({ name:"main", key:"conversation", children:{ "main.conversation":{kind:"single",scope:"session-maybe"} } }, ConversationPanel) …})` → `main` 是 **keyed** 槽（带 `key`），与“已占用 conversations key”一致；
- `dsh-client-ui-workspace/lib/client.js:2344/2348`：`renderSlot("sidebar.workspaces.session.menu.item", …)` / `renderSlot("sidebar.workspaces.session.row.action", …)`；同文件 5227/5235 声明槽、5252+ `ctx.slots.inject(…)` 注册；
- `dsh-cordis-client-runner/lib/client.js:6517/6571`：slot 目录文档列出上述两个 key；
- `dsh-client-ui-layout/lib/client.js:407/468/622`：`selectPanel(panelId)`、`hasMainPanel`、`ctx.reflect.provide("layout", layout)`；
- `uiWorkspace` 在 12 个客户端包的 `inject` 中被引用（静态字符串）。

BOOP 侧（HEAD `2c99dc2` 提交态）：client entry 注册 keyed `main`（`key: MAIN_KEY='boop.tasks'`）与 `sidebar.workspaces.session.menu.item`（id `boop.open-board`，渲染 `MenuItemButton`）；工作树里 E04-01b teammate 已改成 `sidebar.footer.action` 等新槽（未提交，不在本次对齐口径内）。

---

## 4. 实验 4 · 回归口径抽查（STATUS §0.1 与 tests 断言）

### 4.1 测试声明数（静态核对，未重跑全量）

| 套件 | 文件 | 声明 `test(` 数 | STATUS 声称 |
|---|---|---|---|
| host 集成 | e00-01 / e00-02 / e01-01 / e03-01 / e04-01-assets | 11 + 8 + 5 + 5 + 8 = **37** | 37/37 ✓ |
| unit + client | 8 个 unit 文件 11+17+11+9+9+9+7+7=80；2 个 client 文件 7+6=13 | **93** | 93/93 ✓ |

（声明数一致；**实际执行结果由 Lead 最终回归负责，本次未跑全量 host 套件**。）

### 4.2 STATUS §0.1 A1–A5 与实现/证据对照

| 断言 | 独立核验 |
|---|---|
| A1 兼容门 → 旧清单被静默跳过、404、客户端模块图无 BOOP；BOOP 以 `engines.dsh` + 升 peers 对齐 | 机制与后果**确认**（实验 1）；但“rc.2.1 新增插件兼容门”措辞**不准确**（peer 门 rc.2.0 已有） |
| A2 包集合 289→306；store/slots/primitives 不再单独发货；shell 静态表仍提供 id 且 `MenuItemButton` 仍导出 | 289→306 ✓；不再发货 ✓；表/id/导出 ✓；但“rc.2.1 新增 dockkit”**不确认**（旧表已有） |
| A3 web profile 新增 `schedule` 等行；`capabilities.schedule=true`；列出新包 | `schedule` 行新增 ✓（新 `dsh-web-app/cordis.patch.yml` 116 个 `- id:` 行 vs 旧 112 个，新增 `schedule`/`harness-dev-context`/`ui-secret-mask`/`ui-schedule`/`ui-deepseek-model-label-1017`，移除 `tool-ralph`）；`capabilities.schedule=true` ✓（实验 1 B1 + live host）；但清单中 **`session-title-llm` 旧 payload 已存在**（其余 remote-access/tool-schedule/tool-session-query/tool-terminal/working-directory 确为新） |
| A4 client slot 面兼容（live Inspector + shell 字符串双重取证） | shell/客户端包静态证据 ✓；**live client Inspector 本次无法复现**（页面未连接），该半句保留 |
| A5 先真正停 Host 再重启，scopeId 稳定 + fencingToken 严格 +1；心跳缺口记入风险 | 测试实现与断言**属实**（`tests/host/e01-01-storage-in-host.test.mjs:65-87`）；风险确实写入 `STATUS.md:262`；但“第二 Host 只读”的**host 级断言不充分**（见 4.3） |

### 4.3 断言不充分 / 与实现不符（重点）

**F1（最重要）`E01-02 a second live Host … reports no write management` 断言空转。**
`tests/host/e01-01-storage-in-host.test.mjs:89-102` 只断言 `typeof storage.lease.held === 'boolean'`（恒真）与 `writeModeEnabled === false`（冻结常量，任何实现都是 false），并未验证标题所称“第二个 Host 不持有写管理”；`STATUS.md` 同节“已验证 3：第二个 Host 拿不到租约即转只读”在宿主级**无有效证据**（仅 unit 级 `LeaseManager` 用例覆盖 live-lease 场景）。

用真实宿主复现（`node .work/qa-align-20261018-0203/exp4-lease.mjs`，独立 DSH_HOME，临时复制件）：

| 次序 | 场景 | boot | `lease.held` | `fencingToken` | `scopeId` |
|---|---|---|---|---|---|
| host-1 | 单独启动 | 33.5s | **true** | 2 | `boop-afed6ca45c7f7022` |
| host-2 | **host-1 仍存活**时启动第二台 | 36.0s | **true**（holder 变为 `dsh@516`） | **3**（+1） | 同前 |
| host-3 | 两台都停后顺序重启 | 36.8s | true | 4 | 同前 |

即：启动耗时（34–37s）> 租约 TTL（15s），**第二个并发 Host 在启动窗口内直接接管了仍存活的第一台的写管理**——这正好实证了 `STATUS.md:262` 记录的“租约无心跳”风险，同时说明测试标题/STATUS 的“no write management / 只读”描述与真实行为**不符**（断言因恒真而掩盖）。风险严重性：当前写模式由独立冻结开关拦住，尚未造成越权写，但 G08 多 Host 语义不可宣称“第二个只读”。

**F2 E00-01 的“浏览器半已发布”断言偏弱。** `tests/host/e00-01-plugin-load.test.mjs:133-140` 只 `assert.match(html, /boop|__DSH_BOOT__/i)`，而 `__DSH_BOOT__` 必定出现在受权 index → 断言不区分 BOOP 是否存在；真正的 BOOP 模块断言在下一用例（`AT-38`，142-147 行，`/dsh-boop/`）里，结论仍成立，但该条 PASS 证据力弱。

**F3 版本断言只到 payload，未锚定安装的 Desktop。** `hostFacts().dshVersion` 读 `.work/test-host/payload-0.2.1/.../package.json`；测试没有任何 payload↔asar/`dshBuildCommit` 的自动比对（`pinnedCommit` 在 helper 里是硬编码常量且无断言）。当前 payload 经 §0 验证可信，但**残留风险**：下次宿主升级若未重建 payload，测试可能在旧 payload 上“全绿”。

**F4 措辞类**：`e00-02` 的 “after a Host restart” 用例（161-181 行）实际是在**第一台仍存活**时再起第二台（并非重启）；其“不自动接管上一进程命令”的断言仍有意义，但“重启实测”表述不精确。E01-02 的 `fencingToken +1` 断言本身有效（clean release→reacquire），但 STATUS 用“接管（takeover）”描述，与 unit 用例里的“过期租约接管”不是同一语义。

**F5（文档完整性）STATUS 引用的证据文档不存在。**
- `docs/development/STATUS.md:24`：“完整差异报告见 `docs/development/RC21_ALIGNMENT.md`” → `HEAD`、工作树、`git log --all -- docs/development` 中均**无此文件**；
- `docs/development/STATUS.md:52` 与 `src/host/transport/command-envelope.ts:5` 引用 `docs/development/evidence/e00-01/`、`…/e00-02/` → 仓库中**无 `docs/development/evidence/` 目录**（`git check-ignore` 未忽略）；
- 提交 `1481418`（“record … alignment findings and evidence”）实际只改 `docs/development/STATUS.md` 与 `.workbuddy/memory/2026-10-18.md`，**未新增** `RC21_ALIGNMENT.md` 或任何 `docs/development/evidence/**` 文件（`git show --stat 1481418` 可证）。→ “证据必须能复现”的台账规则未被文档引用兑现，需在收尾前补齐或改掉引用。

### 4.4 其他核对（确认）

- `tests/helpers/test-host.mjs` 默认 payload 已切到 `.work/test-host/payload-0.2.1/dsh`（第 21 行）✓；
- 测试通过 `spawn(NODE_BIN, [CLI_ENTRY…], { env: {…, DSH_HOME: home} })` 注入私有 home（helper 87-105/111-121 行）✓；
- `capabilities` 确实来自 live registry 探针（`src/host/index.ts:131` → `probeHostSurface` 的 `ctx.reflect`），非硬编码 ✓。

---

## 5. 实验 5 · 隔离性（用户 `~/.dsh` 未被测试读写）

- 代码路径：所有 host 用例的 `WORK = path.join(PROJECT_ROOT, '.work/test-runs/<case>-<ts>')`，`home = WORK/dsh-home`，仅把该目录作为 `DSH_HOME` 传给子进程；BOOP 账本落在 `$DSH_HOME/boop/boop.sqlite`（`src/host/persistence/storage.ts` 由 `ctx.dshHomePath()` 解析）。本次核验全部使用 `.work/qa-align-20261018-0203/home`。
- 用户 `~/.dsh` 只 stat、未读内容，前后对比（实验窗口 02:03–02:14）：

| 路径 | 实验前 | 实验后 |
|---|---|---|
| `~/.dsh`（顶层 mtime） | 2026-10-18T01:50:26 | **2026-10-18T01:50:26（不变）** |
| `~/.dsh/profiles` | 2026-10-17T17:05:20 | 不变 |
| `~/.dsh/sessions` | 2026-10-18T01:16:13 | 不变 |
| `~/.dsh/storages` | 2026-10-18T01:17:33 | 不变 |
| `~/.dsh/boop`（BOOP 账本） | 不存在 | **仍不存在** |

- 我的写入仅：`.work/qa-align-20261018-0203/**` + 本证据文件；未 git commit；未改 `src/tests/package.json/STATUS`。仓库 `package.json` 无 diff（临时复制件实验后已恢复原清单）。
- 收尾时无遗留 qa-align 子进程（`Get-CimInstance Win32_Process` 过滤 `qa-align` 为空）。
- **措辞更正（有保留）**：`tests/helpers/test-host.mjs` 的 `NODE_BIN`/`pnpm.cjs` 绝对路径指向 `C:/Users/wanyexin/.dsh/dsh-runtimes/...`，测试会**执行**用户 `~/.dsh` 下的宿主 Node/pnpm 二进制（只读执行，未碰 DSH_HOME 数据）。因此“用户真实 `~/.dsh` 未被读取或修改”严格说不成立，准确表述应为“未读写 `~/.dsh` 的 DSH_HOME 数据（profiles/sessions/storages/boop 等）；仅执行其中的已安装运行时二进制”。另：`~/.dsh/.../runtime.json` 的陈旧值由 Lead 声明，本次按约束未读取，无法独立复核。

---

## 6. 结论汇总

**确认（独立复现）**

1. 安装包 = DSH Desktop 0.2.1-rc.2 / commit 332895e0… / dirty=false；测试 payload 提取忠实（抽样 500/500 hash 匹配）。
2. 兼容门行为：`engines.dsh` 错误或旧 peers 清单 → bundle 被跳过（行零装配、dump exit 0、stderr 单行 incompatible、boot 34s、`/api/boop/*` 404、客户端模块图无 BOOP）；改回 `0.2.1-rc.2` 全部恢复（bootstrap 200、capabilities.schedule=true）。
3. 包集合 289→306；store/slots/primitives 不再单独发货；web shell 静态模块表（11 项）仍提供这些 id；`MenuItemButton` 在 primitives 命名空间内仍导出。
4. web profile 新增 `schedule` 行；`capabilities.schedule=true`（live host + boot 双重）。
5. 测试声明计数 37 / 93 与台账一致；测试隔离路径仅 `.work/**`，用户 DSH_HOME 数据与 `~/.dsh/boop` 前后不变。
6. E01-02 启动慢 + 15s TTL 的时序问题真实存在（实测 boot 34–37s）。

**有保留**

1. client live Inspector（Slots/Service）本会话 4 次查询均失败（页面未连接），A4 的 live 半句无法独立复现；静态证据支持结论。
2. “第二 Host 只读”在 host 级断言空转且与真实行为不符（§4.3 租约实测：并发第二 Host 接管，fencingToken +1）；心跳缺口风险已被实证，E07-01 前应补心跳或明确单实例策略。
3. “静默跳过”应精确为：进程不失败、stdout 无提示、stderr 恰一行（测试若只读 stdout 会漏）。

**不确认（与事实不符，需改文档/断言）**

1. A2 “rc.2.1 新增 `dsh-client-ui-dockkit`”：旧 shell 静态表已有该 id，且两版均无该独立包；真正的表新增项是 `zod`、`@tanstack/react-virtual`。
2. A3 清单里的 `session-title-llm` 在 0.2.0-rc.2 payload 中已存在（不是新包）。
3. A1 “`dsh-app-boot` 新增插件兼容门”：rc.2.0 已有 peer 版兼容门；rc.2.1 新增的是 `engines.dsh` 单独决定语义。
4. STATUS 引用的 `docs/development/RC21_ALIGNMENT.md` 与 `docs/development/evidence/e00-01|e00-02/` 在仓库/历史中不存在。

---

## 7. 与 Lead 结论的差异

| Lead 口径 | 独立核验 | 差异性质 |
|---|---|---|
| rc.2.1 “新增插件兼容门” | peer 门 rc.2.0 已存在；新增 `engines.dsh` 判定 | 措辞不精确（影响结论不变） |
| shell 表“含 rc.2.1 新增 dockkit” | dockkit 旧表已有；新增项为 zod / @tanstack/react-virtual | **与事实不符** |
| A3 “session-title-llm 等新包” | session-title-llm 旧 payload 已有 | **与事实不符**（其余新包名确认） |
| A4 “live Inspector + shell 字符串双重取证” | host live ✓；client live 本次不可复现（无连接页面）；shell 字符串 ✓ | 证据强度保留 |
| “第二个 Host 只读” / E01-02 断言 | host 级断言恒真；实测并发第二 Host 在 TTL 到期后接管 | **断言不充分/标题误导**（风险已在文档记录） |
| “用户真实 ~/.dsh 未被读取或修改” | DSH_HOME 数据未动 ✓，但执行了 `~/.dsh/dsh-runtimes` 下的 Node/pnpm 二进制 | 措辞需收紧 |
| “证据见 RC21_ALIGNMENT.md / evidence 目录” | 文件不存在 | **文档缺失** |

与 `STATUS.md` 其余对齐结论（A1 影响、A3 schedule、BOOP 以 `engines.dsh` 对齐而非豁免、测试计数）无实质冲突。

---

## 8. 遗留风险

1. **租约心跳缺失（高）**：实测并发第二 Host 34–37s 启动窗口 > 15s TTL，直接接管仍存活 Host 的写管理（fencingToken +1）。当前写模式冻结开关兜底，但 G08/E07-01 前必须补心跳或明确“仅单 Host”策略，并修正 E01-02 第二条断言与 STATUS 描述。
2. **STATUS 证据文档缺失**：`RC21_ALIGNMENT.md`、`docs/development/evidence/**` 未落地，违反台账“证据必须能复现”规则；收尾前补齐或删除引用。
3. **client live Inspector 不可用（本会话）**：A4 结论仅静态支撑；若 Lead 的 live 证据来自更早的页面连接，需在最终报告注明时间/环境或重连后补录。
4. **payload 未与安装包自动锚定**：测试只读 payload 内版本；升级后若忘记重建 payload，可能出现“旧 payload 全绿”。建议在 E00-01 增加 asar/payload sha256 或 `dshBuildCommit` 交叉断言。
5. **“静默”语义**：测试若只过滤 stdout，会漏掉 stderr 的跳过行；建议兼容门回归里显式断言 stderr。
6. `~/.dsh` 措辞（执行运行时二进制）与 `runtime.json` 陈旧值需在文档中如实区分“数据”与“二进制”。
7. 功能 teammate 正在改 `src/client`、`src/host` 与共享 `lib/`（核验期间 02:11 有仓库内 build），本证据只对 HEAD 对齐口径负责；最终回归需在干净工作树复核。

---

## 9. 可复现的一键核验命令（本机）

```powershell
cd E:\dsh-plugin\dsh-boop

# 0) 安装包版本（独立于仓库文档；只读 asar）
#    见 §0.1 内联 node -e 命令；期望 0.2.1-rc.2 / 332895e0… / false

# 1) 兼容门：临时复制件 + 独立 DSH_HOME，两步 dump + 两次真实启动（约 2.5 min）
node .work/qa-align-20261018-0203/exp1.mjs
#    证据：exp1.log.txt / exp1-result.json / dump-*.std{out,err}.txt
#    期望：坏 engines → 行 0 + stderr incompatible + boot 404/无客户端模块；恢复 → 行 1 + boot 200
#    旧清单对照：manifest-old.json（git show 3717637:package.json）→ 同样被跳过

# 2) shell 静态模块表 + MenuItemButton 字符串取证（秒级）
node .work/qa-align-20261018-0203/exp2-static.mjs
#    证据：exp2-static.log.txt / exp2-static-result.json
#    期望：新 11 项（含 zod、@tanstack/react-virtual、ui-dockkit）、旧 9 项、MenuItemButton 在 primitives 命名空间内

# 3) 租约/重启实证（约 2 min，三次真实启动）
node .work/qa-align-20261018-0203/exp4-lease.mjs
#    证据：exp4.log.txt / exp4-lease-result.json
#    期望：host-2 在 host-1 存活时 held=true 且 token=host-1+1（心跳缺口）；host-3 清洁重启 token 再 +1

# 4) live host 服务面（本会话工具）
#    cordis_inspect_query(platform=host, provider=Service, method=listService)
#    期望目录含：agentLoop/approval/connection/llm/profileContext/schedule/sessionController/
#                 sessionProjections/sessionQuery/tools/typertGateway/workspaceRegistry

# 5) live client 槽面（需要 GUI 页面已连接 inspector 客户端；本次环境失败）
#    cordis_inspect_query(platform=client, provider=Slots, method=listSubTree)
#    cordis_inspect_query(platform=client, provider=Service, method=listService)
```

> 说明：`.work/**` 被 `.gitignore` 忽略，实验脚本与原始日志只在本机可复现；证据摘要已固化在本文件。所有宿主子进程均注入 `DSH_HOME=.work/qa-align-20261018-0203/home`，不接触用户 `~/.dsh` 数据。

---

## 附：本次核验的原始证据文件（本机）

```
.work/qa-align-20261018-0203/
  exp1.mjs  exp1.log.txt  exp1-result.json  dump-*.stdout.txt  dump-*.stderr.txt
  manifest-old.json                      # git show 3717637:package.json
  exp2-static.mjs  exp2-static.log.txt  exp2-static-result.json
  exp4-lease.mjs  exp4.log.txt  exp4-lease-result.json
  pkg/**                                 # HEAD 快照临时复制件（build 后 lib/**，已恢复原 package.json）
  home/**                                # 独立 DSH_HOME（profiles/boop-test + BOOP 账本）
```
