# 安装、升级与卸载（#6 开发版）

版本 `0.1.0-dev.2` 提供 Bundle、服务契约、LocalBackend 和设置占位页。设置页与 Agent 尚不能发起授权/查询；Host 私有配置了已存在的精确 Profile 后，后端可以执行三项只读调用。真实企业授权留到最后联调。

本地已验证的宿主基线为官方 DSH `0.2.1-rc.5`、Cordis `4.0.5`，Node `^22.19 || >=24`。package.json 的 `engines.dsh` 暂时只声明这个确切版本，其他版本需另行验证；不授予兼容性豁免。

## 构建与打包

在插件目录执行：

```powershell
npm ci
npm run build
npm run typecheck
npm test
npm run verify:local
npm run verify:bundle
```

普通构建、类型检查和契约／生命周期测试只需 npm ci 安装本包的开发依赖，不依赖外部工作区。verify:bundle 另需先按 G0 文档准备官方 DSH 测试运行库，或设置 `DSH_TEST_RUNTIME` 指向已有独立测试运行库。它会打包到 `artifacts/`，通过官方 CLI 在临时 DSH_HOME 的干净 Profile 安装、加载、卸载，然后清理测试环境。

安装包默认名 `artifacts/dsh-dingtalk-0.1.0-dev.2.tgz`。包只包含构建产物、公开契约、版本锁、patch 和说明；不包含 DWS 二进制、源码、个人授权或测试 Profile。发布/分享前重新执行验证并核对报告的 SHA256。verify:local 另需 G0 缓存中的已校验官方 DWS，只访问隔离本地夹具。

## 安装到自己的测试 Profile

使用实际 DSH CLI 路径替换 `$taskDsh`；不要直接修改已在用的 desktop Profile。

```powershell
$taskDsh = '你的 dsh.cmd 完整路径'
& $taskDsh plugin --profile dingtalk-dev add '安装包完整路径/dsh-dingtalk-0.1.0-dev.2.tgz' --ignore-scripts
```

官方 CLI 将包加到 Profile 依赖并激活 `dsh.profile.bundles` 中的 Bundle。patch 插入名为 `dsh-dingtalk` 的条目，配置默认 `mode: local`。Host 提供 `dingtalkConnection`；Web Client 向现有设置面板注册「钉钉连接」，显示“连接功能尚未启用”，按钮不可点击。

启用/停用使用宿主现有插件管理；或在测试 Profile 的用户 patch 中覆盖该条目的 `disabled` 字段，重启测试实例使两端配置一致。不要修改原生设置壳、Agent 运行时或原有用户对话。

可用 `link:插件源码完整目录` 做开发安装，但必须先构建，目录也不能移动。正式归档安装不依赖源码目录。插件当前没有自动更新、网络回调或开机授权弹窗。可选的 Host 私有 DWS 配置见 [LOCAL-BACKEND.md](LOCAL-BACKEND.md)；它与前端/模型参数分开。

## 升级与回滚

保留原有安装包与校验值。在测试 Profile 使用相同的 `plugin add` 命令安装新版本归档，重启并验证加载/卸载。回滚时重新安装上一版本归档。`link:` 模式指向可变源码，回滚前需恢复对应提交并重新构建。

## 卸载

```powershell
& $taskDsh plugin --profile dingtalk-dev remove dsh-dingtalk
```

卸载前先停用/停止测试实例，卸载后重新启动。官方管理器清理依赖和 Bundle 激活记录；Cordis fiber 清理 Host 服务和设置注册，取消本后端在途与排队工作，旧服务引用也会拒绝后续调用。没有新增业务 Tool 或授权事务；不删除已有 DWS Profile/凭证。

不删除 DSH 会话和其他设置。未来 DWS 精确解绑/撤销由 #7 实现，不将卸载等同于远端 OAuth 撤销。
