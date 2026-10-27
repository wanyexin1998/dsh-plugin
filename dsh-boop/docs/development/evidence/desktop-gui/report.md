# Desktop window probe

Date: 2026-10-27. Run `.work/test-runs/desktop-gui-1793092410382`. G09 stays PASS from this window. G08 stays PASS from the Web host fencing test plus the ledger this window opened. The board shows write mode open. The control row still does not dispatch.

`tools/desktop-gui-probe.mjs` started `DeepSeek Harness.exe` (DSH Desktop **0.2.1-rc.3**, commit `be72761ee1a6736ebcdf4f3739363b083ae53c98`) with:

- `DSH_HOME` under `.work/test-runs/desktop-gui-1793092410382/dsh-home`
- a fresh Electron `--user-data-dir` under that same run directory
- the `desktop` profile joined to an isolated web profile that already contained `dsh-boop`
- `ELECTRON_RUN_AS_NODE` removed, so the executable stays the GUI

The user's `~/.dsh` mtime did not change (`userDshUntouched: true`).

`engines.dsh` is `0.2.1-rc.2 || 0.2.1-rc.3`. There is no `compatibility.json`. The plugin page does not say 不兼容. The sidebar shows `BOOP 任务板` and `打开 BOOP 主聊天`.

The board text in `report.json` reads:

- 恢复门禁已装备, 写模式开启, 账本在位（单写者）
- main session `boop-main` bound in the ledger
- host version **DSH 0.2.1-rc.3**, commit `be72761ee1a6…`
- gates G01–G06 PASS, G07 BLOCKED, G08 PASS, G09 PASS
- control row: 写模式：开启 · 账本：可写 · 派发：不可用（`dispatch-not-on-this-row`）
- the page also says 有些门禁被阻断, which matches G07 staying BLOCKED
- light theme: `body` has no `data-ds-dark-theme`, the board panel is mounted, 4 BOOP style sheets (`desktop-theme-light.png`)
- dark theme: `data-ds-dark-theme` is set and the shell plus the board go dark (`desktop-theme-dark.png`). `followsHost` is true
- package switch `启用 dsh-boop` started `aria-checked=true`. After it was turned off, sidebar labels matching BOOP were 0, the board panel was gone, BOOP style sheets were 0, and 新会话 was still there
- the same switch was clicked again after it reported unchecked: `enabledAgain` is true, `afterChecked` is true, and the sidebar returned `BOOP 任务板` and `打开 BOOP 主聊天`. No restart notice
- no `Invalid hook call` / multiple-React console errors

That home's ledger has two `boot/reconciled` audits. The later one is `clean=true unknown=0`. The live `clean_shutdown` value was `0` because the probe then stops the process. This is not a second operating system. The Web host test shows a second process stays read-only while the first heartbeats.

macOS and Linux were not run.
