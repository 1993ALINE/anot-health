<#
 build-v41-artifact.ps1 — Build deployment zip for v41 (graceful settings decryption)
 Usage: pwsh -File scripts/build-v41-artifact.ps1
#>

$ErrorActionPreference = 'Stop'
$ProjectDir = Split-Path -Parent (Split-Path -Parent $MyInvocation.MyCommand.Path)
$Version = 'v41'
$ArtifactDir = Join-Path $ProjectDir 'artifacts'
$zipPath = Join-Path $ArtifactDir "anot-backend-$Version.zip"

$tarExe = Join-Path $env:WINDIR 'System32\tar.exe'
if (-not (Test-Path $tarExe)) {
    throw "Windows tar (bsdtar) not found at $tarExe"
}

Push-Location $ProjectDir
try {
    Write-Host "Running npm install..."
    & npm install
    if ($LASTEXITCODE -ne 0) { throw "npm install failed (exit $LASTEXITCODE)" }

    if (-not (Test-Path $ArtifactDir)) { New-Item -ItemType Directory -Path $ArtifactDir | Out-Null }
    if (Test-Path $zipPath) { Remove-Item $zipPath -Force }

    $include = @(
        'src', 'scripts', 'migrations', 'certs', 'package.json',
        'package-lock.json', 'Dockerfile', '.ebextensions', '.dockerignore',
        'instrument.js', 'ecosystem.config.js', 'DEPLOYMENT_V41.md'
    )
    $existing = $include | Where-Object { Test-Path (Join-Path $ProjectDir $_) }

    Write-Host "Building $zipPath ..."
    $tarArgs = @(
        '-a', '-c', '-f', $zipPath,
        '--exclude', 'node_modules',
        '--exclude', 'src/uploads',
        '--exclude', '*.webm',
        '--exclude', '*.zip',
        '--exclude', '*.tar.gz',
        '--exclude', '.git'
    ) + $existing

    & $tarExe @tarArgs
    if ($LASTEXITCODE -ne 0) { throw "tar failed (exit $LASTEXITCODE)" }
    if (-not (Test-Path $zipPath)) { throw "Artifact not created: $zipPath" }

    $size = (Get-Item $zipPath).Length
    Write-Host "Done: $zipPath ($size bytes)"
} finally {
    Pop-Location
}
