# 06-PLUGIN-ENGINEERING — 插件工程规范

> 状态：草案（待 G1 架构冻结）｜上游：00（命名/基线）、02（包结构）
> 本规范是 M0 开工的工程检查清单；所有锚点已在 dsh 仓库（分支 codex/presentation-v2）核验。

---

## 1. 仓库与分支策略

| 决策 | 取值 | 理由 |
|---|---|---|
| 开发位置 | **外部独立仓库**：`E:/dsh-plugin/dsh-data-ide`（独立 git 仓；pnpm workspace，包路径镜像 monorepo 约定 `packages/client/ui-sql-workbench/`） | **2026-10-17 变更**：原方案为 monorepo 内开发。改为外部仓库的理由——① 不切换用户 monorepo 当前分支（避免影响 `E:/wyx_code/dsh-desktop` 对 presentation-v2 工作树的绑定）；② 插件分发终态本就是外部包，从一开始就按外部包验证更真实；③ 验证走本地 bundle（tgz）+ `dsh plugin add <path>` 装到独立 dev profile（`--profile dev-sql`，不污染生产 profile）。仅当 S1 spike 证明「外部注册确实需要 monorepo 侧 compat」时，才用 `git worktree add` 开独立工作树做最小适配并回记本文（见 §12） |
| 基线分支 | `codex/presentation-v2`（本地 checkout 当前在 master，需 `git switch`） | `session.pane.right` 仅存在于该分支（与 master 差 107 files / +2920-251） |
| 与上游同步 | 每周 rebase 一次分支；推动该分支合入 master 以缩短暴露 | 分支未合并是 R1 风险（见 08） |
| 桌面端注意 | `E:/wyx_code/dsh-desktop` 绑定 presentation-v2 工作树的 built CLI，切换工作树前先换绑 | HANDOVER-PLAN.md 记录 |

## 2. 包结构

```
packages/client/ui-sql-workbench/
├── package.json            # 契约核心（见 §3）
├── tsconfig.json           # extends tsconfig.base.client.json
├── tsdown.config.ts        # clientBundle(...) 预设
├── src/
│   ├── index.ts            # node 半：空 apply（host 管生命周期）
│   ├── invariant.ts        # 伴随不变量
│   ├── locales.ts          # zh/en 字典 + declare module LocaleNamespaceMap
│   ├── css-modules.d.ts
│   └── client/
│       ├── index.ts        # 浏览器半：slots 注册（见 §5）
│       ├── contract/       # slots.ts（owner props 合同）、api.ts（宿主服务面）
│       ├── components/     # 面板外壳/连接条/编辑器/网格/git 面板
│       └── *.module.css    # CSS Modules（--dsw-alias-* token）
├── mcp/
│   └── server.ts           # MCP server 入口（Node，stdio）——同包子路径导出
└── tests/
    ├── *.client.spec.tsx   # client 渲染测试
    └── *.spec.ts           # node 半 + MCP 协议测试
```

**MCP server 归属决策**：与 UI 插件**同包**（`mcp/server.ts`，package.json `exports` 增加 `./mcp` 子路径）。理由：一次 `dsh plugin add` 即装全 UI + MCP 服务，避免双包版本漂移；bundle 发布时同 npm 包分发。

## 3. package.json 契约（逐字段）

以 `packages/client/ui-user-questions/package.json` 为最小样板，关键字段：

```jsonc
{
  "name": "@deepseek-ai/dsh-client-ui-sql-workbench",
  "exports": {
    ".":        { "types": "./lib/types/index.d.ts", "default": "./lib/index.js" },
    "./invariant": { ... },
    "./client": { "types": "./lib/types/client/index.d.ts", "default": "./lib/client.js" },
    "./mcp":    { "default": "./lib/mcp/server.js" },     // 新增：MCP server 入口
    "./src/*": "./src/*",
    "./package.json": "./package.json"
  },
  "dsh": { "client": { "inject": ["<依赖包名>"], "platform": "web" } },
  "peerDependencies": {
    "@deepseek-ai/cordis": "workspace:^",
    "@deepseek-ai/dsh-client-runtime": "workspace:^"
  },
  "files": ["lib/index.js", "lib/invariant.js", "lib/client.js", "lib/mcp/server.js", "lib/types/**/*.d.ts"]
}
```

