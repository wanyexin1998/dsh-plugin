# 安装后连接钉钉

普通用户无需填写 JSON、clientId、corpId、userId、scope 或 AppSecret。默认使用官方 DWS 托管应用。当前是 Windows x64 开发候选，真实企业联调仍待完成，G0 HOLD / G1 BLOCKED。

## 用户操作

1. 安装插件并重启隔离 DSH 测试 Profile。
2. 在设置 → 钉钉连接，或会话中的小卡片，点击「连接钉钉」。首次会自动下载并校验固定版本 DWS，原面板显示已下载大小和细进度条，可取消。刷新页面后恢复进度，下载完成后进入授权；安装和状态读取不会自行弹出授权页。
3. 在新标签页完成钉钉登录和同意授权。浏览器拦截弹窗时，点击界面提供的「打开授权页」。
4. 授权成功后回到原会话。Host 在线核验身份后，设置和会话卡片自动更新；草稿和会话保留，不自动发送查询。授权页无法关闭或没有 opener 时，短期轮询仍可更新结果。
5. 此后可查询本人信息、日程、文档。重新授权必须匹配当前绑定的企业账号；需要换账号时，先在设置中二次确认「解除连接」，再连接新账号。

企业未开通 DWS CLI、应用权限不足和组织数据策略限制可能阻止使用。按界面的明确原因联系 IT；网络错误或普通 403 不会被猜成企业未开通。

## Host 自动完成的工作

- 首次点击连接时，从 dws.lock.json 的官方 GitHub 发布地址下载 DWS 1.0.66 Windows x64 ZIP。固定大小上限，分别核对 ZIP 和 exe 的 SHA256，核对 PE 架构与版本，原子安装；已存在且校验通过时复用。损坏文件拒绝执行，不使用 PATH 回退。
- dev.9 起组件准备是 Host 后台单任务，UI 每秒通过短请求读取进度。下载总时限 30 分钟，连续 90 秒无数据才按停滞超时处理，不再受旧的 60 秒下载 / 100 秒前端请求上限限制。OAuth 的 120 秒时限从准备完成后才开始计算。
- 临时下载按锁定归档哈希保存在当前插件状态目录的 bin 下；中断、取消后保留已下载内容，显式重试尝试 Range 续传。206 必须匹配偏移与总长度，200 会从头覆盖；完整缓存也必须通过 SHA256 才能使用。安装成功后删除对应下载缓存。下载中断、超时与校验失败分别提示，不将网络失败归类为钉钉授权失败。
- 通过固定 HTTPS https://mcp.dingtalk.com/cli/clientId 获取公开应用 ID；不需要应用密钥，不接受来自模型或 RPC 的自定义下载/发现地址。
- 按固定上游默认 OAuth 流程，使用 openid corpid、127.0.0.1 动态端口及 /callback。无需用户在自建应用后台登记回调。默认应用与用户自己创建的企业应用是不同授权入口。
- 独立 state、nonce、HttpOnly/SameSite cookie、120 秒事务有效期、单次消费、浏览器 owner 校验；code 仅由 Host 经 stdin 交给同 clientId 的官方 DWS 托管换码。
- 首次从在线身份结果建立精确 corpId:userId 绑定，不预填身份，也不读取既有 DWS 默认账号。后续重授权和业务调用核对该绑定；断开只处理这个 Profile。
- 私有状态位于 DSH_HOME 下 plugin-state/dsh-dingtalk/<Profile 路径摘要>；未设置 DSH_HOME 时使用本机用户状态目录。仅持久化非 Token 绑定和 DWS 自身状态，Token 由官方 DWS 的 DPAPI/HKCU 保存。不同目录不等于 Windows 凭据隔离；同 Host 的会话共享绑定，仅支持单 managed Host 使用同一状态目录。

默认机制依据锁定上游 commit f215043e676d6889e1ddce3464828d8b1ec40c31 的 internal/auth/oauth_provider.go、oauth_helpers.go、endpoints.go、external_exchange.go 和 managed_exchange.go。本地合成授权不替代真实企业 consent 验收。

## 真实联调

用户只需按上面的步骤自行授权，不向开发者发送配置内容、AppSecret、Code 或 Token。默认路径不使用之前准备的自建应用 JSON；如果启动环境仍设置了 DSH_DINGTALK_CONFIG_FILE，由维护者清除此旧覆盖并重启测试 Host。

分别验证已开通 / 未开通 CLI 账号、三项只读查询、重新授权、取消、超时、断网、刷新、弹窗受阻、无 opener、重启和精确解绑。核对真实 LLM 的三种中文意图选择和原生 Tool 卡片。Desktop 另行验收。

CLI 已保存新凭据后附加在线核验失败，会进入 verification_failed_after_save 并阻断读取。重新授权可恢复，但不能宣称已回滚旧 Token。保存前取消或换码失败保留原连接。

报告只记版本、时间、账号类别、operationId、状态和原因码。不要保留真实授权页、回调 URL、网络 HAR、凭证或业务正文。

## 可选：维护者自建应用覆盖

仅供获准的开发/兼容测试，普通用户不需要配置。旧 DSH_DINGTALK_CONFIG_FILE 显式覆盖继续支持；不自动扫描桌面或下载目录。仓库外 JSON 示例：

```json
{
  "oauth": {
    "clientId": "<测试应用 ID>",
    "redirectUri": "http://127.0.0.1:18789/dsh-dingtalk/callback",
    "scopes": "<已获批的 scope>",
    "expectedCorpId": "<预期企业 ID>",
    "expectedUserId": "<预期用户 ID>"
  }
}
```

binaryPath 可省略，仍自动准备锁定版本；状态目录位于此文件旁的 dsh-dingtalk-state。自建应用必须精确配置回调，并具备官方确认的托管换码能力或同 clientId 已由 DWS 安全保存的应用凭据。任意自建应用不能据此承诺可用。插件不接收或注入 AppSecret，不使用其他应用/Cellgent SSO 的授权码。
