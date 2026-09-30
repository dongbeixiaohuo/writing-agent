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
$lines = foreach ($artifact in $artifacts) {
    $hash = Get-Sha256Hex -LiteralPath $artifact.FullName
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
