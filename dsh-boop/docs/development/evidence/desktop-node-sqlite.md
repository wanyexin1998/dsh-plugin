# Desktop Electron Node — ledger suite

Date: 2026-10-27. This does **not** mark G08 PASS.

Command, from the repo root, without reading or writing the user `~/.dsh`:

```powershell
$env:ELECTRON_RUN_AS_NODE='1'
& 'E:\deepseek-harness\DeepSeek Harness.exe' --test --test-timeout=20000 --test-force-exit tests/unit/e00-03-storage.test.mjs tests/unit/e03-05-host-init.test.mjs tests/unit/e01-01-lease-heartbeat.test.mjs
```

Result: **17/17 PASS**. The process reported `node=v24.21.0` and `sqlite=3.53.4`.

What this proves: the Desktop install binary can run BOOP's SQLite ledger, lease heartbeat, boot reconciliation, initialization watermarks, forget tombstones, and FTS using `node:sqlite`.

What this does not prove: the Desktop GUI loaded the plugin, a window chrome regression, or a second operating system. `ELECTRON_RUN_AS_NODE` uses that binary's Node. It does not start the Electron main window.
