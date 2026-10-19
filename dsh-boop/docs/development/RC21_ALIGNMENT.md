# BOOP × DSH 0.2.1-rc.2 对齐差异报告（v1）

> 状态：**v1（主体结论已定；未完成项见 §8）**。
> 结论先行：BOOP 在 0.2.1-rc.2 上**必须改的宿主面只有「插件兼容声明」一类**（Lead 已在 commit `2c99dc2` 处理）；Typert Remote、`/api` 资产路由、客户端静态模块表、BOOP 用到的 slot、agent preset schema、BOOP 依赖的 host 服务均**无需改代码**。新增的远程访问控制（`remote-access`）与 `schedule` 内建行属行为面变化，已按“本地 owner 场景”评估为可接受。
>
> 调查对象：
> - 旧 payload（rc.2）：`.work/test-host/payload/dsh`（0.2.0-rc.2，12 412 文件 / 350 MB）
> - 新 payload（rc.2.1）：`.work/test-host/payload-0.2.1/dsh`（0.2.1-rc.2，17 263 文件 / 406 MB，`payload.json` 记录由 `tools/build-test-payload.mjs` 从 `E:/deepseek-harness/resources/app.asar` 提取）
> - 取证手段：`git diff --no-index --ignore-cr-at-eol`（README/package.json/patch.yml）、`Select-String`/node 字符串定位（dist/lib 构建产物）、依赖清单 JSON 比较、live Cordis Inspect（host 面）。
> - **未使用** `host-rc21/`（任务指定其不可靠）；未读取或修改用户 `~/.dsh`；未运行任何会写 `~/.dsh` 或启动宿主的命令。
>
> 基线提交：Lead 已提交 `2c99dc2 feat(align): BOOP on DSH 0.2.1-rc.2 (plugin compatibility, harness, evidence)`，本报告把该提交覆盖的项标为「已处理」。

---

## 0. 结论摘要

### 0.1 必须改（否则 rc.2.1 上不工作 / 行为错误）

| # | 差异 | 证据 | 处理状态 |
|---|---|---|---|
| M1 | **插件兼容检查改了判定源**：rc.2 app-boot 只看 `peerDependencies`（README 原文 "These checks use peer declarations, not `engines.dsh`"），rc.2.1 改为 **`engines.dsh` 优先且单独决定**，没有 `engines.dsh` 才看 dsh peers。BOOP 旧 `peers` 钉 `0.2.0-rc.2` → rc.2.1 启动时 bundle 被**跳过**（stderr 一行 `skipping profile bundle`，GUI 无感）→ BOOP 行不装配、`/api/boop/*` 404。 | 新：`.../dsh-app-boot/README.md`「Before a profile imports a plugin…」段；`dsh-app-boot/lib/index.js` 的 `lib/types/plugin-compatibility.js` 区段（`unmetRequirements()`：`Object.hasOwn(engines,"dsh")` 时只算 engines.dsh）。旧：同文件旧版函数仅遍历 `peerDependencies`，全文件 `engines` 出现 0 次（`Select-String -Pattern engines` count=0）。 | **已处理**：`package.json` 增加 `"engines": { "dsh": "0.2.1-rc.2" }` 并把 4 个 dsh peers 提到 `0.2.1-rc.2`。 |
| M2 | 版本常量与测试断言仍写 rc.2（BOOP 自述事实、probe 注释、测试期望）。 | 旧 `src/host/index.ts:58-62`、`src/shared/types.ts:182-184`；测试版本断言。 | **已处理**：`2c99dc2` 改 `dshProfileVersion:'0.2.1-rc.2'`、`dshCommit:'332895e0…'`；`src/host/tools.ts` 改为读 `boop.state()`；tests 版本断言/适配期望重基线。 |
| M3 | 测试宿主默认指向旧 payload。 | `tests/helpers/test-host.mjs:20-28`。 | **已处理**：默认 `.work/test-host/payload-0.2.1/dsh`；新增 `tools/build-test-payload.mjs`；`.gitignore` 忽略 `/host-rc21/`。 |
| M4 | 客户端入口此前注册在**未验证**的 `sidebar.workspaces.session.row.action`；新的 live/契约证据显示 `menu.item` 是宿主自带动作也在用的稳定入口。 | 旧 `src/client/index.tsx`（`git show 2c99dc2^:src/client/index.tsx`）；新旧 payload 的 `dsh-client-ui-workspace/lib/client.js` 都注册两个 list slot。 | **已处理**：`src/client/index.tsx` 改为 `sidebar.workspaces.session.menu.item`，`id:'boop.open-board'`、`order:240`、`locale:'boop'`。 |
| M5 | **仓库依赖快照未随 peers 提升**：`pnpm-lock.yaml` 中 `0.2.1-rc.2` 出现 0 次、`0.2.0-rc.2` 出现 2623 次；`node_modules/.pnpm/@deepseek-ai+dsh*` 仍是 0.2.0-rc.2（`node_modules/@deepseek-ai/{dsh,dsh-client-ui-primitives,dsh-tools,dsh-typert-protocol}` 的 `version` 均为 0.2.0-rc.2）。 | `Select-String -Path pnpm-lock.yaml -Pattern '0\.2\.1-rc\.2' | Measure-Object` → 0；`node_modules/@deepseek-ai/*/package.json` version 字段。 | **待处理（不影响宿主运行）**：esbuild 把 `@deepseek-ai/*` 全部 external、测试运行时用 payload 的 node_modules，因此功能/测试不受影响；但 `pnpm install --frozen-lockfile` 会因 lockfile 与 package.json 不一致失败，`pnpm typecheck` 仍在 rc.2 类型面上。建议 Lead 在验收冻结前重跑 `pnpm install` 并提交更新后的 `pnpm-lock.yaml`。 |

### 0.2 无需改（本轮已核对，保持现状）

1. **Typert Remote 协议**：`TypertRemoteService(ctx, serviceKey, {namespace})` 构造、`Remote('method')` 字符串装饰器、descriptor `version: 1`、`remoteMethods()`、SRC 模式**按形参名**组装参数、线格式 `{type:'client-request',rpcId,method,payload:{args}}`、客户端 `connection.rpc.call('/api', endpoint, {args})` —— 全部保持（§3）。
2. **`/api/boop/*` 精确资产路由**：`connection.fetch.register({path, methods, requestBody, fetch})` 的 getter 与 route 形状**逐字未变**（`registerFetchRoute` 新旧同源）；匿名 401 / 白名单 404 / ETag 304 语义不变（§4）。
3. **客户端浏览器半**：`dsh-client-store`/`dsh-client-ui-slots`/`dsh-client-ui-primitives` 在 rc.2.1 宿主 node_modules 中**不再作为独立包出现**（被合并进 shell 产物），但 shell 的 **static modules 表仍 seed 这三个模块名**，且 `MenuItemButton` 仍导出、props 契约一致 → BOOP 的 `require('@deepseek-ai/dsh-client-ui-primitives').MenuItemButton` 与 React external 全部继续可用（§5）。
4. **BOOP 用到的 slot 全部存在且契约不变**：`main`（keyed / root scope / key 必填 / 保留 key `conversation`）、`sidebar.workspaces.session.menu.item`（list / root）、`sidebar.workspaces.session.row.action`（list / root）；`ctx.layout.selectPanel(id)` 不变（§5）。
5. **Agent preset**：`@deepseek-ai/dsh-agent-preset` 的 Config schema（`id/name/description/order/plugins`）新旧**逐字相同**；BOOP 的 `presets/boop.patch.yml` 仍合法（含 persona `suffix: Your working directory is {{cwd}}.` 与 `includeRuntimeContext:true`，`dsh-persona` schema 未变）（§6）。
6. **Host 服务面**：BOOP adapter/probe 依赖的 16 个服务键在 rc.2.1 live 目录中全部存在；BOOP 实际调用的方法签名逐项比对不变（§2）。

