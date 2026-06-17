# One-time local PostgreSQL setup for Anot (Windows, PostgreSQL 18 typical path).
# Run PowerShell as Administrator if trust-auth reload fails.
# Usage: .\scripts\setup-local-postgres.ps1

$ErrorActionPreference = "Stop"
$psql = "C:\Program Files\PostgreSQL\18\bin\psql.exe"
$pgHba = "C:\Program Files\PostgreSQL\18\data\pg_hba.conf"
$pgHbaBak = "$pgHba.bak.anot"
$repoBackend = Split-Path $PSScriptRoot -Parent

if (-not (Test-Path $psql)) {
  Write-Error "PostgreSQL psql not found at $psql. Install PostgreSQL 18 or edit paths in this script."
}

if (-not (Test-Path $pgHbaBak)) {
  Copy-Item $pgHba $pgHbaBak -Force
  (Get-Content $pgHba) -replace 'host\s+all\s+all\s+127\.0\.0\.1/32\s+scram-sha-256', 'host    all             all             127.0.0.1/32            trust' | Set-Content $pgHba
  & "C:\Program Files\PostgreSQL\18\bin\pg_ctl.exe" reload -D "C:\Program Files\PostgreSQL\18\data" 2>$null
}

& $psql -U postgres -h 127.0.0.1 -d postgres -v ON_ERROR_STOP=1 -c @"
DO `$`$ BEGIN
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'anot_dev') THEN
    CREATE ROLE anot_dev LOGIN PASSWORD 'anot_local_dev_2026';
  END IF;
END `$`$;
"@

& $psql -U postgres -h 127.0.0.1 -d postgres -c "CREATE DATABASE anot_dev OWNER anot_dev;" 2>$null

# Run DDL as anot_dev so tables are owned by the app user (avoids ALTER permission errors at login).
$env:PGPASSWORD = 'anot_local_dev_2026'
& $psql -U anot_dev -h 127.0.0.1 -d anot_dev -f "$repoBackend\scripts\bootstrap-local-schema.sql"

Get-ChildItem "$repoBackend\migrations" -Filter *.sql | Sort-Object Name | ForEach-Object {
  & $psql -U anot_dev -h 127.0.0.1 -d anot_dev -f $_.FullName
}
Remove-Item Env:PGPASSWORD -ErrorAction SilentlyContinue

$envContent = @"
NODE_ENV=development
PORT=5000
DB_HOST=127.0.0.1
DB_PORT=5432
DB_NAME=anot_dev
DB_USER=anot_dev
DB_PASSWORD=anot_local_dev_2026
JWT_SECRET=local-dev-jwt-secret-change-me
"@
Set-Content -Path "$repoBackend\.env" -Value $envContent.TrimEnd()

Set-Location $repoBackend
npm run seed:dev

Write-Host ""
Write-Host "Done. From repo root run: npm run dev"
Write-Host "Sign in: superadmin@dev.anot.local / DevSuperAdmin!2026"
Write-Host "Restore pg_hba from backup if you enabled trust: $pgHbaBak"
