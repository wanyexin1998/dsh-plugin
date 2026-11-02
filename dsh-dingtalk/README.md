# dsh-dingtalk

DSH 钉钉插件开发版 `0.1.0-dev.1`。当前交付 [Issue #5](https://github.com/wanyexin1998/dsh-plugin/issues/5) 的可安装 Bundle 骨架、ConnectionService 契约和「钉钉连接」设置占位页，保留 #4 的 G0 本地验证工具和证据。**授权和钉钉业务调用尚未接入。**

当前范围以 [Epic #3](https://github.com/wanyexin1998/dsh-plugin/issues/3) 为准：只执行原生 DSH P0（#4–#13）；Cellgent、独立 Connector、企业 SSO 和 #14–#17 暂缓。DWS 是独立的官方依赖，本仓库不包含其 Go 源码、二进制、真实凭证或上游测试源码副本。

- [G0 可行性报告](docs/G0-feasibility.md)：已验证事实、待联调项和 HOLD 结论。
- [本地复现说明](docs/G0-local-validation.md)：隔离安装、Schema 采集和本地 OAuth 夹具。
- [真实联调清单](docs/G0-enterprise-test-plan.md)：最后接入测试应用、账号时执行。
- [版本与校验锁](dws.lock.json)：DWS 1.0.66 发布制品、命令映射和验证指纹。
- [安装、升级、卸载](docs/INSTALL.md)：构建归档并安装到隔离测试 Profile。
- [ConnectionService 契约](docs/CONTRACT.md)：公共 DTO、错误码、适配器与生命周期边界。

本地脚本只使用临时配置目录和合成测试身份；Windows 另隔离 DPAPI 注册表命名空间。脚本不会安装到全局 PATH、修改现有 DSH Profile，或发起真实钉钉登录。真实企业 OAuth、企业权限及浏览器回调验收尚未完成，不关闭 #4、不宣称 G0 通过。

在本目录执行 `npm ci`、`npm run build`、`npm run typecheck`、`npm test`；准备 G0 的官方测试运行库后执行 `npm run verify:bundle`，归档输出至 `artifacts/`。当前宿主兼容范围锁定官方 DSH `0.2.1-rc.5`，需要 Node `^22.19 || >=24`。

生产骨架只支持 `mode: local`，状态为 unknown/backend_not_ready；授权报未就绪、解绑返回 false、工具调用明确失败。`cellgent` 模式本期明确拒绝，双模拟适配器只用于契约测试，不装进归档。

后续工程目标：LocalBackend → 三项只读 Tool/Skill → 会话授权卡片与完整设置管理 → 安全及真实 E2E 验收。当前分支只提交推送，按用户要求暂不创建 PR。
