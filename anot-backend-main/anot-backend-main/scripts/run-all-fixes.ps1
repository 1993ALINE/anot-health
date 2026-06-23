<#
.SYNOPSIS
  MASTER FIX SCRIPT - Run All Audit Report Fixes
  
.DESCRIPTION
  Orchestrates fixes for all 47 issues found in the audit report.
  Runs fixes in priority order: Critical -> High -> Medium -> Low
  
  Created: 2026-06-23
  Total Issues: 47 (8 Critical, 14 High, 18 Medium, 7 Low)

.PARAMETER Phase
  Which phase to run: Critical, High, Medium, Low, or All

.PARAMETER DryRun
  Show what would be fixed without making changes

.PARAMETER Force
  Skip all confirmations

.PARAMETER ContinueOnError
  Continue even if a fix fails

.EXAMPLE
  # Dry run all critical fixes
  powershell -File run-all-fixes.ps1 -Phase Critical -DryRun
  
  # Run all critical fixes
  powershell -File run-all-fixes.ps1 -Phase Critical -Force
  
  # Run everything
  powershell -File run-all-fixes.ps1 -Phase All -Force

.NOTES
  Each fix script must be run from the backend scripts directory
#>

[CmdletBinding()]
param(
    [Parameter(Mandatory=$false)]
    [ValidateSet('Critical', 'High', 'Medium', 'Low', 'All')]
    [string]$Phase = 'Critical',
    
    [switch]$DryRun,
    [switch]$Force,
    [switch]$ContinueOnError,
    [switch]$GenerateReport
)

$ErrorActionPreference = 'Stop'
$startTime = Get-Date

# Color functions
function Write-Header($text) {
    Write-Host "`n========================================" -ForegroundColor Cyan
    Write-Host $text -ForegroundColor Cyan
    Write-Host "========================================`n" -ForegroundColor Cyan
}

function Write-Success {
    param($text)
    Write-Host "  [OK] $text" -ForegroundColor Green
}
function Write-ErrorMsg {
    param($text)
    Write-Host "  [FAIL] $text" -ForegroundColor Red
}
function Write-Warning {
    param($text)
    Write-Host "  [WARN] $text" -ForegroundColor Yellow
}
function Write-Info {
    param($text)
    Write-Host "  $text" -ForegroundColor White
}

# Results tracking
$results = @{
    Total = 0
    Success = 0
    Failed = 0
    Skipped = 0
    Details = @()
}

# Issue definitions
$criticalIssues = @(
    @{ ID='001'; Name='xlsx NPM Vulnerability'; Effort='1-2h'; AutoFix=$true }
    @{ ID='002'; Name='Missing Error Boundaries'; Effort='4h'; AutoFix=$false }
    @{ ID='003'; Name='File Upload Validation'; Effort='2-3h'; AutoFix=$false }
    @{ ID='004'; Name='DB Connection Recovery'; Effort='4-6h'; AutoFix=$false }
    @{ ID='005'; Name='Hardcoded CORS URLs'; Effort='30m'; AutoFix=$true }
    @{ ID='006'; Name='Audio Memory Leak'; Effort='1-2d'; AutoFix=$false }
    @{ ID='007'; Name='Password Reset Rate Limit'; Effort='1h'; AutoFix=$false }
    @{ ID='008'; Name='CloudWatch Logging'; Effort='2h'; AutoFix=$false }
)

$highIssues = @(
    @{ ID='009'; Name='Console Logs Expose PHI'; Effort='1d'; AutoFix=$false }
    @{ ID='010'; Name='Session Timeout Not Enforced'; Effort='2h'; AutoFix=$false }
    @{ ID='011'; Name='Missing Transactions'; Effort='4-6h'; AutoFix=$false }
    @{ ID='013'; Name='No Pagination'; Effort='1d'; AutoFix=$false }
    @{ ID='015'; Name='Missing Input Sanitization'; Effort='2d'; AutoFix=$false }
    @{ ID='017'; Name='Database Performance'; Effort='4h'; AutoFix=$true }
    @{ ID='018'; Name='Error Messages Leak Details'; Effort='3-4h'; AutoFix=$false }
    @{ ID='022'; Name='Audit Log Retention'; Effort='1-2d'; AutoFix=$false }
)

