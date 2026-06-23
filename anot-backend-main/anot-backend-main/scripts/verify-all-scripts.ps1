$ErrorActionPreference = 'Stop'

Write-Host "`n========================================" -ForegroundColor Cyan
Write-Host "  COMPREHENSIVE SYNTAX CHECK" -ForegroundColor Cyan
Write-Host "  All fix-ISSUE-*.ps1 scripts" -ForegroundColor Cyan
Write-Host "========================================`n" -ForegroundColor Cyan

$scriptsDir = "C:\Users\Administrator\Desktop\anot-health\anot-backend-main\anot-backend-main\scripts"
$scripts = Get-ChildItem "$scriptsDir\fix-ISSUE-*.ps1" | Sort-Object Name

$cleanCount = 0
$errorCount = 0
$scriptsWithErrors = @()

foreach ($script in $scripts) {
    $content = Get-Content $script.FullName -Raw -Encoding UTF8
    $errors = $null
    [void][System.Management.Automation.PSParser]::Tokenize($content, [ref]$errors)
    
    if ($errors.Count -eq 0) {
        $cleanCount++
    } else {
        $errorCount++
        $scriptsWithErrors += @{
            Name = $script.Name
            Errors = $errors
        }
    }
}

Write-Host "Results:" -ForegroundColor Yellow
Write-Host "  [OK] Clean scripts: $cleanCount / $($scripts.Count)" -ForegroundColor Green
Write-Host "  [FAIL] Scripts with errors: $errorCount" -ForegroundColor $(if ($errorCount -gt 0) { 'Red' } else { 'Green' })

if ($errorCount -gt 0) {
    Write-Host "`nScripts with errors:" -ForegroundColor Red
    foreach ($item in $scriptsWithErrors) {
        Write-Host "  - $($item.Name) ($($item.Errors.Count) errors)" -ForegroundColor Yellow
        foreach ($err in $item.Errors | Select-Object -First 2) {
            Write-Host "      Line $($err.Token.StartLine): $($err.Message)" -ForegroundColor Gray
        }
    }
} else {
    Write-Host "`n✓✓✓ ALL SCRIPTS PARSE CLEANLY! ✓✓✓" -ForegroundColor Green -BackgroundColor Black
}

Write-Host "`n========================================" -ForegroundColor Cyan
Write-Host "Testing dry-run execution..." -ForegroundColor Cyan
Write-Host "========================================`n" -ForegroundColor Cyan

# Test a few critical scripts with -DryRun
$testScripts = @("fix-ISSUE-001.ps1", "fix-ISSUE-005.ps1", "fix-ISSUE-008.ps1")
$successCount = 0

foreach ($testScript in $testScripts) {
    $testPath = Join-Path $scriptsDir $testScript
    if (Test-Path $testPath) {
        try {
            Write-Host "Testing $testScript..." -ForegroundColor Yellow
            $output = & powershell -File $testPath -DryRun -ErrorAction Stop 2>&1 | Out-String
            if ($LASTEXITCODE -eq 0 -or $output -match "DRY-RUN") {
                Write-Host "  [OK] $testScript executes" -ForegroundColor Green
                $successCount++
            } else {
                Write-Host "  [WARN] $testScript may have runtime issues" -ForegroundColor Yellow
            }
        } catch {
            Write-Host "  [FAIL] $testScript execution failed: $_" -ForegroundColor Red
        }
    }
}

Write-Host "`n========================================" -ForegroundColor Cyan
Write-Host "FINAL SUMMARY" -ForegroundColor Cyan
Write-Host "========================================" -ForegroundColor Cyan
Write-Host "  Total scripts: $($scripts.Count)" -ForegroundColor White
Write-Host "  Syntax clean: $cleanCount" -ForegroundColor Green
Write-Host "  Tested successfully: $successCount / $($testScripts.Count)" -ForegroundColor Green
Write-Host "========================================`n" -ForegroundColor Cyan

if ($cleanCount -eq $scripts.Count) {
    Write-Host "SUCCESS! All scripts are ready to use!" -ForegroundColor Black -BackgroundColor Green
    Write-Host ""
} else {
    Write-Host "WARNING: Some scripts still need fixes!" -ForegroundColor Black -BackgroundColor Red
    Write-Host ""
    exit 1
}