### 0.3 风险 / 需关注（不阻塞本轮，但建议记录并排期）

| # | 风险 | 影响 | 建议 |
|---|---|---|---|
| R1 | **Remote 方法级访问控制**：rc.2.1 起每个 Remote 调用对非 owner Peer 走 `ctx.remoteAccess.decide()`；无 policy → `remote-access/denied`。精确 fetch 路由对非 owner Peer 直接 **403**。 | BOOP 的 `boop/*` Remote 与 `/api/boop/*` 资产对**本地 owner** 完全不受影响；对未来的非 owner 页面/liveshare 场景默认拒绝。 | 本轮显式接受“仅 owner”。若未来有非 owner 场景，需为 `dsh-api-remote-access` 注册 policy/role（不在本轮范围，不提议版本豁免）。 |
| R2 | 客户端 boot graph 新增 `release` 身份（`version`+`commit`），Host 与页面 release 不一致时页面不应用新 graph/重建帧，只提示并等用户刷新。 | BOOP client bundle 格式不变；但升级后**已打开的旧页面不会热加载新 bundle**，需刷新页面才见到面板变化。 | 验收/回归时先刷新页面再判断客户端半。 |
| R3 | `dsh-tools` 的 presentation mode **取消 `both`**（仅 `native`/`ptc`）。 | BOOP 未使用 `both`；`ctx.tools.register(defineTool(...))` 不变。 | 无动作；若后续测试/配置出现 `both` 即报错。 |
| R4 | 凭证解析顺序变化：rc.2.1 为「托管 `$DSH_HOME/.credentials.yaml` → 继承环境 → 项目 `.env` → 用户 `.env`」。 | BOOP E05-00 模型凭证真实金标仍 BLOCKED；真实环境配置凭证时顺序与旧不同。 | 真实金标阶段按新顺序配置；本轮不改代码。 |
| R5 | `--from-default-profile` 语义由「创建」改为「**替换**」自定义 profile；`RETIRED_BUNDLES` 会从 profile bundle 列表移除已退役 bundle（`@deepseek-ai/dsh-experimental-schedule-bundle`）。 | 只影响测试 harness/用户 profile 维护，不影响 BOOP 运行。 | 测试每次用全新 `DSH_HOME`；不要复用旧 profile 目录做“已存在则跳过”的假设。 |
| R6 | BOOP preset 的 `suffix: Your working directory is {{cwd}}.` 与 rc.2.1 新增的 `working-directory` 服务/上下文可能重复提示 cwd。 | 仅 prompt token 与表述重复，不报错、不影响加载。 | v2 评估：保留（固定主聊天 cwd 提示）或删除（跟随宿主统一上下文）。属产品选择。 |
| R7 | 新 API `appendPluginRecord()` 明确仅供 `packages/experimental/` 的仓库内插件使用，第三方插件“must not call it either”。 | BOOP 不应使用；当前未用。 | 记录为禁用 API。 |

### 0.4 Lead 已处理清单（commit `2c99dc2`）

- `package.json`：`engines.dsh:"0.2.1-rc.2"`；4 个 dsh peers → `0.2.1-rc.2`。
- `src/host/index.ts`：`dshProfileVersion`/`dshCommit` → 0.2.1-rc.2 / `332895e0…`。
- `src/host/tools.ts`：`boop_catalog` 的版本改为读 `boop.state()`。
- `src/shared/types.ts`：`DSH_TARGET` → 0.2.1-rc.2 / `332895e0…`。
- `src/client/index.tsx`：入口从 `row.action` 切到 `menu.item`。
- `tests/helpers/test-host.mjs`、`tests/host/e00-01-plugin-load.test.mjs`、`tests/host/e01-01-storage-in-host.test.mjs`、`tests/client/e04-01-companion3d.test.mjs`：payload 默认值/版本断言/E01-02 重启用例重基线。
- `tools/build-test-payload.mjs`（新增）、`.gitignore`（`/host-rc21/`）。
- 迁移跑通证据：E00-01 11/11、E00-02 8/8、E01-01 5/5、E03-01 5/5、E04-01 assets 8/8（见 commit message）。

---

## 1. 插件清单与装配

### 1.1 payload 版本与依赖面变化

| 项 | rc.2（旧） | rc.2.1（新） | 变化 / 对 BOOP 影响 |
|---|---|---|---|
| desktop-runtime 版本 | `0.2.0-rc.2` | `0.2.1-rc.2` | 宿主升级本身。 |
| `hostProtocolVersion` | `4` | `4` | **不变**：host/client 线协议兼容。 |
| 运行时 Node / pnpm | `24.18.1` / `11.7.0` | `24.21.0` / `11.28.5` | BOOP `engines.node=^22.19.0 || >=24.0.0` 仍满足；测试 harness 的 pnpm 路径为本机固定路径，需本机 pnpm 版本实际存在（Lead 已验证测试通过）。 |
| cordis 家族 | cordis `4.0.4`、loader `1.0.5`、group `1.0.4`、include `1.0.9`、timer `1.1.6`、cosmokit `1.8.5`、schemastery `3.18.4` | `4.0.5` / `1.0.6` / `1.0.5` / `1.0.10` / `1.1.7` / `1.8.6` / `3.18.5` | cordis 核心 README **无差异**（仅版本号）；loader 新增 `loader.resolve(id).moduleNamespace`（README 一行），不影响 BOOP 的函数式插件。 |
| @deepseek-ai/dsh-* 包数 | 279 | 296（物理目录 289→306） | 见下两行。 |
| 新增包（28） | — | `dsh-api-remote-access`、`dsh-tool-schedule`、`dsh-tool-session-query`、`dsh-tool-terminal`、`dsh-tool-working-directory`、`dsh-working-directory`、`dsh-harness-dev-context`、`dsh-plugin-market(-index)`、`dsh-web-deepseek-api`、`dsh-session-title-all-prompts-llm`、多个 experimental bundle/inspector/translator/worktree 等 | 与 BOOP 直接相关：`dsh-api-remote-access`（Remote 访问控制，§3）、`dsh-tool-schedule`（提醒工具从 dsh-schedule 拆出）、`dsh-working-directory`（cwd 服务）。 |
| 移除包（11） | — | `dsh-client-store`、`dsh-client-ui-primitives`、`dsh-client-ui-slots`、`dsh-experimental-schedule-bundle`、`dsh-hook-protocol`、`dsh-hooks-claude-code`、`dsh-hooks-codex`、`dsh-invariants`、`dsh-subagent-in-process-driver`、`dsh-webhook`、`dsh-webhook-github` | **关键**：三个 client-ui 基础包不再独立安装，但浏览器静态模块表仍提供其模块名（§5）；`experimental-schedule-bundle` 退役（schedule 进 web profile，§2）。 |

