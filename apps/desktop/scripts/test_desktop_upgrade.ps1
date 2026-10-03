# Product distribution helper; intentionally outside the legacy claude-runtime mirror.
[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)]
    [string]$PreviousInstallerPath,
    [Parameter(Mandatory = $true)]
    [string]$CurrentInstallerPath,
    [string]$EvidencePath = 'output/desktop-upgrade-test.json',
    [int]$ExpectedProtocolVersion = 22,
    [int]$TimeoutSeconds = 120,
    [switch]$SimulateOrphanedPreviousInstall
)

$ErrorActionPreference = 'Stop'
$previousInstaller = (Resolve-Path -LiteralPath $PreviousInstallerPath).Path
$currentInstaller = (Resolve-Path -LiteralPath $CurrentInstallerPath).Path
$nonce = ([Guid]::NewGuid().ToString('N')).Substring(0, 12)
$installRoot = Join-Path $env:LOCALAPPDATA "Temp\writing-agent-upgrade-test-$nonce 中文 安装"
$appDataRoot = Join-Path $env:APPDATA 'Writing Agent'
$appDataRootExisted = Test-Path -LiteralPath $appDataRoot
$appDataSentinel = Join-Path $appDataRoot "upgrade-preservation-$nonce.txt"
$documentsAppRoot = Join-Path ([Environment]::GetFolderPath('MyDocuments')) 'Writing Agent'
$documentsAppRootExisted = Test-Path -LiteralPath $documentsAppRoot
$workspaceRoot = Join-Path $documentsAppRoot 'Workspace'
$workspaceRootExisted = Test-Path -LiteralPath $workspaceRoot
$workspaceSentinel = Join-Path $workspaceRoot "upgrade-preservation-$nonce.txt"
$smokeEvidencePath = Join-Path $env:TEMP "writing-agent-upgrade-smoke-$nonce.json"
$application = Join-Path $installRoot 'Writing Agent.exe'
$uninstaller = Join-Path $installRoot 'Uninstall Writing Agent.exe'
$shortcutBackupRoot = Join-Path $env:TEMP "writing-agent-upgrade-shortcuts-$nonce"
$shortcutPaths = @(
    (Join-Path ([Environment]::GetFolderPath('Desktop')) 'Writing Agent.lnk'),
    (Join-Path ([Environment]::GetFolderPath('Programs')) 'Writing Agent.lnk')
)
$shortcutSnapshots = @()

