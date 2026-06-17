# Applies migrations/20260515_local_schema_gaps.sql (needs table owner — usually postgres).
# Run PowerShell as Administrator if trust-auth reload is required.
$ErrorActionPreference = "Stop"
$psql = "C:\Program Files\PostgreSQL\18\bin\psql.exe"
$repoBackend = Split-Path $PSScriptRoot -Parent
$sql = Join-Path $repoBackend "migrations\20260515_local_schema_gaps.sql"

if (-not (Test-Path $psql)) {
  Write-Error "PostgreSQL psql not found at $psql"
}

Write-Host "Applying schema gaps as postgres (trust or your OS admin login)..."
& $psql -U postgres -h 127.0.0.1 -d anot_dev -v ON_ERROR_STOP=1 -f $sql
if ($LASTEXITCODE -ne 0) {
  Write-Host ""
  Write-Host "If postgres login failed, run this file manually in pgAdmin or as Administrator:"
  Write-Host "  $sql"
  exit 1
}

Write-Host "Done. Restart npm run dev if the API is already running."
