# 事故记录：探针导致 desktop web boot 失败（2026-10-15 20:44）

**状态**：已定位、已修复、已加守卫；**已从用户 profile 移除**，待用户自行重启确认。
**影响**：DSH Desktop 无法打开（窗口起不来）；用户禁用第三方插件后才恢复。
**责任**：本插件（探针包 `dsh-split-probe`）的构建产物格式错误。

## 1. 现象与证据

应用自带日志：`%APPDATA%\@deepseek-ai\dsh-desktop\logs\crash-2026-10-15T12-44-07-424Z-web-boot.log`
（另一份 `…12-44-28-778Z-web-boot.log` 同因）：

```
Error: web boot: 1 entry did not activate
dsh-split-probe: import failed (see console for the import error)

--- renderer console (error level) ---
dsh-app://app/plugins/??…,dsh-split-probe/client.js,…&rev=…:35635 Uncaught ReferenceError: require is not defined
dsh-app://app/plugins/??dsh-split-probe/client.js&rev=1726ff1bf90c:18866 Uncaught ReferenceError: require is not defined
```

（`~\.dsh\logs` 下只有 2026-10-10 的旧日志，与本事故无关；该目录不是桌面端启动日志的落点。）

## 2. 根因

**客户端半边必须自己把自己注册进模块加载器**。加载器把 `client.js` **原样**服务给浏览器，`require`/`module`/`exports`
只存在于这层工厂闭包里（见 `dsh-client-modules/lib/client.js:3-6` 的模板与本仓库旧产物 `lib/client.js:1-6`）：

```js
window.__ModuleLoader__.load({
  id: 'dsh-split',
  factory: (require) => {
    var module = { exports: {} }
    var exports = module.exports
    … 模块体 …
    return module.exports
  },
})
```

探针的 esbuild 产物**没有这层外壳**（`__ModuleLoader__` 命中 0），于是浏览器按 ES module 求值，
第一个 `require("react")`（产物第 18866 行）抛 `require is not defined` → 条目激活失败 →
web boot 要求**每个条目**都激活 → 整个窗口打不开。

## 3. 修复

1. `probe/build.mjs` 的 esbuild 配置增加 `banner`/`footer`，产出与旧产物同形的工厂外壳
   （`format: 'cjs'` + `external: ['react']` 不变，React 仍不打包）。
2. 产物核对：头部第 5-8 行为 `window.__ModuleLoader__.load({ id: 'dsh-split-probe', factory: (require) => { … }`，
   尾部 `return module.exports } })`；`exports.apply` 与 `require("react")` 各 1 处。
3. **守卫**：`probe/tools/probe-dry-run.mjs` 现在先从产物里取 `__ModuleLoader__.load` 记录并断言
   `{id, factory}` 存在（"the bundle registers itself with the module loader"），缺少外壳即红 —— 这类事故不会再静默通过。

## 4. 顺带修掉的两个探针缺陷（同一轮空跑发现）

1. 面板用 `props.ctx`，而 `ctx` 从未作为 prop 传入（它在 `face.ctx` 上）→ 真机上每个动作都会崩。
2. `face.setCopy` 被面板的 React setter 覆盖、而 `face.copy()` 读另一个变量 → 卸载动作看不到副本，
   **副本永远不会卸载**（等于在真机上留下第二份可编辑呈现，违反 F12）。现在 `apply` 持有唯一真源，
   面板只发布自己的 setter（`face.attachCopyState`）。

## 5. 环境恢复（本次已执行，待用户重启确认）

| 项 | 处理 |
| --- | --- |
| profile `dependencies` / `dsh.profile.bundles` | 从事故前备份恢复：`dsh-chat`、`dsh-split` 保留；**探针条目已移除** |
| `node_modules\dsh-split-probe` junction | 已删除（原目标 `E:\dsh-plugin\dsh-split\probe`） |
| profile `cordis.patch.yml` | **未改动**（那是用户自己的设置层；应用在 20:48 自行重写过，见 §6） |
| 备份文件 | `package.json.bak-probe-20261015-195813`（目录内保留） |

## 6. 观察（非本插件所为，供用户判断）

`~\.dsh\profiles\desktop\cordis.patch.yml` 现为 750 B（20:48），而 19:13 的备份为 1780 B：
当前版本缺少 `llm-pi-ai`（自定义本地模型 provider，`http://172.26.0.49:8000/v1`）与 `agent-default-model` 行，
UI 偏好也不同（`transcriptView: standard`、账号步骤 `done`）。本插件从未写过该文件；请确认这些设置是否符合预期。

## 7. 后续铁律（写进 P1 构建契约）

1. 客户端产物**必须**自带 `window.__ModuleLoader__.load({ id, factory })` 外壳；构建脚本负责生成，dry-run 守卫负责拦截。
2. 任何要加入用户 profile 的东西，必须**先经用户明确同意**、先备份、先过 dry-run 与守卫，再由用户自己重启。
3. 不再有"先加上去试试"的步骤。

## 8. 追加：第二次启动失败的另一半根因（同日 22:30 / 次日修复）

外壳修好之后，探针仍让 web boot 失败，日志只给出一句 `dsh-split-probe: failed`（import 成功、**激活**失败）。
为拿到原因，探针加了一个**不依赖插槽的降级面板**（纯 DOM，任何注册失败或 React 面板 3 秒未上屏即出现，并把失败原因印在面板上）。
用户在应用里跑出来的原因：

```
shell.overlay 面板: cannot get property "slots" without inject
probe.copy 子槽:    cannot get property "slots" without inject
main 键位:          cannot get property "slots" without inject
```

**根因**：Cordis 要求插件在 `inject` 里声明它要访问的每个服务，否则 `ctx.<service>` 直接抛
`cannot get property "…" without inject`。探针的客户端半边只导出了 `apply`，**漏了 `inject`** ✗
（可正常工作的旧插件在 `lib/client.js:2409-2411` 声明了
`['slots','sessions','layout','uiSession','uiWorkspace','sidebarRight','locale','shortcuts']`）。

**修复**：探针导出 `exports.inject = ['slots','sessions','layout','uiSession','uiWorkspace','sidebarRight']`
（只声明实际用到的六个，避免"声明了不存在的服务"反而无法激活）。

**新增守卫**：空跑现在用**模拟 Cordis 的严格上下文**激活插件 —— 一个 Proxy，凡访问未在 `inject` 中声明的
服务就抛与宿主相同的错误；同时断言 `inject` 覆盖了 `slots`/`sessions`/`layout`。这类缺陷从此在本地即红。

**经验（写进 P1 契约）**：客户端插件的导出形状 = `{ inject: [...], apply(ctx) }`；`inject` 漏项不是降级而是
**激活失败**；任何"激活期访问的服务"都必须在名单里，访问得晚（如发现类探针）也要么声明、要么按访问逐条 try/catch。
