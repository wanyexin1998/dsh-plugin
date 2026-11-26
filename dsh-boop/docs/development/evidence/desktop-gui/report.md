# Desktop window probe

Date: 2026-11-10. Run `.work/test-runs/desktop-gui-1794292802095`. This folder's screenshots and `report.json` are from this run. The 2026-10-27 rc.3 images that used to live here were replaced.

`tools/desktop-gui-probe.mjs` started `DeepSeek Harness.exe` (DSH Desktop **0.2.2-rc.1**, commit `c59d10aff167ad7eefead4b3a9082fb57c8fbfe8`) with:

- `DSH_HOME` under `.work/test-runs/desktop-gui-1794292802095/dsh-home`
- a fresh Electron `--user-data-dir` under that same run directory
- the `desktop` profile joined to the isolated web profile `boop-web-e2e-control`, whose `dsh-boop` link points at this repo
- `ELECTRON_RUN_AS_NODE` removed, so the executable stays the GUI

The user's `~/.dsh` mtime did not change (`userDshUntouched: true`). Browser string: `Chrome/152.0.7977.130`. Elapsed 22663 ms. Title `DeepSeek Harness`.

`engines.dsh` admits `0.2.2-rc.1`. There is no `compatibility.json`. The plugin page does not say 不兼容. The sidebar shows `BOOP 任务板` and `打开 BOOP 主聊天`.

The board text in `report.json` reads:

- 恢复门禁已装备, 写模式开启, 账本在位（单写者）
- main session `boop-main` bound in the ledger
- host version **DSH 0.2.2-rc.1**, commit `c59d10aff167…`
- the board prints gates G01–G06 PASS, G07 BLOCKED, G08 PASS, G09 PASS. Those badges are the plugin's compiled ledger, not a new measurement of every gate
- control row: 写模式：开启 · 账本：可写 · 派发：不可用（`dispatch-not-on-this-row`）
- the page also says 有些门禁被阻断, which matches G07 staying BLOCKED
- light theme: `body` has no `data-ds-dark-theme`, the board panel is mounted, 4 BOOP style sheets (`desktop-theme-light.png`)
- dark theme: `data-ds-dark-theme` is set (`desktop-theme-dark.png`). `followsHost` is true
- package switch started `aria-checked=true`. After it was turned off, sidebar labels matching BOOP were 0, the board panel was gone, BOOP style sheets were 0, and 新会话 was still there
- the same switch was clicked again: `enabledAgain` is true, `afterChecked` is true, and the sidebar returned `BOOP 任务板` and `打开 BOOP 主聊天`. No restart notice
- no `Invalid hook call` / multiple-React console errors

That home's ledger has two `boot/reconciled` audits. The later one is `clean=true unknown=0`. The live `clean_shutdown` value was `0` because the probe then stops the process.

macOS and Linux were not run. This window did not send a `boop_dispatch` followup.
