[CmdletBinding()]
param(
    [Parameter(Mandatory)][string]$Directory,
    [Parameter(Mandatory)][ValidateSet('test-signing', 'release-signing')][string]$Policy
)

$ErrorActionPreference = 'Stop'
$version = (Get-Content -Raw -LiteralPath (Join-Path $PSScriptRoot '../package.json') | ConvertFrom-Json).version
$entries = @(Get-ChildItem -LiteralPath $Directory -Force)
if ($entries.Count -ne 1 -or $entries[0].PSIsContainer -or $entries[0].Name -cne "Writing-Agent-Setup-$version-x64.exe") {
    throw "Expected only the Windows x64 installer for $version from SignPath."
}
$installer = $entries[0]
$signature = Get-AuthenticodeSignature -LiteralPath $installer.FullName
$certificate = $signature.SignerCertificate
if ($null -eq $certificate -or $signature.SignatureType -ne 'Authenticode') { throw 'Missing embedded Authenticode signature.' }
$fingerprint = $certificate.GetCertHashString([System.Security.Cryptography.HashAlgorithmName]::SHA256)
$originalStatus = $signature.Status.ToString()

if ($Policy -eq 'release-signing') {
    if ($signature.Status -ne 'Valid' -or $fingerprint -ne $env:WRITING_AGENT_UPDATE_SIGNER_SHA256) {
        throw 'Windows did not validate the release signature against the production certificate pinned in the app.'
    }
} elseif ($signature.Status -ne 'Valid') {
    # The Foundation test certificate is self-signed. Trust it only for this check on an ephemeral runner.
    if ($env:GITHUB_ACTIONS -ne 'true' -or $env:RUNNER_ENVIRONMENT -ne 'github-hosted' -or $certificate.Subject -ne $certificate.Issuer) {
        throw 'Test certificate validation needs a GitHub-hosted Windows runner and the self-signed test certificate.'
    }
    $store = [System.Security.Cryptography.X509Certificates.X509Store]::new('Root', 'CurrentUser')
    $added = $false
    try {
        $store.Open('ReadWrite')
        if (-not ($store.Certificates | Where-Object Thumbprint -eq $certificate.Thumbprint)) {
            $store.Add($certificate)
            $added = $true
        }
        $signature = Get-AuthenticodeSignature -LiteralPath $installer.FullName
        if ($signature.Status -ne 'Valid') { throw "Test installer signature validation failed: $($signature.StatusMessage)" }
    } finally {
        try { if ($added) { $store.Remove($certificate) } } finally { $store.Close() }
    }
}

[ordered]@{
    version = $version
    policy = $Policy
    sourceRevision = $env:GITHUB_SHA
    certificateSubject = $certificate.Subject
    certificateSha256 = $fingerprint
    windowsStatusBeforeTestTrust = $originalStatus
    verifiedStatus = $signature.Status.ToString()
    installerSha256 = (Get-FileHash -LiteralPath $installer.FullName -Algorithm SHA256).Hash
} | ConvertTo-Json | Set-Content -LiteralPath (Join-Path $Directory 'signing-verification.json') -Encoding utf8
