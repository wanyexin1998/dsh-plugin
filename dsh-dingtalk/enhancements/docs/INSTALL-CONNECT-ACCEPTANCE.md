# 安装后直接授权：dev.4 本地验收

用户流程：安装 Bundle → 设置或小卡片点击连接 → 自动准备官方 DWS 和公开应用信息 → 钉钉用户授权 → 在线身份核验并绑定 → 原会话状态更新。无需手填 JSON、应用密钥或企业/用户 ID。

首次准备可取消，失败可重试；受阻弹窗提供链接；回调采用与锁定官方默认 OAuth 一致的动态 loopback /callback。重授权核对现有绑定，断开后才可明确切换账号。会话卡片保持最大 420px，已连接状态约 100px，原会话草稿和 URL 保留。

面板仅保留状态、简短提示与操作。连接成功、失效、失败均更新原卡片；浏览器回归核对 React DOM 节点引用和卡片数量不变，不插入状态回填卡片。设置默认不展示技术能力 ID、重复账号占位或验证时间；IT 申请长文仅通过复制按钮提供。

常用操作使用平面小图标按钮，连接 / 重连 / 断开搭配短文字，刷新和收起仅图标；细边框、淡底色反馈，悬停提示与 aria-label 保留完整名称。解除确认仅保留「保留 / 解除」。浅暗色与移动端共用样式，不扩大卡片。

## 验证与证据

证据快照位于 docs/evidence/install-connect；docs/evidence/p0 保留 dev.3 历史证据。

- build、typecheck、npm test：契约、安装器摘要/损坏/取消、无配置首次绑定、重启、账号切换、OAuth/RPC、执行器、UI 和生命周期。
- verify:p0：真实锁定 DWS 二进制、缓存的真实官方 ZIP、合成 OAuth/MCP、隔离 DPAPI 测试命名空间。验证无 JSON 准备、三查询、错账号拒绝、失败恢复和精确解绑。
- verify:browser：Chrome + 实际 React / Host RPC Harness，无 JSON 自动安装和合成授权；验证原会话草稿、两个卡片同步、浅暗色/390px、二次确认、弹窗受阻、无 opener、取消和卸载。不是正式 DSH 外壳。
- verify:dsh-web：安装归档到官方 DSH 0.2.1-rc.5 干净 Profile，使用原样生产 Host，真实公开下载及 clientId 发现，点击后到达正确官方 OAuth URL；浏览器在向官方授权站发请求前截住页面，再通过 UI 取消。没有真实 consent、授权码或业务数据。
- verify:bundle：官方 CLI 安装/加载/卸载归档，确认所含文件和 SHA256；不打包 DWS exe、测试或个人配置。

报告中的 classification / limitations 是验收边界的一部分。真实企业扫码同意、IT 开关/应用 scope、真实 LLM 意图选择、原生完整 Tool transcript、Desktop 和最终独立安全验收仍待完成，G0 HOLD / G1 BLOCKED，不关闭相应 Issue。

## 运行方式

按 INSTALL.md 安装 dev.4 归档到隔离 Profile，重启后直接点「连接钉钉」。此前自建应用和 JSON 不属于普通路径。维护者若曾在启动环境设置 DSH_DINGTALK_CONFIG_FILE，需要清除旧兼容覆盖后重启，才能验证默认路径。

Windows x64 是当前支持平台；首次下载需要 GitHub 发布源和钉钉 MCP 可达。下载或校验失败保留未连接，不执行未验证二进制。升级版本需重新锁定摘要并复验。
