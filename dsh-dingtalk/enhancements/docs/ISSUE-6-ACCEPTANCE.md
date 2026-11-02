# DWS-03 / Issue #6 本地验收

日期：2026-11-02（Asia/Shanghai）。关联 [#6](https://github.com/wanyexin1998/dsh-plugin/issues/6)。

结论：**LocalBackend 本地工程验证通过**；真实企业 OAuth、IT 权限、Agent/UI 与日志隐私发布门禁仍未通过。按用户安排只提交推送新的开发分支，不建 PR、不自动关闭 Issue 或部署生产。

## 实现范围

- 从 Host 私有配置读取受信绝对路径和精确 corpId:userId，不使用 PATH 猜程序/账号，不向 Client 或模型暴露私有配置。
- 按 dws.lock.json 复用官方 1.0.66 的二进制 SHA256，检查 PE 架构、版本和完整 commit，拒绝缺失/非锁定制品。
- 三项静态只读操作与严格参数校验，固定精确 Profile；每次业务请求先在线核对本人身份。缓存 token_valid 不直接转 connected。
- spawn argv 数组、shell=false、关闭 stdin；资源限额、单后端串行、有界队列、整条操作 deadline、Abort 与卸载取消。
- stdout/stderr 合计字节限制、UTF-8/JSON 校验、业务字段及带标记文本脱敏、受控错误码；不返回原始 stderr/日志。
- 授权和精确解绑仍留给 #7，不调用全局 logout，不改变 DWS 默认 Profile。

## 已执行检查

| 命令 | 结果 | 核心证据 |
| --- | --- | --- |
| npm run build | PASS | Host ESM/类型声明和 Client 平台模块 |
| npm run typecheck | PASS | 公共契约类型、操作输入限制、Host AbortSignal 与 Node 接口 |
| npm test | 21/21 PASS | 原有契约/生命周期 + 本地进程执行、参数攻击、身份、状态、错误、队列、输出、父子进程清理 |
| npm run verify:local | 6/6 PASS | 已校验的官方 DWS 二进制 + 隔离本地 MCP/OAuth 夹具 |
| npm run verify:bundle | 4/4 PASS | 官方 DSH CLI 归档安装、激活、实际 Host 加载/卸载与用户 patch 保持 |
| node scripts/g0/verify-evidence.mjs | PASS | #4 的快照和版本锁仍一致，真实 G0 仍为 HOLD |

Windows x64，Node 22.23.2，官方 DWS 1.0.66，官方 DSH 0.2.1-rc.5，Cordis 4.0.5。测试没有使用真实企业账号、真实 OAuth code/token 或业务正文。

Node 子进程夹具检查包括：写命令及 profile/path/shell/userId 注入均在启动前拒绝；以 flag 开头的 query/cursor 仍为字符串值；旧版本/损坏 JSON/私有 stderr 被受控归一化；未确认状态不当成退出；超时及 Abort 清理父进程和实际创建的子进程；队列溢出、等待超时、排队取消及 queueLimit=0 顺序调用均通过。

官方二进制夹具建立 A/B 两个合成 Profile，保留 A 为默认，给后端只绑定 B。未绑定后端不读取默认 A；绑定后身份、日历、文档调用全部使用 B，得到 JSON，DWS 正常刷新短期合成 Token。调用结束默认 A 及其 Profile 元数据保持不变。

## 脱敏报告和安装包

- [官方二进制本地报告](evidence/issue-6/local-report.json)，等级 OFFICIAL_BINARY_LOCAL_FIXTURES_ONLY。
- [归档安装报告](evidence/issue-6/bundle-report.json)，等级 ISOLATED_PROFILE_AND_RUNTIME。
- 本地安装包：artifacts/dsh-dingtalk-0.1.0-dev.2.tgz，SHA256 `f64f719d7c22ef5c1e422b75b94f10006899028a8a6cadbb012932a90241fb08`。归档不提交到 Git，源码和依赖锁已纳入版本管理。

## 明确保留的边界

1. 官方 DWS 磁盘诊断日志会记录搜索关键词：合成测试实测为 true。固定版 LogResponseBody 在错误路径还有截断响应体记录。插件输出脱敏不等于上游日志隐私已通过；没有擅自删除、篡改用户日志或修改官方 Go 源码。此项保留为 #12 / 发布前必须处理的隐私门禁。
2. 仅 Windows x64 完成真实二进制验证；其他平台版本锁中的下载元数据不等于运行通过。未使用测试命名空间冒充生产隔离；本机同 OS 用户仍属于同一安全域。
3. 初次授权/重新授权/精确撤销由 #7 实现，Agent Tool/Skill 由 #8，完整卡片及设置由 #9/#10。设置当前仍是不可授权的占位页。
4. 真实企业的应用、scope、IT 开通/禁用错误、刷新及 Desktop/Web 回调由最后联调确认。connection_unknown 不被猜测成 IT 未开通。#4 G0 仍为 HOLD。

配置、命令清单、默认限额、错误语义及更详细风险见 [LOCAL-BACKEND.md](LOCAL-BACKEND.md)。
