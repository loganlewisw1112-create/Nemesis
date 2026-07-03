param(
  [switch]$Package,
  [switch]$TrustCurrentUser,
  [string]$Subject = 'CN=NEMESIS Local Dev Code Signing',
  [string]$TimestampServer = 'http://timestamp.digicert.com',
  [string]$StageDir = 'WINDOWS PACKAGE'
)

$ErrorActionPreference = 'Stop'

$RepoRoot = Resolve-Path (Join-Path $PSScriptRoot '..')
Set-Location $RepoRoot
Add-Type -AssemblyName System.Security

function New-Password {
  $bytes = New-Object byte[] 32
  $rng = [System.Security.Cryptography.RandomNumberGenerator]::Create()
  try {
    $rng.GetBytes($bytes)
  } finally {
    $rng.Dispose()
  }
  return [Convert]::ToBase64String($bytes)
}

function Test-CodeSigningEku($cert) {
  foreach ($extension in $cert.Extensions) {
    if ($extension.Oid.Value -ne '2.5.29.37') { continue }
    $eku = [System.Security.Cryptography.X509Certificates.X509EnhancedKeyUsageExtension]$extension
    foreach ($oid in $eku.EnhancedKeyUsages) {
      if ($oid.Value -eq '1.3.6.1.5.5.7.3.3') { return $true }
    }
  }
  return $false
}

