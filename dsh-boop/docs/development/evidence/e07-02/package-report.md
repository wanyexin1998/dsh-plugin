# E07-02 打包 / 许可 / 运维准备 · 证据报告

> 范围：安装包完整性修复、许可与归属材料、运维 runbook、隐私与支持矩阵的**准备**。
> 结论先行：**打包链路已真实跑通并可复现；安装/升级/回滚/发布放行仍为 `NOT_RUN`**，
> 等待 E07-01 与 M1 门账本收口。本报告不含任何"预计可用"的 PASS。

## 0. 状态一览

| 项 | 状态 | 证据 |
|---|---|---|
| `files` 白名单修复（补 `assets/3d`、`NOTICE`，排除 dev test bundle 与内部素材） | **PASS** | `npm pack --dry-run --json` 26/26 条目；`package-manifest.json` |
| `tools/package-boop.mjs` 构建+校验工具 | **PASS** | 两次运行 tarball sha256 相同、`reproducible: true` |
| tarball 内容完整性（lib/*、cordis.patch.yml、presets/*、assets/3d/*、README/LICENSE/NOTICE） | **PASS** | 解包校验 26/26 必需条目，0 禁止条目，sha512 与 npm 一致 |
| LICENSE（Apache-2.0 全文） | **PASS**（文件级） | 11,558 bytes，sha256 `1eb85fc9…e9c8c6` |
| NOTICE（项目 + 上游 dashi-taskboard 归属/修改声明 + 用户提供视觉资产 + 宿主依赖许可） | **PASS**（文件级） | `NOTICE`；上游固定提交 `723c400e…` 已用 `.work/taskboard-src` 复核 |
| `source-inventory.json`（导入源码/依赖/资产/内部排除清单） | **PASS**（清单级） | `docs/development/release/source-inventory.json` |
| 运维 runbook（install/upgrade/rollback/uninstall） | **PASS（文档）** | `docs/development/release/*.md`；命令未在真实 profile 执行 |
| 备份机制（`VACUUM INTO` 两种形式，合成账本） | **PASS（合成数据）** | `docs/development/evidence/e07-02/backup-check.json` |
| 隐私/支持矩阵 | **PASS（文档）** | `privacy.md` / `support-matrix.md` |
| **真实 profile 安装** | **NOT_RUN** | 只给命令与步骤，未代用户执行 |
| **升级 / 回滚演练** | **NOT_RUN** | 等 E07-01；见 runbook 的演练缺口 |
| **最终放行（M1/M3）** | **NOT_RUN** | 门账本由 E07-01 收口后再判定 |

## 1. 环境与快照

| 项 | 值 |
|---|---|
| 平台 | Windows（win32 x64） |
| 打包/测试 Node | v24.18.0（本仓库 `node`）；npm 11.16.0 |
| DSH 目标宿主 | 已安装 payload `0.2.1-rc.2`（`.work/test-host/payload-0.2.1/dsh`，只读提取） |
| 实现快照 | 本轮最终开发树（**待提交**；合并提交后以该 commit 重新运行 `node build.mjs && node tools/package-boop.mjs` 刷新本报告）；取证时工作区含并行开发改动 |
| 取证时间 | 2026-10-18T04:16+08:00 |

> 注意：打包证据绑定的是**取证时的工作区内容**（含并行开发的未提交改动），不是某个已提交
> commit 的纯净构建。所有改动合入后必须**重新运行 `node build.mjs && node tools/package-boop.mjs`**
> 并更新本证据；旧 tarball 不能作为发布证据。

## 2. 本轮修复的打包缺陷

修复前 `package.json#files` 为 `["lib", "cordis.patch.yml", "presets", "README.md"]`：

1. **缺 `assets/3d`**：宿主资产行 `src/host/assets.ts` 从 `<pkg>/assets/3d` 读取 `.glb` 与五态 PNG，
   缺了它 3D 角色与其降级图全部 404 —— 已加入。
2. **缺 `LICENSE`/`NOTICE`**：npm 会自动带 LICENSE/README，但 **NOTICE 不会自动带** —— 已显式加入。
3. `lib` 整目录会把 8 个 `*.test.bundle.cjs`（约 0.5 MB 测试产物）一起发布 —— 改为 `lib/*.js`，
   只包含真实运行时 bundle。
4. README 缺失（仓库原只有内部 `README_开发团队先读.md`）—— 新增面向安装者的 `README.md`
   （是什么/依赖/安装停用/数据位置/模型边界/隐私/许可）。
5. 新增 `tools/package-boop.mjs`：`npm pack --dry-run` 白名单断言 → 真实 `npm pack` →
   自解析 tar 校验（必需/禁止条目、sha256、sha512、条目均在 `package/` 下）→ 输出
   `dist/dsh-boop-0.1.0.package.json`（tarball sha256 + 逐文件 sha256 + 检查项 + NOT_RUN）。

## 3. 复现命令与实测结果

```powershell
node build.mjs
npm pack --dry-run --json --ignore-scripts      # 白名单/内容预览（不写 tarball）
node tools/package-boop.mjs                     # 构建 + 全量校验 + 清单
node tools/package-boop.mjs --json              # 第二次运行：可复现性对照
```

### 3.1 `node build.mjs`

成功，14 个产物（含 `lib/index.js`、`lib/client.js`、`lib/api.js`、`lib/tools.js`、`lib/assets.js`、
`lib/workspace-api.js`、`lib/tasks-api.js`、`lib/control-api.js`、`lib/scheduler-api.js` 及测试 bundle）。

### 3.2 `npm pack --dry-run --json`（白名单预览）

原始元数据存档：`docs/development/evidence/e07-02/package-manifest.json`（最终树运行；26 文件、1,102,402 bytes、
7 项断言全部 `true`，与最终 tarball 一致）。

- 24 个文件；与最终 tarball 文件集合完全一致（工具内断言）。
- 必需条目 24/24 存在；禁止条目 0。
- 未出现：`src/**`、`tests/**`、`docs/**`、`baseline/**`、`handoff/**`、`tools/**`、`qa/**`、
  `manifests/**`、`demo/**`、`host-rc2*/`、`node_modules`、`*.test.bundle.cjs`、`pnpm-lock.yaml`、
  `SHA256SUMS.txt`、`BOOP_3D_Animation_v0.1.zip`、根目录重复 `boop.glb`、隐藏 dot-file。

### 3.3 `dist/dsh-boop-0.1.0.tgz`（最终 tarball）

| 字段 | 值 |
|---|---|
| 文件名 | `dsh-boop-0.1.0.tgz` |
| 大小 | **1,102,402 bytes** |
| sha256 | **`0cbd2f7e324a2b113d44a24ca52e4ce12204cb99dee7bcad08cb73e0a8b71e8a`** |
| npm sha512 integrity | `sha512-iQqIIMZMCesqb0IxZ9QQ/WqLBofsjAr/gfYu4vk0KmhJPkdeSB0Y/6KB/f9VoR8dCbDBAQfhoaIckmrYkEV/XA==`（工具已独立复算一致） |
| 解包后 | **2,456,342 bytes / 26 文件** |
| 可复现性 | 连续两次运行 **sha256 相同**，第二份清单 `checks.reproducible: true` |
| 必需条目 | 26/26（`checks.requiredComplete: true`） |
| 禁止条目 | 0（`checks.forbiddenAbsent: true`） |
| test bundle | 0（`checks.testBundlesAbsent: true`） |
| 条目结构 | 全部位于 `package/` 下（`checks.allEntriesUnderPackageDir: true`） |

tarball 内容（24 项，逐一 sha256 见 `package-manifest.json`）：

```text
package.json  cordis.patch.yml  README.md  LICENSE  NOTICE  presets/boop.patch.yml
lib/{index,client,api,tools,assets,workspace-api,tasks-api,control-api,scheduler-api}.js
assets/3d/{boop.glb,boop-assistant.js,boop-assistant.d.ts,README.md}
assets/3d/states/boop-{idle,listen,think,success,error}-256.png
```

关键完整性断言（工具内）：`assets/3d/boop.glb` = 1,389,436 bytes 且 sha256
`379e9845…7b56b` 与资产包 MANIFEST 一致；`lib/client.js` > 100 KB；所有文件 sha256 与 tar 字节一致。

### 3.4 备份机制（合成账本，非用户数据）

`node docs/development/evidence/e07-02/backup-check.mjs` → `docs/development/evidence/e07-02/backup-check.json`：

- 方式 A（仓库 `snapshotBackup` = `VACUUM INTO`）与方式 B（runbook 的只读连接
  `VACUUM INTO ?` 一行命令）**都成功**；
- 两个快照 `PRAGMA integrity_check = ok`、`foreign_key_check` 为空、行数与源库一致（task 1、
  task_revision 1、audit_event 2）；
- 该验证只证明**机制**在合成库上可用；真实用户账本的备份与恢复演练仍 `NOT_RUN`。

## 4. 许可与归属（文件级）

| 材料 | 内容 |
|---|---|
| `LICENSE` | Apache License 2.0 全文（标准文本，来自上游固定提交的仓库 `LICENSE` 原文），**11,558 bytes**，sha256 `1eb85fc97224598dad1852b5d6483bbcf0aa8608790dcc657a5a2a761ae9c8c6` |
| `NOTICE` | 项目版权；上游 **chuspeeism/dashi-taskboard@723c400eec86c454c1ffa56ee1b500746d41e142**（Apache-2.0，上游根目录无 NOTICE）的改写式提取声明与逐文件修改点（编译进 `lib/client.js`）；用户提供的 3D/2D 视觉资产归属（资产包声明不含第三方网格/纹理/字体/JS 库）；4 个宿主提供依赖（MIT © 2026 DeepSeek，不随包分发）；分发包范围声明（内部设计/交接/QA/参考素材不在包内、不随包授权再分发） |
| `docs/development/release/source-inventory.json` | 导入源码 5 项（上游路径/提交/许可/修改点/打包去向）；**不引入**清单；第三方运行时依赖 = 0；宿主依赖 4 项 + dev-only 9 项；资产 9 项（bytes + sha256 + 用户提供 + 未修改）；内部素材排除清单；许可决定与评审状态（合法评审 `NOT_RUN`） |
| 复核 | `.work/taskboard-src` 固定检出 `723c400eec86c454c1ffa56ee1b500746d41e142`（`git rev-parse HEAD` 实测一致） |

## 5. 运维 / 隐私 / 支持矩阵（文档交付）

| 文档 | 覆盖 |
|---|---|
| `docs/development/release/install.md` | 产物与 sha256 校验、前置条件、Web 插件页 / `dsh plugin --profile web add` 两种安装路径、安装后验证、排错 |
| `docs/development/release/upgrade.md` | 升级前记录/停止/一致备份（`VACUUM INTO` + 目录复制）、升级步骤、验证、schema/迁移规则、失败即回滚 |
| `docs/development/release/rollback.md` | 回滚触发条件、重装旧 tarball、只恢复旧 schema 快照（不用旧插件打开新 schema）、回滚后验证与 `integrity_check` 命令 |
| `docs/development/release/uninstall.md` | 三类数据划分、默认只停用保留数据、移除包、单独确认后删 `$DSH_HOME/boop/`、不删 Session/工作区/项目文件 |
| `docs/development/release/privacy.md` | 本地优先、账本实际存储内容、唯一外发边界=用户模型路由、无遥测、日志脱敏、渠道默认关闭、用户控制 |
| `docs/development/release/support-matrix.md` | 仅 Windows + DSH 0.2.1-rc.2 + Node v24.21.0（宿主）等真实执行组合；macOS/Linux/Desktop GUI/真实浏览器等 `NOT_RUN`，**不写入支持列表** |

## 6. 明确未验证（NOT_RUN）

- **真实用户 profile 安装**：本仓库只在隔离 `.work/test-runs/**` DSH_HOME 启动宿主；未代用户安装。
- **升级 / 回滚演练**：runbook 为文档化步骤，未在真实 profile 走完"升级成功/失败/回滚"三分支。
- **最终放行（M1/M3）**：依赖 E07-01 与全部门账本；本任务不写 PASS。
- **DSH Desktop Electron GUI** 的安装/卸载/窗口落位。
- **macOS / Linux** 打包与运行（不宣称支持）。
- 公开 registry / marketplace 发布（未请求；包保持 `private: true`，防止误发布）。
- 许可/归属的独立法务评审。
- 真实用户环境下的网络抓包与宿主日志隐私审计。

## 7. 已知风险 / 注意事项

1. **快照绑定工作区而非 commit**：取证时 tree 有 50 条未提交/未跟踪变化（并行开发），合并后必须重跑
   打包与证据；不得用旧 tarball 作为发布物。
2. **可复现性边界**：同一份文件内容下 `npm pack` 产物字节稳定（两次 sha256 相同）；文件内容任何变化
   （含 `lib/` 重建、README/NOTICE 改动）都会改变 tarball sha256，必须重新记录。
3. 只在 Windows + npm 11.16.0 验证了打包；pnpm/其他 npm 版本、macOS/Linux 打包 `NOT_RUN`。
4. `engines.dsh` 精确钉 `0.2.1-rc.2`：宿主升级需重新对齐，不申请版本豁免。
5. 备份 runbook 的命令已在合成库验证；真实库备份/恢复仍 `NOT_RUN`，发布前必须演练。

## 8. 证据文件

| 文件 | 说明 |
|---|---|
| `docs/development/evidence/e07-02/package-manifest.json` | 打包清单（tarball sha256/逐文件 sha256/检查项/NOT_RUN）；sha256 `90666922c6c52793171a990ba6b25b18bbe66a156de6acb7893272512ce35095` |
| `docs/development/evidence/e07-02/npm-pack-dry-run.json` | `npm pack --dry-run --json` 原始白名单预览与断言（24 文件，与最终 tarball 一致） |
| `docs/development/evidence/e07-02/backup-check.json` | 合成账本的两种一致性备份机制验证（结果 JSON） |
| `docs/development/evidence/e07-02/backup-check.mjs` | 上述验证的可复现脚本（只写仓库内 `.work/`，不触碰用户 `~/.dsh`） |
| `docs/development/release/source-inventory.json` | 来源/依赖/资产清单 |
| `dist/dsh-boop-0.1.0.tgz`（gitignore） | 本地构建产物，不提交；发布时以清单 sha256 为准 |
