# #7–#13 验收矩阵

候选版本：`0.1.0-dev.4`。**G0 HOLD / G1 BLOCKED / NO PROD DEPLOY**。无 JSON 安装后授权补齐见 [INSTALL-CONNECT-ACCEPTANCE.md](INSTALL-CONNECT-ACCEPTANCE.md)。当前提交到开发分支，不创建 PR，不合并，不部署，不因模拟证据关闭 Issue。

| Issue | 本地工程交付 | 已有证据 | 尚不能标记完整验收的事项 |
|---|---|---|---|
| #7 OAuth | 单次事务、state/cookie/nonce/TTL、固定 App/redirect、stdin 换码、在线精确身份、重授权、精确解绑 | 官方 DWS + 合成 OAuth/MCP；取消/换码前失败/错账号保留有效连接；其他默认 Profile 不变；重启恢复 | 实际 App/企业账号、刷新与权限现场；post-save 失败不能恢复旧 Token |
| #8 Tool / Skill | 三项只读 Tool、规范 JSON、独立参数校验、适配官方 Skill 与 Apache 许可 | 官方 DSH ToolRuntime 注册/执行/渲染/卸载；官方 DWS 三查询；写操作与参数注入拒绝 | 三种中文自然语言意图的真实 LLM 调用和脱敏现场记录 |
| #9 会话卡片 | keyed ToolView、用户手势预开页、受阻链接、消息复查、2 秒短期轮询、原位状态、隐藏单卡片 | Chrome + React/真实 Host RPC Harness；保留原 URL/草稿；假消息无效；无 opener 轮询；最大宽 420px | 原生 DSH 真实授权及原始 Tool Call 内现场记录；Desktop/COOP 现场 |
| #10 设置 | 现有 settings.section、同 Store、连接/重授权/二次确认解绑、跨刷新/焦点/广播复查、语言与主题继承 | 10 类状态组件、中文/英文、浅色/暗色/390px、Escape 和焦点恢复；原生 Web 单独报告 | 真账号展示、已配置原生 Host 的实际权限/多浏览器/断网现场；Desktop |
| #11 错误分类 | 唯一结构化 DWS 归一化器、PAT scope/组织策略/普通拒绝分开、限流/网络/未知、IT 申请文案 | 固定上游源码依据；负向 403/文本不会误判 IT；无私有正文/路径透传 | 企业 CLI 总开关未开通的真实或官方确定夹具；自建 App scope 真实拒绝；未知不能冒充特定分类 |
| #12 安全 | 威胁模型、负向回归、隐私修复、独立架构复核与边界记录 | SECURITY-REVIEW.md；OAuth/RPC/CLI/输出/卸载测试 | 完整独立安全验收和最终候选高危/严重风险门禁；架构复核不等于完整漏洞审查 |
| #13 G1 | 独立归档、版本锁、隔离 Profile、安装/卸载、运行手册、兼容矩阵 | verify:bundle / verify:dsh-web / verify:p0 / verify:browser 各自生成分类报告 | 实际钉钉授权 → 返回原会话 → 原卡片 → 真实只读业务，失败账号/LLM/Desktop 证据；G0 前置仍 HOLD |

## 证据层级

1. `npm test`：自动化契约、原生 Cordis/SlotCore 生命周期、OAuth/RPC 边界、错误及 UI 组件。不是企业联调。
2. `verify:p0`：已校验官方 DWS 和官方 DSH ToolRuntime；仅 localhost 合成服务及测试 DPAPI 命名空间，不是真实企业。
3. `verify:browser`：真实 Chrome/React/Host RPC Harness，不是正式 DSH 外壳。尺寸与交互截图在 artifacts/browser。
4. `verify:dsh-web`：安装归档到官方 DSH `0.2.1-rc.5` 的独立 Profile，真实 Web 设置/RPC；不含实际钉钉或 LLM 凭据。
5. `verify:bundle`：官方 CLI 安装、组合、Host 加载/卸载和删除依赖；保留原始用户 patch。归档 SHA256 在报告，不写入归档自身以避免循环摘要。
6. 真实企业及 Desktop：需要用户自行授权，按 AUTHORIZATION.md 执行；未执行项不能由上述层级替代。

验收报告保留明确 classification、realAuthorization、realBusinessData 和 limitations。artifacts 为可重建本地产物；经筛选的合成证据快照保留在 docs/evidence/p0，不采集真实授权网络 HAR/回调 URL。

## 兼容矩阵

| 依赖 / 平台 | 当前范围 |
|---|---|
| 官方 DSH | 0.2.1-rc.5；独立 Bundle，核心源代码 0 行改动 |
| Cordis / React | 4.0.5 / 18.3.1；由宿主提供 Client React |
| Node | 本次 22.23.2；声明 ^22.19 或 >=24 |
| 官方 DWS | 1.0.66 / f215043e676d6889e1ddce3464828d8b1ec40c31，执行前哈希校验 |
| Windows x64 | 当前实际二进制、进程树和 DPAPI 合成环境验证范围 |
| 其他 OS/架构 | 仅上游发行元数据，执行前拒绝，未验收 |
| Chrome Web | Harness 和官方 Web 分开记录；真实企业流程待现场 |
| Desktop | 尚未验收，不宣称双端通过 |

## 后续现场交接

安装当前候选到隔离 Profile，用户点击「连接钉钉」后自行扫码确认，无需 JSON 或身份预填。逐项留下非敏感的版本、时间、账号类别、operationId、结果状态及原因码；完成后更新此表和 G0/G1 结论。PR 仍需用户另行要求，不能自动创建。
