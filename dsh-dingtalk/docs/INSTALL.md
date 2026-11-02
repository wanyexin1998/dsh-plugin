# 安装、升级与卸载（P0 开发候选）

版本 `0.1.0-dev.3` 提供 Bundle、Local OAuth、三项只读 Tool/Skill、会话卡片和设置管理。先使用隔离 Profile；真实企业联调按 [AUTHORIZATION.md](AUTHORIZATION.md) 执行，当前不是生产发布。

本地已验证的宿主基线为官方 DSH `0.2.1-rc.5`、Cordis `4.0.5`，Node `^22.19 || >=24`。package.json 的 `engines.dsh` 暂时只声明这个确切版本，其他版本需另行验证；不授予兼容性豁免。

## 构建与打包

在插件目录执行：

```powershell
npm ci
npm run build
npm run typecheck
npm test
npm run verify:local
npm run verify:p0
npm run verify:browser
npm run verify:dsh-web
npm run verify:bundle
```

普通构建、类型检查和契约／生命周期测试只需 npm ci 安装本包的开发依赖，不依赖外部工作区。verify:bundle 另需先按 G0 文档准备官方 DSH 测试运行库，或设置 `DSH_TEST_RUNTIME` 指向已有独立测试运行库。它会打包到 `artifacts/`，通过官方 CLI 在临时 DSH_HOME 的干净 Profile 安装、加载、卸载，然后清理测试环境。

安装包默认名 `artifacts/dsh-dingtalk-0.1.0-dev.3.tgz`。包包含构建产物、公开契约、适配 Skill 与上游许可、版本锁、patch 和说明；不包含 DWS 二进制、源码、个人授权或测试 Profile。分享前重新执行验证并核对归档 SHA256。浏览器脚本默认调用已安装的 Chrome，也可用 `DSH_TEST_BROWSER` 指定浏览器完整路径。

## 安装到自己的测试 Profile

使用实际 DSH CLI 路径替换 `$taskDsh`；不要直接修改已在用的 desktop Profile。

```powershell
$taskDsh = '你的 dsh.cmd 完整路径'
& $taskDsh plugin --profile dingtalk-dev add '安装包完整路径/dsh-dingtalk-0.1.0-dev.3.tgz' --ignore-scripts
```

官方 CLI 将包加到 Profile 依赖并激活 `dsh.profile.bundles` 中的 Bundle。patch 插入 `dsh-dingtalk`，配置默认 `mode: local`。Host 提供 ConnectionService、Tool、Skill 与 UI RPC；Client 在既有设置壳注册「钉钉连接」及 `dingtalk_call` 专用 ToolView。未配置时显示明确原因，不自动授权。

启用/停用使用宿主现有插件管理；或在测试 Profile 的用户 patch 中覆盖该条目的 `disabled` 字段，重启测试实例使两端配置一致。不要修改原生设置壳、Agent 运行时或原有用户对话。

可用 `link:插件源码完整目录` 做开发安装，但必须先构建，目录也不能移动。正式归档安装不依赖源码目录。插件不自动更新或弹出授权窗口；点击连接后才启动私有配置中的 loopback 回调。Host 私有配置见 [AUTHORIZATION.md](AUTHORIZATION.md)，不要放进 Profile patch。

## 升级与回滚

保留原有安装包与校验值。在测试 Profile 使用相同的 `plugin add` 命令安装新版本归档，重启并验证加载/卸载。回滚时重新安装上一版本归档。`link:` 模式指向可变源码，回滚前需恢复对应提交并重新构建。

## 卸载

```powershell
& $taskDsh plugin --profile dingtalk-dev remove dsh-dingtalk
```

卸载前建议先在设置中「解除连接」并确认成功，再停止测试实例。官方管理器清理依赖和 Bundle 激活记录；Cordis fiber 清理 Host 服务、Tool、Skill、RPC、设置和卡片注册，取消在途/排队工作、授权事务和回调监听。旧服务引用拒绝后续调用。单纯卸载不会删除保留的 DWS 凭据。

不删除 DSH 会话和其他设置。精确解绑只处理绑定身份，不执行全局 logout；卸载不等于远端应用授权撤销。DWS logout 的服务端撤销语义须在真实联调中核实，界面不承诺撤销钉钉全局 SSO。