function Get-CodeSigningCertificate {
  $store = [System.Security.Cryptography.X509Certificates.X509Store]::new(
    [System.Security.Cryptography.X509Certificates.StoreName]::My,
    [System.Security.Cryptography.X509Certificates.StoreLocation]::CurrentUser
  )
  $store.Open([System.Security.Cryptography.X509Certificates.OpenFlags]::ReadWrite)
  try {
    $cert = $store.Certificates |
      Where-Object {
        $_.Subject -eq $Subject `
          -and $_.HasPrivateKey `
          -and $_.NotAfter -gt (Get-Date).AddDays(7) `
          -and (Test-CodeSigningEku $_)
      } |
      Sort-Object NotAfter -Descending |
      Select-Object -First 1

    if ($cert) { return $cert }

    $rsa = [System.Security.Cryptography.RSA]::Create(3072)
    $dn = [System.Security.Cryptography.X509Certificates.X500DistinguishedName]::new($Subject)
    $request = [System.Security.Cryptography.X509Certificates.CertificateRequest]::new(
      $dn,
      $rsa,
      [System.Security.Cryptography.HashAlgorithmName]::SHA256,
      [System.Security.Cryptography.RSASignaturePadding]::Pkcs1
    )
    $request.CertificateExtensions.Add(
      [System.Security.Cryptography.X509Certificates.X509KeyUsageExtension]::new(
        [System.Security.Cryptography.X509Certificates.X509KeyUsageFlags]::DigitalSignature,
        $true
      )
    )
    $oids = [System.Security.Cryptography.OidCollection]::new()
    $oids.Add([System.Security.Cryptography.Oid]::new('1.3.6.1.5.5.7.3.3', 'Code Signing')) | Out-Null
    $request.CertificateExtensions.Add(
      [System.Security.Cryptography.X509Certificates.X509EnhancedKeyUsageExtension]::new($oids, $false)
    )

    $created = $request.CreateSelfSigned(
      [DateTimeOffset]::Now.AddDays(-1),
      [DateTimeOffset]::Now.AddYears(2)
    )
    $password = New-Password
    $pfxBytes = $created.Export(
      [System.Security.Cryptography.X509Certificates.X509ContentType]::Pfx,
      $password
    )
    $flags =
      [System.Security.Cryptography.X509Certificates.X509KeyStorageFlags]::UserKeySet -bor
      [System.Security.Cryptography.X509Certificates.X509KeyStorageFlags]::PersistKeySet -bor
      [System.Security.Cryptography.X509Certificates.X509KeyStorageFlags]::Exportable
    $persisted = [System.Security.Cryptography.X509Certificates.X509Certificate2]::new($pfxBytes, $password, $flags)
    $store.Add($persisted)
    return $persisted
  } finally {
    $store.Close()
  }
}

function Trust-CertificateForCurrentUser($cert) {
  $publicCert = [System.Security.Cryptography.X509Certificates.X509Certificate2]::new(
    $cert.Export([System.Security.Cryptography.X509Certificates.X509ContentType]::Cert)
  )
  foreach ($storeName in @(
    [System.Security.Cryptography.X509Certificates.StoreName]::Root,
    [System.Security.Cryptography.X509Certificates.StoreName]::TrustedPublisher
  )) {
    $store = [System.Security.Cryptography.X509Certificates.X509Store]::new(
      $storeName,
      [System.Security.Cryptography.X509Certificates.StoreLocation]::CurrentUser
    )
    $store.Open([System.Security.Cryptography.X509Certificates.OpenFlags]::ReadWrite)
    try {
      $existing = $store.Certificates | Where-Object { $_.Thumbprint -eq $publicCert.Thumbprint } | Select-Object -First 1
      if (!$existing) { $store.Add($publicCert) }
    } finally {
      $store.Close()
    }
  }
}

function Invoke-NpmPackage {
  $oldCscLink = $env:CSC_LINK
  $oldCscPassword = $env:CSC_KEY_PASSWORD
  $oldWinCscLink = $env:WIN_CSC_LINK
  $oldWinCscPassword = $env:WIN_CSC_KEY_PASSWORD
  $oldCscDiscovery = $env:CSC_IDENTITY_AUTO_DISCOVERY

  try {
    Remove-Item Env:\CSC_LINK -ErrorAction SilentlyContinue
    Remove-Item Env:\CSC_KEY_PASSWORD -ErrorAction SilentlyContinue
    Remove-Item Env:\WIN_CSC_LINK -ErrorAction SilentlyContinue
    Remove-Item Env:\WIN_CSC_KEY_PASSWORD -ErrorAction SilentlyContinue
    $env:CSC_IDENTITY_AUTO_DISCOVERY = 'false'
    npm run package
    if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
  } finally {
    if ($null -eq $oldCscLink) { Remove-Item Env:\CSC_LINK -ErrorAction SilentlyContinue } else { $env:CSC_LINK = $oldCscLink }
    if ($null -eq $oldCscPassword) { Remove-Item Env:\CSC_KEY_PASSWORD -ErrorAction SilentlyContinue } else { $env:CSC_KEY_PASSWORD = $oldCscPassword }
    if ($null -eq $oldWinCscLink) { Remove-Item Env:\WIN_CSC_LINK -ErrorAction SilentlyContinue } else { $env:WIN_CSC_LINK = $oldWinCscLink }
    if ($null -eq $oldWinCscPassword) { Remove-Item Env:\WIN_CSC_KEY_PASSWORD -ErrorAction SilentlyContinue } else { $env:WIN_CSC_KEY_PASSWORD = $oldWinCscPassword }
    if ($null -eq $oldCscDiscovery) { Remove-Item Env:\CSC_IDENTITY_AUTO_DISCOVERY -ErrorAction SilentlyContinue } else { $env:CSC_IDENTITY_AUTO_DISCOVERY = $oldCscDiscovery }
  }
}

function Get-PackageVersion {
  return (Get-Content -Raw -LiteralPath (Join-Path $RepoRoot 'package.json') | ConvertFrom-Json).version
}

function Get-RequiredTargets($Version) {
  return @(
    'apps\global-event-alpha\release\win-unpacked\Global Event Alpha.exe',
    'apps\desktop\release\win-unpacked\resources\gea-app\Global Event Alpha.exe',
    'apps\desktop\release\win-unpacked\NEMESIS.exe',
    "apps\desktop\release\NEMESIS Setup $Version.exe"
  )
}

function Sign-Artifact($Path, $cert) {
  if (!(Test-Path -LiteralPath $Path)) { throw "Missing signing target: $Path" }
  $signature = Set-AuthenticodeSignature -FilePath $Path -Certificate $cert -HashAlgorithm SHA256
  if ($signature.Status -ne 'Valid') {
    throw "Signing failed for ${Path}: $($signature.StatusMessage)"
  }
}

function Assert-SignedArtifact($Path) {
  if (!(Test-Path -LiteralPath $Path)) { throw "Missing signing target: $Path" }
  $sig = Get-AuthenticodeSignature -FilePath $Path
  $subject = ''
  if ($sig.SignerCertificate) { $subject = $sig.SignerCertificate.Subject }
  $line = "{0}`t{1}`t{2}" -f $Path, $sig.Status, $subject
  if ($sig.Status -ne 'Valid') {
    throw "Signature verification failed for ${Path}: $($sig.StatusMessage)"
  }
  return $line
}

function Write-HashEvidence($StagedFile) {
  $hash = Get-FileHash -Algorithm SHA256 -LiteralPath $StagedFile
  $hashFile = "$StagedFile.sha256.txt"
  $content = "$($hash.Hash)  $(Split-Path -Leaf $StagedFile)"
  Set-Content -LiteralPath $hashFile -Value $content -Encoding UTF8
  $written = (Get-Content -Raw -LiteralPath $hashFile).Trim()
  if ($written -ne $content) {
    throw "Hash output mismatch for ${hashFile}"
  }
  return $hashFile
}

function Remove-StaleStagedPackages($StagePath, $CurrentSetup) {
  $current = @(
    [System.IO.Path]::GetFullPath($CurrentSetup),
    [System.IO.Path]::GetFullPath("$CurrentSetup.sha256.txt")
  )
  Get-ChildItem -LiteralPath $StagePath -Filter 'NEMESIS-Windows-v*-Setup.exe*' -ErrorAction SilentlyContinue |
    Where-Object { $current -notcontains [System.IO.Path]::GetFullPath($_.FullName) } |
    Remove-Item -Force
}

$Version = Get-PackageVersion
$cert = Get-CodeSigningCertificate
if ($TrustCurrentUser) {
  Trust-CertificateForCurrentUser $cert
}

if ($Package) {
  Invoke-NpmPackage
}

$targets = Get-RequiredTargets $Version
foreach ($target in $targets) {
  Sign-Artifact $target $cert
}

$stagePath = Join-Path $RepoRoot $StageDir
New-Item -ItemType Directory -Force -Path $stagePath | Out-Null
$setupPath = "apps\desktop\release\NEMESIS Setup $Version.exe"
$stagedSetup = Join-Path $stagePath "NEMESIS-Windows-v$Version-Setup.exe"
Remove-StaleStagedPackages $stagePath $stagedSetup
Copy-Item -LiteralPath $setupPath -Destination $stagedSetup -Force

$signatureLines = foreach ($target in ($targets + $stagedSetup)) {
  Assert-SignedArtifact $target
}
$signaturePath = Join-Path $stagePath 'signatures.txt'
Set-Content -LiteralPath $signaturePath -Value $signatureLines -Encoding UTF8

$hashPath = Write-HashEvidence $stagedSetup

Write-Host "Staged signed Windows package: $stagedSetup"
Write-Host "SHA256: $hashPath"
Write-Host "Signatures: $signaturePath"
