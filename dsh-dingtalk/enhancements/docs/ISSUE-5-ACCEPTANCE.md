# DWS-02 / Issue #5 本地验收

日期：2026-11-02（Asia/Shanghai）。关联 [#5](https://github.com/wanyexin1998/dsh-plugin/issues/5)。

结论：**Bundle 基础工程的本地验收通过；真实 OAuth 与完整浏览器流程仍待后续联调。** 本次只提交推送开发分支，不创建 PR、不关闭真实 G0 门禁、不部署生产。

## 交付

- 独立 `dsh-dingtalk@0.1.0-dev.1`，提供 Host ESM、Client 平台模块、TypeScript 声明、Bundle patch 和可安装归档。
- `src/shared/` 的五方法 ConnectionService、11 种连接状态、稳定错误码、严格只读入参和公开 DTO 投影。
- `local` / `cellgent` 两个模拟适配器共用同一套契约测试；真实 cellgent/Connector 不实现，配置中明确拒绝启用。
- Local 占位后端不调用 DWS、不读凭证；设置页明确显示尚未启用，授权按钮禁用。
- Cordis 管理 Host 服务和 Client 设置注册的生命周期；卸载后旧服务引用和迟到结果不能继续成功。

## 已执行检查

| 命令 | 结果 | 覆盖 |
| --- | --- | --- |
| `npm run build` | PASS | Host ESM/声明与 Client 平台模块构建 |
| `npm run typecheck` | PASS | 严格 TS；从公开 `dsh-dingtalk/shared` 导出消费类型；禁止写操作、profile/argv 和凭证字段的负向类型断言 |
| `npm test` | 9/9 PASS | 双模拟适配器流程、未知/危险入参拒绝、错误和公开结果过滤、调用参数隔离、在途结果/卸载、错误码快照、Host 重载、Client 注册/清理与真实 React 渲染 |
| `npm run verify:bundle` | 4/4 PASS | 归档文件边界、官方 CLI 安装激活、安装归档的 Host 加载/卸载、官方 CLI 卸载及用户 patch 保持 |
| `node scripts/g0/verify-evidence.mjs` | PASS | #4 原有 13 份快照、三项只读 Schema 及三份证据报告仍与锁文件一致 |

验证环境：Windows x64、Node 22.23.2、官方 DSH 0.2.1-rc.5、Cordis 4.0.5。测试均在开发依赖或随机临时 DSH_HOME 中进行，不修改 DSH/Cellgent 源码、在用 Profile 或真实授权材料。

真实 CLI 验收步骤：干净自定义 Profile → `dsh plugin add` 安装归档 → 自动出现 Bundle 激活记录 → 官方 `loadProfileDirectory/composeEntries` 解析 patch → 安装包 Host 在真实 Cordis 加载并返回 backend_not_ready → 卸载 fiber 后服务消失且旧引用拒绝 → `dsh plugin remove` 清理依赖及配置条目 → 用户 patch 保持不变。

设置页注册测试使用真实 SlotCore 和 Cordis，但 owner 席位在测试中声明；React 检查为静态渲染，**不是完整 Desktop/Web 浏览器验收**。当前无业务 Tool，不能将“没有 Tool 残留”表述为 #8 的工具实现已完成。

## 归档与证据

脱敏机器报告：[evidence/issue-5/bundle-report.json](evidence/issue-5/bundle-report.json)。本地归档：`artifacts/dsh-dingtalk-0.1.0-dev.1.tgz`，未提交二进制归档到 Git；源码和锁文件可重新构建。

本次归档 SHA256：`93121cd5964e80e49c15028216dc20c4a67c5e6c2b1ca599929e92d515d9da2c`。归档仅为基础开发版，不代表可查询真实钉钉数据。

## 后续边界

#6 对接精确 Profile 和安全 CLI 执行，#7 实现真实 OAuth、重授权和解绑，#8 实现业务 Tool/Skill，#9/#10 实现完整会话卡片与设置管理。真实授权、企业开通/应用 scope、刷新及 Desktop/Web 回调流程按用户安排留到最后测试。#4 的 G0 状态仍为 HOLD。

安装、升级、回滚和卸载见 [INSTALL.md](INSTALL.md)，运行契约和错误语义见 [CONTRACT.md](CONTRACT.md)。