规则：
- `peerDependencies` 每个 `@deepseek-ai/dsh[-*]` 必须 semver 满足运行时 dsh（origin/master 0.1.7-rc.1 起强制，不满足则 profile 启动拒绝插件，除非精确豁免）——peer 范围随 harness 发版管理；
- `dsh.client` 必须有 `./client` 导出（扫描抛错）；`inject` 是信息性边；`external` 是模块表边（同步 require，必须已被供给）；
- 第三方依赖最小化：前端零新依赖（全用 ui-primitives + clsx）；MCP server 侧 `@modelcontextprotocol/sdk` + `mysql2` 进 `dependencies`。

## 4. 纯度规则（构建期门禁）

- **禁跨包 `@deepseek-ai/*` value import**（purity gate，构建直接失败）；跨包协作只能走 cordis service + slot；`import type` 被擦除不受限；
- 禁模块级副作用；一切注册走 `ctx.effect()` / `ctx.slots.register()` / `ctx.on()`；
- 动态插件代码（cordis_define）是纯 JS：`React.createElement`，无 import/JSX/TS——**JSX 必须经构建，禁止直改 `lib/`**。

## 5. 注册实现（client 半骨架）

```ts
// src/client/index.ts（要点，完整实现以 ui-trajectory 为模板）
export const inject = ['slots', 'locale', 'sessions']
export function apply(ctx: ClientContext): void {
  ctx.effect(() => ctx.locale.register(NS, { zh, en }))
  // 分屏容量：pane 仅在 split(visible>1) 时渲染；effect 卸载即释放
  ctx.effect(() => ctx.sessions.presentation.requestCapacity(2))
  ctx.slots.inject('session.pane.right', () => ctx.slots.register(
    {
      name: 'session.pane.right',
      id: 'sql-workbench',            // tab id
      order: 10,
      label: () => t('tab.title'),    // label thunk 跟随语言
      locale: NS,
    },
    SqlWorkbenchPanel,               // owner props: { focused: boolean }
  ))
}
```

- owner props 只消费 `{ focused }`（frame 只报焦点供命令路由）；
- **勿注册** `root`/`sidebar`/`conversation`/`details`（动态条目优先级更低反而获胜，会抹掉整帧及子 seat）。

## 6. 三处注册面（缺一不可，晚失败）

| # | 位置 | 动作 | 锚点 |
|---|---|---|---|
| 1 | `tsconfig.client.json` | references 增加 `{"path":"./packages/client/ui-sql-workbench"}` | 现有 L88-89（ui-user-questions/ui-trajectory 行） |
| 2 | `packages/bundle/web-app/cordis.patch.yml` | `dsh.client` 区增加一行 `- '@deepseek-ai/dsh-client-ui-sql-workbench'` | 分支 L295（ui-trajectory 行）；L153 起 browser roster 区 |
| 3 | `packages/bundle/web-app/package.json` | dependencies 增加 `"@deepseek-ai/dsh-client-ui-sql-workbench": "workspace:^"` | 现有 ui-* 依赖行 |

另：`scripts/verify-client-packages.ts` 会校验 peer/dev 依赖规则，提交前跑。

## 7. MCP 实例声明（cordis.yml）

bundle patch 中插入 mcp-client 实例（参照 `examples/mcp-memory/mcp-reference-memory.cordis.yml`）：

```yaml
- id: mcp-sql
  name: '@deepseek-ai/dsh-mcp-client'
  config:
    serverName: sql                      # 须匹配 [A-Za-z0-9_-]{1,32}，全局唯一
    transport: stdio
    command: node
    args: ['<plugin>/lib/mcp/server.js'] # bundle 安装时解析为实际路径
    toolCallTimeoutMs: 120000            # 覆盖默认 60s
    env: {}                              # 凭据不经 env（见 05 §安全边界）
```

激活链路：`dsh plugin add <pkg>` → `reconcilePlugins()` 加入 profile bundles → 下次启动 mcp-client 连接 server → `tools/list` → `ctx.tools.register` → agent 自动可见 `mcp__sql__*`（无需手工编目）。

