# DWS-01 / G0 可行性验证

日期：2026-11-02（Asia/Shanghai）

任务：[Issue #4](https://github.com/wanyexin1998/dsh-plugin/issues/4) / [Epic #3](https://github.com/wanyexin1998/dsh-plugin/issues/3)

结论：**本地能力验证通过；真实环境门禁 HOLD，#4 保持开放。**

## 1. 范围与证据等级

本期只开发原生 DSH 插件 #4–#13。附件方案包含的 Cellgent、独立 Connector、SSO 和 #14–#17 已按后续确认暂缓。当前目录交付 G0 验证工具、兼容锁及脱敏证据，尚无正式 Bundle、业务 Tool 或授权 UI。

用户已确认拥有测试应用和账号，将在最后联调时接入。当前不进行真实钉钉登录。`LOCAL_FIXTURE_ONLY` 的成功证明官方二进制机制可在受控环境运行，不证明企业应用、scope、企业 CLI 权限或真实数据访问成功。

| 验证项 | 当前结果 | 证据 / 限制 |
| --- | --- | --- |
| DWS 1.0.66 发布制品与 SHA256 | PASS（Windows x64 下载实算，其余平台元数据锁定） | `dws.lock.json`；官方 checksums.txt 与 GitHub release digest 一致 |
| Windows 可执行文件架构/版本 | PASS | AMD64 PE `0x8664`；版本带预期完整 commit |
| 三项只读命令 help / compact Schema | PASS | `evidence/g0/dws/`，13 条采集命令；Schema 均为 available/read |
| 外部换票、在线身份、保存、刷新、正常 get-self | PASS（本地夹具） | 上游原始断言保留；仅补 Windows 测试命名空间与关闭升级检查 |
| 双 Profile、默认 Profile 保留、身份拒绝 | PASS（本地夹具） | `exchange-report.json`；身份不符及拒绝不改变已有 profiles |
| 失败凭证脱敏、预演不联网、不读 stdin | PASS（本地夹具） | 上游 9 种 redaction 场景及本项目额外验证 |
| 企业 CLI 开通/拒绝与应用 scope 错误码 | BLOCKED / 待真实联调 | 通用 exchange 认证错误不能确定 IT 原因 |
| 测试企业自有应用 code、redirect、scope、刷新 | BLOCKED / 待真实联调 | 用户最后提供配置和测试账号 |
| 官方 DSH 0.2.1-rc.5 Tool / Cordis / Slot API | PASS（发布包 API） | `dsh-report.json`；4 组检查；未请求模型 |
| 目标 Desktop/Web 安装与实际卡片/设置渲染 | PENDING | 本地包级测试不替代装配后的浏览器验收 |
| 浏览器 callback、opener、COOP/CSP、返回原会话 | PENDING | 实际 OAuth 与 UI 阶段验证 |
| Linux/macOS 运行与动态库兼容 | NOT TESTED | 仅锁官方制品；未在这些系统执行 |

## 2. 锁定的依赖

DWS 固定 `v1.0.66`，源码提交 `f215043e676d6889e1ddce3464828d8b1ec40c31`。这里只声明选择的兼容基线，不承诺一直是最新版本。

Windows x64 制品：

- 发布包 SHA256：`64dcf850b32db1e07861ba971a9a251d1ed95a86bbe5bb248866377a67520d53`。
- 解压出的 dws.exe SHA256：`0db4ed09c0a9524b39980878d4b51a020a32a127bad757b852ec1173b149ec74`。
- checksums.txt SHA256：`bc7ae590d2e1a0b2e78359e6bc74310b7ad1b9ce98c77a906389ee38fb66ef47`。

Linux amd64/arm64、macOS amd64/arm64、Windows arm64 的 URL、大小及官方 SHA256 见锁文件；本次没有下载或执行它们。官方 CI 的 `CGO_ENABLED=0` 构建配置是源码观察，不作为 Linux 镜像运行通过的证据。

DSH 使用独立缓存中的官方 npm 发布包 `@deepseek-ai/dsh@0.2.1-rc.5`，不是仓库现有 `.ref-021` 历史片段，也不是本地 Cellgent 构建。Node 为 `v22.23.2`；Python 为 `3.14.7`。当前 API 验证版本不等于已确定的最低兼容版本。

## 3. 对实现有影响的实测发现

### 3.1 换票成功还不能判定 connected

官方外部换票路径进行应用选择、换票、在线身份查询和精确 Profile 保存。受控夹具中整个流程没有请求 `/cli/cliAuthEnabled`。因此不能把返回 `profile_saved` 直接投影成插件 `connected`；还要在目标环境验证企业业务可用性。

夹具返回 HTTP 403 和 `ENTERPRISE_NOT_AUTHORIZED` 时，官方二进制退出 2，错误通过 **stderr JSON** 给出 `category: auth`、`code: 2`、`message: managed token exchange failed`，未保留夹具业务码。证据仅表明这条路径无法从该输出可靠识别企业原因；不是对真实生产错误码的结论。

后续 LocalBackend 必须兼顾 stdout 与 stderr 的机读错误，保留受控通用失败态。不能用退出 2、HTTP 403、认证失败文案或 code exchange 成功去猜 IT 开通状态。

来源：[官方 external exchange](https://github.com/DingTalk-Real-AI/dingtalk-workspace-cli/blob/f215043e676d6889e1ddce3464828d8b1ec40c31/internal/auth/managed_exchange.go)、[CLI exchange](https://github.com/DingTalk-Real-AI/dingtalk-workspace-cli/blob/f215043e676d6889e1ddce3464828d8b1ec40c31/internal/app/auth_exchange.go)。

### 3.2 状态检查需要保留“无法确认”

真正隔离且为空的测试存储返回 `authenticated: false` 和未登录文案。损坏 profiles.json 的受控场景返回 `reason: local_state_unreadable`，同时也包含 `authenticated: false`；只读检查没有改写损坏文件。

因此必须优先处理 reason，而非把 false 一律转成 `unlinked`。源码还定义需要迁移/修复的 `local_state_requires_repair`；本次真实二进制负向验证的是 `local_state_unreadable`，不能将两者混记。

来源：[auth_status_readonly.go](https://github.com/DingTalk-Real-AI/dingtalk-workspace-cli/blob/f215043e676d6889e1ddce3464828d8b1ec40c31/internal/app/auth_status_readonly.go)。

### 3.3 Windows 测试必须单独隔离注册表

Windows 凭证后端使用 DPAPI + HKCU。`DWS_CONFIG_DIR`、`DWS_KEYCHAIN_DIR` 和 macOS 的 `DWS_DISABLE_KEYCHAIN` 不足以隔离 Windows 凭证槽。首次运行上游脚本时，其多个临时目录共用了默认注册表凭证，导致失败用例读回前一用例身份、上游断言失败。

已清理本次可验证的合成夹具记录，并为每个测试目录设置 `DWS_KEYCHAIN_TEST_NAMESPACE`。保留上游全部断言后重跑通过；测试结束只删除按该测试命名空间计算的注册表子键。这个变量仅用于测试，不能成为生产隔离方案。

来源：[keychain_windows.go](https://github.com/DingTalk-Real-AI/dingtalk-workspace-cli/blob/f215043e676d6889e1ddce3464828d8b1ec40c31/internal/keychain/keychain_windows.go)、[上游 smoke](https://github.com/DingTalk-Real-AI/dingtalk-workspace-cli/blob/f215043e676d6889e1ddce3464828d8b1ec40c31/scripts/dev/test-auth-exchange-local.py)。

### 3.4 命令契约与兼容性

| 插件 operationId | 已实测 CLI | compact canonical_path | 注意 |
| --- | --- | --- | --- |
| `identity.getSelf` | `contact user get-self` | `contact.get_current_user_profile` | 无业务参数；不能用 get --ids me 替代 |
| `calendar.listEvents` | `calendar event list` | `calendar.list_calendar_events` | start/end ISO-8601；默认查询当天，时区需由插件明确处理 |
| `docs.search` | `doc search` | `doc.search_documents` | 命令可用，但 compact use_when 已提示弃用，推荐 drive/wiki 搜索 |

保留方案确定的 `docs.search → doc search` 基线，显式记录弃用风险，不在 #4 静默扩大白名单。后续适配可在稳定 operationId 后替换经过验证的 CLI 映射。

compact Schema 的 limit 上限主要写在描述中（日历 100、文档 30），不是完整的机器约束；Host 仍需显式约束边界、未知字段、输入长度及时间范围。Schema/help 包含的其他业务命令建议不应直接作为插件 Skill 发布。

### 3.5 DSH 扩展点已经有本地运行证据，但 UI 待验

通过官方发布包验证：

1. CLI 在隔离 `DSH_HOME` 下运行 `--version`。
2. 真实 `ToolRuntime` 注册并执行合成 `auth_required` 工具。
3. Cordis owner fiber 卸载后工具从注册表消失。
4. 真实 `SlotCore` 接受 keyed `tool.call.toolview` 和 list `settings.section` 注册，disposer 可清理；同时检查对应发布包的类型契约。

SlotCore 测试由夹具显式声明 owner 席位，不等于装配后的 DSH UI 已渲染卡片。尚未启动 Desktop、执行正式 Bundle 安装或验证 OAuth 回调。后续应使用正式 `ctx.effect` 和 inject 契约，不复用历史插件的私有 DOM、整窗接管或宿主补丁方式。

## 4. OAuth 路线决策

**external-code：本地机制可行，暂定首选；企业 GO/NO-GO 未决。** 上游夹具验证默认、显式及省略 clientId 的服务端托管换票，含刷新和持久化后的查询。这里“custom”是模拟服务接受的显式应用 ID，不证明企业自建应用或其 AppSecret 直连路线已经可用。

**device-fallback：保留备选，不作为已通过方案。** 已核对 help 和上游 device 实现；授权过程存在面向终端的交互输出。本次没有建立稳定机读授权事件协议，也没有真实企业验证。不得正则抓链接后宣称满足授权 UX。

auth exchange 不属于稳定 Agent Schema 目录，授权与解绑必须留在 UI/Host 控制面，不能将 CLI 原始入口暴露为 Agent 工具。

## 5. 下一步与完成边界

按用户安排，真实账号在最后接入。本地可继续基于已确认契约开发骨架、执行器和模拟授权/失败路径；这些工作不能关闭真实 G0 门禁。最后按 [企业联调清单](G0-enterprise-test-plan.md) 完成身份、业务、刷新、拒绝和浏览器证据后，才能决定 #4 是否关闭。

每次记录应明确真实/模拟、版本、命令、证据路径和限制。当前不创建 PR，不合并，不部署生产。基本打包、版本锁和卸载说明仍属于 P0，不因 #17 暂缓而省略。
