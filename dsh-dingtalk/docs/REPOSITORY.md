# 仓库与维护

定制产品源码位于 `wanyexin1998/dsh-plugin` 的 `dsh-dingtalk/`，与 `dsh-chat/` 并列。它是普通目录，不是 Git submodule，不含嵌套 `.git`。日常功能开发、问题与 PR 都在大仓库完成。

## 官方来源与保留内容

- 官方仓库：<https://github.com/DingTalk-Real-AI/dsh-dingtalk>。
- 独立跟踪 fork：<https://github.com/wanyexin1998/dsh-dingtalk>，`main` 跟随官方。
- 本次导入的官方基线：`137ea79505e6317d98c1db643f0fbae138e016c8`。
- 定制开发起点：`850a1b0e533cfd1bcec08e20c1280cab23dc1c18`；收尾前的工作树已推送到独立 fork 的 `archive/custom-web-20261103` 分支，备份提交 `e05c9fb102cab22d86a14bf1e688bb2b57310d66`。交付状态见 [收尾记录](CLOSEOUT.md)。
- 早期自研授权代码来源：`dsh-plugin@b11df21abd85a7011eac1d85c60063912eca2e31`。旧开发分支保留。
- 官方 MIT 许可和声明保留；DWS 目录与技能的 Apache-2.0 许可、NOTICE、版本与校验锁保留。
- `enhancements/` 保留授权、Host/Client、紧凑前端、工具名称、DWS 目录、执行边界和测试资产。包名及导出不变。

## 本地布局

```text
E:\Code\dsh-plugin\
  dsh-dingtalk\          日常开发、构建、验证
  dsh-chat\             其他插件保持独立
  .cache\               本机缓存与迁移备份，不提交
E:\Code\dsh-dingtalk-official\
                         仅跟踪官方 main，保留定制备份分支
%LOCALAPPDATA%\dsh-dt\
                         本地预览的 Profile、授权及会话数据，不提交
```

不要在两个源码副本中同时开发产品功能。运行态凭据和 Profile 独立保存，切换官方分支不会覆盖个人授权。

## 验证与提交

使用 Windows x64、Node `^22.19.0 || >=24.0.0`、pnpm 11；本次验证为 Node 22.23.2、pnpm 11.25.0。以下命令在插件目录执行：

```powershell
pnpm install --frozen-lockfile
# 首次运行，下载并校验锁定的 DWS；已有校验过的缓存时跳过
pwsh -File enhancements/scripts/g0/bootstrap-dws.ps1
pnpm run ci
pnpm run verify:browser
# 指向本机已安装 @deepseek-ai/dsh 的测试运行时目录
$env:DSH_TEST_RUNTIME = 'E:\Code\dsh-plugin\.cache\dingtalk-g0\dsh-runtime'
npm run verify:dsh-web
```

安装定制包时在该目录构建 tarball，再添加到需要使用的本机 DSH Profile。不要使用 README 下方保留的官方 NPM 安装命令代替定制包：

```powershell
New-Item -ItemType Directory -Force artifacts | Out-Null
npm pack --pack-destination artifacts
dsh plugin --profile <你的WebProfile名称> add .\artifacts\wanyexin1998-dsh-dingtalk-0.2.0-dev.5.tgz --ignore-scripts
```

当前开发预览继续使用 `http://127.0.0.1:19877`；迁移后的本机启动脚本位于 `%LOCALAPPDATA%\dsh-dt\launch.mjs`，从本目录安装已验证的 tarball。授权与会话备份保留在原目录的忽略缓存中，迁移不清空授权。需要重启预览时，先停止该预览实例，再执行：

```powershell
Start-Process -FilePath node -ArgumentList ('"' + "$env:LOCALAPPDATA\dsh-dt\launch.mjs" + '"') -WindowStyle Hidden
```

`ci` 仅是本地检查脚本，不是远程自动化。不配置 GitHub Actions，不执行 NPM 发布。先完成本地验证，再推送新分支、创建 PR、审查并合并主分支。真实企业全量业务、机器人私聊/群聊以及跨入口身份一致性仍需单独验收，不用模拟端点测试代替。

## 跟进官方更新

1. 在独立跟踪目录 fetch upstream，确认 main 没有定制提交后，以 `--ff-only` 更新官方 main；不强制覆盖分叉历史。
2. 从本文件记录的官方基线比较到新的官方 SHA，审查依赖、入口、协议和权限变更。
3. 在大仓库新分支中按差异迁入 `dsh-dingtalk/`。不直接覆盖整个目录，也不把 fork main 的 Actions 工作流复制进来。
4. 解决与定制代码的冲突，更新官方基线、第三方声明及必要测试；执行全部本地验证后通过 PR 合并。

两个远程仓库的维护策略都是禁用 Actions；远程设置的执行状态见 [收尾记录](CLOSEOUT.md)。跟踪 fork 保留官方 Git 历史中的工作流文件，必须确认远程 Actions 已禁用后再推送分支；产品目录不携带这些工作流。
