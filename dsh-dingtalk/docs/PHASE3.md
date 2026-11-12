# 第三阶段：共享机器人，个人 DSH 执行

开发分支 `feat/dingtalk-phase3-shared-gateway`，版本 `0.2.0-dev.7`。同一企业、一个企业内部机器人、多位成员各自授权。数字员工和跨企业应用分发不在本阶段范围内。

## 流程

机器人由一个网关独占 Stream 连接。各人的 DSH 主动建立 WSS 连接，网关从官方消息读取 `senderCorpId + senderStaffId`，查找个人 DSH，再将结果回复原会话。个人 OAuth、DWS、模型配置和长期会话留在本机。网关会中转消息、结果及附件，但不持久化正文。

管理员给目标 DSH 的 `dingtalk-channel` 配置启用 `relay: true`；此模式不会再启动本机机器人 Stream 或读取机器人凭据。独立模式默认保持原行为。用户完成原有 DWS 个人授权后，在“钉钉连接 → 共享机器人”输入网关地址并点击连接，在打开的钉钉网页确认身份即可。无需发送 `/bind`，也没有替换设备复选框。

网关使用自身应用的网页登录授权，核验所选企业，并通过该应用的 unionId 换取企业 userId；与本地 DWS 身份一致后才绑定。登录用的临时用户 Token 仅用于本次身份核验，不持久化或用来执行 DWS；DWS 授权不上传网关。此流程是网页确认替代命令配对，不承诺与 DWS 授权合并为一次扫码。

同一身份一台活跃设备，最后成功完成网页登录的设备自动成为接收设备。网关先验证新设备就绪，再串行提交该用户的新绑定并撤销旧凭据。取消、超时、账号不一致或新设备断线不会替换原路由。旧设备显示“已在其他设备连接”，停止自动重连，重启也不会重新抢占；只有用户主动点击连接并再次登录才会切回。三个入口共用身份，但各自会话历史仍分别保存。设备切换不会解除旧 DSH 的个人 DWS 授权，也不撤销已经发出的业务操作。

## 网关部署

运行 `dsh-dingtalk gateway --config <仓库外私有配置文件>`。配置示例，值全部为占位符：

```json
{
  "clientId": "YOUR_ROBOT_CLIENT_ID",
  "clientSecret": "YOUR_ROBOT_CLIENT_SECRET",
  "corpId": "YOUR_CORP_ID",
  "publicOrigin": "https://gateway.example.com",
  "stateDirectory": "/private/dingtalk-gateway",
  "host": "127.0.0.1",
  "port": 19878,
  "allowedGroups": [],
  "interactionCardTemplateId": ""
}
```

私有配置仅管理员持有，不进入 Git。HTTPS 反向代理将 `/relay` 的 WebSocket Upgrade 以及 `/relay/login`、`/relay/callback` 的 HTTP 请求转发到此进程。`publicOrigin` 必须与用户填写的网关地址具有相同主机和端口，生产使用 HTTPS/WSS。仅本机测试允许 `publicOrigin: http://127.0.0.1:19878` 与 `ws://127.0.0.1:19878/relay`，员工电脑不开放端口。停用其他对同一机器人的 Stream 连接，避免官方随机分发。

钉钉应用配置：

1. 在“安全设置 → 重定向 URL”新增 `https://网关域名/relay/callback`。本机测试为 `http://127.0.0.1:19878/relay/callback`，保留原有 DWS 回调。
2. 确保应用可调用“获取用户通讯录个人信息”和“根据 unionid 获取用户 userid”，可见范围包含测试成员。登录请求使用官方 `openid corpid`。
3. 网关使用同一个企业内部应用的 Client ID / Secret，`corpId` 为目标企业；不混用其他开发者应用的 unionId。

