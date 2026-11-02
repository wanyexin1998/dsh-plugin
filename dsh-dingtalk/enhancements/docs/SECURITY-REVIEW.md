> 以下保留原阶段记录。当前通用 DWS 执行边界与验收范围以 [DWS 能力说明](../../docs/DWS-CAPABILITIES.md) 为准；原三项只读复核不代表新增能力已通过独立安全复核。

# P0 安全复核记录（#12）

结论：**BLOCKED / NO PROD DEPLOY**。本记录区分工程修复、可重复负向测试、独立架构复核和完整安全验收；不能把架构复核当作完整独立漏洞扫描，也不声称已签发“高危/严重风险 0 未解决”的全面结论。

## 威胁模型与独立复核

完整模型由 `codex-security:threat-model` 工作流保存至受管持久化制品，作用目标为本插件目录，文档名 `threatmodel.md`，SHA256 `584c3aeb51c3b18380d4bf03b99e07e90523473b83f972d6bac60f06ee2ff751`。本机可通过相同 targetPath、persistent、threatmodel.md 读取；最终交付同时提供可点击文件路径。此文档只做仓库内验收索引，不复制个人机器的安全制品路径。

已完成一次新上下文、只读、离线的独立架构复核；另复核了公开精确 Fetch route 与实际 Peer 重新鉴权的边界。复核覆盖资源实际路径、Host Tool / 浏览器 / loopback / DWS / OS 用户边界、打包、测试命名空间与文档差异。未委派实现或测试，未运行额外安全扫描。

明确策略：同一 Host 的所有 DSH 会话/浏览器共享一个预期企业账号，不是每会话/租户隔离。生产 Windows 凭据仍属于当前 OS 用户的 DWS DPAPI/HKCU；私有配置目录不构成对同用户 Bash 或其他 Host 插件的凭据沙箱。仅支持单 managed Host 使用一份私有配置。

## 已修复与验证

| 项目 | 风险 / 修复 | 复现与证据 |
|---|---|---|
| 参数审计及诊断正文落盘 | 中等隐私风险。官方默认 audit 含搜索词；固定 DWS_AUDIT=0，新 owned 目录通过 logs 文件使诊断 logger no-op，不动已有用户日志 | verify:p0 成功及错误路径全目录哨兵扫描；旧 #6 报告保留作对照 |
| 授权保存和解绑竞态 | 潜在访问状态恢复风险。控制变更串行化，先使事务 revision 失效，撤销状态先持久化，再精确 logout | managed-connection.ts；官方二进制精确解绑、确认 token 与旧 revision 负向测试 |
| 重放/CSRF/错误浏览器 | 潜在高风险场景已实施控制，不等于发现了可利用高危漏洞。state、HttpOnly cookie proof、TTL、一次性消费、owner 和精确身份 | tests/oauth.test.mjs；verify:p0 错账号失败保留原连接 |
| 任意执行/写操作/换账号 | Tool 只允许三个静态只读 operation；动态值 equals-form argv，shell=false；不允许模型进入控制面 | tests/local.test.mjs、contract.test.mjs、ui-rpc.test.mjs |
| 假连接/开放重定向 | 消息只触发 Host 复查；固定 callback origin + popup source + tx；验证 return path，不读 OAuth query 作为跳转目标 | verify:browser；oauth.test.mjs |
| 无界进程与卸载 | 串行队列、超时、排队期限、输出上限、Abort、Windows 进程树清理；清理授权监听/订阅/计时器 | local.test.mjs；lifecycle.test.mjs；browser 报告 |
| 原生集成 | 等待 slot 声明；通过 /api 下的精确 Fetch route 共存于原生 Gateway 之前，Connection.admit 重读实际浏览器 Peer | verify:dsh-web；不得以纯 Mock 注册代替原生验证 |

## 剩余风险和门禁

dev.4 新增自动引导边界：首次 UI 点击从包内固定官方发布 URL 获取有大小上限的 ZIP，校验归档及 exe 双重摘要，内存提取单一二进制且不落盘归档路径；固定 HTTPS 发现公开 clientId，禁止 metadata 重定向。下载 60 秒、发现 15 秒上限，UI/卸载可 Abort；不允许模型触发下载或替换地址。新增安装器负向测试和无预填身份的首次绑定/错账号重授权测试。上面的独立架构复核及受管模型基于 dev.3，尚未覆盖此新增边界，不能冒称本候选已完整独立安全验收。

- 官方 CLI 换码已保存、随后附加核验失败：进入 verificationPending，禁止读取；不承诺回滚到旧 Token。固定夹具验证阻断与显式重授权恢复。该行为需要产品/真实联调确认。
- CLI 企业开关的拒绝码、应用 scope、组织 PAT scope 策略必须分别验证。只接受已审阅的结构化码，不解析 hint/message 或服务端授权链接；未知原因保持中性，不自动登出。
- token/status/业务正文不进入连接日志，但经授权的查询结果本身会作为 Tool 结果进入正常 DSH 会话。这不等于插件连接器审计，不能承诺删除宿主会话记录。
- Windows ACL、上游凭据持久化和网络服务、同 OS 用户任意执行、最终独立漏洞审查及真实企业/LLM/Desktop 证据仍是门禁或可信前提。未完成时 #12 / G1 保持开放。

## 可重复命令

```powershell
npm run build
npm run typecheck
npm test
npm run verify:p0
npm run verify:browser
npm run verify:dsh-web
npm run verify:bundle
```

脚本只使用合成账号与独立测试命名空间；不允许在报告、Issue、截图、Git 中放真实密钥、授权码或业务正文。完整验收矩阵见 P0-ACCEPTANCE.md。
