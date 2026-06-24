<#
================================================================================
 fix-common.ps1  -  Shared helpers for ultimate-audit fix scripts
================================================================================
 Dot-source from scripts/fix-*.ps1. Provides path resolution, backups,
 rollback, before/after reporting, and documentation updates.
================================================================================
#>

Set-StrictMode -Version Latest

function Initialize-FixContext {
    param(
        [Parameter(Mandatory)][string]$FixId,
        [Parameter(Mandatory)][string]$Title,
        [string]$AuditRef = '',
        [string]$Priority = 'HIGH'
    )

    $scriptDir = $PSScriptRoot
    if (-not $scriptDir) { $scriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path }

    $workspace = Split-Path -Parent $scriptDir
    $backend = $null
    $frontend = $null

    foreach ($p in @(
        (Join-Path $workspace 'anot-backend-main\anot-backend-main'),
        (Join-Path $workspace 'anot-backend-main')
    )) { if (Test-Path $p) { $backend = $p; break } }

    foreach ($p in @(
        (Join-Path $workspace 'anot-frontend-main\anot-frontend-main'),
        (Join-Path $workspace 'anot-frontend-main')
    )) { if (Test-Path $p) { $frontend = $p; break } }

    $dist = Join-Path $workspace 'dist'
    $reportDir = Join-Path $dist 'fix-reports'
    $backupRoot = Join-Path $dist 'fix-backups'
    $backupDir = Join-Path $backupRoot $FixId
    $docsDir = Join-Path $workspace 'docs\audit-fixes'

    foreach ($d in @($dist, $reportDir, $backupRoot, $backupDir, $docsDir)) {
        if (-not (Test-Path $d)) { New-Item -ItemType Directory -Path $d -Force | Out-Null }
    }

    $stamp = Get-Date -Format 'yyyyMMdd-HHmmss'
    $ctx = [ordered]@{
        FixId       = $FixId
        Title       = $Title
        AuditRef    = $AuditRef
        Priority    = $Priority
        Workspace   = $workspace
        BackendDir  = $backend
        FrontendDir = $frontend
        DistDir     = $dist
        ReportDir   = $reportDir
        BackupDir   = $backupDir
        DocsDir     = $docsDir
        Stamp       = $stamp
        Changes     = New-Object System.Collections.Generic.List[object]
        Created     = New-Object System.Collections.Generic.List[string]
        Modified    = New-Object System.Collections.Generic.List[string]
        Removed     = New-Object System.Collections.Generic.List[string]
        StartTime   = Get-Date
    }

    $script:FixCtx = $ctx
    return $ctx
}

function Write-FixPhase { param([string]$Message)
    Write-Host ''
    Write-Host ('=' * 78) -ForegroundColor Cyan
    Write-Host "  $Message" -ForegroundColor Cyan
    Write-Host ('=' * 78) -ForegroundColor Cyan
}

function Write-FixStep { param([string]$Message) Write-Host "  -> $Message" -ForegroundColor Gray }
function Write-FixOk   { param([string]$Message) Write-Host "  [OK] $Message" -ForegroundColor Green }
function Write-FixWarn { param([string]$Message) Write-Host "  [WARN] $Message" -ForegroundColor Yellow }

function Confirm-FixStep {
    param([string]$Message)
    if ($script:FixDryRun) {
        Write-FixStep "[DRY-RUN] $Message"
        return $true
    }
    if ($script:FixForce) { Write-FixStep "$Message (auto-confirmed)"; return $true }
    $answer = Read-Host "  Proceed: $Message  [y/N]"
    return ($answer -match '^(y|yes)$')
}