官方依据：[浏览器授权流程](https://open-dingtalk.github.io/developerpedia/docs/develop/permission/token/browser/get_user_app_token_browser/)、[unionId 换取企业 userId](https://open.dingtalk.com/document/orgapp-server/query-a-user-by-the-union-id)。

将网关的 `groupMentionSenders` 设为 `"all"` 后，员工把机器人加进群，在群里 @机器人即可使用本人已连接的席位。试点时可填员工的钉钉 userId 数组。网关根据钉钉 Stream 回调的 `isInAtList` 识别机器人被 @，根据发消息的企业和员工选择席位。群内回复对群成员可见。群内第一张流式答复卡片在投放时通过员工 userId 请求钉钉提醒提问人。收到提问人的昵称时，卡片正文从创建到结束均显示「@昵称」。后续更新和续卡不重复提醒。普通文本和 Markdown 在发送答复时 @ 提问人。已有的 `allowedGroups` 继续生效，未配置 `groupMentionSenders` 时只接收名单内的群。

互动审批卡复用现有模板；未配置模板时私聊沿用文字确认，群内需要审批的操作保持原有拒绝行为。入站图片/附件经过网关受限下载（20 MB）转给本人 DSH；文件回传工具仍受现有 IM 工具边界限制，未额外开放本机执行能力。

## 状态与失败行为

- 绑定持久化为小 JSON，在线连接和原会话路由存内存。网关和本机保留 24 小时请求 ID 去重记录，不保留消息正文。
- 未绑定提示到本人 DSH 连接；本人 DSH 离线直接提示，不借用其他人或管理员的实例。
- Web 断开授权后，新消息提示重新连接；重新授权原账号后保留设备配对。换账号不能沿用旧身份执行。
- 请求回复窗口为一小时。网关重启、设备替换或中途断线不自动重放业务请求；结果不确定时明确提示先核查，不能承诺外部写操作严格只执行一次。
- 普通文本和 Markdown 通过原会话发送；卡片创建、更新和回调经网关适配。卡片回调只能由原请求的发送人处理。
- 本地问题回答、会话控制先于任务队列，防止等待确认与排队相互阻塞。
- 单网关故障影响机器人入口，Web 本地入口仍可使用。个人 DSH 需要保持运行和网络可达。

## 验证

`pnpm run ci` 为本地完整检查，不使用 GitHub Actions。`test/relay.test.mjs` 使用真实本机 HTTP/WebSocket、合成登录身份验证多人路由、授权断开、卡片点击者、离线恢复、取消/失败保留原路由、并发登录的唯一设备和旧设备停止重连。`test/relay-login.test.mjs` 覆盖浏览器回调校验、授权码别名、重放、过期以及官方身份 API 字段契约。模拟登录不替代官方真实授权验收。

### 2026-11-03 验收记录

- 本地完整检查通过：消息侧 354 项通过、51 项按平台条件跳过，Web/DWS 52 项通过；类型、格式、敏感内容扫描与安装包边界检查通过。
- 真实 DSH ToolRuntime 验证通过：IM 使用身份限定工具，其他执行入口保持禁用，Web 工具行为保留。实际安装包的设置页、登录跳转及取消状态验证通过。
- 用户完成官方网页身份确认，页面显示已连接；网关确认 Stream 已连接、一位已绑定且在线的用户、登录成功。随后用户私聊机器人查询当前账号与企业，确认“私聊查询正常，身份正确”。
- 用户要求先停止真实测试并交付。两位真实成员、共享网关群聊、真实 A/B 设备切换、实际审批模板及图片附件尚未进行本阶段真实验收；上述自动化用例不能替代这些验收，也不沿用第二阶段的直连群聊结果作为共享网关验收。

后续真实验收需两位成员分别完成 DWS 授权和网关网页登录，确认 Web/私聊/同群身份一致、A 离线或断开授权不影响 B，并验证同一人 A/B 设备切换、实际模板按钮与图片附件。

## 流式反馈与桌面兼容（dev.8，本地验收）

共享网关支持 AI Card 创建、投放、流式更新与结束。先验证真实卡片权限（`Card.Instance.Write` / `Card.Streaming.Write`）和模型文本增量，再把测试入口的 `replyMode.direct` 改为 `aicard`；`streaming.enabled: true`、`throttleMs: 500`、`asyncMode: false`。未经验证的入口保留原配置。

当前 DSH 将文本增量发布到 `agent/assistant-stream`，最终消息与 `turn/end` 仍在 `session/event`。插件同时兼容旧 `assistant/chunk`，只处理当前机器人会话，按修订号去重。已开始发送的帧完成后才提交最终卡片。

开启 `emotionFirstResponse` 后，在原始用户消息上贴 🤔，回复完成后撤回并贴 `🥳 Done`。取消、模型失败或最终投递失败不显示 Done。表情调用串行处理，失败不阻止业务回复，API 错误正文与凭据不写入诊断。

本机 `accounts/shared/feedback.json` 记录 Renderer 收到的流式帧、文本增量、回合结束、最终投递和 Markdown 降级计数；网关 `feedback.json` 记录卡片及表情 API 成败。仅记录固定事件名、计数、时间和错误类别，不记录正文、账号、消息 ID、URL 或 Token。通过既有已认证连接读取网关诊断，不新增公开诊断端点。

`dsh-dingtalk doctor --profile <当前 Profile> --json`（或设置 `DSH_PROFILE`）读取该 Profile 的有效回复配置和共享网关状态。默认仍为 `web`。连接正常不等于卡片权限已验证，需结合 `feedback.gateway` 中创建、更新与结束的实际成功记录。

桌面 UI 接受精确来源 `dsh-app://app`；仍要求宿主已认证的 owner 浏览器 Peer。OAuth 完成后由设置页轮询更新，不让外部浏览器跳转到桌面自定义 scheme。其他任意 scheme、host、端口和带凭据的返回地址仍拒绝。

本地验证记录（2026-11-03）：完整检查 359 项消息侧测试通过、51 项平台条件跳过，54 项 Web/DWS 测试通过；安装包与真实 DSH ToolRuntime 作用域检查通过。机器人应用补齐权限后，真实测试卡片创建、投放、3 次流式更新及结束均成功。安装 dev.8 时保留测试 Profile 的原配置；真实宿主 RPC 以桌面来源完成 bootstrap、status、disconnect-preview，未实际解除连接。随后真实私聊记录到 705 个流式帧、其中 508 个 text-delta 到达 Renderer，2 个回合正常结束并投递成功。三项前置验证通过后，才将测试私聊切为 aicard 并开启表情，群聊仍为 Markdown。

启用后真实私聊验收通过：用户确认原消息及时出现 🤔、卡片正文边生成边更新、完成后显示 🥳 Done。本轮 Renderer 收到 310 个流式帧，其中 277 个 text-delta；回合结束和最终投递均成功。网关卡片创建、投放、2 次流式更新、结束，以及 Thinking 添加、撤回和 Done 添加均成功，所有记录失败数为 0，没有 Markdown 降级记录。`doctor --profile phase1-preview --json` 返回共享网关连接及 AI Card 验证均通过。此结果仅覆盖测试私聊；群聊流式效果与实际 Electron 窗口完整操作尚未单独验收。

群卡片按目标会话校验投放回执。明确拒收会回退文字；投放结果未知时继续更新原卡，避免重复提醒或误标 Done。席位未收到首张卡片编号时，改用文字发送一次正文，避免再次 @ 提问人。正文已发出但收尾回执未知时，不再补发。续卡失败时保留最终正文。企业机器人按企业、应用 ID 和网关地址识别配对目标；完成旧指纹迁移后，调整显示名和配置顺序均可保留配对。