## 8. 构建与验证顺序

```
编辑 src → pnpm --filter @deepseek-ai/dsh-client-ui-sql-workbench bundle   # 出 lib/client.js
        → pnpm run test:gui            # GUI 内环
        → pnpm --filter <pkg> bundle   # 再确认（registry serve lib/client.js 非源码）
        → dsh web --patch <cordis.yml> # 本地 patch 探测
        → DSH_SNAPSHOT=replay pnpm run test:web   # 可见变化时（split 快照先例：apps/web/tests/snapshots/cordis-tool-round/split.expected.md）
```

## 9. 测试门禁

| 层 | 要求 | 文件名 |
|---|---|---|
| node 半 / MCP 协议 | vitest；MCP 端到端 spawn 真实 server（ fixtures 参照 `packages/mcp/mcp-client/tests/`） | `*.spec.ts` |
| client 渲染 | vitest + 渲染断言 | `*.client.spec.tsx` |
| 覆盖率 | **per-file 100%**（`packages/client/AGENTS.md` L117）；豁免须 `/* v8 ignore -- reason */` | — |
| 非平凡变更 | 同 PR 附 Agent Note（`.agents/notes/`） | — |

测试矩阵：MCP 工具单测（schema 校验+错误码）／连接建立集成（对测试库）／分页行为（LIMIT n+1 断言）／git 工具（临时 repo）／UI 渲染（网格/线框状态）。

## 10. 发布与分发

| 阶段 | 方式 |
|---|---|
| 开发期 | monorepo 内 `dsh web --patch` 探测 |
| 联调期 | 本地 bundle 产物 + `dsh plugin add <path-to-tgz>` |
| 内网期 | 内网 npm registry（或 `dsh plugin market` 自定义 index，format-1） |
| peer 门禁 | 发布前用目标 dsh 版本校验 peerDeps（0.1.7-rc.1 起强制） |

## 11. 本地检查清单（提交前）

外部插件形态的检查清单（`tools/precommit.sh` 自动执行六项）：

- [x] 产物是宿主工厂形态：`lib/client.js` 含 `window.__ModuleLoader__.load`（§12.7.8）
- [x] 产物只向壳模块表请求 `react` / `react-dom`（无 `react/jsx-runtime`、无 `@deepseek-ai/*`）
- [x] `pnpm build` 通过（esbuild 三入口 + tsc 声明）
- [x] vitest 全绿 + per-file 100% coverage（含产物契约与端到端 spawn 用例）
- [x] 无硬编码颜色 / 无主题选择器 / 无组件级滚动条选择器
- [x] 无跨包 `@deepseek-ai/*` value import
- [x] 无 `@deepseek-ai/dsh*` peerDependencies（0.1.7 兼容门禁，§12.7.5）
- [ ] Agent Note 已写（随里程碑 PR）

> in-box 三处注册面（§6）对外部插件**不适用**，见 §12.7.4。

## 12. 外部仓库开发路径（2026-10-17，S1 spike 结论）

> 本节替代原「monorepo 内开发」假设下的 §1/§6 部分内容。所有条目均为本机实证（OBSERVED），非推断。

### 12.1 运行载体

| 事实 | 值 |
|---|---|
| **目标宿主** | **dsh 0.1.7-rc.2**：`E:/wyx_code/dsh-official-v0.1.7-rc.2`（用户本地 dsh desktop 通过 `DSH_HARNESS_DIR` 指向它） |
| 桌面端启动 | `E:/wyx_code/dsh-desktop/src-tauri/src/lib.rs` L138-160：`node <harness>/apps/cli/lib/bin.js --profile web --no-open --port N`，cwd = harness 目录。**桌面端跑的是 `web` profile**（`desktop` profile 是另一套手工环境，内含 `dsh-chat` / `dsh-split`） |
| 开发验证命令 | `node /e/wyx_code/dsh-official-v0.1.7-rc.2/apps/cli/lib/bin.js --profile dev-sql` |
| 桌面端 client 包 | `web` profile 将 12 个官方包 `link:` 覆盖为 `dsh-split/rebuild-v5/releases/0.5.0-rebuild.7-387d279eb460/native/…`（含 `dsh-client-ui-layout`、`dsh-client-ui-sidebar-right`，版本 0.2.0-rc.2） |
| 现有 profile | `C:/Users/wanyexin/.dsh/profiles/{web,desktop,chatbridge-test,web.bak-20260925}`；新增 `dev-sql`，**不动 `web` / `desktop`**（装入 `web` 需用户明确批准） |
| **profile 创建时机**（实证） | `--profile dev-sql --dump-config` 直接报错：`profile "dev-sql" does not exist; create it with 'dsh plugin --profile dev-sql add <package>'`。即 **profile 由第一次 `plugin add` 创建**（CLI 内部把剩余参数转发给 profile 目录里的 pnpm）。→ M0 顺序：**建包 → bundle → `plugin add`（同时建 profile）→ 启动验证** |
| CLI 用法（实证 `--help`） | `--profile <name>` / `--patch <path>`（可重复，额外 overlay）/ `--dump-config` / `--dump-default-config` / `web`（= `--profile web`）/ `plugin --profile <n> add <pkg>` |