证据命令（可复现）：
```powershell
node --input-type=module -e "import fs from 'node:fs';const a=JSON.parse(fs.readFileSync('.work/test-host/payload/dsh/package.json')).dependencies,b=JSON.parse(fs.readFileSync('.work/test-host/payload-0.2.1/dsh/package.json')).dependencies;console.log(Object.keys(b).filter(k=>!(k in a)),Object.keys(a).filter(k=>!(k in b)))"
```
以及 `desktop-runtime.json` 的 `release.version / hostProtocolVersion / nodeVersion / pnpmVersion`。

> **工程侧提醒（M5）**：BOOP 仓库自身的 `pnpm-lock.yaml` 与 `node_modules` 仍是 0.2.0-rc.2（见 §0.1 M5）；这不影响 payload 取证与宿主运行，但影响“可复现安装/typecheck 基线”，属待处理项。

### 1.2 app-boot 的插件兼容机制（本轮升级的决定性变化）

**变化**
- rc.2：只检查 `peerDependencies` 中 `@deepseek-ai/dsh` 与 `@deepseek-ai/dsh-*` 是否满足运行时版本；README 明说「not `engines.dsh`」。`engines.dsh` 字段在 `dsh-package-manifest` 的**类型/文档里早已存在**（rc.2 README 同字段行未变），但 app-boot 不读。
- rc.2.1：
  - `unmetRequirements()`：manifest 有 `engines.dsh`（必须是字符串）→ **只看它，peerDependencies 全部忽略**；否则退回 peer 检查。
  - 失配返回 `requirements`（key 为 `engines.dsh` 或 peer 包名）；`evaluatePluginCompatibility()` 返回 `{name,version,runtimeVersion,requirements,exempted}`。
  - 反序列化/类型错误：非对象 `engines`、非字符串 `engines.dsh` → malformed manifest（抛错）；`engines.dsh` 里写 `workspace:` 视为不满足。
  - 拒绝路径不变：普通行变 `disabled:true` 丢弃；bundle 被跳过并进 `skippedBundles`，启动打印一次 `skipping profile bundle "<pkg>": <reason>`；插件代码不会被 import。
  - 豁免机制不变：仍是 profile 目录 `compatibility.json` 里 `package@version → [exact dsh versions]`；**本对齐不使用豁免**（应该对齐声明，而不是绕过）。

**对 BOOP 的影响**：升级到 rc.2.1 后，旧 BOOP bundle 的 peers `0.2.0-rc.2` 全部不满足 → bundle 整体被 skip → 顶部 stderr 一行告警，普通 Session 照常启动，BOOP 端点 404。**已处理**（engines.dsh + peers 提升）。

**建议动作**：保持 `engines.dsh:"0.2.1-rc.2"` 精确串（宿主 `release.version=0.2.1-rc.2`，已核对）；peers 保留仅为声明面，兼容判定不再依赖它们。不要加 `compatibility.json` 豁免。

### 1.3 dsh-package-manifest / bundle patch 语义

- **manifest 字段**：README 表内 `dsh.manifestVersion`、`engines.dsh`、`dsh.bundle.patch`、`dsh.client` 等字段定义**未变**；仅补了 icon 解析（package root 的 `package.json.icon` 或 `<specifier>/icon`）说明。
- **bundle patch 语义**：`bundlePatchFiles()` / `bundlePatchPaths()`（string 或 string[]，按顺序拼接）**逐字未变**；BOOP 的两文件 patch（`cordis.patch.yml`、`presets/boop.patch.yml`）继续有效。
- **新增（rc.2.1）**：
  - `RETIRED_BUNDLES = ["@deepseek-ai/dsh-experimental-schedule-bundle"]`：加载 profile 时从 bundle 列表中移除退役 bundle。
  - `OPTIONAL_BUNDLES` 清单（session-search / ralph / terminal / badge-skill / session-titles / agent-team / voice-input / cot-translation / auto-review / inspector / plugin-market / worktree），Plugin Manager 以“默认关闭”提供。
  - `--from-default-profile` 从「创建」变为「**替换**」（README 与 CLI 行为）。
- **对 BOOP 的影响**：无（BOOP 是普通 bundle；bundle 列表里不存在退役项）。
- **建议动作**：无需改。测试 harness 已每次用新 `DSH_HOME`，不受 replace 语义影响。

### 1.4 dsh-base `cordis.patch.yml` 行变化（旧 → 新）

| 变化 | 内容 | 对 BOOP 影响 |
|---|---|---|
| 新增 `remote-access` 行 | `@deepseek-ai/dsh-api-remote-access`，注释「Gateway requires it」（位置在 `typert-gateway` 之前） | Gateway 现在 `inject:["typert","remoteAccess"]`，**没有它不启动**；base 已随 web profile 挂载，BOOP 无需感知（§3）。 |
| 新增 `working-directory`、`tool-working-directory` 行 | `@deepseek-ai/dsh-working-directory`、`@deepseek-ai/dsh-tool-working-directory` | 新增 cwd 服务；BOOP 未用。 |
| `session-title` 行 | `maxOutputTokens: 64 → 4096`（防失控上限，非长度目标） | 无关。 |
| 新增 `web-deepseek-api` 行 | `@deepseek-ai/dsh-web-deepseek-api` | 无关（BOOP 未用 web 搜索）。 |
| 移除 `skill-badge` 行（disabled） | 移入 `dsh-experimental-badge-skill-bundle` | 无关。 |
| 移除 `tool-ralph` 行（disabled） | 移入 `dsh-experimental-ralph-bundle` | 无关。 |
| `tool-subagent` / `tool-subagent-fork` | 删除 `backgroundMode` 配置（默认行为由工具包自管） | 无关。 |
| `credentials` 注释 | 解析顺序说明改为 managed yaml 优先（R4） | 已在 §0.3 记录。 |
| plan-mode 文案、web 搜索注释 | 文档性 | 无关。 |

证据：`git diff --no-index --ignore-cr-at-eol .work/test-host/payload/dsh/node_modules/@deepseek-ai/dsh-base/cordis.patch.yml .work/test-host/payload-0.2.1/dsh/node_modules/@deepseek-ai/dsh-base/cordis.patch.yml`。新文件 `remote-access` 行位于 `dsh-base/cordis.patch.yml:57-58`。

### 1.5 dsh-web-app `cordis.patch.yml` 行变化（web profile）

