# BOOP（波波）— DSH 原生个人项目助理

BOOP 是一个运行在 **DeepSeek Harness (DSH)** 里的本地插件：一个身份、一条主聊天，
帮你在已授权范围内委托既有 Session 推进项目、跟踪任务三轴状态，并谨慎地停下来等你确认。
它不是另一套 Agent 平台，也不替换 DSH 的原生 Session / Agent / 工具。

> 当前版本：`0.1.0`（**写模式仍关闭**：G02/G05 等验证门未全部通过前，BOOP 只提供只读面、
> 任务投影与人工审批/停止/恢复，不会自动派发执行。）

## 依赖

| 项 | 要求 |
|---|---|
| DSH | **`0.2.1-rc.2`**（插件清单声明 `engines.dsh`，不兼容的宿主会拒绝加载，本插件不申请版本豁免） |
| Node | `^22.19.0 \|\| >=24.0.0`（由 DSH 自带运行时提供） |
| 平台 | **仅 Windows 已验证**；macOS / Linux 为 `NOT_RUN`，未宣称支持（见支持矩阵） |
| 模型服务 | 用户自有的 OpenAI 兼容服务（如自托管 vLLM/Qwen）。BOOP 不内置、不索取、不保存任何模型密钥 |

## 安装（尚未做真实用户 profile 验收，以下为文档化步骤）

> 本包尚未发布到任何 registry。请使用本仓库构建产出的本地 tarball（`.tgz`）。
> **文中命令是给用户的步骤，不会由插件或本仓库替用户执行。** 真实安装/升级/回滚演练
> 仍为 `NOT_RUN`，等 E07-01 完成。

### 方式 A（推荐）：Web 端插件页

1. 启动 DSH Web（`dsh web`）。
2. 侧边栏打开 **Plugins / 插件** 页。
3. 安装本地 tarball（`.tgz` 绝对路径），插件包名为 `dsh-boop`。
4. 在已安装插件列表中**启用** `dsh-boop` 这个 bundle（未启用时不会加载）。
5. 启用后按提示重启，或等待 HMR 重载；侧边栏应出现 BOOP 入口。

### 方式 B：CLI（把依赖装进指定 profile）

```powershell
# 1) 停止正在运行的 DSH（同一 profile 不要在运行时改插件包）
# 2) 把本地 tarball 加入 profile 依赖（dsh plugin 会把参数转发给 profile 目录里的 pnpm）
dsh plugin --profile web add "C:\path\to\dsh-boop-0.1.0.tgz"

# 3) 检查 profile 清单：$DSH_HOME\profiles\web\package.json
#    dsh.profile.bundles 数组里必须出现 "dsh-boop"（Web 插件页启用/停用会维护它；
#    手工编辑时只追加这一项，不要改其他 bundle 的顺序）
# 4) 重新启动
dsh web
```

- `$DSH_HOME` 默认是 `~/.dsh`（Windows：`C:\Users\<你>\.dsh`），可用 `$env:DSH_HOME` 覆盖。
- **Desktop** 使用 Electron 持有的 `desktop` profile：请用 **Desktop 的插件页/自带命令**管理，
  不要用 npm 版 CLI 直接改它。Desktop 侧安装验收为 `NOT_RUN`。

## 停用 / 卸载

- **停用（保留数据，推荐）**：插件页把 `dsh-boop` 开关关闭（或从 `dsh.profile.bundles`
  移除该 bundle），重启后 BOOP 行不再加载；`$DSH_HOME\boop\` 里的数据保留。
- **移除包**：`dsh plugin --profile web remove dsh-boop`（先停用/停 Host）。
- **删除 BOOP 自有数据**（只在明确需要时）：先备份 `$DSH_HOME\boop\`，再手动删除该目录。
  这只会删除 BOOP 自己的账本（任务/审批/记忆索引），**不会删除**你的 DSH Session、
  原生工作区注册或项目文件。
- 卸载不会留下后台进程：BOOP 全部逻辑运行在 DSH Host 进程内，没有独立服务。

## 数据放在哪里

| 数据 | 位置 | 说明 |
|---|---|---|
| BOOP 账本 | `$DSH_HOME\boop\boop.sqlite`（SQLite，WAL） | 任务/动作/审批/审计/记忆索引与读取水位；单写者租约 |
| DSH Session、主聊天、任务真实执行记录 | DSH 原生数据目录 | 由 DSH 管理，BOOP 只读或经授权连接，不复制聊天全文 |
| 你的项目文件 | 原位置 | BOOP 不移动、不删除项目文件 |

升级前请先备份 `$DSH_HOME\boop\`（升级步骤与回滚见发布文档）。

## 模型服务边界

- BOOP 的对话/派发走 **DSH 已配置的模型路由**（用户在 DSH 设置里配置的服务地址、模型与
  凭据引用）。BOOP 不内置供应商、不硬编码地址、不猜测上下文长度。
- 模型服务是**唯一的外发边界**：发给模型的内容就是正常对话/上下文；不额外上传账本或项目文件。
- 模型不可用时，BOOP 如实报告不可用，不静默切换到其他供应商，也不伪造结果。

## 隐私

- 数据默认**全部本地**：账本在 `$DSH_HOME`，不外发。
- **不收集遥测**；本插件不连接任何 BOOP 自有服务器（不存在这样的服务）。
- 渠道（钉钉/飞书）默认关闭，需要用户单独配置凭证后才启用。
- 证据/截图/日志在公开发布前须脱敏；本仓库已提交的证据均为合成数据，不含真实对话或凭证。

## 许可与归属

- 项目许可：**Apache License 2.0**（见 [LICENSE](LICENSE)）。
- 第三方来源、修改声明与资产归属：见 [NOTICE](NOTICE)。
  - 任务看板客户端部分为 `chuspeeism/dashi-taskboard`（Apache-2.0，固定提交
    `723c400eec86c454c1ffa56ee1b500746d41e142`）的**改写式提取**；
  - 角色与 3D 资产由项目所有者提供，不随附任何第三方品牌/字体/图标素材。

## 文档

- 安装/升级/回滚/卸载、隐私与支持矩阵：仓库 `docs/development/release/`。
- 当前验证状态（哪些 Gate/平台是 PASS 或 NOT_RUN）：仓库 `docs/development/STATUS.md`。
  未运行的项目一律 `NOT_RUN`；不要把它们当作已支持。