if (Test-Path -LiteralPath $installRoot) {
    throw "Refusing to reuse upgrade test directory: $installRoot"
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

function Get-VersionFromInstallerName {
    param([Parameter(Mandatory = $true)][string]$LiteralPath)
    $name = [System.IO.Path]::GetFileName($LiteralPath)
    if ($name -notmatch '^Writing-Agent-Setup-(.+)-x64\.exe$') {
        throw "Installer name does not expose the expected version: $name"
    }
    return $Matches[1]
}

function Invoke-And-Wait {
    param([string]$FileName, [string[]]$Arguments)
    # ProcessStartInfo.ArgumentList is unavailable in Windows PowerShell 5.1.
    # Start-Process accepts the same string array on both Windows PowerShell and pwsh.
    $process = Start-Process -FilePath $FileName -ArgumentList $Arguments -PassThru
    if (-not $process.WaitForExit($TimeoutSeconds * 1000)) {
        $process.Kill($true)
        $process.WaitForExit()
        throw "Process timed out: $FileName"
    }
    if ($process.ExitCode -ne 0) {
        throw "Process exited with $($process.ExitCode): $FileName"
    }
}

function Get-WritingAgentRegistrations {
    $rows = @()
    $roots = @(
        @{ Hive = 'HKCU'; Path = 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Uninstall' },
        @{ Hive = 'HKLM'; Path = 'HKLM:\Software\Microsoft\Windows\CurrentVersion\Uninstall' },
        @{ Hive = 'HKLM32'; Path = 'HKLM:\Software\WOW6432Node\Microsoft\Windows\CurrentVersion\Uninstall' }
    )
    foreach ($root in $roots) {
        if (-not (Test-Path -LiteralPath $root.Path)) { continue }
        foreach ($key in Get-ChildItem -LiteralPath $root.Path) {
            $properties = Get-ItemProperty -LiteralPath $key.PSPath -ErrorAction SilentlyContinue
            if ($properties.DisplayName -eq 'Writing Agent') {
                $uninstallString = [string]$properties.UninstallString
                $installLocation = ([string]$properties.InstallLocation).Trim('"')
                if (-not $installLocation) {
                    $uninstallerMatch = [regex]::Match($uninstallString, '^"([^"]+)"')
                    if ($uninstallerMatch.Success) {
                        $installLocation = Split-Path -Parent $uninstallerMatch.Groups[1].Value
                    }
                }
                $rows += [pscustomobject]@{
                    hive = $root.Hive
                    key = $key.PSChildName
                    displayVersion = $properties.DisplayVersion
                    installLocation = $installLocation
                    uninstallString = $uninstallString
                    quietUninstallString = $properties.QuietUninstallString
                }
            }
        }
    }
    return @($rows)
}

function Assert-SingleRegistration {
    param(
        [Parameter(Mandatory = $true)][string]$ExpectedVersion,
        [Parameter(Mandatory = $true)][string]$ExpectedInstallRoot
    )
    $rows = @(Get-WritingAgentRegistrations)
    if ($rows.Count -ne 1) {
        throw "Expected exactly one Writing Agent registration, found $($rows.Count)"
    }
    $registration = $rows[0]
    if ($registration.displayVersion -ne $ExpectedVersion) {
        throw "Expected registered version $ExpectedVersion, found $($registration.displayVersion)"
    }
    if (-not [System.IO.Path]::GetFullPath($registration.installLocation).Equals(
        [System.IO.Path]::GetFullPath($ExpectedInstallRoot),
        [System.StringComparison]::OrdinalIgnoreCase
    )) {
        throw "Unexpected registered install location: $($registration.installLocation)"
    }
    return $registration
}

$previousVersion = Get-VersionFromInstallerName -LiteralPath $previousInstaller
$currentVersion = Get-VersionFromInstallerName -LiteralPath $currentInstaller
if ($previousVersion -eq $currentVersion) {
    throw 'Previous and current installer versions must differ; same-version reinstall is not upgrade evidence'
}
if ([System.Version]::Parse(($previousVersion -replace '-.*$', '')) -gt [System.Version]::Parse(($currentVersion -replace '-.*$', ''))) {
    throw "Previous installer version is newer than current installer version"
}
if (@(Get-WritingAgentRegistrations).Count -ne 0) {
    throw 'A Writing Agent installation already exists; refusing to disturb the user installation'
}

$resolvedSmokeEvidence = $null
try {
    New-Item -ItemType Directory -Force -Path $shortcutBackupRoot | Out-Null
    for ($shortcutIndex = 0; $shortcutIndex -lt $shortcutPaths.Count; $shortcutIndex += 1) {
        $shortcutPath = $shortcutPaths[$shortcutIndex]
        $existed = Test-Path -LiteralPath $shortcutPath
        $backupPath = Join-Path $shortcutBackupRoot "shortcut-$shortcutIndex.lnk"
        if ($existed) {
            Copy-Item -LiteralPath $shortcutPath -Destination $backupPath -Force
            if (-not (Test-Path -LiteralPath $backupPath)) {
                throw "Failed to back up existing shortcut before the isolated upgrade test: $shortcutPath"
            }
            # Historical installers can recover an orphaned install from a real user shortcut.
            # Keep those shortcuts outside the test surface until the finally block restores them.
            Remove-Item -LiteralPath $shortcutPath -Force
        }
        $shortcutSnapshots += [pscustomobject]@{
            path = $shortcutPath
            existed = $existed
            backupPath = $backupPath
        }
    }
    foreach ($shortcutPath in $shortcutPaths) {
        if (Test-Path -LiteralPath $shortcutPath) {
            throw "Refusing to run the isolated upgrade test while a real Writing Agent shortcut is visible: $shortcutPath"
        }
    }

    New-Item -ItemType Directory -Force -Path $appDataRoot | Out-Null
    Set-Content -LiteralPath $appDataSentinel -Value "preserve-$nonce" -Encoding utf8
    New-Item -ItemType Directory -Force -Path $workspaceRoot | Out-Null
    Set-Content -LiteralPath $workspaceSentinel -Value "preserve-$nonce" -Encoding utf8

    Invoke-And-Wait -FileName $previousInstaller -Arguments @('/S', "/D=$installRoot")
    if (-not (Test-Path -LiteralPath $application) -or -not (Test-Path -LiteralPath $uninstaller)) {
        throw 'Previous installer did not create the application and uninstaller'
    }
    $previousRegistration = Assert-SingleRegistration -ExpectedVersion $previousVersion -ExpectedInstallRoot $installRoot
    $previousApplicationSha256 = Get-Sha256Hex -LiteralPath $application
    $previousUninstallerSha256 = Get-Sha256Hex -LiteralPath $uninstaller
    $stalePayload = Join-Path $installRoot 'must-be-removed-during-upgrade.txt'
    Set-Content -LiteralPath $stalePayload -Value 'old-installation-only' -Encoding utf8

    if ($SimulateOrphanedPreviousInstall) {
        if ($previousRegistration.hive -ne 'HKCU') {
            throw "Orphan simulation only supports the expected per-user registration, found $($previousRegistration.hive)"
        }
        $previousRegistrationPath = Join-Path 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Uninstall' $previousRegistration.key
        Remove-Item -LiteralPath $previousRegistrationPath -Recurse -Force
        if (@(Get-WritingAgentRegistrations).Count -ne 0) {
            throw 'Failed to simulate the missing previous installation registration'
        }
    }

    Invoke-And-Wait -FileName $currentInstaller -Arguments @('/S', "/D=$installRoot")
    if (-not (Test-Path -LiteralPath $application) -or -not (Test-Path -LiteralPath $uninstaller)) {
        throw 'Current installer did not replace the application and uninstaller'
    }
    if (Test-Path -LiteralPath $stalePayload) {
        throw 'Upgrade overlaid files without removing the previous installation'
    }
    if (-not (Test-Path -LiteralPath $appDataSentinel)) {
        throw 'Upgrade removed existing Writing Agent user data'
    }
    if (-not (Test-Path -LiteralPath $workspaceSentinel)) {
        throw 'Upgrade removed the existing Writing Agent workspace'
    }

    $currentRegistration = Assert-SingleRegistration -ExpectedVersion $currentVersion -ExpectedInstallRoot $installRoot
    if ($currentRegistration.key -ne $previousRegistration.key) {
        throw "Installer identity changed during upgrade: $($previousRegistration.key) -> $($currentRegistration.key)"
    }
    $currentApplicationSha256 = Get-Sha256Hex -LiteralPath $application
    $currentUninstallerSha256 = Get-Sha256Hex -LiteralPath $uninstaller
    if ($currentApplicationSha256 -eq $previousApplicationSha256) {
        throw 'Application binary did not change during upgrade'
    }
    if ($currentUninstallerSha256 -eq $previousUninstallerSha256) {
        throw 'Uninstaller did not change during upgrade'
    }

    & (Join-Path $PSScriptRoot 'run_desktop_smoke.ps1') `
        -ExecutablePath $application `
        -ExpectedProtocolVersion $ExpectedProtocolVersion `
        -EvidencePath $smokeEvidencePath | Out-Null
    $resolvedSmokeEvidence = $smokeEvidencePath

    Invoke-And-Wait -FileName $uninstaller -Arguments @('/S')
    $deadline = (Get-Date).AddSeconds(20)
    while (((Test-Path -LiteralPath $application) -or @(Get-WritingAgentRegistrations).Count -ne 0) -and (Get-Date) -lt $deadline) {
        Start-Sleep -Milliseconds 250
    }
    if (Test-Path -LiteralPath $application) {
        throw 'Current uninstaller did not remove the upgraded application'
    }
    if (@(Get-WritingAgentRegistrations).Count -ne 0) {
        throw 'Current uninstaller left a Writing Agent registration behind'
    }
    if (-not (Test-Path -LiteralPath $appDataSentinel)) {
        throw 'Normal uninstall removed Writing Agent user data despite the preservation policy'
    }
    if (-not (Test-Path -LiteralPath $workspaceSentinel)) {
        throw 'Normal uninstall removed the Writing Agent workspace despite the preservation policy'
    }

    $evidence = [ordered]@{
        checkedAt = (Get-Date).ToString('o')
        installRoot = $installRoot
        previous = [ordered]@{
            version = $previousVersion
            installer = $previousInstaller
            installerSha256 = Get-Sha256Hex -LiteralPath $previousInstaller
            applicationSha256 = $previousApplicationSha256
            uninstallerSha256 = $previousUninstallerSha256
            registration = $previousRegistration
        }
        current = [ordered]@{
            version = $currentVersion
            installer = $currentInstaller
            installerSha256 = Get-Sha256Hex -LiteralPath $currentInstaller
            applicationSha256 = $currentApplicationSha256
            uninstallerSha256 = $currentUninstallerSha256
            registration = $currentRegistration
            smoke = Get-Content -Raw -LiteralPath $smokeEvidencePath | ConvertFrom-Json
        }
        upgrade = 'PASS'
        previousInstallRemoved = 'PASS'
        stableInstallerIdentity = 'PASS'
        singleRegistration = 'PASS'
        appDataPreservedDuringUpgrade = 'PASS'
        appDataPreservedDuringUninstall = 'PASS'
        workspacePreservedDuringUpgrade = 'PASS'
        workspacePreservedDuringUninstall = 'PASS'
        existingShortcutsPreserved = 'PASS'
        orphanedPreviousInstallRecovered = $(if ($SimulateOrphanedPreviousInstall) { 'PASS' } else { 'NOT_APPLICABLE' })
        uninstall = 'PASS'
    }
    $resolvedEvidence = [System.IO.Path]::GetFullPath($EvidencePath)
    $evidenceDirectory = Split-Path -Parent $resolvedEvidence
    if ($evidenceDirectory) { New-Item -ItemType Directory -Force -Path $evidenceDirectory | Out-Null }
    $evidence | ConvertTo-Json -Depth 12 | Set-Content -LiteralPath $resolvedEvidence -Encoding utf8
    $evidence
}
finally {
    if (Test-Path -LiteralPath $uninstaller) {
        try {
            Invoke-And-Wait -FileName $uninstaller -Arguments @('/S')
        }
        catch {
            Write-Warning "Upgrade test cleanup failed: $($_.Exception.Message)"
        }
    }
    if (Test-Path -LiteralPath $appDataSentinel) {
        Remove-Item -LiteralPath $appDataSentinel -Force
    }
    if (-not $appDataRootExisted -and (Test-Path -LiteralPath $appDataRoot)) {
        $remaining = @(Get-ChildItem -LiteralPath $appDataRoot -Force)
        if ($remaining.Count -eq 0) { Remove-Item -LiteralPath $appDataRoot -Force }
    }
    if (Test-Path -LiteralPath $workspaceSentinel) {
        Remove-Item -LiteralPath $workspaceSentinel -Force
    }
    if (-not $workspaceRootExisted -and (Test-Path -LiteralPath $workspaceRoot)) {
        $remaining = @(Get-ChildItem -LiteralPath $workspaceRoot -Force)
        if ($remaining.Count -eq 0) { Remove-Item -LiteralPath $workspaceRoot -Force }
    }
    if (-not $documentsAppRootExisted -and (Test-Path -LiteralPath $documentsAppRoot)) {
        $remaining = @(Get-ChildItem -LiteralPath $documentsAppRoot -Force)
        if ($remaining.Count -eq 0) { Remove-Item -LiteralPath $documentsAppRoot -Force }
    }
    if ($resolvedSmokeEvidence -and (Test-Path -LiteralPath $resolvedSmokeEvidence)) {
        Remove-Item -LiteralPath $resolvedSmokeEvidence -Force
    }
    foreach ($snapshot in $shortcutSnapshots) {
        if ($snapshot.existed) {
            $shortcutDirectory = Split-Path -Parent $snapshot.path
            if (-not (Test-Path -LiteralPath $shortcutDirectory)) {
                New-Item -ItemType Directory -Force -Path $shortcutDirectory | Out-Null
            }
            Copy-Item -LiteralPath $snapshot.backupPath -Destination $snapshot.path -Force
        }
        elseif (Test-Path -LiteralPath $snapshot.path) {
            Remove-Item -LiteralPath $snapshot.path -Force
        }
    }
    if (Test-Path -LiteralPath $shortcutBackupRoot) {
        $resolvedShortcutBackupRoot = [System.IO.Path]::GetFullPath($shortcutBackupRoot)
        $tempRoot = [System.IO.Path]::GetFullPath($env:TEMP).TrimEnd('\') + '\'
        if ($resolvedShortcutBackupRoot.StartsWith($tempRoot, [System.StringComparison]::OrdinalIgnoreCase) -and
            (Split-Path -Leaf $resolvedShortcutBackupRoot).StartsWith('writing-agent-upgrade-shortcuts-', [System.StringComparison]::Ordinal)) {
            Remove-Item -LiteralPath $resolvedShortcutBackupRoot -Recurse -Force
        }
    }
    if (Test-Path -LiteralPath $installRoot) {
        $tempRoot = [System.IO.Path]::GetFullPath((Join-Path $env:LOCALAPPDATA 'Temp')).TrimEnd('\') + '\'
        $resolvedInstallRoot = [System.IO.Path]::GetFullPath($installRoot)
        if (-not $resolvedInstallRoot.StartsWith($tempRoot, [System.StringComparison]::OrdinalIgnoreCase) -or
            -not ([System.IO.Path]::GetFileName($resolvedInstallRoot)).StartsWith('writing-agent-upgrade-test-', [System.StringComparison]::Ordinal)) {
            Write-Warning "Refusing to remove upgrade test directory outside the expected temp root: $resolvedInstallRoot"
        }
        else {
            $cleanupDeadline = (Get-Date).AddSeconds(20)
            while ((Test-Path -LiteralPath $resolvedInstallRoot) -and (Get-Date) -lt $cleanupDeadline) {
                try {
                    Remove-Item -LiteralPath $resolvedInstallRoot -Recurse -Force -ErrorAction Stop
                }
                catch {
                    Start-Sleep -Milliseconds 250
                }
            }
            if (Test-Path -LiteralPath $resolvedInstallRoot) {
                Write-Warning "Upgrade test directory is still busy after cleanup: $resolvedInstallRoot"
            }
        }
    }
}