### 12.2 外部插件注册右栏 pane：可行，无需改 monorepo

证据链：

1. **slot 由宿主声明，按名注册即可**：`packages/client/ui-layout/src/client/index.ts` L90
   `'session.pane.right': { kind: 'list'; scope: 'session'; owner: SessionPanePanelOwnerProps }`（children 声明 L174）；
   渲染点 `AppFrame.tsx` L296 `{renderSlot('session.pane.right', { focused })}`，位于 `<aside data-session-pane-right>` 且在 split 渲染分支内。
   slot 服务对插件一视同仁——先例外部插件已注册 `settings.section` / `shell.overlay` / `conversation.input.dock` 等宿主声明的 slot。
2. **先例包契约**（`@wanyexin1998/dsh-workbench` 0.2.0-rc.6，已装在 web profile，`file:` tgz 安装）：
   - `package.json`：`main`+`types`，`exports` = `.` / `./client` / `./package.json`；
     `dsh.bundle.patch: "./cordis.patch.yml"`；`dsh.client.inject: [...]`（宿主服务依赖清单）；`dsh.client.platform: "web"`；
     `peerDependencies` **精确锁定** dsh 版本（`0.1.2-rc.1` 系列）+ `@deepseek-ai/cordis ^4.0.2` + `react ^18.2.0`；`"private": true`。
   - `cordis.patch.yml`（随包分发）：
     ```yaml
     - insert:
         - id: dsh-workbench
           name: '@wanyexin1998/dsh-workbench'
     ```
     `dsh plugin add` 经 `dsh.bundle.patch` 自动 apply。
   - 安装落点：profile `package.json` 的 `dependencies`（`file:E://…tgz`）+ `dsh.profile.bundles` 列表 → profile `node_modules`。
3. **requestCapacity 用法**（先例实证代码）：
   ```js
   const releaseCapacity = sessions.presentation.requestCapacity(2)
   ctx.effect(() => releaseCapacity, 'dsh-workbench: pane capacity')
   ```
   即 **返回 disposer，必须挂 `ctx.effect`**（卸载即释放）。契约位置：`packages/api/session-controller/src/client/contract/sessions.ts` L50。
   先例另做了**能力守卫**：探测 `presentation.requestCapacity`、`presentation.state.getSnapshot` 是否存在，缺失则注册一条 disabled banner 而不是崩溃——我们照做可直接缓解 R1/R10（宿主 presentation face 不兼容时优雅降级）。

### 12.3 我们的最小可行挂载清单

1. `package.json`：exports `.` / `./client` / `./mcp` / `./package.json`；`dsh.bundle.patch: "./cordis.patch.yml"`；`dsh.client.inject: [slots, locale, sessions 等宿主包]`；peerDeps 锁定目标 dsh 版本。
2. `cordis.patch.yml`：插入 client 包行 + mcp-client 实例行（MCP 行语法以 `examples/mcp-memory/mcp-reference-memory.cordis.yml` 为准）：
   ```yaml
   - insert:
       - id: sql-workbench
         name: '@deepseek-ai/dsh-client-ui-sql-workbench'
       - id: mcp-sql
         name: '@deepseek-ai/dsh-mcp-client'
         config:
           serverName: sql
           transport: stdio
           command: node
           args: ['<pkg>/lib/mcp/server.js']
           toolCallTimeoutMs: 120000
           env: {}
   ```