| 变化 | 内容 | 对 BOOP 影响 |
|---|---|---|
| **新增 `schedule` 行** | `@deepseek-ai/dsh-schedule`（注释：Host 服务 + 原 Session 内投递） | **rc.2.1 web profile 现在有 `schedule` 服务**；旧 rc.2 需可选 experimental bundle（默认未启用）。BOOP probe 注释已按此更新（已处理）。 |
| 新增 `ui-schedule` 行 | `@deepseek-ai/dsh-client-ui-schedule` | 无关（UI 行）。 |
| 新增 `ui-secret-mask`、`ui-deepseek-model-label-1017` | 客户端 UI 行 | 无关。 |
| 新增 `harness-dev-context` 行 | `@deepseek-ai/dsh-harness-dev-context` | 无关（模型上下文）。 |
| `web-runtime` 配置 | 新增 `publicUrl`；`trustedHosts` 从 `webRuntime` 迁到 `webStartup`；移除 `personaSuffix: Your working directory is {{cwd}}.`（改由 working-directory 服务提供） | 本地 loopback 默认不触发；BOOP 资产路由不依赖 advertised URL。 |
| `webserver` 配置 | 新增 `tls: !!js ctx.webStartup.tls`；host 不再接受通配地址 | BOOP 不直接用 webServer（§4）。 |
| `connection` 行 | `inject: [webRuntime] → [webStartup]`，`trustedHosts` 来源变化 | 本地默认同源 loopback，行为不变。 |
| 删除 `tool-ralph` disabled 行 | 由 ralph bundle 接管 | 无关。 |
| `tools` 注释 | `DSH_TOOLS_MODE (native|ptc|both) → (native|ptc)` | 与 dsh-tools 取消 `both` 一致（R3）。 |
| presets（`cordis/standard/minimal/ptc.patch.yml`） | 新增 `time-context` 行、`tool-schedule` 行、`tool-plugin-market` 行；移除 persona `suffix: …cwd…`、`tool-subagent-codex/-claude-code`、`tool-ralph`；minimal 增加 `tool-fs` + compaction group | BOOP 用自己的 preset，不受影响；§6 讨论 BOOP preset 的 suffix。 |

证据：`git diff --no-index --ignore-cr-at-eol` 同 §1.4 路径（`dsh-web-app/cordis.patch.yml` 与 `dsh-web-app/presets/*.patch.yml`）。新 patch 中 `schedule` 行位于 `dsh-web-app/cordis.patch.yml:139-140`。

---

## 2. Host 服务面

### 2.1 live 目录（rc.2.1，实测）

`cordis_inspect_query(platform=host, provider=Service, method=listService)` 返回的服务键（90+ 个，节选中列出 BOOP 相关项）：`agentLoop、approval、connection、credentials、jobs、llm、profileContext、remoteAccess、schedule、sessionController、sessionProjections、sessionQuery、sessionPersistence、sessions、tools、typert、typertGateway、workspaceRegistry、webServer、webApp、workingDirectory、agents、agentPresets …`。

工具原始输出已落盘（`dsh-spill` 临时文件），本次调查以其中 `"key":"<name>"` 行为准；**client 侧 Inspect Provider 未响应（`Slots.listSubTree` / `Service.listService` / `Builtin.listBuiltins` 均 timeout，一次报 “no connected Harness page”），未取得 client 服务/slot 的 live 输出（见 §8 未完成项 U1；client Provider 由实验性 inspector 客户端 bundle 提供，默认 web profile 不挂载，见 §7 E23）**。

### 2.2 逐项对照（rc.2 → rc.2.1 → BOOP 用处）

| 服务键 | rc.2 | rc.2.1 | BOOP 用在哪 | 影响 / 动作 |
|---|---|---|---|---|
| `profileContext` | 有（`dsh/lib/profile-boot-*.js` provide） | 有（同位置，文件名 hash 变） | probe 能力矩阵 | 无变化。 |
| `sessions` | 有（`@deepseek-ai/dsh-session`） | 有 | `DshAdapter.pendingMessages`（`sessions.get`）、PoC `sessions.create(id,{seed,meta})` | `get(id)`/`create(id,…)` 符号与语义核对未变（dsh-session README 改动为新增 `appendPluginRecord` 与文档，无 API 破坏）。 |
| `sessionController` | 有（`@deepseek-ai/dsh-api-session-controller`） | 有 | `DshAdapter.resolveAgent()` | `resolveAgent()` 仍在（`Select-String` 新旧都命中）。注意：**Remote 端点 `session/*` 的 `session.create` 语义变化**（复用命名 blank、preset 选择与 `agent-preset/selected` 日志、冲突码），BOOP 走的是 Cordis `sessions` 服务不是此 Remote 端点，不受影响。 |
| `sessionProjections` | 有（`@deepseek-ai/dsh-session-projection`） | 有 | `stateOf(session,'inbox')` | `stateOf` 签名与语义不变（README 仅补 disposer/effect 说明）。 |
| `sessionQuery` | 有（`@deepseek-ai/dsh-session-query`） | 有 | `HostSourceReader.listSources/listEvents`（async） | `listSessions()` 新增**可选** `formatStatus` 字段（向后兼容）；`listEvents` 不变；仍为 async。 |
| `sessionPersistence` | 有 | 有 | `DshAdapter.flush(session)`（`persistence.flush`） | README 新增 `formatStatus`（storage 层），`flush` 面不变。 |
| `workspaceRegistry` | 有（`@deepseek-ai/dsh-workspace`） | 有 | probe | 无破坏性变化（README 改动为文档/权限相关）。 |
| `typertGateway` | 有（`@deepseek-ai/dsh-api-gateway`） | 有 | `api-service.ts` 的 `TypertRemoteService` 经 Gateway 认领 | 契约保持；新增 owner/non-owner 访问控制（§3）。 |
| `connection` | 有（host 面：`dsh-client-connection/lib/index.js`） | 有 | `assets.ts` 的 `ctx.reflect.get('connection').fetch.register` | `fetch.register` 形状不变；新语义见 §4。 |
| `tools` | 有（`@deepseek-ai/dsh-tools`） | 有 | `tools.ts`：`ctx.tools.register(defineTool(...))` | `register/defineTool` 不变；presentation mode 取消 `both`（R3）。 |
| `agentLoop` | 有 | 有 | probe；实际投递走 `Agent.followup/steer`（`dsh-agent-loop` 的 Agent 类） | `followup/steer/cancel/whenIdle` 新旧**逐字相同**（`dsh-agent-loop/lib/index.js` 的 Agent 类）。 |
| `llm` | 有（`@deepseek-ai/dsh-llm`） | 有 | `createUserMessage`（`dsh-adapter.ts`）、probe | `createUserMessage` 新旧均导出；llm README 变化集中在 `prepareCall/ConfigureCall`、`imageRequestTarget`、configurable provider 元数据，不影响 `createUserMessage` 与 `stream` 基本用法。 |
| `credentials` | 有 | 有 | probe、E05 凭证引用 | 服务成员不变；解析顺序变化见 R4。 |
| `approval` | 有（`@deepseek-ai/dsh-user-approval`） | 有 | probe | 不变（README 仅文档）。 |
| `schedule` | **缺**（web profile 无该行；需 optional `dsh-experimental-schedule-bundle`） | **有**（web-app patch 新增行） | probe（可选适配面） | **行为变化**：probe 现在会如实报告 `schedule: present`。Lead 已更新 probe 注释（`src/host/probe.ts` 在 `2c99dc2` diff 中）。 |
| `jobs` | 有 | 有 | probe | 不变。 |
| `remoteAccess`（**新增服务**） | 无 | 有（`@deepseek-ai/dsh-api-remote-access`） | 未直接使用 | Gateway 依赖；BOOP Remote 对 owner 不检查、非 owner 默认拒绝（R1）。 |
| `dshHomePath`（非服务，app-boot `ctx.provide`） | 有（`boot()` 中 `ctx.provide("dshHomePath", dshHomePath)`） | 有（逐字相同） | `src/host/index.ts` 存储根解析 | 不变。 |
| `logger`（cordis 基础） | 有 | 有 | 全量日志 | 不变。 |

