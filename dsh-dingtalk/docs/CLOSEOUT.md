# 开发收尾记录

## 2026-11-03 流式反馈与桌面兼容

- 开发分支：`feat/dingtalk-streaming-feedback`，版本 `0.2.0-dev.8`；仅修改 `dsh-dingtalk/`。
- 适配 DSH 当前 `agent/assistant-stream` 事件，共享网关转发 AI Card 与 Thinking / 撤回 / Done，保留旧事件兼容。最终卡片等待在途更新完成；取消、失败或投递失败不显示 Done。
- `doctor --profile NAME --json` 识别指定 Profile 的共享网关，提供脱敏的 Renderer 和 API 诊断。桌面来源 `dsh-app://app` 可正常 bootstrap，保持宿主 owner 校验。
- 本地完整检查：消息侧 359 项通过、51 项平台条件跳过，Web/DWS 54 项通过；格式、类型、敏感内容扫描、安装包与真实 DSH ToolRuntime 作用域验证通过。
- 先验证真实卡片权限和文本增量，再开启测试私聊 aicard 与表情。用户确认即时 🤔、正文实时更新、完成后 🥳 Done 均正常；本轮卡片与表情 API 全部成功，无 Markdown 降级，doctor 通过。
- 群聊仍使用 Markdown，其流式效果尚未验收；桌面来源已通过真实宿主 RPC 验证，尚未单独完成 Electron 窗口全流程验收。详情见 [流式反馈验收](PHASE3.md)。
- 凭据、配置、运行数据及本地日志不纳入提交。完成本地检查后推送当前分支、创建 PR 合并并同步本地 main；GitHub Actions 保持关闭，不发布 NPM。

## 2026-11-03 第三阶段：共享机器人按身份路由

- 开发分支：`feat/dingtalk-phase3-shared-gateway`，基于第二阶段已合并的 `main`；仅修改 `dsh-dingtalk/`。版本 `0.2.0-dev.7`，独立 fork 仍只跟踪官方。
- 一个网关统一接收机器人 Stream，按企业与用户将请求转到本人的 DSH；个人 DWS 授权、模型配置和长期会话留在本机。网页登录身份确认替代 `/bind`，最后完成配对的新设备自动接管，旧设备停止自动重连。
- 本地完整检查通过：消息侧 354 项通过、51 项按平台条件跳过，Web/DWS 52 项通过；格式、类型、敏感内容扫描和安装包校验通过。真实 DSH ToolRuntime 作用域验证、安装包原生设置页登录跳转与取消流程通过。
- 真实网页登录成功；用户已确认共享机器人私聊查询正常、身份正确。按用户要求停止后续真实测试；多人、共享网关群聊、真实双设备切换、模板按钮和附件暂未验收，详见 [第三阶段验收](PHASE3.md)。
- 本地预览服务保留，配置、凭据及运行日志均在仓库外或忽略缓存内。完成本地收尾后推送新分支、创建 PR 合并，再同步本地 main。不使用 GitHub Actions，不发布 NPM。

## 2026-11-03 第二阶段：本人三个入口身份统一

- 开发分支：`feat/dingtalk-phase2-shared-identity`，基于第一阶段已合并的 `main`。本阶段只修改 `dsh-dingtalk/`，独立 fork 继续跟踪官方。
- 版本 `0.2.0-dev.5`：Web、机器人私聊及获准内部群聊复用同一个精确 DWS Profile；保留 owner 绑定、审批及群准入。没有复制 Token、全局切换账号或新增身份映射服务。
- 修复工具前说明混入最终回复，以及重启后绑定会话被网页加载导致机器人静默无回复的问题。后一场景自动建立新 IM 会话，旧历史保留，新会话不继承旧上下文。
- 最终 `pnpm run ci` 通过：342 项消息侧测试通过、51 项按平台条件跳过，52 项 Web/DWS 测试通过；格式、类型、敏感内容扫描和安装包校验通过。真实 DSH ToolRuntime 的 IM 作用域验证通过。
- 隔离安装及真实本机预览验证通过。实际安装代码与构建逐项核验，现有 Web 授权和机器人绑定保留。
- 用户已确认三个入口查询身份一致、Web 断开后 IM 提示重新连接，以及 Web 重连后 IM 无需再次绑定即恢复查询。非 owner 群成员的真实多人测试未进行，对应自动化准入测试通过。详见 [第二阶段验收](PHASE2.md)。
- 本地日志位于 `.cache/migration-20261103/`，运行配置与凭据留在仓库外，不纳入提交。沿用本地收尾、新远程分支、PR 合并、同步本地 main 的交付顺序，不启用 GitHub Actions，不发布 NPM。