3. client 半：`ctx.slots.inject('session.pane.right', () => ctx.slots.register({ name: 'session.pane.right', id: 'sql-workbench', order: 10, label: () => t('tab.title'), locale: NS }, Panel))`。
4. node 半：空 `apply`（宿主单写者逻辑随 M1 加入）。
5. 安装验证：`dsh plugin --profile dev-sql add <tgz>` → 以 `--profile dev-sql` 重启。

### 12.4 待实证（M0-2 / M0-3 关闭）

| # | 问题 | 回退方案 |
|---|---|---|
| A | 包名用 `@deepseek-ai/dsh-client-ui-sql-workbench`（00 §7 定名）是否触发内部包/peer 门禁（R2） | 被拦则改用自有 scope（如 `@wanyexin1998/dsh-data-ide`），同步改 00 §7 |
| B | 外部 `- insert:` 是否默认落进 `dsh.client` roster；mcp 实例行是否需要不同层级/段 | 参照 `examples/mcp-memory/*.cordis.yml` 与 profile `cordis.patch.yml` 的 id-targeted 写法实证 |
| C | split 未开时 tab 不可见 → 「打开 SQL 工作台」命令兜底的命令注册方式（slot/命令名） | 先例查 `ui-commands`；最低兜底：守卫 banner 提示用户先开 split |
| D | 宿主 presentation face 缺失时的降级路径 | 照抄先例 guard banner 模式 |

### 12.5 本机环境事实（M0 基线）

| 项 | 状态 |
|---|---|
| Node / pnpm / npm | v22.22.2 / 11.9.0 / 10.9.7 ✅（满足 `^22.19 ｜ >=24`） |
| `java` | **不在 PATH** → M4 前需装 JDK/JRE 17+（R4） |
| `dsh` CLI | 不在 PATH；经工作树 `apps/cli/lib/bin.js` 调用 |
| git | 2.55.0 ✅ |

### 12.6 关键锚点核验补充（2026-10-17，供 M0 编码直接引用）

已核验（分支 tip `82de604afc` 与工作树 `c5a387cd2f` 双点对照，差异见 00 §5.2）：

1. **client 半注册范式**（抄 `packages/client/ui-trajectory/src/client/index.ts` L43-64）：
   ```ts
   export const inject = ['slots', 'conversationEvents', 'conversationViews', 'sessions', 'locale']  // L23
   ctx.effect(() => ctx.locale.register(NS, { zh, en }), '…')                                         // L31
   const t = ctx.locale.bind(NS)                                                                       // L35
   ctx.slots.inject('<slot 名>', () => ctx.slots.register({
     name: '<slot 名>', id: '<entry id>', order: 10, locale: NS,
     label: () => t('<key>'),                                                                          // thunk，跟随语言
   }, Component))
   ```
   我们的 inject 最小集：`['slots', 'locale', 'sessions']`（+ 后续按需）。
2. **包契约模板**（`packages/client/ui-user-questions/`）：exports `.` / `./invariant` / `./client` / `./src/*` / `./package.json`；`dsh.client.{inject, platform:'web'}`；node 半 `apply` 为空；`bundle` script = `tsdown`；monorepo 内 peerDeps 用 `workspace:^`，**外部仓必须改成精确版本**（先例：0.1.2-rc.1 系列 + `@deepseek-ai/cordis ^4.0.2`）。
3. **MCP 实例 yml 原文格式**（`examples/mcp-memory/mcp-reference-memory.cordis.yml`）：
   ```yaml
   - insert:
       - id: memory-mcp-reference
         name: '@deepseek-ai/dsh-mcp-client'
         config:
           serverName: reference_memory
           transport: stdio
           command: mcp-server-memory
           cwd: !!js process.cwd()
           env: { MEMORY_FILE_PATH: ... }
   ```
   → 我们的 `mcp-sql` 行同构；`toolCallTimeoutMs: 120000` 写进 config（默认 60s）。`packages/bundle/web-app/cordis.patch.yml` 内无任何 mcp 实例，所以**外部插件必须自己 insert 这一行**。