### 2.3 BOOP adapter 实际调用的方法（新旧符号核对）

脚本对以下符号在旧/新 `lib/index.js` 中做存在性比对，结果**全部一致存在**：

```
sessionQuery: async listSessions / async listEvents
sessionController: resolveAgent( / prompt(
sessionProjections: stateOf(
session( dsh-session ): get(id / create(id
agent( dsh-agent-loop Agent 类 ): followup( / steer( / whenIdle / cancel(
llm: createUserMessage
sessionPersistence: flush(
```

证据命令：
```powershell
node --input-type=module -e "……逐个 fs.readFileSync 命中检查……"
# 或直接
Select-String -Path .work/test-host/payload-0.2.1/dsh/node_modules/@deepseek-ai/dsh-agent-loop/lib/index.js -Pattern 'followup\(|steer\(|whenIdle'
```
以及 live 目录对照（§2.1）。

**变化 / 影响 / 建议动作**：无签名破坏；无需改代码。唯一需要留意的是 Remote 面 `session/create` 语义变化（BOOP 未用 Remote 面创建会话，PoC 用的是 Cordis service；若未来改用 UI 的 Remote 创建流程需重审）。

---

## 3. Typert Remote 协议（`/api/boop/*` 端点）

### 3.1 保持不变（BOOP 的 api-service / remote.ts / client 调用依赖）

| 契约 | 旧 | 新 | 证据 |
|---|---|---|---|
| `TypertRemoteService` 构造 | `(ctx, serviceKey, options={})`，`super(ctx, serviceKey)` + `bindTypertRemote(this,this.name,options)` | 相同（新增注释「optional wire namespace」） | `dsh-typert-protocol/lib/index.js` 两版符号逐字核对（`class TypertRemoteService` / `bindTypertRemote`）。 |
| `Remote(name)` 字符串装饰器 | `Remote("bootstrap")` 返回 method decorator，写入 `REMOTE_METHOD_DESCRIPTOR` | 相同（选项对象新增 `name/mode/resources` 三键，但字符串路径不变） | 新 `Remote()` 实现：`typeof x==="string"` → `remoteDecorator({kind:'direct'},{exportName})`；`REMOTE_OPTION_KEYS = {name,mode,resources}`。 |
| descriptor 版本 | `version: 1`，`remoteMethods(service)` 校验 | `version: 1`，`remoteMethods` 同 | `readRemoteMethodDescriptor()` 两版相同。 |
| SRC 模式取参 | 从方法形参名组装 `parameters[]`，JSON 参数 `wire=name`；保留末位 `signal` 为取消位 | **相同**：`srcDescriptor()` → `methodParameterNames(binding.service, marker.method, endpoint)`；`signal` 必须最后且非业务参数 | `dsh-api-gateway/lib/index.js` 的 `srcDescriptor` 区段。 |
| Gateway 端点认领缓存 | `srcClaims ??= collectSrcClaims()`，进程内只算一次 | 相同（`claimsEndpoint` 逻辑不变） | 同上 `claimsEndpoint/collectSrcClaims`。 |
| 线格式 | `POST /api/<ns>/<method>`，body `{type:'client-request',rpcId,method,payload:{args}}` | 相同 | `dsh-client-connection/lib/client.browser.js` 的 `createWebConnectionRpc.call()` 与旧 `client.js` 版本**逐字相同**。 |
| 客户端调用面 | `ctx.connection.rpc.call('/api', endpoint, {args:{}})` | 相同（`rpc.call(channel, endpoint, payload, signal)`） | 同上。 |

### 3.2 变化

1. **访问控制**（最大变化）：每个 Remote 方法都受 `dsh-api-remote-access` 判定；Gateway `static inject = ["typert","remoteAccess"]`，启动时依赖该服务。owner（本地浏览器 cookie）不检查；非 owner peer 需要 policy。被拒返回 `remote-access/denied`（`details:{action,reason}`）。
2. **`@Remote` 选项**：现在可写 `name`、`mode:'stream'`、`resources`（资源 readers）。BOOP 的 `remote(method)` 回放只传方法名，不涉及 resources，仍合法；若未来要给方法声明资源，应改用 options 形式并保持 descriptor v1。
3. **`bindTypertRemote`** 用 `Context.is(ctx)`（跨副本 Context 识别）替代 `instanceof Context` —— 对混合 source/built 组合更稳，BOOP 无感。
4. **新增导出/子注册表**：`principalOf`、`createTypertRemoteInfo`、`isTypertRemoteMethod`、`ctx.typert.resources`（资源默认字段注册）。BOOP 未用。
5. **registry 客户端入口条件导出**：`./client` 在 Node 解析为 `lib/client.node.js`、浏览器解析为 `lib/client.browser.js`（`/plugins/.../client.js` 路由仍按 browser 条件服务）。BOOP host 测试若 `import '@deepseek-ai/dsh-typert-registry/client'` 会拿到 node 版（语义相同），浏览器端不变。
6. **stream/Ping 语义**、`$events` 交互权限等（`interactions:'answer'|'none'`）变化：BOOP 无 stream Remote，无影响。

**对 BOOP 的影响**：`boopApi` 服务 + 7 个 `@Remote` 方法继续被 Gateway 以 SRC 模式认领；形参名约定仍成立（`bootstrap()`、`observeSources()`、`pocSeedInbox(sessionId,instruction?,taskId?)`、`pocInbox(sessionId)`、`pocGateDecision(sessionId)`、`pocGateStatus()`、`pocRelease(messageIds)` 全部普通命名参数）。owner 本地调用不受新访问控制影响；非 owner 默认拒绝（R1）。

**建议动作**：不改。保持「只导出函数式插件 + 服务类分文件」；新增端点继续用普通命名形参；不要给 `@Remote` 传带 `resources` 的 options，除非后续要支持非 owner。

---

## 4. Web 与资产路由（`/api/boop/*`）

### 4.1 `dsh-host-webserver`

| 变化 | 对 BOOP 影响 |
|---|---|
| `WebRoute` 注册语义不变：`register(route)` 支持 `exact`/`prefix`，返回 disposer；匹配顺序 exact → 最长 prefix → fallback；重复 path 抛错。 | BOOP 不直接用 `webServer`（用 `connection.fetch`），无影响。 |
| `host` 不再接受 `0.0.0.0`/通配，必须是具体本机接口 literal；回环判定更严格。 | 本地默认 `127.0.0.1` 不变。 |
| 新增 `tls` 配置、`ctx.webServer.protocol`、`getOrigin()`；TLS 文件激活时一次读取，失败 fail。 | 无关（本地 HTTP）。 |
| 生命周期：TLS+listen 归一个 effect 管理；dispose 等 listener 关闭。 | 无关。 |

