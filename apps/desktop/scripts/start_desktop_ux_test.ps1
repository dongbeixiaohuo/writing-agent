# Starts a visible, isolated desktop UX environment and exposes Chromium CDP on loopback only.
[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)]
    [string]$ExecutablePath,
    [string]$TestId = 'final-ux-20260918',
    [int]$RemoteDebuggingPort = 0,
    [string]$EvidencePath = 'output/desktop-ux-test.json',
    [int]$TimeoutSeconds = 30
)

$ErrorActionPreference = 'Stop'
if ($TestId -notmatch '^[A-Za-z0-9_-]{8,64}$') {
    throw 'TestId must contain 8-64 ASCII letters, digits, underscores, or hyphens'
}
$resolvedExecutable = (Resolve-Path -LiteralPath $ExecutablePath).Path
$tempRoot = [System.IO.Path]::GetFullPath($env:TEMP).TrimEnd('\') + '\'
$testRoot = [System.IO.Path]::GetFullPath((Join-Path $env:TEMP "writing-agent-desktop-test-$TestId"))
if (-not $testRoot.StartsWith($tempRoot, [System.StringComparison]::OrdinalIgnoreCase)) {
    throw "Refusing a desktop test root outside TEMP: $testRoot"
}

if ($RemoteDebuggingPort -eq 0) {
    $listener = [System.Net.Sockets.TcpListener]::new([System.Net.IPAddress]::Loopback, 0)
    $listener.Start()
    try { $RemoteDebuggingPort = ([System.Net.IPEndPoint]$listener.LocalEndpoint).Port }
    finally { $listener.Stop() }
}
if ($RemoteDebuggingPort -lt 1024 -or $RemoteDebuggingPort -gt 65535) {
    throw 'RemoteDebuggingPort must be 0 or between 1024 and 65535'
}

$startInfo = [System.Diagnostics.ProcessStartInfo]::new()
$startInfo.FileName = $resolvedExecutable
$startInfo.UseShellExecute = $false
$startInfo.CreateNoWindow = $true
$startInfo.ArgumentList.Add("--remote-debugging-address=127.0.0.1")
$startInfo.ArgumentList.Add("--remote-debugging-port=$RemoteDebuggingPort")
$startInfo.Environment['WRITING_AGENT_DESKTOP_TEST'] = $TestId
$process = [System.Diagnostics.Process]::Start($startInfo)
if ($null -eq $process) { throw 'Desktop UX process could not be started' }

$endpoint = "http://127.0.0.1:$RemoteDebuggingPort"
$deadline = (Get-Date).AddSeconds($TimeoutSeconds)
$version = $null
try {
    while ($null -eq $version -and (Get-Date) -lt $deadline) {
        if ($process.HasExited) { throw "Desktop UX process exited with code $($process.ExitCode)" }
        try { $version = Invoke-RestMethod -Uri "$endpoint/json/version" -TimeoutSec 2 }
        catch { Start-Sleep -Milliseconds 250 }
    }
    if ($null -eq $version) { throw "Desktop UX CDP endpoint did not become ready: $endpoint" }
}
catch {
    if (-not $process.HasExited) {
        $process.Kill($true)
        $process.WaitForExit()
    }
    throw
}

$evidence = [ordered]@{
    status = 'ready'
    startedAt = (Get-Date).ToString('o')
    testId = $TestId
    processId = $process.Id
    executable = $resolvedExecutable
    testRoot = $testRoot
    workspace = (Join-Path $testRoot 'workspace')
    userData = (Join-Path $testRoot 'user-data')
    cdpEndpoint = $endpoint
    browser = $version.Browser
    protocolVersion = $version.'Protocol-Version'
    isolation = 'TEMP_ONLY_NO_PRODUCTION_PROFILE'
    modelCalls = 'DISABLED_UNTIL_EXPLICIT_TEST_CONFIGURATION'
}
$resolvedEvidence = [System.IO.Path]::GetFullPath($EvidencePath)
$evidenceDirectory = Split-Path -Parent $resolvedEvidence
if ($evidenceDirectory) { New-Item -ItemType Directory -Force -Path $evidenceDirectory | Out-Null }
$evidence | ConvertTo-Json -Depth 6 | Set-Content -LiteralPath $resolvedEvidence -Encoding utf8
$evidence
