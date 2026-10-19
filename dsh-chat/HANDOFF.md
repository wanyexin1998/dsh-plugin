# 交付说明 / Handoff — `dsh-chat`

> 自研 DSH 插件：用一条悬浮的 **〔工作 | 聊天〕** 切换条，把 **DeepSeek Chat 网页版嵌在应用内**打开
> （不是弹窗、不是外部浏览器）。零运行时依赖：宿主半边 ESM + 客户端半边手工 CJS 闭包，无构建步骤。
>
> 思路参考了社区插件 [`dsh-deepseek-chat`](https://github.com/heshuren371/dsh-deepseek-chat)，代码、协议与安全模型均为独立实现。

---

## 1. 当前状态

| 项目 | 值 |
| --- | --- |
| 插件名 | **`dsh-chat`**（旧名 `dsh-deepseek-chat-bridge`，已全量改名） |
| 仓库 | `E:\wyx_code\dsh-deepseek-chat-bridge` —— **目录名待改**，见 §6.1 |
| desktop profile | 依赖 `"dsh-chat": "link:E:/wyx_code/dsh-deepseek-chat-bridge"`；patch 行 `id: dsh-chat` / `name: 'dsh-chat'` |
| 测试 profile | `chatbridge-test`，同样已改为 `dsh-chat` |
| profile 联接 | `profiles\<profile>\node_modules\dsh-chat` → 仓库目录 |
| 备份 | 两个 profile 的 `package.json` / `cordis.patch.yml` 旁各有 `.bak-dshchat` |
| 使用说明 | [README.md](README.md) |
| 历史审计 | [docs/VERIFICATION.md](docs/VERIFICATION.md)（针对旧命名的修订版） |
| 代理可行性原始证据 | [experiments/PROXY-EVIDENCE.md](experiments/PROXY-EVIDENCE.md) |

**要让它生效：完全退出 DSH 再打开。** 宿主半边的路由只在启动时注册；这个壳的安装版也**没有**"刷新页面"入口（`Ctrl+R` / `F12` 都不响应），所以客户端半边同样需要重启应用。

## 2. 它做了什么

- **〔工作 | 聊天〕悬浮切换条**：`shell.overlay` 里的单例。**不占布局** —— 页面保持原始尺寸，条浮在窗口 chrome 带下方 40px 高的区域里。
- **右侧边栏的 DeepSeek Chat 标签页**：用 shell 公开的 `ctx.sidebarRightTabs.register()` 注册**一种自己的 tab 类型**（内置「浏览器」tab 用的就是同一套契约），再按插件 id 注册内容槽与标题槽。打开后网页版直接嵌在右侧栏里，不用输网址。
- **右栏空状态里的 DeepSeek Chat 卡片**：右栏没有标签页时，壳列出每种 tab 类型的一张卡片（内置 工作区文件 / 新建终端 / 浏览器）。本插件用 tab 定义的 `guide` 字段登记自己的卡片与图标组件，由壳的卡片渲染与派发 —— 不复制卡片样式，因此天然与内置行一致。
- **打开标签页的入口**：① 右栏空状态里的卡片；② 左栏底部（设置上方）的 **DeepSeek Chat** 动作。同一会话重复打开只聚焦已有的那一个（`multiple: false`）。**需要先有会话** —— 右栏是按会话渲染标签页的。
- **悬停展开、移开收起**：默认收起，只露出一个指向下的小箭头；指针**落在控件矩形内**淡入展开，离开淡出（140ms）。**箭头只在收起时出现**，展开后退场。整条横带不拦截任何输入——没有 `pointer-events`，也**不在 `-webkit-app-region` 的原生拖拽区内**（原生命中区会先于页面吞掉点击，`pointer-events` 挡不住）。窗口由 shell 的标题栏拖动。
- **切到「聊天」**：整窗接管，iframe 铺满，渲染**真正的** `chat.deepseek.com`（经本机 loopback 反代，剥掉 `frame-ancestors 'none'` 等阻止嵌框的响应头）。
- **切回「工作」**：覆盖层 `visibility:hidden`，**iframe 不销毁** —— 草稿、滚动位置、会话状态都保留。
- **⟳ / ↗**：重新导航帧内页面 / 用一次性票据在独立浏览器窗口打开同一个已授权会话；面板与标签页共用同一个 `BridgeFrame` 与同一个外开函数。
- **焦点隔离**：接管期间给 shell 的大块同级子树加 `inert`；切换条自身永不被 `inert` 命中。

## 3. 这一版修掉的关键缺陷（都有实测证据）

| # | 缺陷 | 症状 | 修法 |
| --- | --- | --- | --- |
| 1 | 会话 cookie 是 `SameSite=Lax` | 面板是**跨站 iframe**（桌面渲染器源为 `dsh-app:` scheme），Chromium 把 Lax cookie 当第三方丢弃 → `bridge: no-session` | 改为 `SameSite=None; Secure; HttpOnly`（`Secure` 在 loopback 上被 Chromium 视为可信） |
| 2 | 转发上游响应头时 `set-cookie` 被**整体覆盖** | 刚下发的会话 cookie 被上游自己的 cookie 冲掉，等于没下发 | 改为**追加合并** |
| 3 | iframe 导航被 302 去掉 token | 302 之后那条腿既无 token 又无 cookie → 403 | 带 token 的 **iframe 导航直接 200**，token 留在 URL；另加导航标记兜底 |
| 4 | 帧内请求依赖 cookie | 守卫脚本覆盖不到浏览器自发的 favicon / manifest 请求 | 在文档里把这两类引用改写成带 token 的 URL |
| 5 | ⟳ / ↗ 落在 `-webkit-app-region: drag` 区域 | Electron 吞掉点击 → 按钮"点了没反应" | 条保留 `drag`（窗口可拖），**条内每个控件显式 `no-drag`** |
| 6 | 切换条标签读 shell 主题 token | 深色模式下标签是近白色，落在白色滑块上**看不见** | 标签改用固定色；对比度实测 17.94:1 / 7.44:1，三态一致 |
| 7 | 重构漏改 `openOutside` 引用 | 组件一渲染就 `ReferenceError`，控件直接消失 | 修复，并加了逐标识符的未使用声明扫描工具 |
| 8 | 重开面板时 iframe `src` 不变 | 渲染器复用旧的**失败页**，怎么点都是那句错 | URL 带 nonce，每次打开强制重新导航 |

## 4. 关于"直接引用 desktop 登录的账号"——重要的实话

**做不到。** desktop 的登录态是一份 **Platform 授权**（issuer `https://platform.deepseek.com`），不是 chat 授权。实测按 `Authorization: Bearer` / `Cookie: userToken=` / `x-dsh-auth-token` 三种方式送给 chat，分别得到 `40003 invalid token` 与 `40002 Missing token`；对 `app.asar` 做全量字节扫描**从未出现** `chat.deepseek.com` 字样。

所以实际形态是：**在面板里登录一次，长期有效** —— 面板会话属于 loopback 源，登录态存在浏览器对该源的存储里，切换与重启都还在。反向代理只做转发，**不持有任何凭据**。

（早期版本曾在切换条上显示 desktop 账号与余额。你后来要求去掉，现已连同宿主的 `/api/account` 路由、`lib/account.js` 与 `accountTimeoutMs` / `platformOrigin` / `credentialsPath` 配置项一并删除。）

## 5. 验证（本机实测）

| 用例 | 结果 | 覆盖 |
| --- | --- | --- |
| `node tests/verify-ui.mjs <gui> <token>` | **33/33** | 真实 headless Edge + 真实鼠标事件 |
| `node tests/unit-guard.mjs <gui> <token>` | **45/45** | 注入的请求守卫、iframe 直发 200、cookie 属性、无 cookie 的标记腿 |
| `node tests/verify-strip-hit-area.mjs <gui> <token>` | **10/10** | 命中范围就是控件本身；整行其余位置不拦截鼠标；**行内没有任何元素占用原生拖拽区** |
| `node tests/verify-guide-entry.mjs <gui> <token> [shot]` | **11/11** | 右栏空状态的卡片：出现、带标题与描述、有自己的图标、点击后标签页打开且文档 200 |
| `node tests/verify-sidebar-tab.mjs <gui> <token> [shot]` | **9/9** | 右栏标签页端到端：入口存在可点 → 点击后标签页出现 → 内容槽渲染 → iframe 指向桥接地址且文档 200 → 无 403、无控制台错误 |
| `node tests/unit-host.mjs [port]` | **41/41** | 宿主半边直连真实上游 |
| `node tests/unit-upstream.mjs` | **8/8** | 自建受控上游 |
| `node tests/check-tagged-references.mjs` | **5/5** | favicon / manifest 引用带 token 且 200 |
| `node tests/verify-switch-readability.mjs <gui> <token>` | 两种主题全部通过 | 计算真实对比度（含半透明轨道合成） |
| `node tests/verify-external-window.mjs <gui> <token>` | 通过 | ↗ 路径端到端 |

截图：`docs/screenshots/`。可用 `node tools/screenshots.mjs <gui> <token> <outDir>` 重新生成。

## 6. 你还需要做的

### 6.1 删掉旧目录副本（已完成镜像与切换，只剩删除）

仓库已经是 `E:\dsh-plugin\dsh-chat`：**逐文件 SHA256 比对一致**（40 文件、0 不一致），两个 profile 的联接与 `link:` 路径都已指向它，并已从新路径跑通全部门禁。

旧目录 `E:\wyx_code\dsh-deepseek-chat-bridge` 改名失败（`Access to the path ... is denied`）——不是联接造成的（拆掉联接重试仍被拒），而是**运行中的应用持有插件文件的句柄**，应用内部无法释放。所以改成"镜像 + 切联接"，旧目录留作副本。**完全退出 DSH 后删掉它**：

```powershell
Remove-Item -LiteralPath 'E:\wyx_code\dsh-deepseek-chat-bridge' -Recurse -Force
```

删之前可确认新仓库就是真身：`E:\dsh-plugin\dsh-chat`，profile 已全部指向它。

### 6.2 重启 DSH

**完全退出应用再打开**，新名字、右侧栏标签页与本轮所有修复才会生效（这个壳的安装版没有刷新入口）。

## 7. 已知限制（结构性，改代码解决不了）

- **微信扫码 / Apple 登录不可用**：`redirect_uri` 必须是微信 / Apple 后台登记过的域名，loopback 源永远无法满足。
- **面板内 Google 等第三方登录不可用**：对方同样禁止被嵌框；需要时用 ↗ 在独立窗口打开。
- **语音 / TTS 不可用**：走 `wss://<当前 host>/api/v0/chat/tts/`，http loopback 上建不起来。
- **⟳ 回到 chat 首页**，不保留当前对话路由（跨源读不到帧内路由）。
- 切换条的悬停区域只在**控件自身矩形**内生效（约 184×42）；该矩形之外的整行都不拦截鼠标。矩形正下方的应用元素仍会被盖住。窗口**不能**从这一行拖动，用上方标题栏。
- 接管期间被盖住的 DSH 界面不可见、不可交互（已 `inert` 隔离）；需要审批或设置时先点「工作」。
- 面板内创建的 chat 会话存在浏览器对 loopback 源的存储中；清理浏览器数据需要重新登录一次。
- **卡片不显示快捷键**：第三方插件注册的快捷键不进壳的快捷键目录（实测：`ctx.shortcuts.register` 不报错，但卡片的 `aria-keyshortcuts` 为空、按下该组合键也不生效），所以卡片不承诺一个按不响的键。
- **右侧栏标签页需要先打开一个会话**：此壳按会话渲染标签页，没有会话就没有地方安放它。左栏底部的入口在这种状态下点击不生效，且页脚没有位置显示原因（结果写在按钮自身的 `data-bridge-open-tab` 上，供排查）。

## 8. 安全模型

- 反代**只监听 `127.0.0.1`**，绝不暴露到局域网。
- 每次启动生成 256 位随机 token；授权三条路都需要凭据：会话 cookie（`HttpOnly; SameSite=None; Secure`）、URL 里的 `?__bridge_session=`、或由它种下的 `?__bridge_nonce=` 导航标记（有界 LRU，最多 64 条）。无凭据一律 `403`。
- **故意不按 `Sec-Fetch-Site: cross-site` 拒绝**：桌面渲染器的源是 `dsh-app:` scheme，浏览器会把插件自己合法的 framed 导航标成 `cross-site`，按这个头拒绝会让桌面端每次启动都打不开面板；安全性由上面三条凭据保证。
- 插件**从不返回、从不打印**任何凭据；上游 `set-cookie` 会被清洗（去 `Domain` / `Secure` / `Partitioned`，`Strict` 降 `Lax`）并与插件自己的 cookie **合并**。
- 帧内 `fetch` / `XMLHttpRequest` 由注入的守卫自动带上 token（跨源请求与 `WebSocket` 不动）。
- `/__bridge/health` 只回 `{ok, upstream, port}`，不含凭据，也不转发上游。
- 剥 CSP 是让嵌框可行的必要手段，仅限 loopback 使用。

## 9. 维护要点

- `lib/client.js`：手工 `window.__ModuleLoader__.load({ id, factory })` 闭包，`require` 只用于平台模块表的 `react`。**注册 id 必须等于包名**，否则宿主不会把浏览器半边挂到那一行 Loader entry。
- `lib/index.js` / `bridge-proxy.js` / `config.js` / `shared.js`：普通 ESM，零依赖。插件**不导出 `Config` schema**（会导致 Cordis 报 `Cannot read properties of undefined (reading 'validate')`），配置由 `lib/config.js` 自行规范化。
- 客户端 `inject = ['slots', 'locale', 'sidebarRight', 'sidebarRightTabs']`。后两个是右侧栏标签页的注册表与控制器，与内置「浏览器」tab 同一套公开服务。
- **槽位 `inject` 回调的返回值会展开成组件 props**（没有 `hooks` 之类的包裹层）。写错会读到 `undefined`，该 seat 组件抛错后控件整体消失——这是本次开发中真实踩到的坑，症状是"按钮/入口不见了"。
- 右侧栏标签页的槽位按 **tab 类型的 `id`** 派发（`entryKey = definition.id`），所以注册 id、`kind` 与两个槽的 `key` 必须一致。
- 引导卡片的图标由 tab 定义的 `guide[].icon` 提供，壳按 `<Icon size className>` 调用它 —— 只画图标、不复刻卡片，是这里最稳的做法。
- 工具：`node tools/screenshots.mjs <gui> <token> <outDir>`、`node tools/find-dead-code.mjs <file> ...`、`node tools/diag-sidebar-right.mjs <gui> <token>`（右栏控件 + 本插件类型登记情况）、`node tools/diag-icon-stack.mjs <gui> <token>`（命中元素与祖先链）。
- 宿主半边改动 → 重启 DSH；客户端半边改动 → 刷新页面（此壳安装版无刷新入口，实际也要重启）。
- 排查面板问题时，设 `DSH_BRIDGE_TRACE=<文件路径>`，反代会把每条请求（是否带 token / cookie / 标记、`sec-fetch-*`、响应状态）写成 JSONL。默认关闭。