### 4.2 `connection.fetch.register`（BOOP 7 条精确资产路由）

**结论：API 形状完全兼容，无需改。**

- Host 侧 `get fetch()` 返回 `{ register: route => this.registerFetchRoute(owner, route) }`，新旧相同。
- `registerFetchRoute(owner, route)` 实现**逐字相同**：`assertFetchRoute(route)`；保存 `{methods:Set, requestBody, fetch}`；effect 注册/去重/释放；`requestBody` 支持 `buffered`/streaming 声明。
- 分派：`createSharedFetchHandler(channel)` 的 exact 表查询在 `/api` prefix interceptor 之前，BOOP 的 `/api/boop/model.glb` 等精确路径优先命中。
- **新语义**：分派 `fetch(request, peer)`；精确路由先判 `peer.principal.kind !== 'owner'` → **403**。匿名请求在 `/api` 前缀路由处仍 401（`admit()` 先做 trust/auth），与 E00-01/E04-01 断言一致。
- 新 `bridge(request,res,handler,peer)` 传 peer；RPC handler 接收调用 Peer。

**对 BOOP 影响**：本地浏览器（owner）行为不变：精确路由命中、ETag/304、`content-type`、缓存头、白名单 404、匿名 401 全部保持；仅“非 owner API peer 访问资产会 403”这一新限制（R1）。

**建议动作**：不改。E04-01 assets 8/8 已在 rc.2.1 重跑通过（Lead 证据）。

### 4.3 `/api` 通道

`connection.rpc.call`（浏览器）与 `/api` 共享 handler 注册（`register(owner,'/api',handler)`）、`registerInterceptor` 均未变；`/connect?token=…&interactions=…` 是新增的 API peer 入口，页面 cookie 流程（`authorizeIndex`）不变。

---

## 5. 客户端模块与 slot

### 5.1 `dsh.client` 声明与模块加载

| 项 | 旧 | 新 | BOOP 影响 |
|---|---|---|---|
| `dsh.client` 字段集 | `platform / inject / immediately / external` | 同四字段（全 payload `package.json` 扫描，新旧字段集合一致） | BOOP 声明 `{"platform":"web"}` 足够。 |
| 模块 id | 解析后的 package name | 同 | `dsh-boop`。 |
| bundle 形态 | `window.__ModuleLoader__.load({id, factory})`，factory(require) 懒执行 | **同**（client-modules README「executing a plugin bundle only REGISTERS its factory」；shell facade `create()` 过程不变） | BOOP `build.mjs` 生成的 wrapper 无需改。 |
| bundle URL | `/plugins/<package>/client.js?rev=<rev>` + combo `/plugins/??…&rev=…` | 同（新增说明：chunk 通过异步 fs API 读取；/plugins 路由跟随 webServer 生命周期重注册） | 无影响。 |
| `exports["./client"]` 条件 | 仅 `default` | 相关宿主包（如 `dsh-client-connection`、`dsh-typert-registry`）改成 `node`/`browser` 条件导出（BOOP 自己的 `./client` 仍是 `default`，client-modules 以 browser 条件解析宿主包，对只声明 default 的包仍回落到 default） | 无影响。 |
| **新增 `release` 身份** | 无 | boot graph 携带 `{version, commit}`；Host/页面 release 不同时不应用 graph/重建帧，只发 `releaseChange` 提示，用户刷新后加载 | R2：升级后旧页面不会热加载新 BOOP bundle，需刷新。 |
| client entry 状态 | — | 新增 `ClientEntries` 队列/release 逻辑，bundle 仍是单资源 URL | 无影响。 |

### 5.2 PLATFORM_MODULES 静态表（shell dist）

| 版本 | 表内容 |
|---|---|
| 旧 shell `dsh-web-frontend/dist/assets/index-5SrrfWpU.js`（函数 `rM()`） | `react`、`react/jsx-runtime`、`react-dom`、`react-dom/client`、`@deepseek-ai/cordis`、`@deepseek-ai/dsh-client-store`、`@deepseek-ai/dsh-client-ui-slots`、`@deepseek-ai/dsh-client-ui-primitives`、`@deepseek-ai/dsh-client-ui-dockkit`（**9 项**） |
| 新 shell `index-CN7NIWNw.js`（函数 `SZ()`） | 同 9 项 + **`zod`** + **`@tanstack/react-virtual`**（**11 项**） |

**关键推断已验证**：rc.2.1 node_modules 中不再有 `dsh-client-store` / `dsh-client-ui-slots` / `dsh-client-ui-primitives` 三个包，但 shell 表**仍以这三个名字**作为 seed（`SZ()` 返回对象里键名逐字保留）；`dsh-client-ui-primitives` 的命名空间是冻结对象，含 `MenuItemButton:tA`（新 shell dist 字符串 `MenuItemButton:tA` 可定位），说明浏览器端 `require('@deepseek-ai/dsh-client-ui-primitives')` 仍解析。

**MenuItemButton props 契约（旧 primitives lib/index.js vs 新 shell 内联实现）**：`children, shortcut, icon, disabled=false, danger=false, separatorBefore=false, onSelect` —— 逐项相同，渲染结构（`div.itemWrap > [separator, button[role=menuitem]>icon,label,shortcut]`）也一致。BOOP 只用了 `onSelect` + children，稳定。

### 5.3 slot 目录

| slot | 旧 | 新 | 契约变化 | BOOP 用法 |
|---|---|---|---|---|
| `main` | keyed / root scope；`key` 必填；保留 key `conversation`（宿主可派发任意 key） | **相同**（`dsh-client-ui-layout/lib/client.js` 的 root 注册里 `"main": {kind:"keyed",scope:"root"}`；契约文档条 `key:"main"` 相同） | 无 | `ctx.slots.inject('main', …)` + `ctx.slots.register({name:'main',key:'boop.tasks',inject:()=>({})}, Panel)` —— 有效。 |
| `sidebar.workspaces.session.menu.item` | list / root；宿主自带 `pin(100)/rename(200)/fork(300)/archive(400)` | list / root；**新增 `session-id(450)`**（Copy Session ID） | 契约文档同步补 session-id；`hookContext: MenuOpenState` 与「用 `useMenuOpenState` 关闭菜单」的说明两版都有 | BOOP `order:240`（rename 与 fork 之间）合理；`inject:()=>({run})` 渲染 `MenuItemButton` 有效。 |
| `sidebar.workspaces.session.row.action` | list / root；宿主自带 `archive(100)/pin(200)` | **相同**（仍存在） | 无 | 当前 BOOP 未使用（M4 已切到 menu.item）。 |
| `shell.bottom` | 无 | **新增** root scope 单 seat（`dsh-client-ui-layout/lib/client.js` 的 root children 新增 `"shell.bottom":{kind:"single",scope:"root"}`，并在 AppFrame 中渲染；layout README 新增段） | 新增槽 | 无关。 |
| `main.conversation` / `shell.overlay` / `shell.leading` 等 | 有 | 有（候选键增加，例如 `main.conversation` 的 standardProps 加 RemoteAccess hooks） | 对 BOOP 无影响 | 未使用。 |

