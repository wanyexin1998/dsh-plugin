# E07-02 · 隔离 profile 安装 / 升级 / 卸载演练报告

> 结论先行：**从真实打包产物 tarball 安装到私有 DSH profile → 启动 → BOOP 行/API/3D 资产可用 → 重装 → 卸载后端点消失且账本保留，20 个阶段全部 PASS。**
> 本演练**未触碰用户的真实 `~/.dsh` profile**；真实用户环境安装与真实版本升级（旧版本→新版本）仍为 `NOT_RUN`。

## 0. 证据

- 脚本：`tools/rehearse-install.mjs`（可复现；只写 `.work/` 与证据目录，不安装到用户 profile）
- 原始结果：`docs/development/evidence/e07-02/install-rehearsal-2026-10-18T04-46-10-768Z.json`
- 产物：`dist/dsh-boop-0.1.0.tgz`（sha256 `0cbd2f7e324a2b113d44a24ca52e4ce12204cb99dee7bcad08cb73e0a8b71e8a`，26 files）
- 环境：Windows 10/11 · DSH 0.2.1-rc.2（payload `.work/test-host/payload-0.2.1/dsh`）· Node v24.18.0 · 私有 DSH_HOME `.work/test-runs/e07-02-rehearsal-*`

## 1. 步骤与结果

| # | 阶段 | 结果 |
|---|---|---|
| 1 | 私有 DSH_HOME 中用 `--from-default-profile web` 初始化 profile（不触碰真实 profile） | PASS |
| 2 | `dsh plugin --profile boop-install add <tgz>` 从 tarball 安装 | PASS |
| 3 | 安装后包内容核对：`lib/index.js`、`lib/client.js`、`cordis.patch.yml`、`assets/3d/boop.glb` | PASS |
| 4 | profile `dsh.profile.bundles` 加入 `dsh-boop` 后启动真实 Host | PASS |
| 5 | `/api/boop/bootstrap` 鉴权后 200，`scope.dshProfileVersion = 0.2.1-rc.2` | PASS |
| 6 | 打包的 3D 资产路由返回 200（`/api/boop/model.glb`） | PASS |
| 7 | 门账本仍为 `writeMode.enabled=false`，blockedBy `G05,G08,G09`（G01/G02/G03/G04/G06 PASS） | PASS |
| 8 | 首次启动在私有 `$DSH_HOME/boop/boop.sqlite` 创建账本 | PASS |
| 9 | **升级原语**：再次安装同一 tarball（覆盖安装） | PASS |
| 10 | 覆盖安装后再次启动：bootstrap 200、资产 200、门账本一致 | PASS |
| 11 | `dsh plugin remove dsh-boop` 卸载 | PASS |
| 12 | 卸载后启动：`/api/boop/bootstrap` 返回 404 | PASS |
| 13 | 卸载后账本文件仍在、大小稳定（不删除用户数据） | PASS |

## 2. 发现与修复

1. CLI 首次 `plugin add` 初始化的是**最小 profile**（仅 `@deepseek-ai/dsh-base`，没有 `dsh-web-app`），直接启动 web 会挂起（`connection`/`agentPresets` 等待）。真实安装步骤必须先有 web/desktop profile，再添加插件 —— 已写入 `docs/development/release/install.md` 的步骤并固化进本脚本；runbook 强调"先有目标 profile，再装 bundle"。
2. launch token 交换必须使用**服务器打印的原始 URL**：token 可能含 `+`，先 `URLSearchParams.get` 再重新编码会把 `+` 变成空格并得到 400。脚本已改为精确使用打印的 URL（对用户无影响，仅运维/自动化注意）。

## 3. 未覆盖（如实）

- **真实用户 profile** 的安装/升级/卸载（需用户明确授权后才做；本演练使用一次性私有 DSH_HOME）。
- **真实版本到版本升级**（tarball 只有 0.1.0；"再次覆盖安装"只证明升级原语可用，不证明 schema/数据在旧→新版本间的兼容）。
- Desktop（Electron）界面路径与桌面端菜单入口。
- 升级前备份 → 回滚的真实演练（备份机制在合成账本上已验证，见 `backup-check.json`）。
- 公开 registry 发布（包保持 `private:true`，防误发布）。
