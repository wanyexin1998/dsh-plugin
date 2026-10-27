# BOOP 安装指南（准备版）

> 状态：**准备材料**。文档中的命令与步骤尚未在真实用户 profile 上演练；"真实安装到用户
> profile" 在 E07-02 证据里明确为 `NOT_RUN`，最终放行等待 E07-01 与 M1 门账本收口。
> 本文只给步骤，不代替用户执行，也不写入用户 `$DSH_HOME`。

## 1. 产物与校验

```powershell
# 在仓库根目录构建插件包（只写 dist/，不安装、不联网）
node build.mjs
node tools/package-boop.mjs
```

产物：

| 文件 | 说明 |
|---|---|
| `dist/dsh-boop-0.1.0.tgz` | 可安装 tarball（运行时文件 + README/LICENSE/NOTICE + `assets/3d`） |
| `dist/dsh-boop-0.1.0.package.json` | 清单：tarball sha256、逐文件 sha256、检查项与 NOT_RUN 列表 |

安装前核对：

```powershell
Get-FileHash .\dist\dsh-boop-0.1.0.tgz -Algorithm SHA256
```

必须与 `dist/dsh-boop-0.1.0.package.json` 中的 `tarball.sha256` 一致，且清单里
`checks.requiredComplete` / `checks.forbiddenAbsent` 均为 `true`。**只安装经过校验的 tarball。**
插件代码在 DSH Host 进程内运行（与普通插件同权限），不要安装来源不明的副本。

安装包的普通接口不注册 PoC 方法。只有隔离测试同时写了 `pocEnabled: true` 并且进程设了 `BOOP_ALLOW_POC=1` 时，这些方法才会挂上。安装步骤两样都不做。

## 2. 前置条件

| 项 | 要求 |
|---|---|
| DSH | `0.2.1-rc.2` 或 `0.2.1-rc.3`（`engines.dsh` 只声明这两个已核对版本；不兼容宿主会拒绝加载，不使用 `compatibility.json` 豁免） |
| Node | `^22.19.0 || >=24.0.0`（由 DSH 自带运行时提供） |
| 平台 | 仅 Windows 已验证；macOS/Linux 为 `NOT_RUN`（见 `support-matrix.md`） |
| 模型服务 | 用户自有的 OpenAI 兼容服务，配置在 DSH 模型设置里；BOOP 不内置密钥 |
| 权限 | 能修改目标 profile；安装前**停止正在运行的 DSH** |

确定目标 profile：Web 用 `web`；**Desktop 使用 Electron 持有的 `desktop` profile，请用 Desktop
自带插件页/命令管理**（npm 版 CLI 拒绝其插件管理请求）。下文以 `web` 为例。

安装前备份（若此前装过 BOOP 或用过本插件）：

```powershell
# 推荐：确认 DSH 已停止后，整体复制 BOOP 数据目录
$stamp = Get-Date -Format 'yyyyMMdd-HHmmss'
Copy-Item "$env:USERPROFILE\.dsh\boop" "$env:USERPROFILE\.dsh\boop.bak-$stamp" -Recurse
```

`$DSH_HOME` 若已设置则替换上文的 `$env:USERPROFILE\.dsh`；`$DSH_HOME` 默认是 `~/.dsh`。
不要复制正在运行、带活跃 WAL 的单个 `boop.sqlite` 文件（见 `upgrade.md` 的一致备份方式）。

## 3. 方式 A（推荐）：DSH Web 插件页

1. 启动 DSH（`dsh web`），侧边栏打开 **Plugins / 插件**。
2. 选择安装本地包，填入 tarball 的**绝对路径**（`...\dist\dsh-boop-0.1.0.tgz`）。
3. 安装完成后在插件列表中**启用** `dsh-boop` bundle（安装不等于启用）。
4. 按提示重启（未启用 HMR 时），或等待 HMR 重载。
5. 侧边栏出现 BOOP 入口即装配成功；BOOP 行加载失败时插件页会显示错误原因，不要当成功。

## 4. 方式 B：CLI（把依赖装进 `web` profile）

```powershell
# 1) 停止正在运行的 DSH
# 2) 把 tarball 加入 profile 依赖（dsh plugin 把参数转发给 profile 目录中的 pnpm）
dsh plugin --profile web add "C:\absolute\path\to\dsh-boop-0.1.0.tgz"

# 3) 确认 bundle 被选中：$env:USERPROFILE\.dsh\profiles\web\package.json
#    dsh.profile.bundles 数组里必须出现 "dsh-boop"。
#    使用 Web 插件页启用最稳妥；手工编辑时只追加该项，不要重排其他 bundle。
# 4) 启动
dsh web

# 5) 只读检查装配（不启动 Host）
dsh --profile web --dump-config | Select-String -Pattern 'boop|dsh-boop'
```

期望 `--dump-config` 输出中出现 `- id: dsh-boop`、`- id: boop-api`、`- id: boop-tools`、
`- id: boop-assets`、`- id: boop-workspace`、`- id: boop-tasks` 等行（行数以实际发布为准），
且不出现 `incompatible` 跳过提示。

## 5. 安装后验证

| 检查 | 期望 |
|---|---|
| 侧边栏/入口 | 出现 BOOP 入口；普通 Session 侧栏与聊天不受影响 |
| `dsh --profile web --dump-config` | BOOP 行只出现一次，原生顶层行与未装 BOOP 时一致 |
| 未认证 API | `POST /api/boop/bootstrap` 无 cookie → **401/403** |
| 认证后 `boop/bootstrap` | 返回 scope 身份、门账本、能力矩阵；`writeModeEnabled: false` |
| BOOP 数据目录 | 首次启动后出现 `$DSH_HOME/boop/boop.sqlite`（SQLite） |
| 能力矩阵 | 只读端点可用；写入口按门拒绝（`CAPABILITY_UNAVAILABLE`），不会自动派发 |

排错要点：

- 插件页显示兼容性拒绝 → **不要**申请版本豁免绕过；升级 DSH 或使用匹配版本。
- 有依赖但无 BOOP 行 → bundle 未启用（`dsh.profile.bundles` 缺 `dsh-boop`）。
- API 401 → 缺少登录 cookie/token，属预期；不要把未认证当成插件未加载。
- 资产 404 → 包内缺 `assets/3d`；用 `tools/package-boop.mjs` 重新打包校验。

## 6. 未验证（NOT_RUN）

- 真实用户 profile 的安装（本仓库只在隔离 `.work` DSH_HOME 中启动过宿主）。
- DSH Desktop Electron 安装与 GUI 落位。
- macOS / Linux 安装（不在支持矩阵内）。
- 升级 / 回滚演练（见 `upgrade.md` / `rollback.md`，同样是准备材料）。
- 本插件的公开 registry / marketplace 发布（尚未发布）。
