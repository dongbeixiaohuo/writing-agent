# Stops only the process recorded by start_desktop_ux_test.ps1; test data is preserved by default.
[CmdletBinding()]
param(
    [string]$EvidencePath = 'output/desktop-ux-test.json',
    [switch]$RemoveTestData,
    [int]$GraceSeconds = 10
)

$ErrorActionPreference = 'Stop'
$resolvedEvidence = (Resolve-Path -LiteralPath $EvidencePath).Path
$evidence = Get-Content -Raw -LiteralPath $resolvedEvidence | ConvertFrom-Json
if ($evidence.status -ne 'ready' -or $evidence.isolation -ne 'TEMP_ONLY_NO_PRODUCTION_PROFILE') {
    throw 'Evidence does not identify an active isolated desktop UX environment'
}
$process = Get-Process -Id ([int]$evidence.processId) -ErrorAction SilentlyContinue
if ($null -ne $process) {
    if ($process.Path -ne $evidence.executable) {
        throw "Refusing to stop PID $($evidence.processId): executable mismatch"
    }
    [void]$process.CloseMainWindow()
    if (-not $process.WaitForExit($GraceSeconds * 1000)) {
        $process.Kill($true)
        $process.WaitForExit()
    }
}

if ($RemoveTestData -and (Test-Path -LiteralPath $evidence.testRoot)) {
    $tempRoot = [System.IO.Path]::GetFullPath($env:TEMP).TrimEnd('\') + '\'
    $resolvedTestRoot = [System.IO.Path]::GetFullPath([string]$evidence.testRoot)
    $leaf = Split-Path -Leaf $resolvedTestRoot
    if (-not $resolvedTestRoot.StartsWith($tempRoot, [System.StringComparison]::OrdinalIgnoreCase) -or
        -not $leaf.StartsWith('writing-agent-desktop-test-', [System.StringComparison]::Ordinal)) {
        throw "Refusing to remove a test root outside the expected TEMP boundary: $resolvedTestRoot"
    }
    Remove-Item -LiteralPath $resolvedTestRoot -Recurse -Force
}

$evidence.status = 'stopped'
$evidence | Add-Member -NotePropertyName 'stoppedAt' -NotePropertyValue ((Get-Date).ToString('o')) -Force
$evidence | ConvertTo-Json -Depth 6 | Set-Content -LiteralPath $resolvedEvidence -Encoding utf8
$evidence
