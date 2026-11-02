# G0 证据索引

采集日期：2026-11-02（Asia/Shanghai）。关联 [Issue #4](https://github.com/wanyexin1998/dsh-plugin/issues/4)。

| 路径 | 内容 | 证据等级 |
| --- | --- | --- |
| `dws/manifest.json` | 13 条公开采集命令、退出码、SHA256、二进制架构、文件副作用 | 本地真实二进制；只含公开声明/空状态 |
| `dws/*.schema.json` | 三项只读能力的官方 compact Schema | 版本契约，不是业务执行成功 |
| `dws/*.txt`、其余 JSON | 公开 help、版本、预演、隔离空存储状态 | 非真实企业授权 |
| `exchange-report.json` | 本项目 6 组额外 OAuth / Profile / 状态负向检查 | `LOCAL_FIXTURE_ONLY` |
| `upstream-smoke-report.json` | 保留上游断言的 6 组检查（包含 9 个脱敏场景） | `LOCAL_FIXTURE_ONLY` |
| `dsh-report.json` | 官方 DSH 发布包 Tool/Cordis/Slot 的 4 组检查及包/契约指纹 | `PUBLISHED_RUNTIME_API_ONLY` |

复现命令见 [本地验证说明](../../G0-local-validation.md)。`manifest.json` 中的空状态不包含任何用户真实登录态。测试报告只记录合成测试的结果和脱敏错误，不保存 code/token、员工资料或业务正文。CLI 日志和临时 Profile 不作为交付物。

验证提交的证据与锁文件一致：

```powershell
node dsh-dingtalk/scripts/g0/verify-evidence.mjs
```

CLI 自动生成的 help/Schema 来源为 DingTalk Workspace CLI `v1.0.66`，Copyright 2026 Alibaba Group，按 Apache-2.0 发布。保留原始公开命令说明，用于兼容审查；换行规范化为 LF。上游许可和 NOTICE 位于 `third-party/`；来源和版本见锁文件。此处不分发 DWS 二进制、Go 源码或上游 Python 测试源码。

**真实企业 OAuth、权限拒绝、应用 scope 和浏览器授权回调尚未验收；G0 保持 HOLD。**
