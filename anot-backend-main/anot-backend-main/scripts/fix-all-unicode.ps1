$ErrorActionPreference = 'Stop'

Write-Host "========================================" -ForegroundColor Cyan
Write-Host "  FIX ALL SCRIPTS - Unicode Cleanup" -ForegroundColor Cyan
Write-Host "========================================`n" -ForegroundColor Cyan

$scriptsDir = "C:\Users\Administrator\Desktop\anot-health\anot-backend-main\anot-backend-main\scripts"
$scripts = Get-ChildItem "$scriptsDir\fix-ISSUE-*.ps1" | Sort-Object Name

$totalFixed = 0
$totalErrors = 0

foreach ($script in $scripts) {
    $content = Get-Content $script.FullName -Raw -Encoding UTF8
    
    # Check for syntax errors before fix
    $errors = $null
    [void][System.Management.Automation.PSParser]::Tokenize($content, [ref]$errors)
    $errorsBefore = $errors.Count
    
    # Replace problematic Unicode characters with ASCII
    $modified = $false
    if ($content -match '[✓✗⚠]') {
        $content = $content -replace '✓', '[OK]'
        $content = $content -replace '✗', '[FAIL]'
        $content = $content -replace '⚠', '[WARN]'
        $content = $content -replace '⊘', '[SKIP]'
        $modified = $true
    }
    
    # Check for syntax errors after fix
    if ($modified) {
        $errors = $null
        [void][System.Management.Automation.PSParser]::Tokenize($content, [ref]$errors)
        $errorsAfter = $errors.Count
        
        if ($errorsAfter -eq 0 -or $errorsAfter -lt $errorsBefore) {
            Set-Content -Path $script.FullName -Value $content -Encoding UTF8 -NoNewline
            if ($errorsAfter -eq 0) {
                Write-Host "  [OK] $($script.Name) - Fixed ($errorsBefore -> 0 errors)" -ForegroundColor Green
                $totalFixed++
            } else {
                Write-Host "  [PARTIAL] $($script.Name) - Improved ($errorsBefore -> $errorsAfter errors)" -ForegroundColor Yellow
                $totalFixed++
            }
        } else {
            Write-Host "  [SKIP] $($script.Name) - No improvement" -ForegroundColor Gray
        }
    } elseif ($errorsBefore -eq 0) {
        Write-Host "  [CLEAN] $($script.Name) - Already OK" -ForegroundColor Cyan
    } else {
        Write-Host "  [ERROR] $($script.Name) - Has $errorsBefore errors (no Unicode)" -ForegroundColor Red
        $totalErrors++
    }
}

Write-Host "`n========================================" -ForegroundColor Cyan
Write-Host "Summary:" -ForegroundColor Cyan
Write-Host "  Total scripts: $($scripts.Count)" -ForegroundColor White
Write-Host "  Fixed: $totalFixed" -ForegroundColor Green
Write-Host "  Still have errors: $totalErrors" -ForegroundColor $(if ($totalErrors -gt 0) { 'Red' } else { 'Green' })
Write-Host "========================================" -ForegroundColor Cyan
