# Product distribution helper; intentionally outside the legacy claude-runtime mirror.
[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)]
    [string]$InstallerPath,
    [string]$EvidencePath = 'output/desktop-installer-test.json',
    [int]$TimeoutSeconds = 120
)

$ErrorActionPreference = 'Stop'
$resolvedInstaller = (Resolve-Path -LiteralPath $InstallerPath).Path
$nonce = ([Guid]::NewGuid().ToString('N')).Substring(0, 12)
$installRoot = Join-Path $env:LOCALAPPDATA "Temp\writing-agent-installer-test-$nonce"
if (Test-Path -LiteralPath $installRoot) {
    throw "Refusing to reuse installer test directory: $installRoot"
}

function Get-Sha256Hex {
    param([Parameter(Mandatory = $true)][string]$LiteralPath)
    $stream = [System.IO.File]::OpenRead($LiteralPath)
    $sha = [System.Security.Cryptography.SHA256]::Create()
    try {
        return ([System.BitConverter]::ToString($sha.ComputeHash($stream))).Replace('-', '').ToLowerInvariant()
    }
    finally {
        $sha.Dispose()
        $stream.Dispose()
    }
}

function Invoke-And-Wait {
    param([string]$FileName, [string[]]$Arguments)
    $startInfo = [System.Diagnostics.ProcessStartInfo]::new()
    $startInfo.FileName = $FileName
    foreach ($argument in $Arguments) { $startInfo.ArgumentList.Add($argument) }
    $startInfo.UseShellExecute = $false
    $process = [System.Diagnostics.Process]::Start($startInfo)
    if (-not $process.WaitForExit($TimeoutSeconds * 1000)) {
        $process.Kill($true)
        $process.WaitForExit()
        throw "Process timed out: $FileName"
    }
    if ($process.ExitCode -ne 0) { throw "Process exited with $($process.ExitCode): $FileName" }
}

function Get-ExistingWritingAgentInstallations {
    $rows = @()
    $roots = @(
        'HKCU:\Software\Microsoft\Windows\CurrentVersion\Uninstall',
        'HKLM:\Software\Microsoft\Windows\CurrentVersion\Uninstall',
        'HKLM:\Software\WOW6432Node\Microsoft\Windows\CurrentVersion\Uninstall'
    )
    foreach ($root in $roots) {
        if (-not (Test-Path -LiteralPath $root)) { continue }
        foreach ($key in Get-ChildItem -LiteralPath $root) {
            $properties = Get-ItemProperty -LiteralPath $key.PSPath -ErrorAction SilentlyContinue
            if ($properties.DisplayName -eq 'Writing Agent') {
                $rows += [pscustomobject]@{
                    key = $key.PSChildName
                    displayVersion = $properties.DisplayVersion
                    uninstallString = $properties.UninstallString
                }
            }
        }
    }
    return @($rows)
}

function Get-ExistingWritingAgentShortcutTargets {
    $shell = New-Object -ComObject WScript.Shell
    $paths = @(
        (Join-Path ([Environment]::GetFolderPath('Desktop')) 'Writing Agent.lnk'),
        (Join-Path ([Environment]::GetFolderPath('Programs')) 'Writing Agent.lnk')
    )
    $targets = @()
    foreach ($path in $paths) {
        if (-not (Test-Path -LiteralPath $path)) { continue }
        $target = $shell.CreateShortcut($path).TargetPath
        if ($target -and [System.IO.Path]::GetFileName($target) -eq 'Writing Agent.exe' -and (Test-Path -LiteralPath $target)) {
            $targets += $target
        }
    }
    return @($targets | Select-Object -Unique)
}

if (@(Get-ExistingWritingAgentInstallations).Count -ne 0 -or @(Get-ExistingWritingAgentShortcutTargets).Count -ne 0) {
    throw 'A Writing Agent installation already exists; refusing to replace the user installation during an isolated installer test'
}

$smokeEvidencePath = Join-Path $env:TEMP "writing-agent-installer-smoke-$nonce.json"
$smokeResultPath = $null
try {
    Invoke-And-Wait -FileName $resolvedInstaller -Arguments @('/S', "/D=$installRoot")
    $application = Join-Path $installRoot 'Writing Agent.exe'
    $uninstaller = Join-Path $installRoot 'Uninstall Writing Agent.exe'
    if (-not (Test-Path -LiteralPath $application) -or -not (Test-Path -LiteralPath $uninstaller)) {
        throw 'Installer did not create the application and uninstaller'
    }

    & (Join-Path $PSScriptRoot 'run_desktop_smoke.ps1') -ExecutablePath $application -EvidencePath $smokeEvidencePath | Out-Null
    $smokeResultPath = $smokeEvidencePath
    Invoke-And-Wait -FileName $uninstaller -Arguments @('/S')
    $deadline = (Get-Date).AddSeconds(20)
    while ((Test-Path -LiteralPath $application) -and (Get-Date) -lt $deadline) {
        Start-Sleep -Milliseconds 250
    }
    if (Test-Path -LiteralPath $application) {
        throw 'Uninstaller did not remove the installed application'
    }

    $evidence = [ordered]@{
        checkedAt = (Get-Date).ToString('o')
        installer = $resolvedInstaller
        installerBytes = (Get-Item -LiteralPath $resolvedInstaller).Length
        installerSha256 = Get-Sha256Hex -LiteralPath $resolvedInstaller
        installRoot = $installRoot
        install = 'PASS'
        packagedSmoke = 'PASS'
        uninstall = 'PASS'
        smoke = Get-Content -Raw -LiteralPath $smokeEvidencePath | ConvertFrom-Json
    }
    $resolvedEvidence = [System.IO.Path]::GetFullPath($EvidencePath)
    $evidenceDirectory = Split-Path -Parent $resolvedEvidence
    if ($evidenceDirectory) { New-Item -ItemType Directory -Force -Path $evidenceDirectory | Out-Null }
    $evidence | ConvertTo-Json -Depth 12 | Set-Content -LiteralPath $resolvedEvidence -Encoding utf8
    $evidence
}
finally {
    $cleanupUninstaller = Join-Path $installRoot 'Uninstall Writing Agent.exe'
    if (Test-Path -LiteralPath $cleanupUninstaller) {
        try {
            Invoke-And-Wait -FileName $cleanupUninstaller -Arguments @('/S')
        }
        catch {
            Write-Warning "Installer test cleanup failed: $($_.Exception.Message)"
        }
    }
    if ($smokeResultPath -and (Test-Path -LiteralPath $smokeResultPath)) {
        Remove-Item -LiteralPath $smokeResultPath -Force
    }
}
