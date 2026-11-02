# dev.5 回调兼容证据

2026-11-02，修复真实联调暴露的同值 code / authCode 双字段 HTTP 400。不采集或复用真实授权码、URL、截图或账户数据。

- 构建、类型检查通过。
- tests/oauth.test.mjs：5 项通过；新增同值双别名仅换码一次，以及冲突值、重复键、空值、error 混用和重放拒绝。
- p0-browser-report.json：真实官方 DWS + 合成 Provider 同时返回两个别名，React / Host RPC 授权到原卡片回填通过。
- p0-bundle-report.json：dev.5 归档 SHA256、文件清单及官方 DSH 安装/加载/卸载结果。

真实联调实例升级时核对已安装版本和 callback 模块摘要与本地构建一致。用户仍需发起新的授权事务确认真实换码及企业权限；模拟通过不代表真实企业完整授权已通过。
