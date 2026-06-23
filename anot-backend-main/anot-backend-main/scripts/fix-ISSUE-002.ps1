<#
.SYNOPSIS
  Fix for ISSUE-002: Missing Error Boundaries in Critical Frontend Portals

.DESCRIPTION
  Severity: CRITICAL
  Component: Frontend - All Portal Pages
  Effort: 4 hours
  
  Issue: ErrorBoundary components exist but not consistently applied to all critical UI sections
  
  Impact: Complete portal failure for users if any component throws an error
  
  Fix: Wrap all major portal sections with ErrorBoundary components

.PARAMETER DryRun
  Show what would be fixed without making changes

.PARAMETER Force
  Skip confirmations

.EXAMPLE
  powershell -File fix-ISSUE-002.ps1 -DryRun
  powershell -File fix-ISSUE-002.ps1 -Force
#>

[CmdletBinding()]
param(
    [switch]$DryRun,
    [switch]$Force,
    [switch]$SkipConfirm
)

# Standard error handling
$ErrorActionPreference = 'Stop'
trap {
    Write-Host "[ERROR] Fix failed: $_" -ForegroundColor Red
    exit 1
}

$frontendPath = "../../../anot-frontend-main/anot-frontend-main"

Write-Host "========================================" -ForegroundColor Cyan
Write-Host "FIX ISSUE-002: Missing Error Boundaries" -ForegroundColor Cyan
Write-Host "========================================`n" -ForegroundColor Cyan

# Phase 1: Pre-flight checks
Write-Host "[PHASE 1] Pre-flight checks" -ForegroundColor Cyan

$portalFiles = @(
    "$frontendPath/src/pages/Clinician/index.jsx",
    "$frontendPath/src/pages/Admin/index.jsx",
    "$frontendPath/src/pages/Scribe/index.jsx"
)

foreach ($file in $portalFiles) {
    if (Test-Path $file) {
        Write-Host "  [OK] Found: $file" -ForegroundColor Green
    } else {
        Write-Host "  [X] Missing: $file" -ForegroundColor Yellow
    }
}

# Check if ErrorBoundary component exists
$errorBoundaryPath = "$frontendPath/src/components/ErrorBoundary.jsx"
if (Test-Path $errorBoundaryPath) {
    Write-Host "  [OK] ErrorBoundary component exists" -ForegroundColor Green
} else {
    Write-Host "  [WARN] ErrorBoundary component not found - will create it" -ForegroundColor Yellow
}

# Phase 2: Identify problem
Write-Host "`n[PHASE 2] Identifying problem" -ForegroundColor Cyan

$filesNeedingFix = @()
foreach ($file in $portalFiles) {
    if (Test-Path $file) {
        $content = Get-Content $file -Raw
        if ($content -notmatch "ErrorBoundary") {
            Write-Host "  [WARN] $file missing ErrorBoundary wrapper" -ForegroundColor Yellow
            $filesNeedingFix += $file
        } else {
            Write-Host "  [OK] $file already has ErrorBoundary" -ForegroundColor Green
        }
    }
}

# Phase 3: Apply fix
Write-Host "`n[PHASE 3] Applying fix" -ForegroundColor Cyan

