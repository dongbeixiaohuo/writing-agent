# Product distribution helper; intentionally outside the legacy claude-runtime mirror.
[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)]
    [string]$ExecutablePath,
    [int]$TimeoutSeconds = 30,
    [int]$ExpectedProtocolVersion = 23,
    [string]$EvidencePath,
    # Use a consistent SQLite online-backup snapshot, never copy an open live DB.
    [string]$DatabaseFixturePath,
    [switch]$KeepSmokeData
)

$ErrorActionPreference = 'Stop'
$resolvedExecutable = (Resolve-Path -LiteralPath $ExecutablePath).Path
$nonce = ([Guid]::NewGuid().ToString('N')).Substring(0, 16)
$resultPath = Join-Path $env:TEMP "writing-agent-desktop-smoke-result-$nonce.json"
$smokeRoot = Join-Path $env:TEMP "writing-agent-desktop-smoke-$nonce"
if ($DatabaseFixturePath) {
    $fixture = (Resolve-Path -LiteralPath $DatabaseFixturePath).Path
    $fixtureDirectory = Join-Path $smokeRoot 'workspace\.writing-agent'
    New-Item -ItemType Directory -Path $fixtureDirectory -Force | Out-Null
    Copy-Item -LiteralPath $fixture -Destination (Join-Path $fixtureDirectory 'workspace.sqlite3') -ErrorAction Stop
}

$startInfo = [System.Diagnostics.ProcessStartInfo]::new()
$startInfo.FileName = $resolvedExecutable
$startInfo.UseShellExecute = $false
$startInfo.CreateNoWindow = $true
$startInfo.RedirectStandardOutput = $true
$startInfo.RedirectStandardError = $true
$startInfo.Environment['WRITING_AGENT_DESKTOP_SMOKE'] = $nonce

$startedAt = Get-Date
$process = [System.Diagnostics.Process]::new()
$process.StartInfo = $startInfo
[void]$process.Start()
$stdoutTask = $process.StandardOutput.ReadToEndAsync()
$stderrTask = $process.StandardError.ReadToEndAsync()
function Write-SmokeFailureEvidence([string]$Reason) {
    if (-not $EvidencePath) { return }
    $failurePath = [System.IO.Path]::GetFullPath($EvidencePath)
    New-Item -ItemType Directory -Force -Path (Split-Path -Parent $failurePath) | Out-Null
    [ordered]@{
        checkedAt = (Get-Date).ToString('o')
        status = 'failed'
        reason = $Reason
        executable = $resolvedExecutable
        isolatedRoot = $smokeRoot
        exitCode = $process.ExitCode
        stdout = $stdoutTask.Result.Trim()
        stderr = $stderrTask.Result.Trim()
    } | ConvertTo-Json -Depth 8 | Set-Content -LiteralPath $failurePath -Encoding utf8
}
$completed = $process.WaitForExit($TimeoutSeconds * 1000)
if (-not $completed) {
    $process.Kill($true)
    $process.WaitForExit()
    Write-SmokeFailureEvidence 'timeout'
    throw "Desktop smoke timed out after $TimeoutSeconds seconds"
}
if ($process.ExitCode -ne 0) {
    Write-SmokeFailureEvidence 'process_exit'
    throw "Desktop smoke exited with $($process.ExitCode): $($stderrTask.Result.Trim())"
}
if (-not (Test-Path -LiteralPath $resultPath)) {
    Write-SmokeFailureEvidence 'missing_result'
    throw "Desktop smoke result was not created: $resultPath"
}

$result = Get-Content -Raw -LiteralPath $resultPath | ConvertFrom-Json
if ($result.status -ne 'ready' -or $result.productName -ne 'Writing Agent') {
    throw 'Desktop smoke returned an invalid product or readiness status'
}
if ($result.url -ne 'writing-agent://app/index.html' -or $result.protocolVersion -ne $ExpectedProtocolVersion) {
    throw "Desktop smoke returned origin '$($result.url)' and protocol '$($result.protocolVersion)'; expected 'writing-agent://app/index.html' and protocol '$ExpectedProtocolVersion'"
}

$evidence = [ordered]@{
    checkedAt = (Get-Date).ToString('o')
    executable = $resolvedExecutable
    exitCode = $process.ExitCode
    durationMilliseconds = [Math]::Round(((Get-Date) - $startedAt).TotalMilliseconds)
    isolatedRoot = $smokeRoot
    usedDatabaseFixture = [bool]$DatabaseFixturePath
    stdout = $stdoutTask.Result.Trim()
    stderr = $stderrTask.Result.Trim()
    result = $result
}
if ($EvidencePath) {
    $resolvedEvidence = [System.IO.Path]::GetFullPath($EvidencePath)
    $evidenceDirectory = Split-Path -Parent $resolvedEvidence
    if ($evidenceDirectory) { New-Item -ItemType Directory -Force -Path $evidenceDirectory | Out-Null }
    $evidence | ConvertTo-Json -Depth 8 | Set-Content -LiteralPath $resolvedEvidence -Encoding utf8
}

if (-not $KeepSmokeData -and (Test-Path -LiteralPath $smokeRoot)) {
    $tempRoot = [System.IO.Path]::GetFullPath($env:TEMP).TrimEnd('\') + '\'
    $resolvedSmokeRoot = [System.IO.Path]::GetFullPath($smokeRoot)
    if (-not $resolvedSmokeRoot.StartsWith($tempRoot, [System.StringComparison]::OrdinalIgnoreCase)) {
        throw "Refusing to remove smoke data outside TEMP: $resolvedSmokeRoot"
    }
    Remove-Item -LiteralPath $resolvedSmokeRoot -Recurse -Force
}
if (-not $KeepSmokeData -and (Test-Path -LiteralPath $resultPath)) {
    Remove-Item -LiteralPath $resultPath -Force
}

$evidence