function Get-RelativePath {
    param([string]$FullPath)
    $root = $script:FixCtx.Workspace
    if ($FullPath.StartsWith($root, [StringComparison]::OrdinalIgnoreCase)) {
        return $FullPath.Substring($root.Length).TrimStart('\', '/')
    }
    return $FullPath
}

function Backup-FileIfExists {
    param([string]$Path)
    if (-not (Test-Path $Path)) { return $null }
    $rel = Get-RelativePath $Path
    $safe = ($rel -replace '[\\/:]', '_')
    $dest = Join-Path $script:FixCtx.BackupDir $safe
    $destDir = Split-Path -Parent $dest
    if (-not (Test-Path $destDir)) { New-Item -ItemType Directory -Path $destDir -Force | Out-Null }
    Copy-Item -Path $Path -Destination $dest -Force
    return @{ Original = $Path; Backup = $dest; Relative = $rel }
}

function Restore-FixBackup {
    param([string]$FixId)
    $backupDir = Join-Path (Join-Path $script:FixCtx.Workspace 'dist\fix-backups') $FixId
    if (-not (Test-Path $backupDir)) {
        throw "No backup found for $FixId at $backupDir"
    }
    $manifestPath = Join-Path $backupDir 'manifest.json'
    if (-not (Test-Path $manifestPath)) {
        throw "Backup manifest missing: $manifestPath"
    }
    $manifest = Get-Content $manifestPath -Raw | ConvertFrom-Json
    foreach ($entry in $manifest.files) {
        if (Test-Path $entry.backup) {
            $parent = Split-Path -Parent $entry.original
            if ($parent -and -not (Test-Path $parent)) {
                New-Item -ItemType Directory -Path $parent -Force | Out-Null
            }
            Copy-Item -Path $entry.backup -Destination $entry.original -Force
            Write-FixOk "Restored $(Get-RelativePath $entry.original)"
        }
    }
    foreach ($created in @($manifest.created)) {
        if ($created -and (Test-Path $created)) {
            Remove-Item -Path $created -Force
            Write-FixOk "Removed created file $(Get-RelativePath $created)"
        }
    }
}

function Show-BeforeAfter {
    param([string]$Label, [string]$Before, [string]$After)
    Write-Host ''
    Write-Host "  --- BEFORE ($Label) ---" -ForegroundColor DarkYellow
    if ($Before) {
        ($Before -split "`n" | Select-Object -First 12) | ForEach-Object { Write-Host "  $_" -ForegroundColor DarkGray }
        if (($Before -split "`n").Count -gt 12) { Write-Host '  ...' -ForegroundColor DarkGray }
    } else { Write-Host '  (none / file did not exist)' -ForegroundColor DarkGray }
    Write-Host "  --- AFTER ($Label) ---" -ForegroundColor DarkGreen
    if ($After) {
        ($After -split "`n" | Select-Object -First 12) | ForEach-Object { Write-Host "  $_" -ForegroundColor Gray }
        if (($After -split "`n").Count -gt 12) { Write-Host '  ...' -ForegroundColor Gray }
    } else { Write-Host '  (removed)' -ForegroundColor Gray }
}

function Set-FixFileContent {
    param(
        [Parameter(Mandatory)][string]$Path,
        [Parameter(Mandatory)][string]$Content,
        [switch]$ForceWrite
    )

    $before = $null
    $existed = Test-Path $Path
    if ($existed) { $before = Get-Content $Path -Raw -ErrorAction SilentlyContinue }

    if (-not $ForceWrite -and $existed -and ($before -eq $Content)) {
        Write-FixStep "No change: $(Get-RelativePath $Path)"
        return
    }

    Show-BeforeAfter -Label (Get-RelativePath $Path) -Before $before -After $Content

    if ($script:FixDryRun) {
        Write-FixStep "[DRY-RUN] Would write $(Get-RelativePath $Path)"
        $script:FixCtx.Changes.Add([pscustomobject]@{
            Path   = Get-RelativePath $Path
            Action = if ($existed) { 'modified' } else { 'created' }
            Backup = $null
        }) | Out-Null
        return
    }

    $backupEntry = $null
    if ($existed) {
        $backupEntry = Backup-FileIfExists -Path $Path
        if ($script:FixCtx.Modified -notcontains $Path) { $script:FixCtx.Modified.Add($Path) | Out-Null }
    } else {
        if ($script:FixCtx.Created -notcontains $Path) { $script:FixCtx.Created.Add($Path) | Out-Null }
    }

    $parent = Split-Path -Parent $Path
    if ($parent -and -not (Test-Path $parent)) { New-Item -ItemType Directory -Path $parent -Force | Out-Null }
    Set-Content -Path $Path -Value $Content -Encoding UTF8 -NoNewline

    $script:FixCtx.Changes.Add([pscustomobject]@{
        Path   = Get-RelativePath $Path
        Action = if ($existed) { 'modified' } else { 'created' }
        Backup = if ($backupEntry) { $backupEntry.Backup } else { $null }
    }) | Out-Null

    Write-FixOk "Wrote $(Get-RelativePath $Path)"
}

function Add-FixFileIfMissing {
    param(
        [Parameter(Mandatory)][string]$Path,
        [Parameter(Mandatory)][string]$Content
    )
    if (Test-Path $Path) {
        Write-FixStep "Already exists: $(Get-RelativePath $Path)"
        return $false
    }
    Set-FixFileContent -Path $Path -Content $Content -ForceWrite
    return $true
}

function Update-FixFileLine {
    param(
        [Parameter(Mandatory)][string]$Path,
        [Parameter(Mandatory)][string]$Search,
        [Parameter(Mandatory)][string]$Replace,
        [switch]$NotContainsSkip
    )
    if (-not (Test-Path $Path)) {
        if ($NotContainsSkip) { return $false }
        throw "File not found: $Path"
    }
    $content = Get-Content $Path -Raw
    if ($content -match [regex]::Escape($Replace)) {
        Write-FixStep "Already patched: $(Get-RelativePath $Path)"
        return $false
    }
    if ($content -notmatch [regex]::Escape($Search)) {
        if ($NotContainsSkip) { Write-FixWarn "Pattern not found in $(Get-RelativePath $Path)"; return $false }
        throw "Search pattern not found in $(Get-RelativePath $Path)"
    }
    $newContent = $content.Replace($Search, $Replace)
    Set-FixFileContent -Path $Path -Content $newContent -ForceWrite
    return $true
}

function Write-FixReport {
    param([string]$Summary, [string[]]$NextSteps = @())

    $ctx = $script:FixCtx
    $duration = (Get-Date) - $ctx.StartTime
    $reportBase = Join-Path $ctx.ReportDir "$($ctx.FixId)-$($ctx.Stamp)"

    $manifest = [ordered]@{
        fixId     = $ctx.FixId
        title     = $ctx.Title
        auditRef  = $ctx.AuditRef
        priority  = $ctx.Priority
        timestamp = (Get-Date).ToUniversalTime().ToString('yyyy-MM-ddTHH:mm:ssZ')
        duration  = $duration.ToString()
        dryRun    = [bool]$script:FixDryRun
        summary   = $Summary
        created   = @($ctx.Created | ForEach-Object { Get-RelativePath $_ })
        modified  = @($ctx.Modified | ForEach-Object { Get-RelativePath $_ })
        removed   = @($ctx.Removed | ForEach-Object { Get-RelativePath $_ })
        changes   = @($ctx.Changes | ForEach-Object { @{ Path = $_.Path; Action = $_.Action } })
        nextSteps = $NextSteps
        rollback  = "powershell -File scripts/$($ctx.FixId).ps1 -Rollback"
    }

    $backupManifest = [ordered]@{
        fixId   = $ctx.FixId
        stamp   = $ctx.Stamp
        files   = @($ctx.Changes | Where-Object { $_.Backup } | ForEach-Object {
            [ordered]@{ original = (Join-Path $ctx.Workspace ($_.Path -replace '/', '\')); backup = $_.Backup }
        })
        created = @($ctx.Created)
    }
    if (-not $script:FixDryRun) {
        Set-Content -Path (Join-Path $ctx.BackupDir 'manifest.json') -Value ($backupManifest | ConvertTo-Json -Depth 6) -Encoding UTF8
    }

    $jsonPath = "$reportBase.json"
    $mdPath = "$reportBase.md"
    $docPath = Join-Path $ctx.DocsDir "$($ctx.FixId).md"

    $changeRows = if ($ctx.Changes.Count -gt 0) {
        ($ctx.Changes | ForEach-Object { "| $($_.Action) | $($_.Path) |" }) -join "`n"
    } else {
        '| (none) | - |'
    }

    $nextBlock = if ($NextSteps.Count) {
        ($NextSteps | ForEach-Object { "- $_" }) -join "`n"
    } else {
        '- Review changes and run tests'
    }

    $md = @"
# $($ctx.Title)

- **Fix ID:** $($ctx.FixId)
- **Audit ref:** $($ctx.AuditRef)
- **Priority:** $($ctx.Priority)
- **Generated:** $(Get-Date -Format 'yyyy-MM-dd HH:mm:ss')
- **Duration:** $($duration.TotalSeconds.ToString('0.0'))s

## Summary

$Summary

## Changes

| Action | Path |
|--------|------|
$changeRows

## Rollback

Run: powershell -File scripts/$($ctx.FixId).ps1 -Rollback

Or restore from backup manifest: dist/fix-backups/$($ctx.FixId)/manifest.json

## Next steps

$nextBlock
"@

    if (-not $script:FixDryRun) {
        try {
            $manifest | ConvertTo-Json -Depth 8 | Set-Content -Path $jsonPath -Encoding UTF8
        } catch {
            Write-FixWarn "Could not write JSON report: $_"
        }
        Set-Content -Path $mdPath -Value $md -Encoding UTF8
        Set-Content -Path $docPath -Value $md -Encoding UTF8
    } else {
        Write-FixStep "[DRY-RUN] Report would be written to $mdPath"
    }

    Write-Host ''
    Write-Host "Report: $mdPath" -ForegroundColor Cyan
    Write-Host "Docs:   $docPath" -ForegroundColor Cyan
}

function Test-RequiredPaths {
    param([switch]$RequireBackend, [switch]$RequireFrontend)
    if ($RequireBackend -and -not $script:FixCtx.BackendDir) { throw 'Backend directory not found' }
    if ($RequireFrontend -and -not $script:FixCtx.FrontendDir) { throw 'Frontend directory not found' }
}

function Merge-JsonFileProperty {
    param(
        [string]$Path,
        [string]$PropertyName,
        [hashtable]$AddProperties
    )
    if (-not (Test-Path $Path)) { throw "package.json not found: $Path" }
    $json = Get-Content $Path -Raw | ConvertFrom-Json
    if (-not $json.$PropertyName) {
        $json | Add-Member -NotePropertyName $PropertyName -NotePropertyValue ([pscustomobject]@{})
    }
    foreach ($key in $AddProperties.Keys) {
        if ($json.$PropertyName.$key) { continue }
        $json.$PropertyName | Add-Member -NotePropertyName $key -NotePropertyValue $AddProperties[$key] -Force
    }
    $out = $json | ConvertTo-Json -Depth 10
    Set-FixFileContent -Path $Path -Content $out -ForceWrite
}

function Invoke-ServerPatch {
    param(
        [string]$Marker,
        [string]$InsertAfter,
        [string]$PatchBlock
    )
    $serverPath = Join-Path $script:FixCtx.BackendDir 'src\server.js'
    if (-not (Test-Path $serverPath)) { throw 'server.js not found' }
    $content = Get-Content $serverPath -Raw
    if ($content -match [regex]::Escape($Marker)) {
        Write-FixStep "Server already contains marker: $Marker"
        return $false
    }
    if ($content -notmatch [regex]::Escape($InsertAfter)) {
        throw "Insert anchor not found in server.js: $InsertAfter"
    }
    $newContent = $content.Replace($InsertAfter, "$InsertAfter`n$PatchBlock")
    Set-FixFileContent -Path $serverPath -Content $newContent -ForceWrite
    return $true
}
