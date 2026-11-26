# Product distribution helper; intentionally outside the legacy claude-runtime mirror.
[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)]
    [string]$ArtifactDirectory,
    [string]$Version,
    [string]$SourceManifestPath,
    [string]$OutputName = 'SHA256SUMS.txt'
)

$ErrorActionPreference = 'Stop'

function Get-ArtifactHash {
    param([Parameter(Mandatory = $true)][string]$LiteralPath, [switch]$Manifest)
    $stream = [System.IO.File]::OpenRead($LiteralPath)
    $sha = if ($Manifest) { [System.Security.Cryptography.SHA512]::Create() } else { [System.Security.Cryptography.SHA256]::Create() }
    try {
        $hash = $sha.ComputeHash($stream)
        if ($Manifest) { return [System.Convert]::ToBase64String($hash) }
        return ([System.BitConverter]::ToString($hash)).Replace('-', '').ToLowerInvariant()
    }
    finally {
        $sha.Dispose()
        $stream.Dispose()
    }
}

$directory = (Resolve-Path -LiteralPath $ArtifactDirectory).Path
if (-not $Version) {
    $packagePath = Join-Path $PSScriptRoot '..\package.json'
    $Version = (Get-Content -Raw -LiteralPath $packagePath | ConvertFrom-Json).version
}
$versionPattern = [regex]::Escape($Version)
$artifacts = Get-ChildItem -LiteralPath $directory -File | Where-Object {
    $_.Name -match "^Writing-Agent-Setup-$versionPattern-[^-]+\.exe(?:\.blockmap)?$"
} | Sort-Object Name
if ($artifacts.Count -ne 2 -or @($artifacts | Where-Object Name -like '*.exe').Count -ne 1 -or @($artifacts | Where-Object Name -like '*.exe.blockmap').Count -ne 1) {
    throw "Expected exactly one installer and blockmap for version $Version in $directory"
}
$installer = $artifacts | Where-Object Name -like '*.exe'
$updateManifestPath = Join-Path $directory 'latest.yml'
$updateManifest = Get-Content -Raw -LiteralPath $updateManifestPath
$installerPattern = [regex]::Escape($installer.Name)
$hashPattern = [regex]::Escape((Get-ArtifactHash -LiteralPath $installer.FullName -Manifest))
$installerBytes = $installer.Length
if ($updateManifest -cnotmatch "(?m)^version: $versionPattern\r?$" -or
    $updateManifest -cnotmatch "(?m)^path: $installerPattern\r?$" -or
    $updateManifest -cnotmatch "(?m)^sha512: $hashPattern\r?$" -or
    $updateManifest -cnotmatch "(?m)^  - url: $installerPattern\r?\n    sha512: $hashPattern\r?\n    size: $installerBytes\r?$") {
    throw 'Update metadata does not match this installer version and SHA-512'
}
if ($env:WRITING_AGENT_UPDATE_SIGNER_SHA256) {
    $securityModule = Join-Path $PSHOME 'Modules\Microsoft.PowerShell.Security\Microsoft.PowerShell.Security.psd1'
    Import-Module -Name $securityModule -ErrorAction Stop
    $signature = Get-AuthenticodeSignature -LiteralPath $installer.FullName
    if ($signature.Status -ne 'Valid' -or $null -eq $signature.SignerCertificate) { throw 'Installer Authenticode signature is invalid' }
    $sha = [System.Security.Cryptography.SHA256]::Create()
    try { $signer = ([System.BitConverter]::ToString($sha.ComputeHash($signature.SignerCertificate.RawData))).Replace('-', '') }
    finally { $sha.Dispose() }
    if ($signer -ne $env:WRITING_AGENT_UPDATE_SIGNER_SHA256.Trim()) { throw 'Installer signing certificate does not match the configured update signer' }
}
$artifacts += Get-Item -LiteralPath $updateManifestPath
$lines = foreach ($artifact in $artifacts) {
    $hash = Get-ArtifactHash -LiteralPath $artifact.FullName
    "$hash  $($artifact.Name)"
}
$outputPath = Join-Path $directory $OutputName
$lines | Set-Content -LiteralPath $outputPath -Encoding utf8

if (-not $SourceManifestPath) {
    $SourceManifestPath = Join-Path $PSScriptRoot '..\dist\package\SOURCE_AND_DEPENDENCY_MANIFEST.json'
}
$sourceManifest = Get-Content -Raw -LiteralPath $SourceManifestPath | ConvertFrom-Json
if ($sourceManifest.version -ne $Version) {
    throw "Source manifest version $($sourceManifest.version) does not match release version $Version"
}
if ([string]$sourceManifest.sourceRevision -notmatch '^[a-f0-9]{40}$') {
    throw 'Source manifest does not contain a full lowercase Git SHA'
}
$buildManifest = [ordered]@{
    version = $Version
    sourceRevision = $sourceManifest.sourceRevision
    artifacts = @($artifacts | ForEach-Object Name)
    checksumFile = $OutputName
}
$manifestJson = $buildManifest | ConvertTo-Json -Depth 4
$utf8NoBom = New-Object System.Text.UTF8Encoding($false)
[System.IO.File]::WriteAllText((Join-Path $directory 'build-manifest.json'), $manifestJson + "`n", $utf8NoBom)
Write-Output $outputPath