## 2026-11-03 第一阶段迁移

### 本地完成

- 大仓库新分支：`feat/dingtalk-official-monorepo`，从 `dsh-plugin/main@6f9c046` 建立。只新增钉钉插件目录及历史方案说明；不改其他插件。
- 官方跟踪目录已回到 `main@137ea79505e6317d98c1db643f0fbae138e016c8`；定制内容备份在 `archive/custom-web-20261103@e05c9fb102cab22d86a14bf1e688bb2b57310d66`。原功能分支保留。
- 迁入全部定制功能、测试、文档、许可证和固定 DWS 目录。排除上游 `.github` 管理文件，不创建 Actions。
- 修复全新检出时类型检查依赖旧生成文件的问题；包元数据改为大仓库子目录，包名和导出不变。
- 预览运行数据移到 `%LOCALAPPDATA%\dsh-dt`，使用短路径避免 Windows 下 pnpm 链接解析失败。按新 Profile 路径重算状态目录名，保留授权、会话和配置。
- 预览服务：`http://127.0.0.1:19877`。已安装大仓库 tarball，关键运行文件与本地构建一致；未认证访问返回 401，启动脚本通过宿主原生入口打开浏览器。无需手填 JSON。
- 原开发源码、构建产物及运行数据保留于本机忽略缓存中；未提交凭据或运行数据。

### 本地验证

- 干净目录依赖安装：`pnpm install --frozen-lockfile` 通过。
- `pnpm run ci` 通过：敏感内容扫描、格式、TypeScript、基础测试 334 通过 / 51 条件跳过、Web 测试 50 通过、tarball 边界检查通过。
- `pnpm run verify:browser` 通过：明暗主题、窄屏、对齐、加载动画、原位授权状态及回复尾部提示。
- 网络恢复后重跑 `npm run verify:dsh-web` 通过：实际 DSH `0.2.1-rc.5` 安装、Web 启动、34 个技能与 1540 命令目录注册、公网 CLI 下载及校验、授权页面跳转、取消后恢复未连接均通过。无改动宿主源码；测试在钉钉授权页面前拦截，未提交真实账号授权。
- 本次没有将真实企业全部业务、真实机器人私聊/群聊或跨入口身份一致性记为验收通过。

本机详细日志位于大仓库 `.cache/migration-20261103/`，不随源码提交。

### 远程交付约定

交付记录：[dsh-plugin PR #18](https://github.com/wanyexin1998/dsh-plugin/pull/18)。两个仓库的 Actions 已通过 API 设置并回读确认为 `enabled: false`；[独立 fork 备份分支](https://github.com/wanyexin1998/dsh-dingtalk/tree/archive/custom-web-20261103) 已推送。最终合并提交以 PR 记录为准，主分支通过 PR 更新。

先完成全部本地验证，再按以下顺序交付；不配置或触发 GitHub Actions，不发布 NPM。远程执行结果以本次 PR 记录为准。

1. 确认并关闭 `wanyexin1998/dsh-plugin` 与 `wanyexin1998/dsh-dingtalk` 的 Actions。
2. 推送 fork 的备份分支；fork main 继续跟踪官方，不合入定制改动。
3. 推送大仓库新分支，创建 PR，检查最终差异及准确 head SHA 后合并 main。
4. 将本地 main 快进到合并结果。不得发布 NPM。
