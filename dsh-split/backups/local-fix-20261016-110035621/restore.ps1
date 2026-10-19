$ErrorActionPreference = 'Stop'
$taskBackup = $PSScriptRoot
$taskRepo = 'E:/dsh-plugin/dsh-split'
# Restore only the release's changed files. No deletions, relinking, or app restart.
Copy-Item -LiteralPath (Join-Path $taskBackup 'lib/client.js') -Destination (Join-Path $taskRepo 'lib/client.js') -Force
Copy-Item -LiteralPath (Join-Path $taskBackup 'lib/index.js') -Destination (Join-Path $taskRepo 'lib/index.js') -Force
foreach ($taskPackage in @('dsh-client-ui-attachment', 'dsh-client-ui-sidebar-right')) {
    Copy-Item -LiteralPath (Join-Path $taskBackup ('patched/' + $taskPackage + '/lib/client.js')) -Destination (Join-Path $taskRepo ('patches/patched/' + $taskPackage + '/lib/client.js')) -Force
}
Copy-Item -LiteralPath (Join-Path $taskBackup 'patched/MANIFEST.json') -Destination (Join-Path $taskRepo 'patches/patched/MANIFEST.json') -Force
Copy-Item -LiteralPath (Join-Path $taskBackup 'PATCHES.md') -Destination (Join-Path $taskRepo 'patches/PATCHES.md') -Force
Write-Output 'Previous installed plugin and host patches restored. Reopen DSH to load them.'
