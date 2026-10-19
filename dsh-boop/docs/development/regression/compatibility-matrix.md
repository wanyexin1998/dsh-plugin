# E07-01 · 兼容性与回归矩阵（准备阶段）

> 生成：2026-10-18 · 任务：E07-01（故障注入与回归编排，准备阶段）
> 结论先行：**本文件不是发布认证。** 目前只在 **Windows + DSH 0.2.1-rc.2 真实宿主**上做过可重复验证；
> Desktop Electron、浏览器截图/IME、macOS/Linux、IM 渠道全部 **NOT_RUN**，不得据此宣称支持。

## 1. 已实测环境（本机，2026-10-18）

| 项目 | 实测值 | 取证方式 |
|---|---|---|
| 操作系统 | Windows（`process.platform = win32`，x64） | `tools/run-regression.mjs` 环境快照 |
| Node.js | `v24.18.0` | 同上（测试运行器实际使用的 node） |
| DSH 宿主 | `0.2.1-rc.2`（installed payload `.work/test-host/payload-0.2.1/dsh`） | 宿主 `@deepseek-ai/dsh/package.json` + `hostFacts()` |
| 宿主固定提交 | `332895e0f7c9d4dbfb29729f5eb367fa263ff986`（Desktop 声明提交） | `tests/helpers/test-host.mjs` `hostFacts()` |
| 仓库工作树 | 见 `docs/development/evidence/e07-01/regression-*.json` 的 `git.head` / `git.dirty` | `git rev-parse HEAD` / `git status --porcelain` |
| DSH_HOME | 每个宿主测试独立的 `.work/test-runs/<task>-<ts>/dsh-home` | 测试自身；用户 `~/.dsh` 不被读写 |
| 真实模型服务 | 自托管 vLLM（Qwen），**opt-in**：`BOOP_QWEN_BASE_URL` + `BOOP_QWEN_MODEL`（+ 可选 `BOOP_QWEN_KEY`；无凭据服务用占位符） | E05-00/E02-03 约定；本次默认未设置 → real 组 **SKIPPED** |
| 浏览器 | 本轮未运行真实浏览器（仅 jsdom 客户端套件） | NOT_RUN |

## 2. 回归分组（`tools/run-regression.mjs`）

| 组 | 内容 | 何时运行 | 失败语义 |
|---|---|---|---|
| `offline` | `tests/unit/*` + `tests/client/*`（jsdom） | 总是 | 失败即离线回归失败 |
| `host` | `tests/host/*` 中**非** real 命名的文件（真实 rc.2.1 宿主，每文件独立 DSH_HOME），含 `e07-01-fault-*` | 总是 | 失败即宿主 hermetic 失败 |
| `real` | `tests/host/*real*`（E02-03 真实派发、E03-02 真实抽取、E05-00 真实模型金标） | 仅当 `BOOP_QWEN_BASE_URL` + `BOOP_QWEN_MODEL` 均存在 | 与离线/host 分组**分开报告**；未配置时记 `SKIPPED`，绝不伪造 |

证据文件：`docs/development/evidence/e07-01/regression-<ts>.json`（版本、commit、dirty、环境、分组命令、TAP 计数、脱敏输出尾、overall、NOT_RUN 清单）。

## 3. 能力矩阵（按验证项）

