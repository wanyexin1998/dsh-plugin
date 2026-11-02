# G0 真实企业联调清单

关联 [Issue #4](https://github.com/wanyexin1998/dsh-plugin/issues/4)。用户已确认测试应用和账号具备，安排在最后联调时提供；当前不索取或保存这些材料。

## 输入准备

| 项目 | 需要核对的内容 | 当前位置 |
| --- | --- | --- |
| 测试应用 | OAuth 类型、可信 clientId、完整匹配的 redirectUri、获准 scope、外部换票通道 | 待接入 |
| 开通账号 | 受信 corpId/userId、企业 DWS CLI 权限已开通 | 待接入 |
| 拒绝账号 | 企业未开通或明确禁止的账号；另准备应用权限不足的可控条件 | 待接入 |
| DSH 目标 | 实际 Desktop/Web 版本、运行入口和测试 Profile | 待接入 |

AppSecret 通过受保护的本地配置/官方凭证存储接入；不发送到聊天、不放入进程 argv、仓库、截图或 Issue。独立 OAuth code 只经 stdin 一次性传给 DWS，不能复用已有 SSO 消费过的 code。

## 操作与证据

1. 在隔离测试 Profile 启动插件/验证入口，校验 DWS 校验值、clientId、redirectUri 和 scope。记录版本，不记录秘密。
2. 用户主动开启授权页；回调校验 state、nonce、TTL、发起会话与回调来源。记录事务结果，不记录 callback query/code。
3. 使用 `dws auth exchange --code-stdin`，提供可信的 expected corpId/userId；读取成功身份摘要，确认精确 Profile。错误应用或错误身份必须拒绝。
4. 使用该精确 Profile 读取本人信息、日历和文档搜索；分别记录成功/拒绝的受控状态与可复现步骤，不保留业务正文。
5. 等待/触发正常 Token 到期刷新，重新启动 CLI 后再次查询；不以同一进程内的 Token 覆盖成功替代持久化验证。
6. 使用企业未开通和应用权限不足的条件分别重试。保留可识别的官方业务码及来源；若 CLI 仅给出通用认证错误，标记“不可区分”，不能映射成“IT 未开通”。
7. 检查错误授权/重试不破坏已有可用 Profile，不改变用户已有默认 Profile。解绑仅针对精确 Profile，不能全局 logout。
8. 真实 Desktop/Web 检查 popup 用户手势、Origin/COOP/CSP、opener 丢失、关闭/聚焦受限、双标签和轮询兜底。记录原会话 ID 保留和卡片刷新；自动恢复只读任务另验，不模拟用户发言。

## 门禁记录模板

每个条目填写 `PASS / FAIL / BLOCKED`、测试日期/版本、脱敏步骤、结果、证据路径及限制。真实 G0 通过至少需要：正确身份换票、持久化后的只读操作、刷新、权限失败可判别性结论和目标 DSH 兼容性结论。未知项保持 BLOCKED。

独立记录 `external-code` 的 GO/NO-GO。若自建应用不被官方换票通道支持，重新验证受控 device 路线的机读协议；不得用正则解析终端文案当成已验收协议。

本地模拟结果不填入真实环境 PASS。当前 `dws.lock.json` 的门禁保持 `HOLD / PENDING_USER_TEST`。
