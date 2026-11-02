# 本地授权与现场联调

仅供隔离测试 Profile。当前 G0 HOLD / G1 BLOCKED / NO PROD DEPLOY。生产配置不包含测试端点覆盖、调试命名空间或任意 URL。

## Host 私有配置

把下列 JSON 保存到仓库之外，例如 `%LOCALAPPDATA%\dsh-dingtalk-test\host.private.json`，只允许当前 Windows 账号和所需管理员读取。替换尖括号字段；不要把配置提交到 GitHub、发进聊天或放进 DSH 的 cordis.patch.yml。

```json
{
  "binaryPath": "E:\\Code\\dsh-plugin\\.cache\\dingtalk-g0\\bin-amd64\\dws.exe",
  "oauth": {
    "clientId": "<同一授权应用的 clientId>",
    "redirectUri": "http://127.0.0.1:18789/dsh-dingtalk/callback",
    "scopes": "<应用已配置且获准使用的 scope，以空格分隔>",
    "expectedCorpId": "<获准测试的 corpId>",
    "expectedUserId": "<获准测试的 userId>"
  }
}
```

在启动测试 Host 的同一个 PowerShell 中设置 `DSH_DINGTALK_CONFIG_FILE` 为该文件绝对路径，然后重启测试 Host。配置旁自动创建 `dsh-dingtalk-state/binding.json` 和 `dsh-dingtalk-state/dws`；只存非 Token 绑定信息，Token 交给官方 DWS。不要在此 JSON 放 AppSecret、Code 或 Token。

`clientId` 必须与 code 所属应用一致。DWS 1.0.66 没有匹配应用密钥时会走服务端托管换码；任意自建应用不能据此承诺可用。自有应用需要已有 DWS 安全保存的同 clientId 凭据，或官方确认受管换码支持。当前插件不提供 secret-argv 注入，也不解析人类终端文本做 device flow。若测试应用不满足，记录 G0 阻断并确认官方受控授权方式，不能用 Cellgent SSO 的 authCode 替代。

Windows 凭据由 DWS 使用当前 OS 账号的 DPAPI/HKCU 存储；独立 configDirectory 不等于独立凭据沙箱。使用获准的专用测试账号，避免与正常工作身份重合。同一私有配置当前仅支持一个 managed Host 进程；同 Host 的多个 DSH 会话/浏览器共享同一绑定身份，不是不同租户。

## 现场步骤

1. 仅提供配置文件路径和已准备账号类别给开发者；不要提供授权材料。先确认回调已登记为上述精确地址、端口空闲、scope 获批，以及测试账号属于预期企业。
2. 启动隔离 DSH Web Profile，在设置 → 钉钉连接主动连接；用户自行在新标签页扫码/确认。授权页使用独立 state、nonce、浏览器 cookie、120 秒 TTL，code 经 stdin 交给 DWS；只有在线身份和只读能力确认后才 connected。
3. 在原会话询问“我在钉钉是谁”“查询指定日期日程”“搜索指定测试文档”。核对真实 LLM 的 operation 选择及获准数据；无需把真实正文复制到验收报告。
4. 验证首次未连接卡片 → 新标签页 → 返回原会话 → 原卡片更新；保留会话 ID/草稿，不自动发送消息。分别测试弹窗受阻、opener/close 不可用、刷新、多浏览器、断网、取消、超时和错账号。
5. 重新授权；验证换码前取消/失败仍保留有效连接。**CLI 已保存新凭据后额外在线验证失败，只能进入 verification_failed_after_save 并阻断读取，尚不能恢复旧 Token，不能把这一项标记 PASS。**
6. 使用未开通 CLI / 应用 scope 不足 / 组织 PAT 策略禁止的账号分别测试。只保留结构化分类码、退出码、版本、时间和测试账号别名。403 或文字不能直接认定企业 CLI 未开通；PAT 组织 scope 策略也不是企业 CLI 总开关。
7. 通过二次确认解除连接，确认本人读取受阻，其他 DWS Profile、默认账号、DSH 登录和会话不变；刷新和重启后仍不能读取。再验证独立卸载/回滚。

报告不得包含真实 AppSecret、AccessToken、RefreshToken、authCode、实际私有路径或业务正文。截图只截 UI，必要时遮蔽用户展示信息；不要导出 callback URL、浏览器网络 HAR、授权页或 DWS 原始诊断。
