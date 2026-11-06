# Issue #26 浏览器验收

运行命令（在 `dsh-dingtalk/`）：

```sh
DSH_TEST_BROWSER=/usr/bin/chromium node enhancements/scripts/verify-connection-status-browser.mjs
```

脚本直接打包当前 `enhancements/src/client/` 的 React 组件与 `ConnectionStore`，启动临时 loopback 页面，通过 Playwright 操作浏览器。RPC、账户、机器人状态、应用凭据与授权页全部模拟；请求只允许访问该本地页面，不读取实际凭据，不连接钉钉或 Connector，也不操作真实机器人。完整结果见 [browser-report.json](browser-report.json)。

覆盖首次慢读、首次失败与重试、已连接账户在手动/focus/15 秒轮询时保持、模拟超时错误与恢复、Host `ok: true`/`unknown`（`service_unavailable`、`backend_not_ready`）响应仍保留旧账户与确认时间、失效/身份变化/权限错误/解绑、DWS 与机器人独立状态、个人配置与 secret 清理、继续/取消登录、停止托管、企业连接、解除确认、键盘焦点和组件卸载清理。

截图仅含合成显示信息；配置截图中的 Secret 输入框为空。

| 截图 | 场景 |
| --- | --- |
| [initial-check-light.png](initial-check-light.png) | 首次读取尚未完成，不显示重连 |
| [stale-connected-light.png](stale-connected-light.png) | 已连接账户保留，并标注读取失败/待更新 |
| [stale-connected-dark-mobile.png](stale-connected-dark-mobile.png) | 同一陈旧状态，深色 360px 布局 |
| [unknown-envelope-dark-mobile.png](unknown-envelope-dark-mobile.png) | 模拟 Host RPC 成功但结果为 unknown，仍显示旧账户与原确认时间 |
| [personal-pairing-dws-unlinked.png](personal-pairing-dws-unlinked.png) | DWS 未连接时，已配置个人机器人只提示应用登录与设备配对 |
| [personal-config-dark-mobile.png](personal-config-dark-mobile.png) | 个人机器人配置表单，深色 360px 布局 |
| [independent-connected-light.png](independent-connected-light.png) | DWS 与企业机器人各自显示已连接 |

未在本脚本中验证完整 DSH Web/Desktop 外壳、真实企业 OAuth/权限、真实 Connector 网络链路和机器人消息收发。回调 origin/source/transaction 校验与旧请求竞态由单元/Host 回归分别验证；这些截图不代表真实企业验收。

另运行了既有浏览器脚本，见 [existing-browser-checks.txt](existing-browser-checks.txt)：`verify-robot-browser.mjs` 通过；`verify-browser.mjs` 在启动浏览器前因缺少 `.cache/dingtalk-g0/bin-amd64/dws.exe` 而失败，该固定 Windows 二进制 fixture 在本 Linux 工作区不可用。未改动这两个既有脚本。

全部本地检查、基线对比与并行分支边界见 [validation.md](validation.md)。
