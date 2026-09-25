# Product distribution helper; intentionally outside the legacy claude-runtime mirror.
[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)]
    [string]$ArtifactDirectory,
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
$artifacts = Get-ChildItem -LiteralPath $directory -File | Where-Object {
    $_.Name -like 'Writing-Agent-Setup-*.exe' -or $_.Name -like 'Writing-Agent-Setup-*.exe.blockmap'
} | Sort-Object Name
if ($artifacts.Count -lt 2) {
    throw "Expected an installer and blockmap in $directory"
}
$lines = foreach ($artifact in $artifacts) {
    $hash = Get-Sha256Hex -LiteralPath $artifact.FullName
    "$hash  $($artifact.Name)"
}
$outputPath = Join-Path $directory $OutputName
$lines | Set-Content -LiteralPath $outputPath -Encoding utf8
Write-Output $outputPath
