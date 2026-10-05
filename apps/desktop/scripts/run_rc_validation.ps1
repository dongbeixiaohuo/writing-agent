# Product distribution helper; intentionally outside the legacy claude-runtime mirror.
[CmdletBinding()]
param(
    [string]$InstallerPath,
    [string]$PreviousInstallerPath,
    [string]$EvidencePath = 'output/rc-local-validation.json',
    [switch]$SkipLegacyWorkflow
)

$ErrorActionPreference = 'Stop'
$startedAt = Get-Date
$checks = [System.Collections.Generic.List[object]]::new()

function Invoke-Check {
    param([string]$Name, [string]$Command, [string[]]$Arguments)
    $checkStartedAt = Get-Date
    & $Command @Arguments
    if ($LASTEXITCODE -ne 0) { throw "$Name failed with exit code $LASTEXITCODE" }
    $checks.Add([ordered]@{
        name = $Name
        status = 'PASS'
        durationSeconds = [Math]::Round(((Get-Date) - $checkStartedAt).TotalSeconds, 2)
    })
}

Invoke-Check 'runtime' 'npm.cmd' @('run', 'check:runtime')
Invoke-Check 'ui' 'npm.cmd' @('run', 'check:ui')
Invoke-Check 'desktop' 'npm.cmd' @('run', 'check:desktop')
Invoke-Check 'python' 'npm.cmd' @('run', 'test:py')
if (-not $SkipLegacyWorkflow) { Invoke-Check 'legacy-workflow' 'npm.cmd' @('run', 'check') }
Invoke-Check 'production-audit' 'npm.cmd' @('audit', '--omit=dev', '--audit-level=high')
Invoke-Check 'prd-pack' 'python' @('-B', 'scripts/check_document_pack.py')

if ($InstallerPath) {
    & (Join-Path $PSScriptRoot 'test_desktop_installer.ps1') -InstallerPath $InstallerPath -EvidencePath 'output/desktop-installer-test.json' | Out-Null
    $checks.Add([ordered]@{ name = 'installer'; status = 'PASS'; durationSeconds = $null })
}
if ($PreviousInstallerPath) {
    if (-not $InstallerPath) { throw 'PreviousInstallerPath requires InstallerPath' }
    & (Join-Path $PSScriptRoot 'test_desktop_upgrade.ps1') `
        -PreviousInstallerPath $PreviousInstallerPath `
        -CurrentInstallerPath $InstallerPath `
        -EvidencePath 'output/desktop-upgrade-test.json' | Out-Null
    $checks.Add([ordered]@{ name = 'installer-upgrade'; status = 'PASS'; durationSeconds = $null })
}

$evidence = [ordered]@{
    scope = 'local-automated-rc-validation'
    startedAt = $startedAt.ToString('o')
    completedAt = (Get-Date).ToString('o')
    checks = $checks
    exclusions = @(
        'this automated command does not call a paid model; separately authorized real-provider evidence is recorded outside this JSON',
        'clean Windows machine validation requires a separate machine or VM',
        'five-person usability study requires real participants',
        'maintainer signoff and public release are not automated'
    )
}
$resolvedEvidence = [System.IO.Path]::GetFullPath($EvidencePath)
$evidenceDirectory = Split-Path -Parent $resolvedEvidence
if ($evidenceDirectory) { New-Item -ItemType Directory -Force -Path $evidenceDirectory | Out-Null }
$evidence | ConvertTo-Json -Depth 10 | Set-Content -LiteralPath $resolvedEvidence -Encoding utf8
$evidence
