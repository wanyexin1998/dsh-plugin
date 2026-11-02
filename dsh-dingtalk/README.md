# dsh-dingtalk

DSH 钉钉插件开发候选 `0.1.0-dev.6`。安装后点击「连接钉钉」即可打开用户授权页；自动准备固定版本 DWS 和官方应用，无需用户手填 JSON。提供精确账号绑定、三项只读 Agent Tool、适配 Skill、克制的会话卡片和独立设置分区。**当前 G1 为 BLOCKED，真实企业联调尚未完成，不能部署生产。**

当前范围以 [Epic #3](https://github.com/wanyexin1998/dsh-plugin/issues/3) 为准：只执行原生 DSH P0（#4–#13）；Cellgent、独立 Connector、企业 SSO 和 #14–#17 暂缓。DWS 是独立的官方依赖，本仓库不包含其 Go 源码、二进制、真实凭证或上游测试源码副本。

- [G0 可行性报告](docs/G0-feasibility.md)：已验证事实、待联调项和 HOLD 结论。
- [本地复现说明](docs/G0-local-validation.md)：隔离安装、Schema 采集和本地 OAuth 夹具。
- [真实联调清单](docs/G0-enterprise-test-plan.md)：最后接入测试应用、账号时执行。
- [版本与校验锁](dws.lock.json)：DWS 1.0.66 发布制品、命令映射和验证指纹。
- [安装、升级、卸载](docs/INSTALL.md)：构建归档并安装到隔离测试 Profile。
- [ConnectionService 契约](docs/CONTRACT.md)：公共 DTO、错误码、适配器与生命周期边界。
- [LocalBackend 配置与边界](docs/LOCAL-BACKEND.md)：Host 私有绑定、命令映射、资源策略和日志限制。
- [安装后授权与真实联调](docs/AUTHORIZATION.md)：用户连接步骤、自动准备、现场验收及可选维护者覆盖。
- [本次流程补齐验收](docs/INSTALL-CONNECT-ACCEPTANCE.md)：无 JSON 安装授权路径与当前证据边界。
- [OAuth 回调兼容修复](docs/OAUTH-CALLBACK-ACCEPTANCE.md)：dev.5 支持一致的 code / authCode 双字段回调。
- [查询反馈与授权提示](docs/QUERY-FEEDBACK-ACCEPTANCE.md)：dev.6 文档结果适配、授权提示去重、成功与普通失败行内展示。
- [P0 验收矩阵](docs/P0-ACCEPTANCE.md)：#7–#13 的实现、证据与待验收项。
- [安全复核记录](docs/SECURITY-REVIEW.md)：威胁模型、独立架构复核和负向验证范围。

本地脚本只使用临时配置目录和合成测试身份；Windows 另隔离 DPAPI 注册表命名空间。脚本不会安装到全局 PATH、修改现有 DSH Profile，或发起真实钉钉登录。真实企业 OAuth、企业权限及浏览器回调验收尚未完成，不关闭 #4、不宣称 G0 通过。

在本目录执行 `npm ci`、`npm run build`、`npm run typecheck`、`npm test`；准备 G0 的官方测试运行库后执行 `npm run verify:bundle`，归档输出至 `artifacts/`。当前宿主兼容范围锁定官方 DSH `0.2.1-rc.5`，需要 Node `^22.19 || >=24`。

只支持 `mode: local`。默认使用官方托管应用，首次在线核验身份后建立绑定，不读取既有默认账号。模型只能调用 `dingtalk_call({operationId,args})` 的本人信息、日程和文档搜索；授权及精确解绑由已认证的浏览器 UI 发起。`cellgent` 模式本期明确拒绝，测试适配器不装进归档。

准备 G0 的已校验官方 CLI 后执行 `npm run verify:p0`，用真实官方二进制与本地合成端点验证授权到解绑；`npm run verify:browser` 验证 React/Host RPC 浏览器链路；`npm run verify:dsh-web` 验证安装归档后的官方 DSH Web。每份报告独立标明模拟、原生与真实企业证据边界。旧 `verify:local` 保留 #6 日志行为对照；新 managed 模式关闭 DWS 参数审计，并在新建插件目录中使诊断 logger 进入 no-op 模式，不修改已有用户日志。

当前分支只提交推送，按用户要求暂不创建 PR。真实授权、企业权限分类、LLM 意图选择和 Desktop 证据不足时，保持 Issue 开放。