`ctx.layout.selectPanel(id)`：新旧实现相同（`if (panelId!==null && !this.hasMainPanel(panelId)) throw`），BOOP 菜单项 `run` 里调用有效。

**live 检查**：`cordis_inspect_query(platform=client, provider=Slots, method=listSubTree)` 两次 timeout、随后 `Builtin.listBuiltins` 报 “no connected Harness page”，**未取得 client live 输出（U1）**；本条结论基于 payload 字符串（slot 注册代码 + 契约文档）与已重跑的测试证据。

**建议动作**：本轮已完成（入口切 menu.item）。若后续要“行内悬停按钮”，`row.action` 仍可用但未在 rc.2.1 live 验证；`order 240` 已避开宿主 100/200/300/400/450。

---

## 6. Agent preset

- **`@deepseek-ai/dsh-agent-preset` Config schema 新旧逐字相同**：
  `id: z.string().required()`、`name: z.string()`、`description: z.string()`、`order: z.number()`、`plugins: z.array(z.any()).required()`；`EntryGroup.key = true`、`inject=["agentPresets"]`、`Service.init` 调 `ctx.agentPresets.register(config)`。
  证据：`dsh-agent-preset/lib/index.js` 两版分别提取 `static Config` 区段比较（README 仅删掉 runtime invariant 段）。
- **BOOP `presets/boop.patch.yml` 仍合法**：`id: presets-boop` 行使用 `@deepseek-ai/dsh-agent-preset`，config `{id:'boop', order:2, plugins:[persona, boop-tools]}`；persona 的 `prefix/suffix/complete/includeRuntimeContext` 四字段在 `dsh-persona` Config 中未变（两版 `lib/index.js` 的 `suffix: z.string().default("")`、`includeRuntimeContext: z.boolean().default(true)` 相同）。
- **宿主自带 presets 的变化（rc.2.1）**：
  - 新增 `time-context` 行（@deepseek-ai/dsh-time-context）、`tool-schedule` 行、`tool-plugin-market` 行（disabled 视条件）。
  - 移除 persona `suffix: Your working directory is {{cwd}}.` —— cwd 改由 `working-directory` 服务/上下文提供（base 新增 working-directory 两行）。
  - 移除 `tool-subagent-codex`/`tool-subagent-claude-code` 行、`tool-ralph` 行；`backgroundMode` 配置移除。
  - minimal preset 增加 `tool-fs`（readImage only）+ compaction group。
- **对 BOOP 的影响**：BOOP preset 自带 cwd suffix 仍被接受（不报错），但 rc.2.1 宿主自身也会给 cwd 上下文 → 可能重复（R6）。BOOP preset 未挂 `tool-schedule`，提醒工具不在 BOOP 主聊天工具面（与设计一致：BOOP 用管理工具）。
- **建议动作**：本轮无需改；v2 评估是否保留 `suffix`。不要给 BOOP preset 加 `tools mode: both`（已不存在）。

---

## 7. 证据索引

### 7.1 关键文件与定位

| # | 证据 | 位置 / 命令 |
|---|---|---|
| E1 | 依赖清单 diff（新增 28 / 移除 11 / cordis 家族版本） | §1.1 的 node 脚本；`desktop-runtime.json` release 字段 |
| E2 | app-boot 兼容机制（engines.dsh 优先；旧版 0 次 engines） | `.../dsh-app-boot/README.md`（En×1「Profiles」段）；`dsh-app-boot/lib/index.js` `//#region lib/types/plugin-compatibility.js`（新 `unmetRequirements`；旧 `evaluatePluginCompatibility` 只遍历 peers） |
| E3 | bundle 跳过诊断 | `dsh-app-boot/lib/index.js` `reportSkippedBundles()`：`${binName}: skipping profile bundle ${JSON.stringify(packageName)}: ${reason}` |
| E4 | 豁免文件位置（未使用） | app-boot README「Exact-version exemptions live in the profile's own `compatibility.json`」；`dsh-app-boot/lib/index.js` `PROFILE_COMPATIBILITY_FILENAME="compatibility.json"` |
| E5 | base patch 变化 | `git diff --no-index --ignore-cr-at-eol .work/test-host/payload/dsh/node_modules/@deepseek-ai/dsh-base/cordis.patch.yml .work/test-host/payload-0.2.1/dsh/node_modules/@deepseek-ai/dsh-base/cordis.patch.yml`；新 `remote-access` 行 `:57-58` |
| E6 | web-app patch 变化 | 同法 diff `dsh-web-app/cordis.patch.yml` 与 `presets/*.patch.yml`；新 `schedule` 行 `:139-140`、`ui-schedule` `:398-399` |
| E7 | RETIRED/OPTIONAL BUNDLES、`--from-default-profile` 替换语义 | `dsh-app-boot/lib/index.js` `const RETIRED_BUNDLES`；`dsh/README.md` 命令表 diff |
| E8 | Typert：服务构造函数/装饰器/descriptor v1/SRC 形参名 | `dsh-typert-protocol/lib/index.js`（`TypertRemoteService`、`Remote()`、`readRemoteMethodDescriptor`）；`dsh-api-gateway/lib/index.js`（`srcDescriptor()`、`collectSrcClaims()`、`TypertGatewayService static inject=["typert","remoteAccess"]`） |
| E9 | Remote 访问控制 | `dsh-api-remote-access/README.md`（`decide/allows/snapshotFor`；owner 不检查；`remote-access/denied`）；`dsh-api-gateway/README.md` 新增段 |
| E10 | 客户端 rpc.call 逐字相同 | `git diff --no-index` 旧 `dsh-client-connection/lib/client.js` vs 新 `lib/client.browser.js`（`createWebConnectionRpc.call` 段相同） |
| E11 | fetch 精确路由 API 相同 | 新旧 `dsh-client-connection/lib/index.js` 的 `registerFetchRoute()` 逐字相同；新 `createSharedFetchHandler()` 的 `if (peer.principal.kind!=="owner") return 403` |
| E12 | webserver 语义 | `dsh-host-webserver/README.md` diff（host/TLS/`getOrigin`） |
| E13 | PLATFORM_MODULES 表 | 旧 shell `.../dsh-web-frontend/dist/assets/index-5SrrfWpU.js` 的 `function rM()`；新 `index-CN7NIWNw.js` 的 `function SZ()` |
| E14 | MenuItemButton 契约 | 旧 `dsh-client-ui-primitives/lib/index.js` `function MenuItemButton({children,shortcut,icon,disabled,danger,separatorBefore,onSelect})`；新 shell dist 字符串 `MenuItemButton:tA` + 同名 props 实现 |
| E15 | `main` / menu.item / row.action slot | `dsh-client-ui-layout/lib/client.js` root 注册 `"main":{kind:"keyed",scope:"root"}`；`dsh-client-ui-workspace/lib/client.js` `ctx.slots.inject('sidebar.workspaces.session.menu.item'|'.row.action')` 与 shipped 行；`dsh-cordis-client-runner/lib/client.js` 内嵌 slot 契约文档（`"key":"main"`、`"key":"sidebar.workspaces.session.menu.item"` 条目） |
| E16 | layout.selectPanel | 新旧 `dsh-client-ui-layout/lib/client.js` 的 `selectPanel(panelId){ if (panelId!==null && !this.hasMainPanel(panelId)) throw … }` |
| E17 | agent preset schema | 新旧 `dsh-agent-preset/lib/index.js` 的 `static Config` 区段；`dsh-persona/lib/index.js` 的 `suffix`/`includeRuntimeContext` |
| E18 | host 服务面 live | `cordis_inspect_query(platform=host, provider=Service, method=listService)` 输出（含 `remoteAccess`、`schedule`）；BOOP 旧 rc.2 矩阵见 `docs/development/STATUS.md` §E00-01 第 7 条（旧 web profile `schedule` 缺失） |
| E19 | 旧/新服务提供包扫描 | 递归扫描 `*/lib/*.js` 的 `super(ctx,"<key>")`/`provide("<key>")`：除 `remoteAccess` 仅新版存在外，其余提供包相同 |
| E20 | BOOP 实际调用符号新旧核对 | §2.3 脚本；`src/host/transport/dsh-adapter.ts`、`src/host/observe/host-reader.ts`、`src/host/api-service.ts`、`src/host/assets.ts` |
| E21 | Lead 已处理 | `git show 2c99dc2 --stat` 与 `git show 2c99dc2 -- package.json src/host/index.ts src/host/tools.ts src/shared/types.ts src/client/index.tsx` |
| E22 | 版本/commit 事实 | `.work/test-host/payload-0.2.1/desktop-runtime.json`（`release.version=0.2.1-rc.2`、`hostProtocolVersion=4`）；`.work/test-host/payload-0.2.1/payload.json`；`tests/helpers/test-host.mjs:38-40` 的 `pinnedCommit` |
| E23 | client Inspect Provider 依赖实验性 bundle | `dsh-experimental-inspector/README.md`（「Both plugin faces run the same browser-safe Cordis collector」）；`dsh-experimental-inspector-profile/cordis.patch.yml`（`experimental-inspector` 行）；`dsh-base/cordis.patch.yml` 与 `dsh-web-app/cordis.patch.yml` 中无 inspector 行 |

