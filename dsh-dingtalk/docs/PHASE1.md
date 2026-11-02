# 第一阶段：官方 Fork 与 Web 功能迁入

最初开发分支：`feat/phase1-web-integration`。当前代码已迁入 `dsh-plugin/dsh-dingtalk`，收尾按本地验证、新分支推送、PR 合并执行，详见 [仓库与维护](REPOSITORY.md)。

## 来源与范围

- 官方基线：`DingTalk-Real-AI/dsh-dingtalk@137ea79505e6317d98c1db643f0fbae138e016c8`。
- 迁入来源：`wanyexin1998/dsh-plugin@b11df21abd85a7011eac1d85c60063912eca2e31` 的 `dsh-dingtalk` 目录。
- `enhancements/src` 保留旧授权、精确 DWS Profile 执行、错误分类及 Web UI；`enhancements/tests`、`scripts`、`docs/evidence` 保留原回归资产。历史报告不代表此 fork 已验收。
- 统一包名 `@wanyexin1998/dsh-dingtalk`，一个 tarball 同时安装官方 channel 和 Web Host／Client；A2UI 导出保留。包保持 private，不发布 npm，不配置 GitHub Actions，所有检查在本地完成。

## 使用边界

Web 保留点击授权、官方 DWS 目录与通用调用（保留原三项查询兼容）、重连、精确断开、同会话提示去重、原位更新及成功行内反馈。Web 数据功能不需要配置机器人。

`0.1.0-phase1.2` 起，授权卡片位于最终回复正文下方、回复操作栏上方，折叠思考不影响操作。会话中只保留最近一次需要授权的回复尾部卡片；同轮重试不新增卡片，连接结果原位更新。已连接时重放历史授权结果不会新增提示。思考内的工具记录仅保留简短行内状态。

机器人保留 Stream、消息收发、会话、队列及命令处理；准入在官方策略之上收紧为已绑定 owner。第一阶段 IM **仅对话，不执行 Agent 工具**，包括个人 DWS、任意 shell、文件发送与其他 preset 工具。模型要求工具时由运行时拒绝并引导使用 Web；这意味着官方文件处理及依赖工具的任务暂不能在 IM 验收为可用。源代码仍保留，第二阶段在身份和工具策略完成后恢复所需能力。

此限制通过真实 DSH `tools.guard()` 实施，覆盖全局继承和作用域注册工具。缺少该接口的宿主拒绝对应 IM 任务；不降级为放行。普通机器人不借用 Web 已加载的活跃 Agent。工具 guard 不改变 Web 的本机操作权限，也不声称隔离同 OS 用户的其他程序。

官方通用 DWS Skill／进程级应用凭据注入不启用。设置中的旧 `tools.enabled` 不会开放 IM 数据。数字员工保持上游源码，但本阶段不启用、不纳入验收；不得将其当作绕过本阶段机器人边界的入口。

个人 DWS 授权与机器人 owner 尚未证明为同一个账号。这是第二阶段工作，不在第一阶段新增配对、多人凭据服务或身份转换数据库。

## 构建和本地验证

要求 Node `^22.19 || >=24`、pnpm 11。增强层当前验证宿主为 DSH `0.2.1-rc.5`，DWS 锁定 `1.0.66`。

```powershell
pnpm install --frozen-lockfile
pnpm run ci
$env:DSH_TEST_RUNTIME = '<已安装官方 DSH 的隔离测试运行库目录>'
node scripts/verify-boundary.mjs
npm run verify:bundle
npm run verify:dsh-web
npm run verify:browser
```

CI 运行原上游测试、迁入的 Web 测试、类型、格式、敏感信息扫描和 tarball 检查。`verify:boundary` 使用真实 DSH ToolRuntime 和合成工具，证明 IM 的继承／局部工具不执行，同时 Web 仍可执行。浏览器 Harness、正式 DSH Web 安装与真实钉钉企业授权分别记录，不互相替代。

本地安装使用构建好的 tarball，例如 `dsh plugin --profile web add <tarball绝对路径> --ignore-scripts`。此 fork 尚未发布 npm，不能使用 README 保留的上游 `npx ...@latest` 命令安装本定制版。机器人管理可在安装 tarball 后运行本地 `node lib/bin.js setup`；若向导要求从未发布的包安装，应停止该安装步骤，先完成 tarball 安装。

`enhancements/scripts` 中未改为根级入口的历史 G0／P0 脚本按旧目录布局留作参考，不作为新的单包安装命令。以根级 package.json 命令为当前入口。

## 旧版切换与回滚

不对正在运行的旧服务自动切换。先用独立 DSH_HOME／Profile 验证新 tarball；独立 Profile 需要自行授权，不能导出旧 Token。

正式切换时停止旧 Host，在**同一 DSH_HOME 和同一 Profile 路径**中卸载旧 `dsh-dingtalk` 包、安装此 fork 的精确 tarball，然后启动 Host。不要同时加载两包，它们有相同服务和 UI 路由。Web 状态派生算法、`dsh-dingtalk` 状态命名空间与 DWS lock 保持原样，因此同路径可继续引用旧绑定；启动后仍须在线核验，不能单靠绑定文件宣告 connected。更换 Profile 路径不自动搬迁账号。

保留原 tarball 与安装清单，回滚时停新 Host、卸载 fork、恢复旧包；不删除 plugin-state，不批量注销其他 DWS Profile。用户主动撤销的授权不得因回滚恢复：精确注销失败或无法确认旧版能识别撤销状态时，保持停用，须重新授权后才能恢复服务。授权不随代码回滚恢复。

## 尚需人工验收

真实企业授权／拒绝账号、真实 LLM 中文意图及机器人私聊／群聊，需要用户完成扫码与消息操作；本次自动化不发送真实钉钉消息、不读取旧服务凭据。Desktop、多用户、跨入口个人身份一致性、数字员工均不属于本阶段完成声明。

Web 能力扩展与当前验证范围见 [DWS-CAPABILITIES.md](DWS-CAPABILITIES.md)。IM 身份统一仍不属于本阶段。
