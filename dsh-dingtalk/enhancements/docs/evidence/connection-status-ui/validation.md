# Issue #26 本地验证与边界

## 基线与范围

- 父分支：`codex/dingtalk-server-runtime`；开始开发时远端父分支、UI 子分支与并行 #27 子分支均为 `0c50a3b063ecc87ee14b51d536bcf8c289af37d7`，与 PR #25 实际 head 一致。
- 提交前再次核对：父分支与 UI 远端仍为上述基线；并行 #27 已到 `91d54a124f33e35379bef8bb587ecf6745ab6ef6`，其修改文件与本单无重叠，没有合入该兄弟分支。
- 只修改 `enhancements/src/client/`、对应测试及本单浏览器脚本/证据；不修改 Host、Connector 契约、工具权限、业务白名单或机器人身份校验。
- 已知授权事务的取消处理属于 #26 的“cancel 与旧响应竞态”验收：`begin` 已返回事务但 `callback-origin` 仍在读取时，Client 必须调用已有 `cancel` RPC。没有新增 RPC 或修改父 PR 与 #27 的业务代码。
- 检出仓库及当前工作区均未包含 `.agents/skills`。执行 `dsh-dingtalk/AGENTS.md`，不发布、不合并、不部署、不操作 39/43 或真实机器人。
- Node `v24.19.0`、pnpm `11.19.0`、Linux、Chromium `151.0.7922.173`。

## 执行结果

本环境默认 `umask 0077` 使既有 `doctor-report.test.mjs` 第 128 行权限场景不成立：请求创建的 0644 文件实际成为 0600。原始基线独立工作树也产生相同断言失败；仅在执行命令中设为 `umask 0022` 后，基线该文件 18/18 通过，无需改测试或生产代码。

最终代码验证结果：

| 检查 | 结果 |
| --- | --- |
| `pnpm run ci` 的扫描、格式、类型、构建 | 通过 |
| 主测试集 | 425 项，418 通过、0 失败、7 跳过 |
| 全量 enhancements | 127 项，118 通过、4 个下述基线环境失败、5 跳过 |
| Store/UI/机器人/生命周期/remote/UI RPC/tail 定向回归 | 74/74 通过，无跳过；Store 单独 39/39 |
| `pnpm run test:pack` | 通过，402 文件，解包大小 4,729,136 bytes |
| 新增浏览器验收 | 13 组通过、7 张合成截图，无外部请求/浏览器错误 |
| 既有机器人浏览器验收 | 通过 |
| 既有完整 Host 浏览器验收 | 前置 Windows 固定二进制缺失，未启动浏览器 |

以下命令在 `dsh-dingtalk/` 运行：

```sh
umask 0022
pnpm run ci
pnpm run test:pack
node --test --test-concurrency=1 enhancements/tests/client-store.test.mjs enhancements/tests/ui.test.mjs enhancements/tests/relay-ui.test.mjs enhancements/tests/lifecycle.test.mjs enhancements/tests/remote.test.mjs enhancements/tests/ui-rpc.test.mjs enhancements/tests/tail.test.mjs
DSH_TEST_BROWSER=/usr/bin/chromium node enhancements/scripts/verify-connection-status-browser.mjs
```

`ci` 的全量 enhancements 测试在此环境存在四个基线可复现失败，因此不能报告全绿：

| 基线失败 | 环境证据 |
| --- | --- |
| `capabilities.test.mjs:168` 固定官方 CLI 模拟端点集成 | 缺少 `.cache/dingtalk-g0/bin-amd64/dws.exe` |
| `identity.test.mjs:5` Host 与 Web 身份一致性 | 同一固定 Windows 二进制前置文件缺失 |
| `identity.test.mjs:28` IM 审批与身份改变 | 同一固定 Windows 二进制前置文件缺失 |
| `local.test.mjs:193` 子进程树退出 | Linux 环境中 `gone(pid)` 在等待窗口内未通过；未改动执行器或该测试 |

独立基线 enhancements 结果：75 项，66 通过、4 失败、5 跳过。既有 Windows 特定跳过项保持原样；新增机器人浏览器测试在本机 Chromium 上实际执行，并未跳过。

## 证据性质与剩余验收

[浏览器报告](browser-report.json)及截图使用生产 React/Store 和模拟 RPC/数据。单元回归覆盖本地 loopback 与 Connector HTTPS callback origin、popup source、transaction ID、Host 复查、下载/事务恢复、跨标签失效、旧请求、取消和解绑；真实 Host 以 `ok:true + unknown` 返回的读取故障也作为读取失败处理，不能冒充新的连接确认。

未验证完整 DSH Web/Desktop 外壳、真实企业 OAuth/权限、真实 Connector 网络及机器人收发。既有完整 Host 浏览器脚本因同一固定 Windows 二进制前置文件缺失，在启动浏览器前停止；[既有浏览器检查记录](existing-browser-checks.txt)包含结果。

如果 `begin` 响应在事务 ID 送达 Client 前丢失，Client 无法定向取消未知 ID；本单不会假报成功或自动重试授权，仍依赖既有 Host 事务过期/校验机制。本单只撤销已知事务，不扩展服务端协议。


## 与 PR #28 的文案交接

核对 #28 的 `codex/dingtalk-workspace-tool-policy@91d54a124f33e35379bef8bb587ecf6745ab6ef6`：personal 已配置机器人的应用 OAuth、配对 owner、消息与普通宿主工具不再借用当前 DWS identity；`dingtalk_call` 继续独立验证 DWS 数据授权。enterprise 和 legacy 没有同样放开，本单保留对应 DWS 错误提示。

首次 personal 配置仍需要 corpId：Host 优先使用已有配置或已确认渠道身份中的企业信息，均不存在时才从 DWS identity 取得。因此未配置提示限定为“尚无企业信息时”先完成 DWS 授权；已配置状态只说明机器人应用登录/设备配对与单独的数据授权。personal 的 `auth_required` 按首次 configure 与已有配置的连接/重配区分，`identity_mismatch` 指向机器人的企业账号而非当前 DWS 账号。中文及英文都覆盖。

新增 4 组机器人 UI 回归，覆盖上述状态、错误、配对提示及 enterprise/legacy 维持原契约；浏览器新增 DWS 未连接但已配置 personal 可进入机器人配对的模拟场景与截图。此处仅验证 UI 对 #28 契约的展示，不声称当前独立 UI 分支已包含 #28 的 Host 实现。

两个 PR 继续共同基于 `codex/dingtalk-server-runtime@0c50a3b`，文件无重叠。本分支不合入、覆盖或改写 #28 文件。#28 的运行时授权解耦应先于或与本次 Client 文案一并交付；保留两个 PR 各自改动并一并验收。不要用整文件覆盖或仅凭新文案认定旧 Host 已解耦。未执行合并、部署或真实机器人联调。
