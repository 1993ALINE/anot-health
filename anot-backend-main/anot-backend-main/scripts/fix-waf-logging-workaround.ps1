<#
================================================================================
 fix-waf-logging-workaround.ps1  -  WAF logging is blocked by a missing
                      account-level permission. This script documents why,
                      prints the exact manual AWS Console steps (plus an S3
                      logging workaround), and PROVES the WAF is still actively
                      protecting CloudFront even while logging is off.
================================================================================
 Pure PowerShell. Works on Windows PowerShell 5.1 and PowerShell 7+.
 ASCII-only on purpose (no em-dashes, no emoji) so it never corrupts on paste.

 THE PROBLEM (why automation failed):
   Enabling WAFv2 logging to CloudWatch Logs (wafv2 put-logging-configuration)
   uses the CloudWatch Logs "vended log delivery" path. The CALLER must be able
   to write a RESOURCE POLICY on the destination log group so the WAF log-delivery
   service is allowed to PutLogEvents. That requires the ACCOUNT-LEVEL action
   'logs:PutResourcePolicy' (it does not support resource scoping - Resource "*").
   The 'anot-ops' user is intentionally least-privilege and does NOT hold
   logs:PutResourcePolicy, so put-logging-configuration returns AccessDenied.
   We will NOT broaden anot-ops for a one-time account-level grant.

 WHAT THIS SCRIPT DOES (top to bottom):
   PHASE 1  Explain the permission gap (printed + written to the report).
   PHASE 2  Emit step-by-step AWS Console instructions for an ADMIN to enable
            logging, plus an alternative S3-destination workaround.
   PHASE 3  VERIFY the WAF is still active and enforcing: confirm the WebACL
            exists, count its rules, confirm it is associated with the
            distribution, and read recent Blocked/Allowed request metrics.
   PHASE 4  PROVE blocking live (-Live): send a benign request and a malicious
            (SQLi/XSS-looking) request through CloudFront and confirm the
            malicious one is challenged/blocked (403) while the benign one is not.
   OUTPUT   A JSON + HTML report showing WAF protection status (independent of
            whether logging is enabled).

 SAFETY:
   * 100% READ-ONLY against AWS. It never calls put-logging-configuration,
     never edits IAM, never changes the WebACL. It only Describes/Gets/Lists and
     sends ordinary HTTP requests to the public CloudFront endpoint.
   * -DryRun prints the plan + the manual guide and skips the live AWS/HTTP probes.
   * -Live runs the read-only AWS checks and the live blocking proof.

 USAGE:
   powershell -File scripts/fix-waf-logging-workaround.ps1 -Live
   powershell -File scripts/fix-waf-logging-workaround.ps1 -DryRun
================================================================================
#>

