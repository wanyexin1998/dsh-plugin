# Web E2E — human control (real Edge)

Verdict: **PASS**. This run does not mark any gate PASS and does not edit STATUS.md. Write mode follows the gate ledger. Approval, stop, and recovery still do not dispatch.

Blocker: none for the control steps.

Channels stay closed on the main host row. This profile does not disable a BOOP row and does not set a write-mode flag.

| Item | Value |
| --- | --- |
| Browser | msedge 156.0.4314.42 |
| Host | DSH 0.2.1-rc.2 |
| Private DSH_HOME | `.work/test-runs/web-e2e-control-1793092604730/dsh-home` |
| URL | http://127.0.0.1:54058/ |
| Port | 54058 |

## Steps

| Status | Step | Detail |
| --- | --- | --- |
| PASS | private web profile prepared (write mode follows the gate ledger) | boop-web-e2e-control; DSH_HOME=.work/test-runs/web-e2e-control-1793092604730/dsh-home; write mode follows the gate ledger |
| PASS | web Host booted on 127.0.0.1 | port 54058; http://127.0.0.1:54058/ |
| PASS | Edge shell ready | title="DeepSeek Harness" url=http://127.0.0.1:54058/ |
| PASS | BOOP task board opened | state=ready writeModeOn=true heroOn=true dispatchClosed=true 写模式：开启 · 账本：可写（ledger，durable） · 派发：不可用（dispatch-not-on-this-row；需要模型：是） |
| PASS | deterministic Stop is honest | clicked "停止全部 BOOP 动作". noop; nothing was claimed stopped. 服务端已受理停止请求（确定性：是；需要模型：否）。没有可停止内容（noop=true，stopped 为空，不是“已撤销成功”）。 范围：all。 服务端说明：没有可停止的 BOOP 动作（用户自己的 turn 不在停止范围，也没有任何外部副作用被宣称撤销）。 策略事实：ownOnly=boop-ledger-actions；用户 turn 被停=否；外部副作用已撤销=否；确定性=是； 需要模型=否。 请求已发送 ≠ 外部副作用已撤销：只有 BOOP 尚未投递的待发动作会被确定性取消；已投递的动作 BOOP 不宣称撤销，未知项不会自动重试。 审计：ledger，已记录（b_cluufh9a5u） control/stop |
| PASS | recovery has no select-all and empty release is refused | selectAll=0 checked=0 release={"text":"释放选中（0）","disabled":true} receipt=none section=重启恢复核查 门禁已装备（fail-closed）：待释放 0 条，已释放 0 条。 恢复必须逐项显式勾选释放；未勾选的旧 BOOP 命令保持阻断，不会自动执行。释放只改变门禁账本。 服务端确认：当前没有需要恢复核查的旧 BOOP 命令。 释放选中（0） |
| PASS | approval empty state is honest | pending=0 cards=0 decidablePending=0. 服务端确认：当前没有等待你决定的有效审批（不是读取失败）。 |
| PASS | seeded approval is recorded and not dispatched | clicked 批准本次 on approval-e2e-1; ledger status=allowed; action stayed awaiting_approval; 服务端已记录：允许本次（仅落账）。审批结论已落账（允许本次）。写模式关闭：本次没有派发任何动作，也没有执行任何外部副作用。 审计：ledger，已记录（b_5jwan8ogdz） control/approval-decided |
| PASS | stale approval cannot be decided | approval-e2e-stale shows 任务版本已移动; approve stays disabled; ledger status stayed pending |
| PASS | IME composition on a BOOP text field | field=搜索任务名、任务ID、工作区或会话 type=search transport=cdp-imeSetComposition events=compositionstart>compositionupdate>compositionupdate>compositionend value="波波" |

## What was checked

- Stop uses the scope-all control `停止全部 BOOP 动作` (`[data-boop-stop-action="stop"]`, radio `value="all"`). An empty board must read as noop (`没有可停止内容`, `noop=true`, `不是“已撤销成功”`) together with `请求已发送 ≠ 外部副作用已撤销`. A refusal that says the ledger was not changed is also honest. A stopped-item list with no actions on the board is a failure.
- Recovery is `[data-boop-recovery]`. There must be no select-all control. With zero checked message ids, `释放选中（0）` must not produce a success that released everything. The standing copy is `必须逐项` / `未勾选的旧 BOOP 命令保持阻断`. A host `INVALID_ARGUMENT` receipt is a refusal.
- Approvals: a ready board with nothing pending must show `服务端确认：当前没有等待你决定的有效审批（不是读取失败）。` and no decidable pending card. A failed read must not be presented as zero pending.
- IME: one composition (`compositionstart` / `compositionupdate` / `compositionend`) on a BOOP-owned text field inside `[data-boop-panel]`, when one exists. A missing field is SKIP, not a failure.

## Screenshots

- `docs/development/evidence/web-e2e-control/2026-10-27T09-16-44-730Z/screens/01-shell-1280x800.png`
- `docs/development/evidence/web-e2e-control/2026-10-27T09-16-44-730Z/screens/02-board-control.png`
- `docs/development/evidence/web-e2e-control/2026-10-27T09-16-44-730Z/screens/03-stop-before.png`
- `docs/development/evidence/web-e2e-control/2026-10-27T09-16-44-730Z/screens/04-stop-result.png`
- `docs/development/evidence/web-e2e-control/2026-10-27T09-16-44-730Z/screens/05-recovery.png`
- `docs/development/evidence/web-e2e-control/2026-10-27T09-16-44-730Z/screens/06-recovery-after-empty-release.png`
- `docs/development/evidence/web-e2e-control/2026-10-27T09-16-44-730Z/screens/07-approvals.png`
- `docs/development/evidence/web-e2e-control/2026-10-27T09-16-44-730Z/screens/09-approval-before.png`
- `docs/development/evidence/web-e2e-control/2026-10-27T09-16-44-730Z/screens/10-approval-decided.png`
- `docs/development/evidence/web-e2e-control/2026-10-27T09-16-44-730Z/screens/11-stale-approval.png`
- `docs/development/evidence/web-e2e-control/2026-10-27T09-16-44-730Z/screens/08-ime.png`