4. **MCP 契约**：serverName 正则 `/^[A-Za-z0-9_-]{1,32}$/`（`sql` ✅）；一实例一 server，重名即抛；工具名 `mcp__sql__<tool>` 由 `src/tools.ts` L111-117 组装（超 64 字符会追加 hash，故工具名保持短）。
5. **凭据**：key 段正则 `/^[a-z][a-z0-9-]*$/`——`dsh-data-ide/<connId>` 两段都须匹配；UUID 必须规范化为 `ds-<8hex>`（04 §4 决策成立）。`modifyRecord(key, mutate)` 为唯一写路径，`mutate` 返回 `undefined` 表示不改。
6. **图标**：`IconBranchOutline16`(L149) / `IconPlayOutline16`(L553) / `IconDataOutline16`(L731) 均存在；**无 Save / Database / Table 命名图标**——保存用 `IconDownloadOutline16`(L543) 或 `IconCheckOutline16`(L129)，刷新 `IconRefreshOutline16`(L245)，停止 `IconStopFill16`(L513)，关闭 `IconCloseOutline16`(L211)，设置 `IconSettingsOutline16`(L68)。
7. **滚动条**：规则不在 `docs/web-styling.md`，在 `ui-theme/README.md` L11 + `scrollbar.css` L11-15——浮层在自身容器 rebind `--dsh-scrollbar-thumb: var(--dsw-alias-scrollbar-bg-l2)`（+ hover 项），**禁写组件级 `::-webkit-scrollbar`**。
8. **monorepo 侧命令**（仅参照，外部仓不直接可用）：`pnpm run test:gui`（秒级内环）、`pnpm run test:coverage`、`pnpm --filter <pkg> bundle`（registry 只服务 `lib/client.js`，改源码必须重 bundle）。外部仓需自建等价 vitest/tsdown 配置（M0-5）。

### 12.7 0.1.7 宿主基线（2026-10-17 切换，覆盖 §2/§3/§5/§6/§7 的旧口径）

原 §2~§7 描述的是 `codex/presentation-v2`（0.1.1/0.1.2-rc.1）上的仓内开发路径。以下为现行口径，**冲突时以本节为准**。

#### 12.7.1 为什么换基线

| 事实 | 证据 |
|---|---|
| 用户日常运行的是 0.1.7-rc.2 | `E:/wyx_code/dsh-desktop/launch-dsh-0.1.7-rc.2.vbs` 设 `DSH_HARNESS_DIR=E:/wyx_code/dsh-official-v0.1.7-rc.2`；该树 `package.json` version = `0.1.7-rc.2` |
| 0.1.7 没有 `session.pane.*`，也没有 `requestCapacity` | 全树 grep：0 命中。右栏子 slot 只有 `main`(keyed/root) / `rightbar`(single/root) / `shell.overlay` / `shell.leading`（`packages/client/ui-layout/src/client/index.ts` L68-112） |
| presentation-v2 支线已落后 | 分支 tip `82de604afc` = 0.1.1-rc.2；工作树快照 `c5a387cd2f` = 0.1.2-rc.2 且**不属任何 ref**（`git branch -a --contains` 为空），与现役差 ~1750 commit |
| 桌面端实际加载的 client 包也是 0.1.7 世代 | `web` profile 把 ui-layout / ui-sidebar-right 等 12 个包 `link:` 到 `dsh-split/rebuild-v5/.../0.5.0-rebuild.7`（0.2.0-rc.2）；该 ui-layout 里 `session.pane.right` = 0、`requestCapacity` = 0、`rightbar` = 77 命中 |

#### 12.7.2 右栏扩展点（现行）

由 `packages/client/ui-sidebar-right` 提供，两阶段注册（先例：`E:/dsh-plugin/dsh-chat/lib/client.js:644-682`）：

