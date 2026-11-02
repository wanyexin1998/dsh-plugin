# LocalBackend / DWS-03

对应 #6 执行器与 #7–#13 managed 入口。当前验证平台为 Windows x64，官方 DWS `1.0.66`、完整 commit `f215043e676d6889e1ddce3464828d8b1ec40c31`。其他平台目前只有发行制品元数据，不承诺二进制运行已验收。

## Host 私有配置

DSH 会向 Client 投影插件配置，因此二进制路径、凭证目录和 Profile 不放在 `cordis.patch.yml`，也不作为 Tool 入参。由启动 Host 的环境变量 `DSH_DINGTALK_CONFIG_FILE` 指向本机私有 JSON 文件，例如：

```json
{
  "binaryPath": "C:\\Tools\\dws\\dws.exe",
  "configDirectory": "C:\\Users\\example\\.dws",
  "profile": "corp-id:user-id"
}
```

这些是占位路径/身份。配置只接受 binaryPath、configDirectory、keychainDirectory、profile；不接受命令、URL、env、Token 或 AppSecret。文件最多 16 KiB，路径须为本机绝对路径，拒绝 UNC/网络路径。configDirectory 省略时沿用当前 OS 用户的 DWS 默认目录；keychainDirectory 仅传给官方支持该参数的后端，不能把它当作 Windows 注册表隔离方案。

上例保留底层 #6 测试 seam 的说明；当前生产 managed 入口配置以 [AUTHORIZATION.md](AUTHORIZATION.md) 为准。profile 若显式配置，必须等于 OAuth 预期 corpId:userId；绑定实际由在线身份建立。managed 的 configDirectory 强制为私有 JSON 同级的 dsh-dingtalk-state/dws，不能指向既有用户配置目录。未配置 OAuth 时，生产 Tool 不能仅凭人工 profile 开始读取。

环境变量未提供时不扫描个人配置、不从 PATH 选程序、不猜测用户账号，状态明确为 cli_missing。不要在聊天、Git 或截图中提供私有配置文件或任何授权材料。

## 版本与执行边界

运行前解析真实文件路径，确认普通可执行文件，按包内 dws.lock.json 核对 SHA256 和 PE 架构；通过后才执行 --version，并核对固定版本和完整 commit。后续每次业务进程调用重新核对二进制哈希。其他版本或损坏制品在执行前拒绝；不能为了诊断版本先运行未验证程序。

用 Node spawn 的 argv 数组执行，shell=false，stdin 关闭；不弹窗。工作目录固定在校验后的 CLI 所在目录，不使用 Agent 项目 cwd。仅继承必要 OS 变量，不继承 DWS/DingTalk 调试端点、代理、AppSecret 或模型密钥变量；受信配置目录按固定键注入。关闭 CLI 更新检查，不使用 debug/verbose，也不自动安装或升级。

静态命令映射：

| operationId | 实际 CLI | 参数约束 |
| --- | --- | --- |
| identity.getSelf | contact user get-self | 无业务参数 |
| calendar.listEvents | calendar event list | start/end、limit、cursor；固定 calendar-id=primary |
| docs.search | doc search | query、limit、cursor；上游弃用提示仍见 G0 兼容报告 |

每条业务命令都带唯一精确 `--profile=corpId:userId` 和 `--format=json`。动态值统一采用 `--key=value`，即使 query/cursor 以 -- 开头也只作为该值，不成为新 flag。未知字段、写操作、任意 Raw API/URL/Profile/文件路径在启动任何进程前拒绝。

## 状态与身份

状态检查仅运行精确 Profile 的 `auth status --readonly`，不迁移、修复、退出或清理凭证。任何 readonly reason（含 unreadable、repair、DEK/Keychain 等）都优先解释为无法确认；不因 authenticated=false 猜测注销。

