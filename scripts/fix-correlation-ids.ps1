<#
.SYNOPSIS
  ULT audit fix: Correlation IDs for request tracing across logs.

.EXAMPLE
  powershell -File scripts/fix-correlation-ids.ps1 -Force
#>

[CmdletBinding()]
param([switch]$Force, [switch]$DryRun, [switch]$Rollback)

$ErrorActionPreference = 'Stop'
. "$PSScriptRoot\fix-common.ps1"
$script:FixForce = $Force
$script:FixDryRun = $DryRun

$ctx = Initialize-FixContext -FixId 'fix-correlation-ids' -Title 'Correlation IDs' `
    -AuditRef 'ULT-0011' -Priority 'HIGH'

if ($Rollback) {
    Write-FixPhase 'ROLLBACK: fix-correlation-ids'
    Restore-FixBackup -FixId 'fix-correlation-ids'
    exit 0
}

Write-FixPhase $ctx.Title
Test-RequiredPaths -RequireBackend
if (-not (Confirm-FixStep 'Add correlation ID middleware and logging integration?')) { exit 0 }

$corrMiddleware = @'
const crypto = require('crypto')

const HEADER = 'x-correlation-id'
const REQUEST_HEADER = 'x-request-id'

function correlationIdMiddleware(req, res, next) {
  const incoming =
    req.get(HEADER) ||
    req.get(REQUEST_HEADER) ||
    req.get('x-amzn-trace-id')

  const correlationId = incoming || crypto.randomUUID()
  req.correlationId = correlationId
  req.requestId = correlationId

  res.setHeader(HEADER, correlationId)
  res.setHeader(REQUEST_HEADER, correlationId)
  next()
}

module.exports = { correlationIdMiddleware, HEADER, REQUEST_HEADER }
'@

Set-FixFileContent -Path (Join-Path $ctx.BackendDir 'src\middleware\correlationId.js') -Content $corrMiddleware

Invoke-ServerPatch -Marker 'correlationIdMiddleware' -InsertAfter 'const app = express()' `
    -PatchBlock @"
const { correlationIdMiddleware } = require('./middleware/correlationId')
app.use(correlationIdMiddleware)
"@

$logPath = Join-Path $ctx.BackendDir 'src\middleware\logging.js'
if (Test-Path $logPath) {
    $log = Get-Content $logPath -Raw
    if ($log -notmatch 'correlationId') {
        $oldMsg = '`${req.method} ${req.originalUrl || req.path} returned ${res.statusCode}`'
        $newMsg = '`[${req.correlationId || ''no-corr-id''}] ${req.method} ${req.originalUrl || req.path} returned ${res.statusCode}`'
        Set-FixFileContent -Path $logPath -Content ($log.Replace($oldMsg, $newMsg)) -ForceWrite
    }
}

Write-FixReport -Summary 'Added correlationId middleware (X-Correlation-Id / X-Request-Id) and wired IDs into error audit logs for end-to-end tracing.' -NextSteps @(
    'Pass X-Correlation-Id from frontend api.js on all requests'
    'Search CloudWatch logs by correlation ID during incident response'
)

Write-Host ''
Write-Host '[SUCCESS] fix-correlation-ids completed' -ForegroundColor Green
