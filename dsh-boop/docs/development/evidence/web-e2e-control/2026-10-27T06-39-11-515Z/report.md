# Web E2E — human control (real Edge)

Verdict: **NOT_RUN**. This run does not mark any gate PASS, does not edit STATUS.md, and does not enable write mode.

Blocker: web exited early (1) stdout: stderr: dsh: startup failed: 1 required plugin did not activate Failed plugins (1): modules (required) Package: @deepseek-ai/dsh-client-modules AggregateError: client-modules: 1 client package failed to compose: other failures: - client-modules: package dsh-boop resolves from multiple active Loader sources: "dsh-boop" from file:///E:/dsh-plugin/dsh-boop/.work/test-runs/web-e2e-control-1793083151523/dsh-home/profiles/boop-web-e2e-control/, "file:///E:/dsh-plugin/dsh-boop/.work/test-runs/web-e2e-control-1793083151523/dsh-home/profiles/boop-web-e2e-control/node_modules/dsh-boop/lib/channels-api.js" from file:///E:/dsh-plugin/dsh-boop/.work/test-runs/web-e2e-control-…

| Item | Value |
| --- | --- |
| Browser | msedge |
| Host | DSH 0.2.1-rc.2 |
| Private DSH_HOME | `.work/test-runs/web-e2e-control-1793083151523/dsh-home` |
| URL | not booted |
| Port | 60419 |

## Steps

| Status | Step | Detail |
| --- | --- | --- |
| PASS | private web profile prepared (write mode not enabled) | boop-web-e2e-control; DSH_HOME=.work/test-runs/web-e2e-control-1793083151523/dsh-home; write mode not enabled |
| NOT_RUN | web Host booted on 127.0.0.1 | web exited early (1) stdout: stderr: dsh: startup failed: 1 required plugin did not activate Failed plugins (1): modules (required) Package: @deepseek-ai/dsh-client-modules AggregateError: client-modules: 1 client package failed to compose: other failures: - client-modules: package dsh-boop resolves from multiple active Loader sources: "dsh-boop" from file:///E:/dsh-plugin/dsh-boop/.work/test-runs/web-e2e-control-1793083151523/dsh-home/profiles/boop-web-e2e-control/, "file:///E:/dsh-plugin/dsh-b… |
| NOT_RUN | Edge shell ready | web exited early (1) stdout: stderr: dsh: startup failed: 1 required plugin did not activate Failed plugins (1): modules (required) Package: @deepseek-ai/dsh-client-modules AggregateError: client-modules: 1 client package failed to compose: other failures: - client-modules: package dsh-boop resolves from multiple active Loader sources: "dsh-boop" from file:///E:/dsh-plugin/dsh-boop/.work/test-runs/web-e2e-control-1793083151523/dsh-home/profiles/boop-web-e2e-control/, "file:///E:/dsh-plugin/dsh-b… |
| NOT_RUN | BOOP task board opened | web exited early (1) stdout: stderr: dsh: startup failed: 1 required plugin did not activate Failed plugins (1): modules (required) Package: @deepseek-ai/dsh-client-modules AggregateError: client-modules: 1 client package failed to compose: other failures: - client-modules: package dsh-boop resolves from multiple active Loader sources: "dsh-boop" from file:///E:/dsh-plugin/dsh-boop/.work/test-runs/web-e2e-control-1793083151523/dsh-home/profiles/boop-web-e2e-control/, "file:///E:/dsh-plugin/dsh-b… |
| NOT_RUN | deterministic Stop is honest | web exited early (1) stdout: stderr: dsh: startup failed: 1 required plugin did not activate Failed plugins (1): modules (required) Package: @deepseek-ai/dsh-client-modules AggregateError: client-modules: 1 client package failed to compose: other failures: - client-modules: package dsh-boop resolves from multiple active Loader sources: "dsh-boop" from file:///E:/dsh-plugin/dsh-boop/.work/test-runs/web-e2e-control-1793083151523/dsh-home/profiles/boop-web-e2e-control/, "file:///E:/dsh-plugin/dsh-b… |
| NOT_RUN | recovery has no select-all and empty release is refused | web exited early (1) stdout: stderr: dsh: startup failed: 1 required plugin did not activate Failed plugins (1): modules (required) Package: @deepseek-ai/dsh-client-modules AggregateError: client-modules: 1 client package failed to compose: other failures: - client-modules: package dsh-boop resolves from multiple active Loader sources: "dsh-boop" from file:///E:/dsh-plugin/dsh-boop/.work/test-runs/web-e2e-control-1793083151523/dsh-home/profiles/boop-web-e2e-control/, "file:///E:/dsh-plugin/dsh-b… |
| NOT_RUN | approval empty state is honest | web exited early (1) stdout: stderr: dsh: startup failed: 1 required plugin did not activate Failed plugins (1): modules (required) Package: @deepseek-ai/dsh-client-modules AggregateError: client-modules: 1 client package failed to compose: other failures: - client-modules: package dsh-boop resolves from multiple active Loader sources: "dsh-boop" from file:///E:/dsh-plugin/dsh-boop/.work/test-runs/web-e2e-control-1793083151523/dsh-home/profiles/boop-web-e2e-control/, "file:///E:/dsh-plugin/dsh-b… |
| NOT_RUN | IME composition on a BOOP text field | web exited early (1) stdout: stderr: dsh: startup failed: 1 required plugin did not activate Failed plugins (1): modules (required) Package: @deepseek-ai/dsh-client-modules AggregateError: client-modules: 1 client package failed to compose: other failures: - client-modules: package dsh-boop resolves from multiple active Loader sources: "dsh-boop" from file:///E:/dsh-plugin/dsh-boop/.work/test-runs/web-e2e-control-1793083151523/dsh-home/profiles/boop-web-e2e-control/, "file:///E:/dsh-plugin/dsh-b… |

## What was checked

- Stop uses the scope-all control `停止全部 BOOP 动作` (`[data-boop-stop-action="stop"]`, radio `value="all"`). An empty board must read as noop (`没有可停止内容`, `noop=true`, `不是“已撤销成功”`) together with `请求已发送 ≠ 外部副作用已撤销`. A refusal that says the ledger was not changed is also honest. A stopped-item list with no actions on the board is a failure.
- Recovery is `[data-boop-recovery]`. There must be no select-all control. With zero checked message ids, `释放选中（0）` must not produce a success that released everything. The standing copy is `必须逐项` / `未勾选的旧 BOOP 命令保持阻断`. A host `INVALID_ARGUMENT` receipt is a refusal.
- Approvals: a ready board with nothing pending must show `服务端确认：当前没有等待你决定的有效审批（不是读取失败）。` and no decidable pending card. A failed read must not be presented as zero pending.
- IME: one composition (`compositionstart` / `compositionupdate` / `compositionend`) on a BOOP-owned text field inside `[data-boop-panel]`, when one exists. A missing field is SKIP, not a failure.

## Screenshots

- none