本地 token_valid=true 只代表缓存可用，不代表企业 CLI 业务开通：首次返回 business_verification_required。每个业务操作先用相同 Profile 在线 get-self，严格核对 corpId/userId，再执行所需命令；身份不符拒绝，不继续日历或文档读取。

成功后才记录已验证能力。connected 的 checkedAt 是最近一次成功在线业务验证的时间，不会用本地检查时间冒充在线确认；错误/身份变化会清除可用性缓存，但不删除凭证。Token 到期且有刷新空间时保留 unknown/token_refresh_pending，正常业务调用交给官方 DWS 刷新，不让插件索取或保存 Token。

## 资源与错误

| 公共 execution 配置 | 默认 | 可配范围 |
| --- | --- | --- |
| timeoutMs | 15000 | 100–120000 ms |
| maxOutputBytes | 262144 | 1024–2097152 |
| queueLimit | 8 | 0–32 个等待任务 |
| queueTimeoutMs | 5000 | 50–60000 ms |

同一个绑定后端一次只运行一个操作，整个状态/身份/业务链共用执行 deadline；队列等待另有限额/期限。AbortSignal 只能来自 Host 操作上下文；排队取消不会启动 CLI。卸载取消队列和在途进程，并等待清理。Windows 用固定系统 taskkill /T /F，Unix 进程组用 SIGKILL；本次实测了 Windows 父子进程退出。跨实例凭证并发仍由官方 DWS 的持久化锁处理。

合计限制 stdout+stderr 字节数，严格解析 UTF-8/JSON，限制业务 JSON 深度与节点，删除常见凭证字段并遮蔽带标记的 Bearer/Code/Secret 值。输出超限/解析失败即受控失败，不把部分结果当完整成功。未知字段名下的任意文本无法靠模式保证识别所有秘密，因此仍需 #8 的业务结果映射及 #12 隐私审查。

不返回原始 CLI 错误、hint、堆栈或路径。仅依官方结构化 error.category=auth + code/退出码 2 归类 connection_unknown；不将 HTTP 403、认证文本或退出 2 猜成 IT 未开通/必须重授权。其余失败使用 cli_failed 等稳定原因码，完整错误分类待 #11。

## 上游日志的已知边界

旧 #6 对照测试确认官方 DWS 默认诊断日志保留搜索关键词，错误路径还记录响应片段；默认 audit 也保留参数。新 managed 入口只创建新的插件目录，将 logs 设为零字节普通文件，让固定上游 Setup 的 MkdirAll 失败进入 no-op logger；调用前检查固定 marker、文件类型和大小。子进程固定 DWS_AUDIT=0，剥离继承的日志/审计转发变量。官方二进制合成成功/失败路径的全目录哨兵扫描确认未落盘 query/code/Token/错误正文。不删除或修改既有用户日志；升级 DWS 必须重验这一行为。

未修改/复制 DWS Go 源码，未擅自删除或篡改用户日志；将此项保留在 #12 / 发布前安全验收中，真实企业联调和上线前必须解决日志策略。当前测试仅用合成身份/数据，临时目录和测试注册表命名空间结束后清理。

这是当前 OS 用户权限范围内的本地执行器，不是抵抗同用户任意程序的凭证沙箱；二进制校验也不宣称消除同用户替换文件的所有时序风险。生产 Cellgent 凭证隔离仍属于后置阶段。

## 验证

`npm test` 使用真实 Node 子进程夹具验证命令、错误、队列与进程清理。`npm run verify:local` 使用已校验官方 DWS 与仅监听 loopback 的本地 MCP/OAuth 夹具验证三项只读调用、绑定 B 而默认 A 不变，以及 Token 刷新。调试端点/测试环境注入仅存在于可信内部测试 seam，不是生产配置或 Agent API。

这些通过不代表真实企业 OAuth、IT 权限或应用 scope 通过。当前三种 Tool、授权/重授权/精确解绑及浏览器交互另有本地集成报告；#4 G0 保持 HOLD，G1 状态见 P0-ACCEPTANCE.md。