```ts
export const inject = ['slots', 'locale', 'sidebarRight', 'sidebarRightTabs']   // 两个服务缺一不可

ctx.effect(() => ctx.locale.register(NS, { zh, en }), '…')                     // 字典
ctx.effect(() => ctx.sidebarRightTabs.register({                                // 阶段一：页面类型
  id: TAB_ID, kind: TAB_KIND, multiple: false,
  title: () => t('tab.title'),
  guide: [{ id: TAB_ID, order: 40, title: () => t('tab.title'), description: () => t('tab.guide'), icon: Artwork }],
}), '…')
ctx.effect(() => ctx.slots.inject('sidebar.right.pane.tab', () =>              // 阶段二：body
  ctx.slots.register({ name: 'sidebar.right.pane.tab', key: TAB_ID,
    inject: (sessionId, actions) => ({ sessionId, actions }) }, Body)), '…')
ctx.effect(() => ctx.slots.inject('sidebar.right.pane.tab.title', () =>        // 阶段二：chip
  ctx.slots.register({ name: 'sidebar.right.pane.tab.title', key: TAB_ID }, Title)), '…')
```

- seat 声明在 `rightbar.session` 的 children 里（`ui-sidebar-right/src/client/index.ts` L177-195，generator 形式 `yield`）：`'sidebar.right.pane.tab'` = `{kind:'keyed', scope:'session', inject:{hooks:{tabInfo}}}`；
- **body 与 title 的 `key` 必须等于定义的 `id`**——右栏按 `entryKey = definition.id` 去 keyed seat 取组件（`shell/SidebarRight.tsx`）；
- `SidebarRightTabDefinition`（`tab-registry.ts` L94-139）：`id` / `kind` / `multiple?` / `keepMounted?` / `patterns?` / `priority?`（默认 `extension`）/ `canOpen?` / `title(address)` **必填** / `guide?`；
- tab body 拿到的注入 props：`{ sessionId, actions }`，`actions` = `{ openTab, openResource, close }`（`contract/slots.ts` L143-161）；另有 `tabInfo` hook 提供 `{ sidebar, panel:{id}, tab }`；
- **不需要 `requestCapacity`**；右栏内可并排多个 pane（dockkit `splitPane` / `openTab({preferNewPane})`）。

#### 12.7.3 能力边界（决定了哪些验收项不成立）

| 能力 | 0.1.7 |
|---|---|
| 每个会话各自独立的 SQL 面板 | ✅（`rightbar.session` 按 session 实例化） |
| 右栏内并排看两个 SQL 工作台 | ✅（dockkit 多 pane） |
| 对话分屏时每个 pane 各挂一个右栏 | ❌ 0.1.7 **没有对话分屏**（`rightbar` 是 root 级 single；`main` 按面板 id keyed，非分屏） |

→ 因此 **AC 不含 per-pane 语义**；R10（capacity 生命周期）随之关闭。

#### 12.7.4 挂载链（外部插件，无需改 monorepo）

| 环节 | 0.1.7 锚点 |
|---|---|
| 判定「这个包要入 bundle 栈」 | `packages/boot/plugin-manager/src/operations.ts:77`（`manifest.dsh.bundle.patch !== undefined`） |
| reconcile 进 `dsh.profile.bundles` | 同文件 `:88-111`，调用点 `:522` |
| 装配 client 半 | `packages/client/modules/src/index.ts:823` `resolveMeta`（要求 `dsh.client.platform==='web'` + `exports['./client']` 落到真实文件） |

> 三处注册面（`tsconfig.client.json` / `bundle/web-app/cordis.patch.yml` / `bundle/web-app/package.json`）是 **in-box 专属**（`packages/client/AGENTS.md` L132-137 首句限定 `packages/client/<name>`），外部插件**不要**改 monorepo。

#### 12.7.5 兼容性门禁（最容易踩的一条）

- `packages/boot/plugin-manager/src/index.ts:301-302`：不兼容且无豁免 → `throw ManagementFailure('incompatible-version')`，**整包跳过**；
- `packages/boot/app-boot/src/plugin-compatibility.ts:69`：`if (!Object.hasOwn(fields, 'peerDependencies')) return undefined` → **不声明 peerDependencies 即免检**；
- 现场证据：`E:/wyx_code/dsh-desktop/dsh-desktop-server.log` 里 `@wanyexin1998/dsh-workbench@0.2.0-rc.6` 正因 peer 钉 `0.1.1-rc.2` 被反复跳过；同 profile 的 `dsh-chat` / `dsh-split` 零 peerDependencies，畅通；
- **结论**：本插件 `package.json` 不写任何 `@deepseek-ai/dsh*` peerDependencies；产品兼容改由 `src/client/guard.ts` 运行期守卫（缺 `sidebarRight`/`sidebarRightTabs` → 打印可读原因并跳过注册）。

