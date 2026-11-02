param([string]$CacheDirectory)
$ErrorActionPreference = 'Stop'
$taskPluginRoot = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '../..'))
if (-not $CacheDirectory) { $CacheDirectory = Join-Path $taskPluginRoot '../.cache/dingtalk-g0' }
$taskCache = [IO.Path]::GetFullPath($CacheDirectory)
$taskLock = Get-Content -LiteralPath (Join-Path $taskPluginRoot 'dws.lock.json') -Raw | ConvertFrom-Json
$taskArch = [Runtime.InteropServices.RuntimeInformation]::OSArchitecture.ToString().ToLowerInvariant()
if ($taskArch -eq 'x64') { $taskArch = 'amd64' }
$taskAsset = $taskLock.dws.assets | Where-Object { $_.platform -eq "windows-$taskArch" }
if (-not $IsWindows -or $taskArch -ne 'amd64' -or -not $taskAsset) { throw 'This G0 bootstrap currently verifies Windows x64 only; other release assets are metadata-locked but untested.' }
$taskDownloads = Join-Path $taskCache 'downloads'
New-Item -ItemType Directory -Force -Path $taskDownloads | Out-Null
$taskArchive = Join-Path $taskDownloads $taskAsset.filename
$taskChecksums = Join-Path $taskDownloads 'checksums.txt'
if (-not (Test-Path -LiteralPath $taskChecksums)) {
  Invoke-WebRequest -Uri $taskLock.dws.checksums.url -OutFile $taskChecksums
}
if ((Get-FileHash -LiteralPath $taskChecksums -Algorithm SHA256).Hash.ToLowerInvariant() -ne $taskLock.dws.checksums.sha256) {
  throw 'Official checksum manifest failed SHA256 verification.'
}
$taskExpectedLine = $taskAsset.sha256 + '  ' + $taskAsset.filename
if (-not ((Get-Content -LiteralPath $taskChecksums) -contains $taskExpectedLine)) { throw 'Release digest differs from checksums.txt.' }
if (-not (Test-Path -LiteralPath $taskArchive)) {
  Invoke-WebRequest -Uri $taskAsset.url -OutFile $taskArchive
}
if ((Get-FileHash -LiteralPath $taskArchive -Algorithm SHA256).Hash.ToLowerInvariant() -ne $taskAsset.sha256) {
  throw 'DWS archive failed SHA256 verification; refusing extraction.'
}
$taskBin = Join-Path $taskCache "bin-$taskArch"
if (Test-Path -LiteralPath $taskBin) { throw "Destination already exists: $taskBin. Choose a fresh cache or use the previously verified binary." }
Expand-Archive -LiteralPath $taskArchive -DestinationPath $taskBin
$taskBinary = Join-Path $taskBin 'dws.exe'
$taskBinaryHash = (Get-FileHash -LiteralPath $taskBinary -Algorithm SHA256).Hash.ToLowerInvariant()
$taskRuntimeArch = if ($taskArch -eq 'amd64') { 'x64' } else { $taskArch }
$taskExpectedBinary = $taskLock.dws.binaryChecksums."win32-$taskRuntimeArch"
if (-not $taskExpectedBinary -or $taskBinaryHash -ne $taskExpectedBinary) { throw 'Unverified extracted binary. Do not run until its checksum has been reviewed and locked.' }
[pscustomobject]@{ version = $taskLock.dws.version; binary = $taskBinary; sha256 = $taskBinaryHash; globalInstall = $false }
