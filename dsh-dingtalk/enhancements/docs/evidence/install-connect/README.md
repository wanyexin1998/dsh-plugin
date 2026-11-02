# 安装后直接连接：本地证据

2026-11-02，候选 0.1.0-dev.4。普通用户无需 JSON。34 项自动化测试通过、0 跳过；最终文字/按钮调整后补充 UI 与浏览器回归。各 JSON 的 classification 和 limitations 限定证据范围。

- p0-local-report.json：官方二进制、真实缓存 ZIP、合成 OAuth/MCP，首次身份自动绑定和三项查询/解绑；不是真实企业。
- p0-browser-report.json：React / 实际 Host RPC Harness；原卡片节点在 connected / expired / failed 回填时保持不变，草稿保留；平面按钮、短文字、浅暗色与 390px。
- p0-dsh-web-report.json：安装归档到官方原样 DSH Web；真实公开下载及 clientId 发现，浏览器截住本机 start 的官方重定向后取消，没有提交真实 consent。
- p0-bundle-report.json：最终归档 SHA256、文件白名单、官方 CLI 安装/加载/卸载结果。
- tests-report.json：构建、类型检查、自动化测试摘要。

[浅色](browser/connected-light.png) · [暗色与移动端](browser/connected-dark-mobile.png) · [原生 DSH 设置](browser/native-web-settings.png)

真实企业账号、权限开关、LLM 和 Desktop 仍待最终现场，G0 HOLD / G1 BLOCKED。一次旧失败测试的临时目录清理被执行策略拒绝，目录保留；后续正常隔离验收已清理自身环境，不修改个人 DWS 凭据。