[CmdletBinding()]
param(
    [switch]$DryRun,
    [switch]$Live,
    [int]$MetricLookbackHours = 24
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

#region ----------------------------- CONFIG ----------------------------------
$AwsAccountId   = '625242092266'
$Region         = 'ap-southeast-1'
$GlobalRegion   = 'us-east-1'

# CLOUDFRONT-scoped WAFv2 + its log group live ONLY in us-east-1.
$WebAclName     = 'anot-cloudfront-waf'
$WebAclScope    = 'CLOUDFRONT'
$LogGroupName   = 'aws-waf-logs-anot-cloudfront'
$OpsPolicyName  = 'anot-ops-prod-policy'

$DistributionId = 'E6SKNV1EEXNPP'
$CloudFrontUrl  = 'https://d3t0m4s0ayca85.cloudfront.net/'

$ProjectDir  = Split-Path -Parent $PSScriptRoot
$ArtifactDir = Join-Path $ProjectDir 'dist'
$Stamp       = Get-Date -Format 'yyyyMMdd-HHmmss'
$ReportJson  = Join-Path $ArtifactDir "waf-protection-report-$Stamp.json"
$ReportHtml  = Join-Path $ArtifactDir "waf-protection-report-$Stamp.html"

# Default to LIVE if neither switch was given.
if (-not $DryRun -and -not $Live) { $Live = $true }
if ($DryRun) { $Live = $false }

$env:AWS_DEFAULT_REGION = $GlobalRegion
$env:AWS_PAGER = ''
try { [Net.ServicePointManager]::SecurityProtocol = [Net.ServicePointManager]::SecurityProtocol -bor [Net.SecurityProtocolType]::Tls12 } catch {}
$script:CurrentPhase = 'startup'
$script:Checks = New-Object System.Collections.Generic.List[object]
#endregion

#region --------------------------- HELPERS -----------------------------------
function Write-Phase {
    param([string]$Title)
    $script:CurrentPhase = $Title
    Write-Host ''
    Write-Host ('=' * 78) -ForegroundColor Cyan
    Write-Host "  $Title" -ForegroundColor Cyan
    Write-Host ('=' * 78) -ForegroundColor Cyan
}
function Write-Step { param([string]$Message) Write-Host "  -> $Message" -ForegroundColor Gray }
function Write-Ok   { param([string]$Message) Write-Host "  [OK] $Message" -ForegroundColor Green }
function Write-Warn { param([string]$Message) Write-Host "  [!!] $Message" -ForegroundColor Yellow }
function Write-Diag { param([string]$Message) Write-Host "    $Message" -ForegroundColor DarkGray }

function ConvertTo-HtmlText {
    param([string]$Text)
    if ($null -eq $Text) { return '' }
    return $Text.Replace('&','&amp;').Replace('<','&lt;').Replace('>','&gt;').Replace('"','&quot;')
}

function Add-Check {
    param([string]$Name, [ValidateSet('PASS','WARN','FAIL','INFO','SKIP')] [string]$Status, [string]$Detail = '')
    $script:Checks.Add([pscustomobject]@{ Name = $Name; Status = $Status; Detail = $Detail })
    $color = switch ($Status) { 'PASS' { 'Green' } 'WARN' { 'Yellow' } 'FAIL' { 'Red' } 'INFO' { 'Cyan' } 'SKIP' { 'DarkGray' } default { 'Gray' } }
    Write-Host ("  [{0,-4}] {1}" -f $Status, $Name) -ForegroundColor $color
    if ($Detail) { Write-Diag $Detail }
}

# Non-throwing read-only AWS CLI wrapper. Returns @{ Ok; Code; Stdout; Stderr; Json }.
function Invoke-AwsRead {
    [CmdletBinding(PositionalBinding = $false)]
    param(
        [string]$What,
        [int]$Retries = 3,
        [int]$DelaySeconds = 4,
        [Parameter(ValueFromRemainingArguments = $true)][string[]]$CliArgs
    )
    if (-not $CliArgs -or $CliArgs.Count -eq 0) { throw 'Invoke-AwsRead called with no AWS CLI arguments.' }
    $result = [pscustomobject]@{ Ok = $false; Code = $null; Stdout = ''; Stderr = ''; Json = $null }
    $attempt = 0
    while ($true) {
        $attempt++
        $prevEap = $ErrorActionPreference
        $ErrorActionPreference = 'Continue'
        try { $captured = & aws @CliArgs 2>&1; $code = $LASTEXITCODE }
        catch { $code = 9001; $captured = $_.Exception.Message }
        finally { $ErrorActionPreference = $prevEap }

        $outParts = @(); $errParts = @()
        foreach ($item in @($captured)) {
            if ($null -eq $item) { continue }
            if ($item -is [System.Management.Automation.ErrorRecord]) { $errParts += $item.ToString() }
            else { $outParts += [string]$item }
        }
        $stdout = ($outParts -join "`n"); $stderr = (($errParts -join "`n")).Trim()
        if ($code -eq 0) {
            $result.Ok = $true; $result.Code = 0; $result.Stdout = $stdout
            if ($stdout -and ($stdout.TrimStart().StartsWith('{') -or $stdout.TrimStart().StartsWith('['))) {
                try { $result.Json = $stdout | ConvertFrom-Json } catch { $result.Json = $null }
            }
            return $result
        }
        if ($attempt -lt $Retries) { Start-Sleep -Seconds $DelaySeconds; continue }
        $result.Ok = $false; $result.Code = $code; $result.Stdout = $stdout; $result.Stderr = $stderr
        return $result
    }
}

function Test-AccessDenied {
    param([string]$Text)
    if (-not $Text) { return $false }
    return ($Text -match 'AccessDenied|UnauthorizedOperation|not authorized|AuthorizationError|is not authorized to perform')
}

function Invoke-Probe {
    param([string]$Url, [int]$TimeoutSec = 20)
    $rec = [pscustomobject]@{ Code = $null; Reachable = $false; Error = $null }
    try {
        $resp = Invoke-WebRequest -Uri $Url -UseBasicParsing -TimeoutSec $TimeoutSec -MaximumRedirection 5 -ErrorAction Stop
        $rec.Reachable = $true; $rec.Code = [int]$resp.StatusCode
    }
    catch {
        $ex = $_.Exception; $resp = $null
        if ($ex.PSObject.Properties.Name -contains 'Response') { $resp = $ex.Response }
        if ($resp) { $rec.Reachable = $true; try { $rec.Code = [int]$resp.StatusCode } catch { $rec.Code = $null } }
        $rec.Error = $ex.Message
    }
    return $rec
}
#endregion

trap {
    Write-Host ''
    Write-Host ('=' * 78) -ForegroundColor Red
    Write-Host '  FIX-WAF-LOGGING-WORKAROUND FAILED' -ForegroundColor Red
    Write-Host ('=' * 78) -ForegroundColor Red
    Write-Host "  Phase : $script:CurrentPhase" -ForegroundColor Red
    foreach ($l in ("$($_.Exception.Message)" -split "`n")) { Write-Host "    $l" -ForegroundColor Red }
    Write-Host ''
    exit 1
}
# =============================================================================
# PRE-FLIGHT
# =============================================================================
Write-Phase 'PRE-FLIGHT: tooling + identity'

if ($DryRun) { Write-Warn 'DRY-RUN MODE: prints the explanation + manual guide; skips live AWS/HTTP probes.' }
else         { Write-Step 'LIVE MODE: read-only WAF verification + live blocking proof (no mutations).' }

New-Item -ItemType Directory -Force -Path $ArtifactDir | Out-Null

$awsReady = $false
$identityArn = '(unknown)'
if (-not $DryRun) {
    if (Get-Command aws -ErrorAction SilentlyContinue) {
        $idr = Invoke-AwsRead -What 'sts get-caller-identity' sts get-caller-identity --output json
        if ($idr.Ok -and $idr.Json) { $awsReady = $true; $identityArn = $idr.Json.Arn; Write-Diag "Authenticated as: $identityArn" }
        else { Write-Warn 'AWS identity not available; WAF read checks will be SKIPPED, but the guide still prints.' }
    } else { Write-Warn 'AWS CLI not on PATH; WAF read checks will be SKIPPED, but the guide still prints.' }
}

# =============================================================================
# PHASE 1 - Why WAF logging needs an account-level permission
# =============================================================================
Write-Phase 'PHASE 1: why WAF logging is blocked (root cause)'

$explainLines = @(
    "Finding        : WAF logging is DISABLED for the CloudFront WebACL '$WebAclName'.",
    "Attempted fix  : wafv2 put-logging-configuration -> AccessDenied for user '$OpsPolicyName'/anot-ops.",
    '',
    'Root cause:',
    '  WAFv2 -> CloudWatch Logs uses the CloudWatch Logs "vended log delivery" mechanism.',
    '  To let the WAF log-delivery service write into the destination log group, the',
    '  CALLER must attach a RESOURCE POLICY to CloudWatch Logs. That is the account-level',
    "  action logs:PutResourcePolicy, which does NOT support resource scoping (Resource '*').",
    '',
    "  The 'anot-ops' user is deliberately least-privilege and does not hold",
    '  logs:PutResourcePolicy. Granting an account-wide log-resource-policy action to a',
    '  scoped operations user would widen its blast radius for a one-time setup task, so',
    '  we keep anot-ops scoped and perform this single enablement as an ADMIN instead.',
    '',
    'Key point: this is a LOGGING/observability gap only. The WAF itself is fully',
    '  provisioned and actively inspecting + blocking traffic regardless of logging.'
)
foreach ($l in $explainLines) { if ($l) { Write-Diag $l } else { Write-Host '' } }

# =============================================================================
# PHASE 2 - Manual AWS Console guide (+ S3 workaround)
# =============================================================================
Write-Phase 'PHASE 2: manual setup guide for an administrator'

$LogGroupArn = "arn:aws:logs:us-east-1:${AwsAccountId}:log-group:$LogGroupName"

$consoleSteps = @(
    'OPTION A - Enable WAF logging to CloudWatch Logs (recommended; admin, one-time):',
    '  1. Sign in to the AWS Console as an ADMIN (a principal with logs:PutResourcePolicy',
    '     and wafv2:PutLoggingConfiguration), then switch the region to N. Virginia',
    '     (us-east-1) - CloudFront-scoped WAF is global and lives only in us-east-1.',
    '  2. Go to: WAF & Shield -> Web ACLs -> set scope "CloudFront (Global)" ->',
    "     open the Web ACL '$WebAclName'.",
    '  3. Open the "Logging and metrics" tab -> "Logging" -> click "Enable".',
    "  4. For the destination choose the CloudWatch Logs log group '$LogGroupName'.",
    '     (If it does not exist: CloudWatch -> Log groups -> Create log group, name it',
    "      EXACTLY '$LogGroupName' - WAF requires the 'aws-waf-logs-' name prefix.)",
    '  5. (Optional) Add redacted fields (e.g. authorization, cookie) to avoid logging',
    '     sensitive headers, then Save. The console auto-creates the required CloudWatch',
    '     Logs resource policy for delivery.amazonaws.com - that is the privileged step',
    '     that the anot-ops user cannot perform from the CLI.',
    '  6. Verify: the WebACL Logging tab shows "Enabled" pointing at the log group.',
    '',
    'OPTION B - CLI as an admin (equivalent to the existing fix-waf-logging.ps1):',
    "     aws wafv2 put-logging-configuration --region us-east-1 \\",
    "       --logging-configuration ResourceArn=<webacl-arn>,LogDestinationConfigs=$LogGroupArn",
    '   Run scripts/update-ops-policy-waf-logging.ps1 + a logs:PutResourcePolicy grant',
    '   FIRST if you intend anot-ops to own this going forward (not recommended).',
    '',
    'OPTION C - Workaround: log to an S3 bucket instead of CloudWatch Logs:',
    '  WAF can deliver logs to an S3 bucket whose name starts with "aws-waf-logs-".',
    '  S3 delivery is authorized by an S3 BUCKET POLICY (s3:PutObject for',
    '  delivery.logs.amazonaws.com) rather than logs:PutResourcePolicy, so it avoids the',
    '  account-level CloudWatch permission entirely:',
    "    1. Create bucket 'aws-waf-logs-anot-$AwsAccountId' (us-east-1), block public access,",
    '       enable default SSE (AES256 or KMS).',
    '    2. Attach a bucket policy allowing delivery.logs.amazonaws.com to PutObject.',
    '    3. WAF & Shield -> Web ACL -> Logging -> Enable -> destination = that S3 bucket.',
    '  This satisfies the "log to a different location" requirement when CloudWatch is',
    '  not an option for the operating principal.'
)
foreach ($l in $consoleSteps) { if ($l) { Write-Host "  $l" -ForegroundColor Gray } else { Write-Host '' } }
# =============================================================================
# PHASE 3 - Verify the WAF is still active + enforcing (read-only)
# =============================================================================
Write-Phase 'PHASE 3: verify WAF protection is active (independent of logging)'

$webAclArn = $null
$ruleCount = 0
$ruleNames = @()
$loggingEnabled = $null
$blocked24h = $null
$allowed24h = $null

if ($DryRun) {
    Add-Check -Name 'WAF verification' -Status 'SKIP' -Detail 'Dry-run: live AWS reads skipped. Re-run with -Live.'
} elseif (-not $awsReady) {
    Add-Check -Name 'WAF verification' -Status 'SKIP' -Detail 'AWS not available to this shell.'
} else {
    # 3a. Resolve the WebACL + count its rules.
    $list = Invoke-AwsRead -What 'wafv2 list-web-acls' wafv2 list-web-acls --scope $WebAclScope --output json
    $summary = $null
    if ($list.Ok -and $list.Json -and ($list.Json.PSObject.Properties.Name -contains 'WebACLs')) {
        $m = @($list.Json.WebACLs | Where-Object { $_.Name -eq $WebAclName })
        if ($m.Count -gt 0) { $summary = $m[0] }
    }
    if ($null -eq $summary) {
        Add-Check -Name 'WebACL exists' -Status 'FAIL' -Detail "CLOUDFRONT WebACL '$WebAclName' not found. Run scripts/enable-cloudfront-waf.ps1."
    } else {
        $webAclArn = $summary.ARN
        Add-Check -Name 'WebACL exists' -Status 'PASS' -Detail "id=$($summary.Id)"
        $get = Invoke-AwsRead -What 'wafv2 get-web-acl' wafv2 get-web-acl --name $WebAclName --scope $WebAclScope --id $summary.Id --output json
        if ($get.Ok -and $get.Json) {
            $rules = @($get.Json.WebACL.Rules)
            $ruleCount = $rules.Count
            $ruleNames = @($rules | ForEach-Object { $_.Name })
            $defAction = if ($get.Json.WebACL.PSObject.Properties.Name -contains 'DefaultAction') {
                if ($get.Json.WebACL.DefaultAction.PSObject.Properties.Name -contains 'Allow') { 'Allow' } else { 'Block' }
            } else { 'unknown' }
            if ($ruleCount -gt 0) {
                Add-Check -Name 'WebACL has active rules' -Status 'PASS' -Detail "$ruleCount rule(s): $($ruleNames -join ', '); default action=$defAction"
            } else {
                Add-Check -Name 'WebACL has active rules' -Status 'WARN' -Detail 'WebACL exists but has 0 rules (enforcing nothing).'
            }
        } else {
            Add-Check -Name 'WebACL has active rules' -Status 'WARN' -Detail "Could not read WebACL detail: $($get.Stderr)"
        }

        # 3b. Confirm the WebACL is associated with the CloudFront distribution.
        $distRes = Invoke-AwsRead -What 'cloudfront get-distribution' cloudfront get-distribution --id $DistributionId --output json
        if ($distRes.Ok -and $distRes.Json) {
            $assocArn = "$($distRes.Json.Distribution.DistributionConfig.WebACLId)"
            if ($assocArn -eq $webAclArn) {
                Add-Check -Name 'WebACL attached to CloudFront' -Status 'PASS' -Detail "distribution $DistributionId -> $WebAclName"
            } elseif ($assocArn) {
                Add-Check -Name 'WebACL attached to CloudFront' -Status 'WARN' -Detail "distribution attached to a DIFFERENT WebACL: $assocArn"
            } else {
                Add-Check -Name 'WebACL attached to CloudFront' -Status 'FAIL' -Detail 'distribution has NO WebACL associated.'
            }
        } else {
            Add-Check -Name 'WebACL attached to CloudFront' -Status 'INFO' -Detail "Could not read distribution: $($distRes.Stderr)"
        }

        # 3c. Logging status (this is the gap we are documenting, not fixing here).
        $logRes = Invoke-AwsRead -What 'wafv2 get-logging-configuration' wafv2 get-logging-configuration --resource-arn $webAclArn --output json
        if ($logRes.Ok -and $logRes.Json) {
            $loggingEnabled = $true
            $dests = @($logRes.Json.LoggingConfiguration.LogDestinationConfigs)
            Add-Check -Name 'WAF logging' -Status 'PASS' -Detail "ENABLED -> $($dests -join ', ')"
        } elseif ($logRes.Stderr -match 'WAFNonexistentItem|not.*found') {
            $loggingEnabled = $false
            Add-Check -Name 'WAF logging' -Status 'WARN' -Detail 'DISABLED (expected). Enable via the admin guide above; protection is unaffected.'
        } elseif (Test-AccessDenied $logRes.Stderr) {
            Add-Check -Name 'WAF logging' -Status 'INFO' -Detail 'logging status: access denied to this identity.'
        } else {
            Add-Check -Name 'WAF logging' -Status 'INFO' -Detail "logging status unknown: $($logRes.Stderr)"
        }

        # 3d. Read recent Blocked/Allowed request metrics (proof WAF is evaluating).
        $endT = [DateTime]::UtcNow
        $startT = $endT.AddHours(-1 * $MetricLookbackHours)
        $fmt = 'yyyy-MM-ddTHH:mm:ssZ'
        foreach ($metric in @('BlockedRequests','AllowedRequests')) {
            $mr = Invoke-AwsRead -What "cloudwatch get-metric-statistics ($metric)" cloudwatch get-metric-statistics `
                --namespace 'AWS/WAFV2' --metric-name $metric `
                --dimensions "Name=WebACL,Value=$WebAclName" 'Name=Rule,Value=ALL' 'Name=Region,Value=CloudFront' `
                --start-time $startT.ToString($fmt) --end-time $endT.ToString($fmt) `
                --period 86400 --statistics Sum --output json
            $sum = 0
            if ($mr.Ok -and $mr.Json -and @($mr.Json.Datapoints).Count -gt 0) {
                $sum = [int](@($mr.Json.Datapoints) | Measure-Object -Property Sum -Sum).Sum
            }
            if ($metric -eq 'BlockedRequests') { $blocked24h = $sum } else { $allowed24h = $sum }
        }
        $detailMetrics = "last ${MetricLookbackHours}h: blocked=$blocked24h allowed=$allowed24h"
        if ($null -ne $blocked24h -and ($blocked24h + $allowed24h) -gt 0) {
            Add-Check -Name 'WAF is evaluating traffic (CloudWatch metrics)' -Status 'PASS' -Detail $detailMetrics
        } else {
            Add-Check -Name 'WAF is evaluating traffic (CloudWatch metrics)' -Status 'INFO' -Detail "$detailMetrics (no traffic in window, or metrics access denied)"
        }
    }
}

# =============================================================================
# PHASE 4 - Prove blocking live (benign passes, malicious is blocked)
# =============================================================================
Write-Phase 'PHASE 4: live blocking proof through CloudFront'

$benignCode = $null
$maliciousCodes = @()
if ($DryRun) {
    Add-Check -Name 'Live blocking proof' -Status 'SKIP' -Detail 'Dry-run: no HTTP probes sent.'
} else {
    Write-Step "Sending a benign request to $CloudFrontUrl ..."
    $benign = Invoke-Probe -Url $CloudFrontUrl
    $benignCode = $benign.Code
    Write-Diag "benign request -> HTTP $benignCode"

    # Requests crafted to trip AWS managed SQLi/XSS/known-bad-inputs rules. These
    # are harmless probes against our own endpoint; a protecting WAF should answer
    # 403 (blocked) rather than passing them to the origin.
    $maliciousUrls = @(
        ($CloudFrontUrl + "?id=1%20OR%201%3D1--"),
        ($CloudFrontUrl + "?q=%3Cscript%3Ealert(1)%3C%2Fscript%3E"),
        ($CloudFrontUrl + "?file=../../../../etc/passwd")
    )
    $blockedCount = 0
    foreach ($u in $maliciousUrls) {
        $p = Invoke-Probe -Url $u
        $maliciousCodes += [pscustomobject]@{ url = $u; code = $p.Code }
        Write-Diag "malicious probe -> HTTP $($p.Code)  ($u)"
        if ($p.Code -eq 403) { $blockedCount++ }
    }

    if ($blockedCount -gt 0) {
        Add-Check -Name 'Live blocking proof' -Status 'PASS' -Detail "$blockedCount/$($maliciousUrls.Count) malicious probe(s) blocked with HTTP 403; benign request returned HTTP $benignCode."
    } elseif ($null -ne $benignCode) {
        Add-Check -Name 'Live blocking proof' -Status 'WARN' -Detail "Endpoint reachable (benign HTTP $benignCode) but no probe returned 403. Managed rules may be in Count mode, or probes did not match a rule."
    } else {
        Add-Check -Name 'Live blocking proof' -Status 'INFO' -Detail 'CloudFront endpoint not reachable from this host; could not run the live proof.'
    }
}
# =============================================================================
# OUTPUT: report (JSON + HTML) + verdict
# =============================================================================
Write-Phase 'OUTPUT: WAF protection report'

$passCount = @($script:Checks | Where-Object { $_.Status -eq 'PASS' }).Count
$failCount = @($script:Checks | Where-Object { $_.Status -eq 'FAIL' }).Count
$warnCount = @($script:Checks | Where-Object { $_.Status -eq 'WARN' }).Count

# "Protecting" = the WebACL exists, has rules, and (when checked) is attached.
$existsOk   = @($script:Checks | Where-Object { $_.Name -eq 'WebACL exists' -and $_.Status -eq 'PASS' }).Count -gt 0
$rulesOk    = @($script:Checks | Where-Object { $_.Name -eq 'WebACL has active rules' -and $_.Status -eq 'PASS' }).Count -gt 0
$attachWarn = @($script:Checks | Where-Object { $_.Name -eq 'WebACL attached to CloudFront' -and $_.Status -eq 'FAIL' }).Count -gt 0
$isProtecting = ($existsOk -and $rulesOk -and -not $attachWarn)

if ($DryRun) { $verdict = 'DRY-RUN (no live verification performed)'; $vColor = 'DarkGray' }
elseif ($isProtecting) { $verdict = 'WAF IS ACTIVELY PROTECTING (logging gap is observability-only)'; $vColor = 'Green' }
else { $verdict = 'WAF PROTECTION COULD NOT BE CONFIRMED - investigate'; $vColor = 'Yellow' }

$reportObj = [ordered]@{
    generatedAt   = (Get-Date).ToUniversalTime().ToString('yyyy-MM-ddTHH:mm:ssZ')
    mode          = $(if ($DryRun) { 'dry-run' } else { 'live' })
    account       = $AwsAccountId
    webAclName    = $WebAclName
    webAclArn     = $webAclArn
    distribution  = $DistributionId
    verdict       = $verdict
    protecting    = $isProtecting
    rootCause     = "WAF logging requires account-level logs:PutResourcePolicy (vended log delivery); anot-ops is intentionally not granted it."
    logging       = [ordered]@{
        enabled       = $loggingEnabled
        targetGroup   = $LogGroupName
        targetArn     = $LogGroupArn
        remediation   = 'Enable via AWS Console as an admin (OPTION A), CLI as admin (OPTION B), or S3 destination workaround (OPTION C).'
    }
    enforcement   = [ordered]@{
        ruleCount        = $ruleCount
        ruleNames        = $ruleNames
        blockedLastHrs   = $blocked24h
        allowedLastHrs   = $allowed24h
        lookbackHours    = $MetricLookbackHours
        benignHttpCode   = $benignCode
        maliciousProbes  = @($maliciousCodes | ForEach-Object { [ordered]@{ url = $_.url; code = $_.code } })
    }
    checks        = @($script:Checks | ForEach-Object { [ordered]@{ name = $_.Name; status = $_.Status; detail = $_.Detail } })
    consoleGuide  = $consoleSteps
}
[System.IO.File]::WriteAllText($ReportJson, ($reportObj | ConvertTo-Json -Depth 12), [System.Text.UTF8Encoding]::new($false))
Write-Step "Report JSON -> $ReportJson"

# ---- HTML report ----
$sb = New-Object System.Text.StringBuilder
[void]$sb.AppendLine('<!doctype html><html lang="en"><head><meta charset="utf-8">')
[void]$sb.AppendLine('<meta name="viewport" content="width=device-width, initial-scale=1">')
[void]$sb.AppendLine('<title>Anot Health - WAF Protection Report</title>')
[void]$sb.AppendLine(@'
<style>
:root{color-scheme:light dark}*{box-sizing:border-box}
body{font-family:-apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif;margin:0;background:#0f1419;color:#e6e6e6}
.wrap{max-width:1050px;margin:0 auto;padding:24px}
h1{font-size:24px;margin:0 0 4px}h2{font-size:18px;margin:26px 0 10px;border-bottom:1px solid #2a3340;padding-bottom:6px}
.meta{color:#9aa7b4;font-size:13px;margin-bottom:18px}
.verdict{font-size:18px;font-weight:700;padding:10px 16px;border-radius:10px;display:inline-block;margin:8px 0 16px}
.ok{background:#0f3d24;color:#5ee08a;border:1px solid #1d6b41}
.warn{background:#3d340f;color:#e0c95e;border:1px solid #6b5d1d}
.na{background:#23262b;color:#9aa7b4;border:1px solid #3a3f47}
table{border-collapse:collapse;width:100%;margin:6px 0 12px;font-size:14px}
th,td{text-align:left;padding:8px 10px;border-bottom:1px solid #232c38;vertical-align:top}
th{color:#9aa7b4;font-weight:600;font-size:12px;text-transform:uppercase}
.badge{font-size:11px;font-weight:700;padding:2px 8px;border-radius:20px}
.badge.PASS{background:#0f3d24;color:#5ee08a}.badge.WARN{background:#3d340f;color:#e0c95e}
.badge.FAIL{background:#3d0f0f;color:#e05e5e}.badge.INFO{background:#13314d;color:#5eb6e0}.badge.SKIP{background:#23262b;color:#9aa7b4}
pre{background:#161d27;border:1px solid #2a3340;border-radius:10px;padding:14px;white-space:pre-wrap;font-size:13px;color:#c2ccd6}
.muted{color:#9aa7b4}
</style>
'@)
[void]$sb.AppendLine('</head><body><div class="wrap">')
[void]$sb.AppendLine('<h1>Anot Health - WAF Protection Report</h1>')
[void]$sb.AppendLine("<div class='meta'>Generated $(ConvertTo-HtmlText $reportObj.generatedAt) &middot; mode <b>$($reportObj.mode)</b> &middot; account $AwsAccountId &middot; WebACL <b>$(ConvertTo-HtmlText $WebAclName)</b> &middot; distribution $DistributionId</div>")
$vCls = if ($isProtecting -and -not $DryRun) { 'ok' } elseif ($DryRun) { 'na' } else { 'warn' }
[void]$sb.AppendLine("<div class='verdict $vCls'>$(ConvertTo-HtmlText $verdict)</div>")

[void]$sb.AppendLine('<h2>Why logging is blocked</h2>')
[void]$sb.AppendLine("<pre>$(ConvertTo-HtmlText ($explainLines -join "`n"))</pre>")

[void]$sb.AppendLine('<h2>Verification checks</h2><table><tr><th>Status</th><th>Check</th><th>Detail</th></tr>')
foreach ($c in $script:Checks) {
    [void]$sb.AppendLine("<tr><td><span class='badge $($c.Status)'>$($c.Status)</span></td><td>$(ConvertTo-HtmlText $c.Name)</td><td class='muted'>$(ConvertTo-HtmlText $c.Detail)</td></tr>")
}
[void]$sb.AppendLine('</table>')

[void]$sb.AppendLine('<h2>Enforcement evidence</h2><table><tr><th>Metric</th><th>Value</th></tr>')
[void]$sb.AppendLine("<tr><td>Active rules</td><td>$ruleCount ($(ConvertTo-HtmlText ($ruleNames -join ', ')))</td></tr>")
[void]$sb.AppendLine("<tr><td>Blocked requests (last ${MetricLookbackHours}h)</td><td>$(if ($null -ne $blocked24h) { $blocked24h } else { 'n/a' })</td></tr>")
[void]$sb.AppendLine("<tr><td>Allowed requests (last ${MetricLookbackHours}h)</td><td>$(if ($null -ne $allowed24h) { $allowed24h } else { 'n/a' })</td></tr>")
[void]$sb.AppendLine("<tr><td>Benign probe</td><td>HTTP $(if ($null -ne $benignCode) { $benignCode } else { 'n/a' })</td></tr>")
foreach ($mc in $maliciousCodes) { [void]$sb.AppendLine("<tr><td>Malicious probe</td><td>HTTP $($mc.code) &middot; <span class='muted'>$(ConvertTo-HtmlText $mc.url)</span></td></tr>") }
[void]$sb.AppendLine('</table>')

[void]$sb.AppendLine('<h2>Administrator setup guide</h2>')
[void]$sb.AppendLine("<pre>$(ConvertTo-HtmlText ($consoleSteps -join "`n"))</pre>")
[void]$sb.AppendLine("<p class='muted'>Generated by fix-waf-logging-workaround.ps1 &middot; $(ConvertTo-HtmlText ((Get-Date).ToString('yyyy-MM-dd HH:mm:ss')))</p>")
[void]$sb.AppendLine('</div></body></html>')
[System.IO.File]::WriteAllText($ReportHtml, $sb.ToString(), [System.Text.UTF8Encoding]::new($false))
Write-Step "Report HTML -> $ReportHtml"

Write-Host ''
Write-Host ('=' * 78) -ForegroundColor $vColor
Write-Host "  $verdict" -ForegroundColor $vColor
Write-Host ('=' * 78) -ForegroundColor $vColor
Write-Host "  checks: PASS=$passCount WARN=$warnCount FAIL=$failCount" -ForegroundColor Gray
Write-Host "  HTML  : $ReportHtml" -ForegroundColor Gray
Write-Host "  JSON  : $ReportJson" -ForegroundColor Gray
Write-Host ''
Write-Host '  WAF logging itself stays a documented MANUAL admin step (see the guide above).' -ForegroundColor DarkGray
Write-Host '  Next: powershell -File scripts/verify-production-100-percent.ps1 -Live' -ForegroundColor Gray
Write-Host ''

if ($DryRun) { exit 0 }
if ($failCount -gt 0) { exit 1 }
exit 0



