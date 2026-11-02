param([Parameter(Mandatory = $true)][string]$Namespace)
$ErrorActionPreference = 'Stop'
# Match the reviewed v1.0.66 Windows test namespace algorithm exactly.
$taskNamespace = [IO.Path]::GetFullPath($Namespace).ToLowerInvariant()
$taskBytes = [Text.Encoding]::UTF8.GetBytes($taskNamespace)
$taskDigest = [Convert]::ToHexString([Security.Cryptography.SHA256]::HashData($taskBytes)).ToLowerInvariant().Substring(0, 32)
$taskPath = 'Software\DwsCli\keychain\dws-cli\test-' + $taskDigest
if ($taskPath -notmatch '^Software\\DwsCli\\keychain\\dws-cli\\test-[0-9a-f]{32}$') { throw 'Invalid test registry target' }
[Microsoft.Win32.Registry]::CurrentUser.DeleteSubKeyTree($taskPath, $false)
