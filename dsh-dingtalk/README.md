# dsh-dingtalk

DSH 钉钉插件的开发目录。当前交付 [Issue #4](https://github.com/wanyexin1998/dsh-plugin/issues/4) 的 G0 本地验证工具和证据，**尚不是可安装使用的插件**。

当前范围以 [Epic #3](https://github.com/wanyexin1998/dsh-plugin/issues/3) 为准：只执行原生 DSH P0（#4–#13）；Cellgent、独立 Connector、企业 SSO 和 #14–#17 暂缓。DWS 是独立的官方依赖，本仓库不包含其 Go 源码、二进制、真实凭证或上游测试源码副本。

- [G0 可行性报告](docs/G0-feasibility.md)：已验证事实、待联调项和 HOLD 结论。
- [本地复现说明](docs/G0-local-validation.md)：隔离安装、Schema 采集和本地 OAuth 夹具。
- [真实联调清单](docs/G0-enterprise-test-plan.md)：最后接入测试应用、账号时执行。
- [版本与校验锁](dws.lock.json)：DWS 1.0.66 发布制品、命令映射和验证指纹。

本地脚本只使用临时配置目录和合成测试身份；Windows 另隔离 DPAPI 注册表命名空间。脚本不会安装到全局 PATH、修改现有 DSH Profile，或发起真实钉钉登录。真实企业 OAuth、企业权限及浏览器回调验收尚未完成，不关闭 #4、不宣称 G0 通过。

后续工程目标：独立 Bundle → LocalBackend → 三项只读 Tool/Skill → 会话授权卡片与设置页 → 安全及真实 E2E 验收。当前分支只提交推送，按用户要求暂不创建 PR。