| 验证项 | 状态 | 证据 / 命令 | 限制 |
|---|---|---|---|
| 离线单元 + 客户端回归 | **PASS（本机）** | `regression-2026-10-17T20-17-32-215Z.json` → offline **307/307**；`node tools/run-regression.mjs --only=offline` | 仅 Node + jsdom，不是浏览器 |
| 宿主 hermetic 套件（全量） | **PASS_WITH_EXTERNAL_FAILURE（本机）** | `regression-2026-10-17T20-20-07-692Z.json`：host **109/110**，唯一失败为 `tests/host/e05-01-scheduler-in-host.test.mjs`（"this Host owns the writer lease"），**非 E07-01 故障注入文件**，属并行进行的 E05-01 工作项 | 全量 host 组在同一 `node --test` 进程内并行跑 13 个文件；失败项需 E05-01 负责人处理，本任务不修改该文件 |
| 故障注入：SIGKILL 中途杀进程 + 重启 + 快照恢复 | **PASS（本机，准备阶段，5/5）** | `node --test --test-force-exit tests/host/e07-01-fault-kill-restart.test.mjs`；`evidence/e07-01/fault-kill-restart-*.json` | 只证明本机 Windows 行为；未覆盖 Desktop Electron。恢复快照含未过期 lease → 重启只读（已知限制） |
| 故障注入：模型路由不可达 | **PASS（本机，准备阶段，4/4）** | `tests/host/e07-01-fault-model-down.test.mjs`；`fault-model-down-*.json` | 闭合端口模拟不可达；未测真实服务超时/限流/5xx 全谱 |
| 故障注入：审批并发 + 伪造绑定 | **PASS（本机，准备阶段，4/4）** | `tests/host/e07-01-fault-approval-concurrency.test.mjs`；`fault-approval-concurrency-*.json` | 直接 SQLite 种入 fixture（已披露）；不是 UI 点击证据 |
| 真实模型：单轮派发/对账（E02-03） | **NOT_RUN（本轮）** | real 组 opt-in；历史证据见 `evidence/e02-03/` | 需要用户提供真实服务 env |
| 真实模型：抽取/金标（E03-02/E05-00） | **NOT_RUN（本轮）** | real 组 opt-in | 同上 |
| Web 端 UI（真实浏览器、三屏、深浅主题截图） | **NOT_RUN** | — | 需真实浏览器/Desktop；jsdom 不等于浏览器 |
| Desktop Electron（安装/窗口按钮/分屏） | **NOT_RUN** | — | 需 Desktop 环境；本机只验证 Web Host |
| IME / 触屏 / 屏幕阅读器 / 200% 字号 | **NOT_RUN** | — | 需真实输入法/触屏设备 |
| Linux / macOS | **NOT_RUN** | — | 未在对应平台运行；不得宣称支持 |
| IM 渠道（钉钉/飞书） | **NOT_RUN** | — | 无凭据、渠道未接入；保持关闭 |
| 恢复门禁 `agent/pre-step` 运行时强制 | **PARTIAL / 已知风险** | E04-03 `runtimeEnforcement.composed:false`；E07-01 kill/restart 只证明“无自动重放/无自动 claim” | 运行时门控接线未组合；不得写成“重启后运行时已阻断” |

## 4. 明确不宣称的事项

- 不宣称 Desktop/Electron、浏览器、macOS、Linux、IM 渠道可用或兼容。
- 不把 jsdom 组件测试当作浏览器验收；不把 hermetic fixture 当作真实用户数据验收。
- 不把 SIGKILL 后“没有自动重放”夸大为“恢复门禁运行时已强制”；`agent/pre-step` 接线仍未组合（NOT_RUN，见 STATUS 风险）。
- 不把未配置真实模型时的 `SKIPPED` 写成 PASS。

## 5. 复现命令

```powershell
# 全部可运行分组（real 组在无 env 时 SKIPPED）
node tools/run-regression.mjs

# 仅离线
node tools/run-regression.mjs --only=offline

# 仅本轮故障注入文件（更快）
node tools/run-regression.mjs --only=host --host-filter=e07-01

# 三个故障注入文件直接运行
node --test --test-force-exit tests/host/e07-01-fault-kill-restart.test.mjs
node --test --test-force-exit tests/host/e07-01-fault-model-down.test.mjs
node --test --test-force-exit tests/host/e07-01-fault-approval-concurrency.test.mjs

# 真实模型 opt-in（示例；无服务时不要运行）
$env:BOOP_QWEN_BASE_URL="http://<host>:8000/v1"
$env:BOOP_QWEN_MODEL="<model-id>"
node tools/run-regression.mjs --only=real
```
