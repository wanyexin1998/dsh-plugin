# P0 证据落点（W003 / W004 / W005）

本目录存放 **P0 的运行时证据**。契约盘点的分区证据在工作区临时目录 `E:\wyx_code\_v5-frozen\evidence\`，
不随插件工程提交；本目录只保留放行评审需要的最终结果。

## 需要放进来的东西

| 文件 | 来源 | 用途 |
| --- | --- | --- |
| `p0-probe-report.json` | 应用内探针面板「复制报告」按钮（或控制台 `[dsh-split-probe] report …`） | W003/W004/W005 的运行时结论 |
| `g0-decision.md` | 由 `docs/gates/P0.md` 填写而成 | G0 放行结论与未证实清单 |
| `dockview-version.md` | W005 通过后写入的版本决策（包 + 版本 + 许可 + lockfile 条目） | 依赖锁定依据 |

## 报告里怎么读（对应判据）

| 探针条目 | 看什么 | 对应判据 |
| --- | --- | --- |
| `W003-a/select-own-main-key` | `during.workbenchMounted` 为真、`during.retention.info` 与 `before` 是否一致、`during.rightbar.*` 是否变化 | 原生服务在关闭呈现后是否继续；右栏耦合是否如静态结论 |
| `W003-a/verdict` | `pass` 表示自建主面板生效且保活未变 | P-1 的判据 |
| `W003-b/second-presentation` | `nativeRootMovedOut`：**true 即证实**「第二个 occurrence 静默搬走原生编辑根」 | F12 的唯一根纪律 |
| `W003-b/verdict` + `W003-b/manual-typing` | 人工输入结论与可编辑 root 数 | N01/N03 的雏形 |
| `W004/session-switch-sidebar` | `marked` 节点数量与 `hidden` 变化、`sidebarRightExpanded` | F03：同时可见面是否恒为 0/1 |
| `W005/dockview-restricted` | `constructError`/`moveError`、`componentSurvivedMove`、`maximize`、`snapshotKeys`、`dndCapabilities` | W005 验收：公开 API 移动不重建内容 |

## 纪律

- 证据必须记录：插件与探针版本、宿主 `dsh 0.2.0-rc.2`、平台/视口/缩放、复现步骤、实际结果。
- 不记录凭证与完整聊天正文；截图不能替代原生契约结论（N/V 项要求行为证据）。

## 报告评估

把报告存成 `docs/evidence/p0-probe-report.json` 后运行：

```
node tools/p0-report.mjs docs/evidence/p0-probe-report.json    # 退出码 0 = 证据齐备
node tools/p0-report.mjs --self-test                          # 校验评估器自身
```

评估器只读报告、只打印判据结论；`missing` 与 `fail` 计入阻断，`info` 是需要写进 G0 结论的发现
（例如宿主会静默搬走编辑器根、右栏可见面的实际取值）。