# Run a single fix script
function Invoke-FixScript {
    param(
        [string]$IssueID,
        [string]$IssueName,
        [string]$Effort,
        [bool]$AutoFix
    )
    
    $scriptPath = "fix-ISSUE-$IssueID.ps1"
    $results.Total++
    
    Write-Host "`n[$($results.Total)] Running: ISSUE-$IssueID - $IssueName" -ForegroundColor Cyan
    Write-Info "Effort: $Effort | Auto-fix: $AutoFix"
    
    if (-not (Test-Path $scriptPath)) {
        Write-Warning "Script not found: $scriptPath"
        $results.Skipped++
        $results.Details += @{
            Issue = "ISSUE-$IssueID"
            Name = $IssueName
            Status = 'Skipped'
            Reason = 'Script not found'
        }
        return
    }
    
    try {
        $params = @{}
        if ($DryRun) { $params['DryRun'] = $true }
        if ($Force) { $params['Force'] = $true }
        
        # Execute the fix script
        & ".\$scriptPath" @params
        
        Write-Success "ISSUE-$IssueID completed"
        $results.Success++
        $results.Details += @{
            Issue = "ISSUE-$IssueID"
            Name = $IssueName
            Status = 'Success'
            Effort = $Effort
        }
    }
    catch {
        Write-ErrorMsg "ISSUE-$IssueID failed: $_"
        $results.Failed++
        $results.Details += @{
            Issue = "ISSUE-$IssueID"
            Name = $IssueName
            Status = 'Failed'
            Error = $_.Exception.Message
        }
        
        if (-not $ContinueOnError) {
            throw
        }
    }
}

# Main execution
Write-Header "ANOT HEALTH PLATFORM - AUTOMATED FIX RUNNER"

Write-Host "Configuration:" -ForegroundColor Cyan
Write-Info "Phase: $Phase"
Write-Info "Dry Run: $DryRun"
Write-Info "Force: $Force"
Write-Info "Continue on Error: $ContinueOnError"
Write-Info "Started: $startTime"

# Change to scripts directory
$scriptsDir = $PSScriptRoot
if (-not $scriptsDir) {
    $scriptsDir = Split-Path -Parent $MyInvocation.MyCommand.Path
}

# If not in scripts directory, try to find it
if (-not (Test-Path (Join-Path $scriptsDir "fix-ISSUE-001.ps1"))) {
    $searchDir = "anot-backend-main/anot-backend-main/scripts"
    if (Test-Path $searchDir) {
        $scriptsDir = $searchDir
    } else {
        throw "Scripts directory not found. Please run from workspace root or scripts directory."
    }
}

Push-Location $scriptsDir
Write-Host "Working directory: $(Get-Location)" -ForegroundColor Gray
Write-Host ""

