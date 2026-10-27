# BOOP v0.2 实施台账

分支：`cursor/boop-mvp-v0.2-f3d6`  
起点：`6f9c046681e58a1304704baf165dce5de2a49f4f`  
环境：Linux 云端，Node v22.23.4，本机 DSH CLI `0.2.1-rc.2`。没有 Windows 桌面，也没有已配置的对话模型。

状态只用 DONE、PARTIAL、BLOCKED。PARTIAL 表示代码在，但该项要求的真实宿主证据没有。

| 任务 | 状态 | 文件 | 验证 |
|---|---|---|---|
| T01 | DONE | `ADR-0001-boop-home.md`，本台账 | 分支从远端 main 拉出，未改 `baseline/` 与 `handoff/` |
| T02 | PARTIAL | `package.json`，`tests/helpers/test-host.mjs`，`tools/*` | 个人绝对路径改为显式环境变量。`node build.mjs` 与 unit 测试已跑。没有做一次从零的冻结安装 |
| T03 | BLOCKED | `src/host/home/native-session.ts` | 适配器只调用方案里核对过的 create、resolveAgent、flush、followup、inbox.remove、cancel。没有真实 Host 事件日志 |
| T04 | DONE | `persistence/database.ts`，`migrate.ts`，`storage.ts` | 空库直接 schema 2。有业务表但没有 meta 时拒绝写入。`checkWrite` 使用本进程记住的 fence。测试：`mvp-delegation`、原 `e00-03`、`e01-01` |
| T05 | DONE | `schema-v2.ts`，`delegation/service.ts` | 请求回执、单槽、结果和验收表随迁移创建。20 次同请求在测试里只保留一个 action |
| T06 | DONE | `home/service.ts`，`tests/unit/mvp-home.test.mjs` | 第二次 ensureHome 不再 create。模型缺失时 `send=false` 仍可 ready |
| T07 | PARTIAL | `src/client/index.tsx`，`home/controller.ts` | 隔离的 DSH Web 0.2.1-rc.2 上点「BOOP · 波波」打开了 `boop.home`。没有模型时页面说明去设置连接。截图 `evidence/screenshots/dsh-web-boop-ready.png`。没有发出真实聊天 |
| T08 | PARTIAL | `home/Header.tsx`，`Welcome.tsx`，`home-styles.ts`，截图 | 组件截图见 evidence/screenshots。不是宿主里的实机像素 |
| T09 | PARTIAL | `ComposerState.tsx`，home CSS | 去噪选择器不隐藏审批槽。中文输入法、附件和原生草稿没有在宿主里操作 |
| T10 | PARTIAL | `delegation/service.ts` catalog/context | 候选最多 5 个，排除项不进目录。上下文预算在服务里截断。真实 SessionQuery 目录未跑 |
| T11 | PARTIAL | `tools.ts`，`presets/boop.patch.yml` | 注册 `boop_dispatch` 与 `boop_task_control`。工具输出是一份 JSON。没有真实模型调用 |
| T12 | DONE | `delegation/service.ts` tick | 忙目标不占槽，空闲目标可以先走。测试覆盖 |
| T13 | PARTIAL | `gate/pre-step.ts`，`native-session.ts` | 混批先留下人类消息，不等 120 秒。v2 已准入的消息可以放行。没有真实 pre-step 事件 |
| T14 | PARTIAL | `delegation/service.ts` finishAction | 结束轮次才写结果。只有「完成了」且不可交付时验证不是 passed |
| T15 | PARTIAL | deliver() | 主会话忙时结果留在 outbox。测试没有覆盖主会话忙的投递 |
| T16 | DONE | stop() | 用户已接管时不调用 cancel。测试覆盖 |
| T17 | DONE | confirm/revise | 确认收下不改 checks。新修订使用新版本，旧结果还在 |
| T18 | PARTIAL | reconcile/bootRecover | 丢失的 followup 不重发。杀进程后的真实 Host 恢复未跑 |
| T19 | DONE | `projection.ts` | 已交付、待确认、验证失败可以同时存在 |
| T20 | PARTIAL | WorkDrawer、WorkCard、TargetCandidates | 组件和选择卡解析有测试。点击流程没有在宿主里点过 |
| T21 | PARTIAL | SettingsPanel、HistoryList、Diagnostics | 设置页截图。范围写入有 `setAccess`，UI 还没有编辑表单 |
| T22 | PARTIAL | `scheduler.ts` retireOwned | 启动时改为摘掉带 BOOP 标记的每日日程，不新建。没有在真实 schedule 服务上演练 |
| T23 | PARTIAL | home 样式注释，旧任务板不再注册 | DS-Bot 只借用紧凑页头的结构，颜色仍是 BOOP。旧任务板源码还在，但不是入口 |
| T24 | BLOCKED | — | 没有模型，也没有可执行的原会话产物 |
| T25 | PARTIAL | 委托测试 | 停止、未知结果、确认收下有单测。审批并发和杀 Host 未跑 |
| T26 | PARTIAL | 迁移测试 | v1 行保留，备份目录缺失时不升级。没有用旧包装回去再装新包 |
| T27 | PARTIAL | 截图 | 1280 浅色、深色抽屉、390 窄屏、设置页。对比度没有用仪器量。键盘流程未在宿主里走 |
| T28 | BLOCKED | — | 没有 rc.3 桌面，也没有可安装候选包的双端安装记录 |
| T29 | DONE | 本文件，`RUN.md`，`acceptance.json` | 台账按实际测试填写，没有把未跑的项写成通过 |

## 本环境命令

- `node build.mjs`：成功。
- `node --test tests/unit/*.test.mjs`：295 通过（含本轮新增之前的全量 unit，以及当时一起跑的 lifecycle 测试）。
- 之后又单独通过：`mvp-home.test.mjs`、`mvp-delegation.test.mjs`、`mvp-home-lifecycle.test.mjs`、`e04-01b-client-apply.test.mjs`。
- `tests/client/e04-01-companion.test.mjs` 仍引用构建脚本没有产出的 `lib/companion.test.bundle.cjs`。这是原有入口和构建映射不一致，本轮没有把它算进通过。