if ($DryRun) {
    Write-Host "[DRY-RUN] Would make the following changes:" -ForegroundColor Yellow
    if (-not (Test-Path $errorBoundaryPath)) {
        Write-Host "  1. Create ErrorBoundary component at $errorBoundaryPath" -ForegroundColor Yellow
    }
    foreach ($file in $filesNeedingFix) {
        Write-Host "  2. Wrap portal content in $file with `<ErrorBoundary`>" -ForegroundColor Yellow
    }
} else {
    if (-not $Force -and -not $SkipConfirm) {
        $confirm = Read-Host "Apply error boundary fixes to $($filesNeedingFix.Count) file(s)? (y/n)"
        if ($confirm -ne 'y') {
            Write-Host "Aborted by user" -ForegroundColor Yellow
            exit 0
        }
    }
    
    # Create ErrorBoundary component if it doesn't exist
    if (-not (Test-Path $errorBoundaryPath)) {
        Write-Host "  Creating ErrorBoundary component..." -ForegroundColor Yellow
        
        $errorBoundaryContent = @'
import React from 'react';

class ErrorBoundary extends React.Component {
  constructor(props) {
    super(props);
    this.state = { hasError: false, error: null, errorInfo: null };
  }

  static getDerivedStateFromError(error) {
    return { hasError: true };
  }

  componentDidCatch(error, errorInfo) {
    // Log error to CloudWatch or error tracking service
    console.error('ErrorBoundary caught an error:', error, errorInfo);
    
    // You can also log to your error tracking service here
    // logErrorToService(error, errorInfo);
    
    this.setState({
      error: error,
      errorInfo: errorInfo
    });
  }

  render() {
    if (this.state.hasError) {
      return (
        <div style={{
          padding: '40px',
          textAlign: 'center',
          maxWidth: '600px',
          margin: '100px auto'
        }}>
          <h1 style={{ color: '#e74c3c', marginBottom: '20px' }}>
            Something went wrong
          </h1>
          <p style={{ marginBottom: '20px', color: '#666' }}>
            {this.props.portalName || 'This section'} encountered an unexpected error.
            Please refresh the page or contact support if the problem persists.
          </p>
          <button
            onClick={() => window.location.reload()}
            style={{
              padding: '12px 24px',
              backgroundColor: '#3498db',
              color: 'white',
              border: 'none',
              borderRadius: '4px',
              cursor: 'pointer',
              fontSize: '16px'
            }}
          >
            Refresh Page
          </button>
          {process.env.NODE_ENV === 'development' && this.state.error && (
            <details style={{ marginTop: '30px', textAlign: 'left' }}>
              <summary style={{ cursor: 'pointer', marginBottom: '10px' }}>
                Error Details (Development Only)
              </summary>
              <pre style={{
                backgroundColor: '#f5f5f5',
                padding: '15px',
                borderRadius: '4px',
                overflow: 'auto',
                fontSize: '12px'
              }}>
                {this.state.error && this.state.error.toString()}
                {this.state.errorInfo && this.state.errorInfo.componentStack}
              </pre>
            </details>
          )}
        </div>
      );
    }

    return this.props.children;
  }
}

export default ErrorBoundary;
'@
        
        # Create components directory if needed
        $componentsDir = "$frontendPath/src/components"
        if (-not (Test-Path $componentsDir)) {
            New-Item -Path $componentsDir -ItemType Directory -Force | Out-Null
        }
        
        Set-Content -Path $errorBoundaryPath -Value $errorBoundaryContent -Encoding UTF8
        Write-Host "  [OK] ErrorBoundary component created" -ForegroundColor Green
    }
    
    Write-Host "`n  Note: Portal files need manual wrapping with ErrorBoundary" -ForegroundColor Yellow
    Write-Host "  For each portal file, wrap the main component with:" -ForegroundColor Yellow
    Write-Host '  ' -ForegroundColor Cyan
    Write-Host '  import ErrorBoundary from ''../../components/ErrorBoundary'';' -ForegroundColor Cyan
    Write-Host '  ' -ForegroundColor Cyan
    Write-Host '  // Then wrap your portal content:' -ForegroundColor Cyan
    Write-Host '  <ErrorBoundary portalName="Portal Name">' -ForegroundColor Cyan
    Write-Host '    <YourPortalContent />' -ForegroundColor Cyan
    Write-Host '  </ErrorBoundary>' -ForegroundColor Cyan
}

# Phase 4: Verify fix
Write-Host "`n[PHASE 4] Verifying fix" -ForegroundColor Cyan

if (-not $DryRun) {
    if (Test-Path $errorBoundaryPath) {
        Write-Host "  [OK] ErrorBoundary component exists" -ForegroundColor Green
    }
    
    Write-Host "`n  Manual verification needed:" -ForegroundColor Yellow
    Write-Host "    1. Review each portal file" -ForegroundColor Yellow
    Write-Host "    2. Ensure ErrorBoundary is imported and used" -ForegroundColor Yellow
    Write-Host "    3. Test by triggering an error in dev mode" -ForegroundColor Yellow
}

# Phase 5: Test
Write-Host "`n[PHASE 5] Testing" -ForegroundColor Cyan

Write-Host "  Test steps:" -ForegroundColor Yellow
Write-Host "    1. Start the frontend: npm run dev" -ForegroundColor Yellow
Write-Host "    2. Navigate to each portal (Clinician, Admin, Scribe)" -ForegroundColor Yellow
Write-Host "    3. Trigger a test error in development mode" -ForegroundColor Yellow
Write-Host "    4. Verify error boundary shows fallback UI" -ForegroundColor Yellow
Write-Host "    5. Verify other portals remain functional" -ForegroundColor Yellow

Write-Host "`n========================================" -ForegroundColor Green
Write-Host "[SUCCESS] ISSUE-002 fix prepared" -ForegroundColor Green
Write-Host "========================================`n" -ForegroundColor Green

Write-Host "Next steps:" -ForegroundColor Cyan
Write-Host "  1. Manually wrap portal components with ErrorBoundary" -ForegroundColor White
Write-Host "  2. Test error scenarios in each portal" -ForegroundColor White
Write-Host "  3. Commit changes: git add src/components/ErrorBoundary.jsx src/pages/" -ForegroundColor White
Write-Host "  4. Create commit: git commit -m 'fix: add error boundaries to all portals (ISSUE-002)'" -ForegroundColor White