#### 12.7.6 MCP 实例声明与路径解析

```yaml
- insert:
    - id: mcp-sql
      name: '@deepseek-ai/dsh-mcp-client'
      config:
        serverName: sql
        transport: stdio
        command: !!js process.execPath
        args: !!js >-
          (() => {
            const at = process.argv.indexOf('--profile')
            const profile = at >= 0 ? process.argv[at + 1] : 'web'
            const home = typeof dshHomePath === 'function'
              ? dshHomePath()
              : (process.env.DSH_HOME || ((process.env.USERPROFILE || process.env.HOME) + '/.dsh'))
            return [home + '/profiles/' + profile + '/node_modules/dsh-data-ide/lib/mcp/server.js']
          })()
        toolCallTimeoutMs: 120000
```

- `!!js` 的求值域：`vendor/loader/src/config/utils.ts` 的 `evaluate = new Function('ctx','expr', 'with(ctx){return eval(expr)}')` → **只有 `process` 与 Loader ctx 上的服务**；`app-boot/src/index.ts:995` 只 provide 了 `dshHomePath`。**没有 `require` / `import.meta` / `__dirname`**；
- profile 名没有环境变量，只能从 `process.argv` 的 `--profile` 读（桌面端就是这么传的，`src-tauri/src/lib.rs` L150）；
- serverName 正则 `/^[A-Za-z0-9_-]{1,32}$/`；默认超时 60s，故显式设 `toolCallTimeoutMs: 120000`；官方 stdio 样例见 `apps/cli/config/examples/mcp-memory/*.cordis.yml`。

#### 12.7.7 类型面策略

0.1.7 的 client 类型包未发布到 npm（`@deepseek-ai/dsh-client-ui-sidebar-right` 最新仅 `0.1.5-alpha.1`），而桌面端实际加载的还是本地 link 的 rebuild。因此**宿主类型面自建**在 `src/client/contract/host.ts`，产物对 `@deepseek-ai/*` 零 import（服务全走 ctx），仓库可独立编译与测试。

#### 12.7.8 浏览器半的产物契约（踩坑记录，2026-10-17）

dsh 浏览器端**不走 ESM**。`lib/client.js` 必须是 classic script，并通过宿主模块表注册：

```js
window.__ModuleLoader__.load({
  id: 'dsh-data-ide',            // 必须等于包名
  factory: (require) => {         // require 来自壳模块表
    var module = { exports: {} }
    var exports = module.exports
    ;(function (require, module, exports) { /* cjs 产物 */ })(require, module, module.exports)
    return module.exports
  },
})
```

| 规则 | 依据 |
|---|---|
| 产物形态 = classic script + `__ModuleLoader__.load`；ESM 顶层 import 直接 `import failed` | `packages/client/modules/src/client/manifest.ts` L10-16、L316-328 |
| `id` 必须等于包名（也是 graph row 名） | 同上；重复注册会抛 `duplicate factory registration` |
| 壳模块表只 seed 平台单例（`react` 等），**未知 specifier 直接抛** | `system.ts` 解析顺序：seed → memo → graph row → registered → else throw |
| JSX 必须用**经典运行时**（`React.createElement`），不能用 `react/jsx-runtime` | 模块表没有 jsx-runtime 条目 |
| 样式要在 factory 内注入；旁挂的 `client.css` 不会被加载 | manifest 注释「CSS injection lives inside the factory closure」 |
| 物料化（factory 执行）时才跑副作用，且只跑一次 | `loadCache` memo |

实现见 `build.mjs`（client 半 = esbuild `format:'cjs'` + 经典 JSX + `.css` 按 text 内联 + 包装）与 `src/client/styles.ts`（`ensureStyles` 单次注入）。
回归测试 `tests/client-bundle.spec.ts`：按宿主方式加载产物，断言注册 id、只向模块表请求 `react`、apply 后页面类型与两个 keyed seat 到位。