### 7.2 复现方法（只读）

```powershell
# README / package.json / patch.yml 差异（忽略 CRLF）
git --no-pager diff --no-index --ignore-cr-at-eol -- `
  .work/test-host/payload/dsh/node_modules/@deepseek-ai/dsh-app-boot/README.md `
  .work/test-host/payload-0.2.1/dsh/node_modules/@deepseek-ai/dsh-app-boot/README.md
# dist 字符串定位（PowerShell 大文件按行截断）
Select-String -Path .work/test-host/payload-0.2.1/dsh/node_modules/@deepseek-ai/dsh-web-frontend/dist/assets/index-CN7NIWNw.js -Pattern 'staticModules|__ModuleLoader__'
# 槽位/契约文档
Select-String -Path .work/test-host/payload-0.2.1/dsh/node_modules/@deepseek-ai/dsh-cordis-client-runner/lib/client.js -Pattern 'sidebar.workspaces.session.menu.item'
```

---

## 8. 未决问题（v1 未完成项）

| # | 未决项 | 现状 | 建议 |
|---|---|---|---|
| U1 | **client live 检查器未取到**（`Slots.listSubTree`/`Service.listService`/`Builtin.listBuiltins` 均 timeout 或 “no connected Harness page”）。原因可证：client 侧 Inspect Provider 由实验性 `@deepseek-ai/dsh-experimental-inspector` 的客户端 bundle 提供（DEV note：Client 收集器随该包浏览器半运行），其挂载行在 `dsh-experimental-inspector-profile` 这一 **OPTIONAL bundle** 中，默认 web profile 的 base/web-app patch 均无 inspector 行。 | 已用 payload 字符串（slot 注册代码、契约文档、shell 静态表）+ 已重跑测试（E00-01 11/11 等）替代；结论可信但非 live 双证。 | Lead 在 GUI 页面中人工确认：BOOP 面板 key `boop.tasks` 出现在 `main` 面板派发列表、会话“…”菜单出现“BOOP 任务板”。若需要自动证据，需临时启用 inspector bundle（会改 profile，超出本任务约束，不建议为本轮验收做）。 |
| U2 | `sidebar.workspaces.session.row.action` 仍存在但 BOOP 已不使用。 | 未验证 rc.2.1 下 row-action 的渲染顺序（宿主 archive100/pin200）。 | 产品决定是否恢复行内按钮；恢复前先用 live slot 查询确认。 |
| U3 | BOOP preset 的 cwd `suffix` 与宿主 `working-directory` 上下文可能重复。 | `dsh-persona` schema 未变，仍可加载（不报错）。 | v2 评估去重；不阻塞本轮验收。 |
| U4 | 非 owner Peer 的 BOOP Remote/资产访问默认拒绝。 | 未注册 policy；本地 owner 路径完整。 | 若未来有非 owner/liveshare 场景，另立任务设计 `dsh-api-remote-access` policy；**不加版本豁免**。 |
| U5 | E05 真实模型金标仍 BLOCKED（缺凭证）；凭证解析顺序在 rc.2.1 变化。 | 契约测试 7/7 通过，真实金标未跑。 | 真实凭证阶段按新顺序验证（R4）；不伪造 PASS。 |
| U6 | rc.2.1 新增 `appendPluginRecord` 第三方禁用、`dsh-tools` mode 取消 `both`、`session/create` Remote 语义变化等旁支。 | 已记录，BOOP 未使用相关路径。 | 保持“不使用”即可；若未来扩展功能再单独立项。 |

> 后续（若 Lead 需要）：本报告 v2 可在 U1 取得 live 双证后补 §5 live 表与 U1 结论，其余部分预计不变。

---

## 9. v1 之后的更新（2026-10-18，提交前）

- **M5 已处理**：`pnpm-lock.yaml` 全量重装到 `0.2.1-rc.2`（`0.2.0-rc.2` 引用 0 条），`node_modules/@deepseek-ai/{dsh,dsh-client-ui-primitives,dsh-tools,dsh-typert-protocol}` 均为 `0.2.1-rc.2`；补 `@types/node`；`pnpm-workspace.yaml` 的 `allowBuilds` 显式 `false`（原生构建脚本被安全策略阻断，继续使用 `esbuild-wasm`）。`pnpm install` 退出码 0。
- **行为面新增记录**：E02-04（`boop-workspace` 行）与 E04-01 第二批（`boop/mainSession|sources|initPlan` + 客户端主聊天/初始化/来源交互）已落地，证据见 `docs/development/STATUS.md` §E02-04 / §E04-01（第二批）。
- **R2 生效**：客户端 boot graph 的 `release` 身份意味着升级宿主后**已打开的旧页面需刷新**才能看到新客户端 bundle（本轮验收口径：先刷新再判断客户端半）。
- 本轮测试实证（rc.2.1-rc.2）：单元 112/112 + 客户端 42/42 = 154/154；宿主集成 63/63。
