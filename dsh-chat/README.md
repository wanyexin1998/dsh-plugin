# dsh-chat

在 DeepSeek Harness（DSH）GUI 里一键切换到 **DeepSeek Chat 网页版**——网页版**嵌在应用内**显示，不是弹出浏览器窗口。

自研实现。思路参考了社区插件 [`dsh-deepseek-chat`](https://github.com/heshuren371/dsh-deepseek-chat)（loopback 反代 + 整窗接管），代码、协议与安全模型均为独立设计与实现。

---

## 1. 它做了什么

| 能力 | 实现方式 |
| --- | --- |
| 〔工作 \| 聊天〕悬浮切换条 | 挂在 shell 的 frame-wide overlay slot（`shell.overlay`）。**不占布局**：页面保持原始尺寸，条浮在窗口 chrome 带下方 |
| **右侧边栏的 DeepSeek Chat 标签页** | 用 shell 公开的 `ctx.sidebarRightTabs.register()` 注册一种**自己的 tab 类型**（内置「浏览器」tab 走的就是这套契约），内容槽与标题槽按插件 id 派发。打开后网页版直接嵌在右侧栏里，不需要输网址 |
| **右栏空状态里的 DeepSeek Chat 卡片** | 右栏没有任何标签页时，壳会列出每种 tab 类型的一张卡片（内置是 工作区文件 / 新建终端 / 浏览器）。本插件通过 tab 定义的 `guide` 字段登记自己的卡片与图标，由壳的卡片渲染，点击即在该会话打开标签页 |
| 打开标签页的入口 | ① 右栏空状态里的上述卡片；② 左栏底部（设置旁边）的 **DeepSeek Chat** 动作。同一会话重复打开只聚焦已有的那一个（`multiple: false`） |
| 悬停展开 / 移开收起 | 默认收起，只露出一个指向下的小箭头；指针**落在控件矩形内**即淡入展开，离开即淡出。整条横带**不拦截任何输入**：既没有 `pointer-events`，也**不在原生拖拽区内**（`-webkit-app-region` 是原生命中区，会先于页面吞掉点击，`pointer-events` 挡不住它）。窗口改由 shell 自己的标题栏拖动 |
| 切到「聊天」 | 整窗接管：覆盖层盖住三列，iframe 铺满，渲染**真正的** chat.deepseek.com |
| 切回「工作」 | 覆盖层 `visibility:hidden`，**iframe 不销毁**（草稿、滚动位置、会话状态都保留） |
| ⟳ 刷新 | 重新导航 iframe（等价于对该面板按 Cmd+R）；面板与标签页共用同一个 `BridgeFrame` |
| ↗ 外开 | `/api/ticket` 签发一次性票据，可在普通浏览器窗口中打开同一个已授权会话 |
| 键盘/焦点隔离 | 接管期间给 shell 的大块同级子树加 `inert`，隐藏的 DSH 界面不会误触；切换条本身不在 `inert` 内 |

> 右侧栏的标签页与整窗接管是**两条独立的入口，共用同一套桥接**：标签页适合"边干活边聊"，整窗接管适合专心聊。

**为什么需要本地反代**：`chat.deepseek.com` 返回 `content-security-policy: frame-ancestors 'none'`，浏览器不允许任何站点用 iframe 嵌它。插件因此在本机 loopback 起一个只监听 `127.0.0.1` 的反向代理，转发整个域并剥掉阻止嵌框的响应头；首屏 HTML 还会去掉两个 `<script>` 上的 `integrity` / `crossorigin`——CDN 只放行 `*.deepseek.com` 系 Origin，带上它们页面必然白屏（`src` 与 `onerror` 原样保留，字节不变）。

**为什么连静态 CDN 也一起代理**：网页版的字体（woff2）与 opus 解码 wasm 是以 CORS 模式从 `fe-static.deepseek.com` 取的，而该 CDN 对 loopback Origin 回的是 `access-control-allow-origin: https://*.deepseek.com` —— 一个永远匹配不上的字面量，于是字体被拒、控制台一片红。脚本和样式表能活下来只是因为上面的属性剥离让它们变成 no-cors，字体与 `fetch()` 的 wasm 无法这样救。插件因此把静态源也挂到同一个 loopback 源下的 `/__bridge_static/`，并把 HTML、JS、CSS 里的绝对 CDN 引用改写过去，让 CORS 检查根本不再发生。

## 2. 关于"复用 desktop 登录的账号"

**结论：做不到，插件不假装做得到。**

- desktop 的登录态是一份 **Platform 授权**（`.credentials.yaml` 里的 `deepseek-account-platform/default`，issuer 为 `https://platform.deepseek.com`），官方通过 `x-dsh-auth-token` 请求头回放给 Platform。
- **它不是 chat 授权。** chat 网页版的鉴权是它自己的 token（`localStorage["userToken"]`，以 `Authorization: Bearer` 发出）。实测把 desktop 授权按 `Authorization: Bearer` / `Cookie: userToken=` / `x-dsh-auth-token` 送给 chat，分别得到 `40003 invalid token` 与 `40002 Missing token`；对 app.asar 做全量字节扫描，**从未出现** `chat.deepseek.com` 字样——机器上不存在任何可拷贝的 chat 登录态。
- 所以实际做法是：**在面板里登录一次，长期有效**。CHAT 面板的会话属于 loopback 源（`http://127.0.0.1:<port>`），登录态存在浏览器对该源的存储里，切来切去、重启 DSH 都还在。反向代理只做转发，**不持有任何凭据**。
- 如果你手里有真实的 chat `userToken`，可以用 `seed` 配置在页面启动前注入（见 §4）。

## 3. 安装

前提：DSH 已安装并能打开 GUI；本插件源码位于 `E:\dsh-plugin\dsh-chat`。

### 3.1 装进 desktop profile（本机 GUI 用的就是这个）

```powershell
$dsh = 'E:\deepseek-harness\resources\runtime\cli\bin\dsh.cmd'
& $dsh plugin --profile desktop add link:E:/dsh-plugin/dsh-chat
```

手动等价做法（`link:` 装好后插件目录不能移动/删除）：

1. 在 `C:\Users\wanyexin\.dsh\profiles\desktop\package.json` 的 `dependencies` 里加
   `"dsh-chat": "link:E:/dsh-plugin/dsh-chat"`；
2. 在 `C:\Users\wanyexin\.dsh\profiles\desktop\cordis.patch.yml` 末尾追加：

   ```yaml
   - insert:
       - id: dsh-chat
         name: 'dsh-chat'
         config:
           port: 0
   ```

3. 让 profile 的 `node_modules` 里出现该包（`pnpm install`，或用目录联接指向插件目录）。

**重启 DSH**（宿主半边的新路由只在启动时注册）。客户端半边随页面刷新即生效——但注意：这个壳在安装版里**没有**"刷新页面"菜单项，也不响应 `Ctrl+R` / `F12`，所以客户端改动同样要重启应用才生效。

### 3.2 只验证、不动你的 profile

复制 `profiles\desktop` 为另一个 profile（例如 `profiles\dsh-chat-test`），把插件链接进去，然后

```powershell
& $dsh --profile dsh-chat-test --port 19390
```

浏览器打开启动日志里打印的 `http://127.0.0.1:19390/?token=...` 即可。测试实例与正在使用的 desktop 实例互不影响（不同端口、不同 profile）。

> 注意：`--profile <name>` 后面直接跟 `--port`；`dsh --profile x web --port y` 会被 CLI 判为多余参数。

## 4. 配置

插件**不导出 `Config` schema**（刻意零运行时依赖），配置由 `lib/config.js` 自行规范化，非法值会明确抛错。

| 键 | 默认值 | 说明 |
| --- | --- | --- |
| `target` | `https://chat.deepseek.com` | 被镜像的上游源 |
| `port` | `0` | 反代监听端口；`0` = 让系统分配。默认会先试一个由 `$DSH_HOME` 派生的稳定端口（34000–34899），占用则回落随机端口 |
| `seed` | `{}` | 注入到被代理页面 `localStorage` 的键值（页面自身脚本执行前写入） |
| `startInChat` | `false` | 加载时直接落在「聊天」页；`false` = 落在「工作」页 |

## 5. 安全模型

- 反代**只监听 `127.0.0.1`**，绝不暴露到局域网。
- 每次启动生成 256 位随机会话令牌。授权有三条路，都需要凭据：
  1. `HttpOnly; SameSite=None; Secure` 的会话 cookie（每次启动新生成）；
  2. URL 里的 `?__bridge_session=<token>`；
  3. 由 (2) 种下的 `?__bridge_nonce=<marker>` 导航标记（有界 LRU，最多 64 条）。
  没有凭据的本机进程只会拿到 `403`。
- **为什么 cookie 是 `SameSite=None`**：面板是**跨站 iframe**（桌面渲染器的源是 `dsh-app:` scheme，与 loopback 源不同 site），`SameSite=Lax` 的 cookie 在那里会被 Chromium 当第三方 cookie 丢弃。实测追踪：首条带 token 的导航 `hasToken:true`，302 之后那条 `hasCookie:false` → `bridge: no-session`。
- **为什么 iframe 导航不再 302**：带 token 的 iframe 导航直接 `200` 下发文档、token 留在 URL 里，这样即使 cookie 被丢也仍然有凭据。非 iframe 的普通浏览器导航仍走 302，把 token 从地址栏去掉。
- **故意不按 `Sec-Fetch-Site: cross-site` 拒绝请求**：桌面渲染器的页面源是 `dsh-app:` scheme，浏览器会把插件自己合法的 framed 导航标成 `cross-site`；按这个头拒绝会让桌面端每次启动都打不开面板。安全性没有损失——真正的栅栏是上面那三条凭据。
- **帧内请求自带授权**：交给浏览器的文档顶部注入一段引导脚本，帧内**同源**的 `fetch` / `XMLHttpRequest` 自动带上本次启动的 token（跨源请求与 `WebSocket` 不动）。文档里浏览器**自己发起**的引用（favicon、web-app manifest）不经过任何脚本，因此在文档里就被改写成带 token 的 URL。
- `/__bridge/health` 只回 `{ok, upstream, port}`，不含任何凭据，也不转发上游。
- 插件**从不返回、从不打印**任何凭据。上游响应头里 `set-cookie` 会被清洗（去掉 `Domain` / `Secure` / `Partitioned`，`SameSite=Strict` 降为 `Lax`），且与插件自己的 cookie **合并**而不是覆盖。
- 剥 CSP 是让嵌框可行的必要手段，仅限 loopback 使用。

## 6. 已知限制

- **微信扫码登录不可用**（结构性问题）：网页版的微信登录用微信自己的 `WxLogin` 组件（脚本来自 `open.weixin.qq.com`），`redirect_uri` 必须是微信后台登记过的域名；loopback 源永远无法满足，所以二维码位置会显示"redirect_uri 参数"。**Apple 登录**同理。请用手机号 / 邮箱验证码登录。
- **"聊天"页内的第三方登录（Google 等）不可用**：对方同样禁止被嵌框。需要别的登录方式时用 ↗ 在独立窗口打开。
- **语音/TTS 不可用**：网页版的 TTS 走 `wss://<当前 host>/api/v0/chat/tts/`，在 http loopback 上无法建立。
- 接管期间被盖住的 DSH 界面不可见、不可交互（已被 `inert` 隔离），需要审批或设置时先点「工作」。
- ⟳ 刷新回到 chat 首页，不保留当前对话路由（跨源读不到 iframe 的路由）。
- 面板内创建的 chat 会话存在浏览器对 loopback 源的存储中；清理浏览器数据会需要重新登录一次。
- 切换条的悬停区域**只在控件自身矩形内**生效（约 184×42），该矩形之外的整行都不拦截鼠标；矩形正下方的应用元素仍会被它盖住。
- 右侧栏的标签页与卡片**需要先打开一个会话**：shell 按会话渲染标签页，没有会话就没有地方安放它。这种情况左栏底部的入口点不动（页脚无位置显示原因），结果写在按钮自身的 `data-bridge-open-tab` 上。
- 卡片**不显示快捷键**：第三方插件注册的快捷键不会进入壳的快捷键目录（实测：注册不报错但卡片 `aria-keyshortcuts` 为空，且按下该组合键不会打开标签页），所以卡片不承诺一个按不响的键。

## 7. 实测结论（本机）

| 用例 | 结果 | 覆盖 |
| --- | --- | --- |
| `node tests/verify-ui.mjs <gui> <token>` | **33/33** | 真实 headless Edge + 真实鼠标事件：悬浮条不占布局、收起只露箭头、悬停展开、箭头在展开后隐藏、拖拽区/点击区分离、点「聊天」挂载代理文档、点「工作」返回、无控制台错误 |
| `node tests/unit-guard.mjs <gui> <token>` | **45/45** | 注入的请求守卫：同源请求带 token、跨源与非 http 不动、幂等；iframe 导航直接 200；`SameSite=None; Secure; HttpOnly`；无 cookie 的标记腿仍被放行而未种下的标记一律 403 |
| `node tests/verify-strip-hit-area.mjs <gui> <token>` | **10/10** | 命中范围就是控件本身：控件左右两侧的行内位置不展开条、元素命中测试落在应用自己的节点上，控件自身才展开，移开即收起；**行内没有任何元素占用 `-webkit-app-region` 拖拽区** |
| `node tests/verify-guide-entry.mjs <gui> <token> [shot]` | **11/11** | 右栏空状态：卡片真的出现、带标题/描述/自己的图标、内置三张卡片仍在、点击后标签页打开且桥接文档 200、无 403、无控制台错误 |
| `node tests/verify-sidebar-tab.mjs <gui> <token> [shot]` | **9/9** | 右侧栏标签页：左栏底部入口存在且可点；点击后标签页真的出现、内容槽渲染、iframe 指向桥接地址且文档 200、无 403、无控制台错误 |
| `node tests/unit-host.mjs [port]` | **41/41** | 宿主半边直连真实上游：配置校验、信任栅栏、cookie/Location 重写、去 integrity/crossorigin、静态源同源化、CSS 字体改写、脚本改写、上游链路复用 |
| `node tests/unit-upstream.mjs` | **8/8** | 自建受控上游：按配置拨号协议与端口、POST 逐字节一致、绝对 Location 改写、404 透传、set-cookie 清洗 |
| `node tests/check-tagged-references.mjs` | **5/5** | 文档里的 favicon / manifest 引用确实带上 token 且返回 200，去掉 token 则 403 |
| `node tests/verify-switch-readability.mjs <gui> <token>` | **两种主题** | 计算真实对比度（含半透明轨道合成）：选中标签 17.94:1、未选中 7.44:1，在"原样 / prefers-dark / data-theme=dark"三态一致 |
| `node tests/verify-external-window.mjs <gui> <token>` | **通过** | ↗ 路径端到端：签发票据 → 打开 → cookie 存下 → 页面是 DeepSeek |

截图：[docs/screenshots/panel-chat.png](docs/screenshots/panel-chat.png)（面板态）、[sidebar-tab.png](docs/screenshots/sidebar-tab.png)（右侧栏标签页）、[arrow-collapsed.png](docs/screenshots/arrow-collapsed.png)（收起态只露箭头）、[panel-conversation.png](docs/screenshots/panel-conversation.png)、[switch-zoom.png](docs/screenshots/switch-zoom.png)。

历史审计档案：[docs/VERIFICATION.md](docs/VERIFICATION.md)（两位独立验证者的对抗式报告，针对早期命名 `dsh-deepseek-chat-bridge` 的修订版）。

## 8. 开发

- `lib/client.js` 是手工编写的 `window.__ModuleLoader__.load({id, factory})` CJS 闭包，`require` 只用于平台模块表里的 `react`；**不需要打包器**。注册 id 必须等于包名（`dsh-chat`），宿主才会把它的浏览器半边挂到那一行 Loader entry 上。
- `lib/index.js` / `bridge-proxy.js` / `config.js` / `shared.js` 是普通 ESM，零依赖；插件**不导出 `Config` schema**，配置由 `lib/config.js` 自行规范化。
- 客户端声明 `inject = ['slots', 'locale', 'sidebarRight', 'sidebarRightTabs']`：前两个用于 overlay 与文案，后两个是右侧栏标签页的注册表与控制器（与内置「浏览器」tab 用的是同一套公开服务）。
- 槽位的 `inject` 回调**返回值会展开成组件 props**，没有 `hooks` 之类的包裹层；写错会读到 `undefined` 并让该 seat 崩溃（表现为控件整个消失）。
- **`-webkit-app-region` 是原生命中区**：给覆盖层声明 `drag` 会在页面收到事件之前吞掉点击，`pointer-events: none` 对它无效。这个插件的条因此完全不碰拖拽区——否则它会吃掉应用右上角那排控件（分栏 / 全屏 / 收起右侧栏）的点击。
- 工具：
  - `node tools/screenshots.mjs <gui> <token> <outDir>` —— 抓全部交付截图。
  - `node tools/diag-icon-stack.mjs <gui> <token>` —— 打印条上各控件的矩形、命中元素与其祖先链（排查"按钮点不到"这类遮挡问题）。
  - `node tools/diag-sidebar-right.mjs <gui> <token>` —— 列出右栏所有可见控件，并用壳自己的「新标签页」入口检查本插件的类型是否被登记（排查标签页不出现的问题）。
  - `node tools/find-dead-code.mjs <file> ...` —— 报告声明了却从未再被引用的标识符（逐文件统计，避免跨文件同名误报）。
  - `node tools/proc-env.mjs` —— 查看进程环境（排查宿主启动参数）。
- 宿主半边改动需要重启 DSH；客户端半边改动刷新页面即可（这个壳的安装版没有刷新入口，实际也要重启应用）。

## 9. 卸载

```powershell
& $dsh plugin --profile desktop remove dsh-chat
```

并删掉 `profiles\desktop\cordis.patch.yml` 里的 insert 行，重启 DSH 即彻底移除（反代随宿主退出）。
