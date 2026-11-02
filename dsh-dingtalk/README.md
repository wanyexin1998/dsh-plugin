# dsh-dingtalk

DSH 钉钉插件开发版 `0.1.0-dev.2`。在 #5 Bundle 和公共契约基础上实现 [Issue #6](https://github.com/wanyexin1998/dsh-plugin/issues/6) 的 LocalBackend：校验官方 DWS、精确 Profile、三项只读调用、串行队列、超时取消、输出限制和脱敏。**首次授权、Agent Tool 和完整连接 UI 尚未接入。**

当前范围以 [Epic #3](https://github.com/wanyexin1998/dsh-plugin/issues/3) 为准：只执行原生 DSH P0（#4–#13）；Cellgent、独立 Connector、企业 SSO 和 #14–#17 暂缓。DWS 是独立的官方依赖，本仓库不包含其 Go 源码、二进制、真实凭证或上游测试源码副本。

- [G0 可行性报告](docs/G0-feasibility.md)：已验证事实、待联调项和 HOLD 结论。
- [本地复现说明](docs/G0-local-validation.md)：隔离安装、Schema 采集和本地 OAuth 夹具。
- [真实联调清单](docs/G0-enterprise-test-plan.md)：最后接入测试应用、账号时执行。
- [版本与校验锁](dws.lock.json)：DWS 1.0.66 发布制品、命令映射和验证指纹。
- [安装、升级、卸载](docs/INSTALL.md)：构建归档并安装到隔离测试 Profile。
- [ConnectionService 契约](docs/CONTRACT.md)：公共 DTO、错误码、适配器与生命周期边界。
- [LocalBackend 配置与边界](docs/LOCAL-BACKEND.md)：Host 私有绑定、命令映射、资源策略和日志限制。

本地脚本只使用临时配置目录和合成测试身份；Windows 另隔离 DPAPI 注册表命名空间。脚本不会安装到全局 PATH、修改现有 DSH Profile，或发起真实钉钉登录。真实企业 OAuth、企业权限及浏览器回调验收尚未完成，不关闭 #4、不宣称 G0 通过。

在本目录执行 `npm ci`、`npm run build`、`npm run typecheck`、`npm test`；准备 G0 的官方测试运行库后执行 `npm run verify:bundle`，归档输出至 `artifacts/`。当前宿主兼容范围锁定官方 DSH `0.2.1-rc.5`，需要 Node `^22.19 || >=24`。

只支持 `mode: local`。未指定受信 DWS 时返回 unknown/cli_missing；未绑定精确 Profile 时不读取默认账号。授权和解绑仍留给 #7；`cellgent` 模式本期明确拒绝，测试适配器不装进归档。

准备 G0 的已校验官方 CLI 后可执行 `npm run verify:local`，使用隔离的合成身份验证三项查询、刷新和默认 Profile 不变，不接触真实授权。插件不转发原始错误/日志；上游 DWS 诊断日志的查询参数保留已记录，发布前仍需完成日志隐私评审。

后续工程目标：OAuth → 只读 Tool/Skill → 会话授权卡片与完整设置管理 → 安全及真实 E2E 验收。当前分支只提交推送，按用户要求暂不创建 PR。
