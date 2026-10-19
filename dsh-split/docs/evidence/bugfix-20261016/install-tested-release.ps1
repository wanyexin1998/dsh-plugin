# One-time local release for the artifacts tested on 2026-10-16.
# Does not stop/start DSH, modify app.asar, or remove any files.
$ErrorActionPreference = 'Stop'
$taskRepo = (Resolve-Path -LiteralPath 'E:/dsh-plugin/dsh-split').Path
$taskNode = 'C:/Users/wanyexin/.dsh/dsh-runtimes/dsh-primary-runtime/dependencies/node/bin/node.exe'
$taskProfileDir = 'C:/Users/wanyexin/.dsh/profiles/desktop'
$taskStage = Join-Path $taskRepo 'dist/host-patches-fix'
$taskExpected = @{
    'dist/client.js' = '8ecdbc972d5a4c7bf24a5b0eb0b8b7b5a82f1182b5bd61cc90edbe2e547b1053'
    'dist/host-patches-fix/dsh-client-ui-attachment/lib/client.js' = '0f54931521da35fb27a8279773cbd200ec3aa3e6ebeea2f0b0efd1b95452ab92'
    'dist/host-patches-fix/dsh-client-ui-sidebar-right/lib/client.js' = 'eaf6a0b189421c3a62739ba466e916f2a98b98337bdddcfacdf9a3bf22af2f25'
}
foreach ($taskEntry in $taskExpected.GetEnumerator()) {
    if ((Get-FileHash -LiteralPath (Join-Path $taskRepo $taskEntry.Key)).Hash -ne $taskEntry.Value) {
        throw "Tested artifact changed: $($taskEntry.Key)"
    }
}
$taskProfileJson = Get-Content -LiteralPath (Join-Path $taskProfileDir 'package.json') -Raw | ConvertFrom-Json
if ($taskProfileJson.dsh.profile.bundles -notcontains 'dsh-split') { throw 'Plugin bundle is not enabled' }
$taskLinks = @{
    'dsh-split' = $taskRepo
    '@deepseek-ai/dsh-client-ui-sidebar-right' = (Join-Path $taskRepo 'patches/patched/dsh-client-ui-sidebar-right')
    '@deepseek-ai/dsh-client-ui-attachment' = (Join-Path $taskRepo 'patches/patched/dsh-client-ui-attachment')
    '@deepseek-ai/dsh-client-ui-workspace' = (Join-Path $taskRepo 'patches/patched/dsh-client-ui-workspace')
}
foreach ($taskEntry in $taskLinks.GetEnumerator()) {
    $taskLink = Get-Item -LiteralPath (Join-Path $taskProfileDir ('node_modules/' + $taskEntry.Key))
    if ($taskLink.LinkType -ne 'Junction' -or [IO.Path]::GetFullPath($taskLink.Target) -ne [IO.Path]::GetFullPath($taskEntry.Value)) {
        throw "Unexpected profile target: $($taskEntry.Key)"
    }
}
$taskManifest = Get-Content -LiteralPath (Join-Path $taskStage 'MANIFEST.json') -Raw | ConvertFrom-Json
$taskChanged = @()
foreach ($taskEntry in $taskManifest.files) {
    $taskRel = $taskEntry.pkg + '/' + $taskEntry.file
    $taskCandidate = Join-Path $taskStage $taskRel
    if ((Get-FileHash -LiteralPath $taskCandidate).Hash -ne $taskEntry.patchedSha256) { throw "Stage manifest mismatch: $taskRel" }
    $taskInstalled = Join-Path $taskRepo ('patches/patched/' + $taskRel)
    if ((Get-FileHash -LiteralPath $taskInstalled).Hash -ne $taskEntry.patchedSha256) { $taskChanged += $taskRel }
}
if (@(Compare-Object ($taskChanged | Sort-Object) (@('dsh-client-ui-attachment/lib/client.js', 'dsh-client-ui-sidebar-right/lib/client.js') | Sort-Object)).Length -ne 0) {
    throw 'Unexpected active patch drift; refusing to overwrite'
}
$taskAppHash = (Get-FileHash -LiteralPath 'E:/deepseek-harness/resources/app.asar').Hash
if ($taskAppHash -ne '983ca71114e6dfd353fc79af5a1f9481a250ee64c2a3c757673029b811b23bc2') { throw 'DSH installation changed since validation' }
$taskBackup = Join-Path $taskRepo ('backups/local-fix-' + (Get-Date -Format 'yyyyMMdd-HHmmssfff'))
New-Item -ItemType Directory -Path $taskBackup | Out-Null
Copy-Item -LiteralPath (Join-Path $taskRepo 'lib') -Destination (Join-Path $taskBackup 'lib') -Recurse
Copy-Item -LiteralPath (Join-Path $taskRepo 'patches/patched') -Destination (Join-Path $taskBackup 'patched') -Recurse
Copy-Item -LiteralPath (Join-Path $taskRepo 'patches/PATCHES.md') -Destination $taskBackup
Copy-Item -LiteralPath (Join-Path $taskRepo 'cordis.patch.yml') -Destination $taskBackup
Copy-Item -LiteralPath (Join-Path $taskProfileDir 'package.json') -Destination (Join-Path $taskBackup 'desktop-profile-package.json')
$taskRestore = @'
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
'@
Set-Content -LiteralPath (Join-Path $taskBackup 'restore.ps1') -Value $taskRestore -Encoding utf8
try {
    & $taskNode (Join-Path $taskRepo 'tools/workbench-install.mjs') --install --yes
    if ($LASTEXITCODE -ne 0) { throw "Plugin installer exited $LASTEXITCODE" }
    foreach ($taskRel in $taskChanged) {
        Copy-Item -LiteralPath (Join-Path $taskStage $taskRel) -Destination (Join-Path $taskRepo ('patches/patched/' + $taskRel)) -Force
    }
    Copy-Item -LiteralPath (Join-Path $taskStage 'MANIFEST.json') -Destination (Join-Path $taskRepo 'patches/patched/MANIFEST.json') -Force
    Copy-Item -LiteralPath (Join-Path $taskStage 'PATCHES.md') -Destination (Join-Path $taskRepo 'patches/PATCHES.md') -Force
    foreach ($taskEntry in $taskManifest.files) {
        $taskInstalled = Join-Path $taskRepo ('patches/patched/' + $taskEntry.pkg + '/' + $taskEntry.file)
        if ((Get-FileHash -LiteralPath $taskInstalled).Hash -ne $taskEntry.patchedSha256) { throw 'Installed patch hash mismatch' }
    }
    $taskLoaded = @()
    foreach ($taskEntry in $taskLinks.GetEnumerator()) {
        $taskClient = Join-Path $taskProfileDir ('node_modules/' + $taskEntry.Key + '/lib/client.js')
        $taskLoaded += [pscustomobject]@{ package = $taskEntry.Key; resolvedTarget = $taskEntry.Value; clientSha256 = (Get-FileHash -LiteralPath $taskClient).Hash.ToLowerInvariant() }
    }
    foreach ($taskArtifact in @('client.js', 'index.js')) {
        if ((Get-FileHash -LiteralPath (Join-Path $taskRepo ('lib/' + $taskArtifact))).Hash -ne (Get-FileHash -LiteralPath (Join-Path $taskRepo ('dist/' + $taskArtifact))).Hash) { throw 'Installed plugin hash mismatch' }
    }
    if ((Get-FileHash -LiteralPath (Join-Path $taskProfileDir 'package.json')).Hash -ne (Get-FileHash -LiteralPath (Join-Path $taskBackup 'desktop-profile-package.json')).Hash) { throw 'Unexpected profile mutation' }
    $taskReceipt = [ordered]@{
        installedAt = (Get-Date).ToString('o')
        status = 'installed-files-verified'
        backup = $taskBackup
        restoreScript = (Join-Path $taskBackup 'restore.ps1')
        appAsarSha256 = $taskAppHash.ToLowerInvariant()
        patchEdits = $taskManifest.edits.Count
        patchFilesVerified = $taskManifest.files.Count
        loadedViaProfile = $taskLoaded
        restartPerformed = $false
        liveUploadOrModelTested = $false
    }
    $taskReceiptJson = $taskReceipt | ConvertTo-Json -Depth 6
    Set-Content -LiteralPath (Join-Path $taskRepo 'docs/evidence/bugfix-20261016/install-receipt.json') -Value $taskReceiptJson -Encoding utf8
    Set-Content -LiteralPath (Join-Path $taskBackup 'install-receipt.json') -Value $taskReceiptJson -Encoding utf8
    Write-Output $taskReceiptJson
} catch {
    & (Join-Path $taskBackup 'restore.ps1')
    throw
}
