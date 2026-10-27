# Web E2E — human control (real Edge)

Verdict: **FAIL**. This run does not mark any gate PASS, does not edit STATUS.md, and does not enable write mode.

Blocker: none.

| Item | Value |
| --- | --- |
| Browser | msedge 156.0.4314.42 |
| Host | DSH 0.2.1-rc.2 |
| Private DSH_HOME | `.work/test-runs/web-e2e-control-1793082807093/dsh-home` |
| URL | http://127.0.0.1:55275/ |
| Port | 55275 |

## Steps

| Status | Step | Detail |
| --- | --- | --- |
| PASS | private web profile prepared (write mode not enabled) | boop-web-e2e-control; DSH_HOME=.work/test-runs/web-e2e-control-1793082807093/dsh-home; write mode not enabled |
| PASS | web Host booted on 127.0.0.1 | port 55275; http://127.0.0.1:55275/ |
| FAIL | Edge shell ready | click-blocking masks remain: 1 [{"text":"预览版说明DeepSeek Harness 目前的 0.2 版本仍处于预览阶段，还有许多地方需要持续改进和打磨，希望听取广大开发者和用户的反馈建议。现在，新的桌面端面向广泛用户，开发者相关的进阶功能可在配置中开启使用。预计 DeepSeek Harness 的产品功能以及插件 API 都会继续快速迭代、持续演化，并逐渐趋于稳定。我们期待与全球用户和开发者一起，在开源、可复用、可组合的基础设施之上，","buttons":[{"text":"继续","aria":null,"disabled":true}]}] |
| NOT_RUN | BOOP task board opened | Edge shell still has a blocking dialog |
| NOT_RUN | deterministic Stop is honest | Edge shell still has a blocking dialog |
| NOT_RUN | recovery has no select-all and empty release is refused | Edge shell still has a blocking dialog |
| NOT_RUN | approval empty state is honest | Edge shell still has a blocking dialog |
| NOT_RUN | IME composition on a BOOP text field | Edge shell still has a blocking dialog |

## What was checked

- Stop uses the scope-all control `停止全部 BOOP 动作` (`[data-boop-stop-action="stop"]`, radio `value="all"`). An empty board must read as noop (`没有可停止内容`, `noop=true`, `不是“已撤销成功”`) together with `请求已发送 ≠ 外部副作用已撤销`. A refusal that says the ledger was not changed is also honest. A stopped-item list with no actions on the board is a failure.
- Recovery is `[data-boop-recovery]`. There must be no select-all control. With zero checked message ids, `释放选中（0）` must not produce a success that released everything. The standing copy is `必须逐项` / `未勾选的旧 BOOP 命令保持阻断`. A host `INVALID_ARGUMENT` receipt is a refusal.
- Approvals: a ready board with nothing pending must show `服务端确认：当前没有等待你决定的有效审批（不是读取失败）。` and no decidable pending card. A failed read must not be presented as zero pending.
- IME: one composition (`compositionstart` / `compositionupdate` / `compositionend`) on a BOOP-owned text field inside `[data-boop-panel]`, when one exists. A missing field is SKIP, not a failure.

## Screenshots

- none