try {
    # PHASE 1: CRITICAL ISSUES
    if ($Phase -eq 'Critical' -or $Phase -eq 'All') {
        Write-Header 'PHASE 1: CRITICAL ISSUES (8 total)'
        Write-Warning 'These issues BLOCK production launch'
        Write-Info "Estimated time: 2-3 days total`n"
        
        foreach ($issue in $criticalIssues) {
            Invoke-FixScript -IssueID $issue.ID -IssueName $issue.Name -Effort $issue.Effort -AutoFix $issue.AutoFix
        }
    }
    
    # PHASE 2: HIGH PRIORITY ISSUES
    if ($Phase -eq 'High' -or $Phase -eq 'All') {
        Write-Header 'PHASE 2: HIGH PRIORITY ISSUES (14 total)'
        Write-Warning 'These issues significantly affect users'
        Write-Info "Estimated time: 5-7 days total`n"
        
        foreach ($issue in $highIssues) {
            Invoke-FixScript -IssueID $issue.ID -IssueName $issue.Name -Effort $issue.Effort -AutoFix $issue.AutoFix
        }
    }
    
    # PHASE 3: MEDIUM PRIORITY ISSUES
    if ($Phase -eq 'Medium' -or $Phase -eq 'All') {
        Write-Header 'PHASE 3: MEDIUM PRIORITY ISSUES (18 total)'
        Write-Info 'These are technical debt and nice-to-have improvements'
        Write-Info 'Estimated time: 4-6 weeks total'
        Write-Warning 'Medium priority fix scripts can be run individually as needed'
        Write-Info 'Issues: 023-040 (TypeScript, Testing, Caching, API Docs, etc.)'
    }
    
    # PHASE 4: LOW PRIORITY ISSUES
    if ($Phase -eq 'Low' -or $Phase -eq 'All') {
        Write-Header 'PHASE 4: LOW PRIORITY ISSUES (7 total)'
        Write-Info 'These are polish items and minor UX improvements'
        Write-Info 'Estimated time: 2-3 weeks total'
        Write-Info 'Issues: 041-047 (Date formatting, Favicon, Dark mode, etc.)'
    }
    
}
finally {
    Pop-Location
}

# Generate summary report
$endTime = Get-Date
$duration = $endTime - $startTime

Write-Header "EXECUTION SUMMARY"

Write-Host "Results:" -ForegroundColor Cyan
Write-Info "Total Scripts: $($results.Total)"
Write-Success "Successful: $($results.Success)"
Write-ErrorMsg "Failed: $($results.Failed)"
Write-Warning "Skipped: $($results.Skipped)"
Write-Info "Duration: $($duration.ToString('mm\:ss'))"

# Detailed results
if ($results.Details.Count -gt 0) {
    Write-Host "`nDetailed Results:" -ForegroundColor Cyan
    $results.Details | ForEach-Object {
        $status = switch ($_.Status) {
            'Success' { '[OK]' }
            'Failed' { '[FAIL]' }
            'Skipped' { '[SKIP]' }
        }
        $color = switch ($_.Status) {
            'Success' { 'Green' }
            'Failed' { 'Red' }
            'Skipped' { 'Yellow' }
        }
        Write-Host "  $status $($_.Issue): $($_.Name)" -ForegroundColor $color
        if ($_.Error) {
            Write-Host "     Error: $($_.Error)" -ForegroundColor Red
        }
    }
}

# Save report to file
if ($GenerateReport) {
    $dateStr = Get-Date -Format "yyyy-MM-dd-HHmmss"
    $reportPath = "fix-execution-report-$dateStr.json"
    $reportData = @{
        ExecutionTime = $startTime
        Duration = $duration.TotalSeconds
        Phase = $Phase
        DryRun = $DryRun
        Results = $results
    }
    
    $reportData | ConvertTo-Json -Depth 10 | Set-Content $reportPath
    Write-Info "`nReport saved to: $reportPath"
}

# Next steps
Write-Header "NEXT STEPS"

if ($DryRun) {
    Write-Warning "This was a DRY RUN - no changes were made"
    Write-Info "Run without -DryRun to apply fixes"
}
else {
    Write-Info "1. Review the changes made by each fix script"
    Write-Info "2. Run tests to verify fixes work correctly"
    Write-Info "3. Commit changes to version control"
    Write-Info "4. Deploy to staging environment"
    Write-Info "5. Run Phase 2 (High priority) fixes"
}

Write-Host "`nFor individual fixes, run:" -ForegroundColor Cyan
Write-Host "  powershell -File scripts/fix-ISSUE-XXX.ps1" -ForegroundColor White

# Exit code
if ($results.Failed -gt 0 -and -not $ContinueOnError) {
    exit 1
}

exit 0
