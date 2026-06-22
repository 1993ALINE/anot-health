<#
================================================================================
 load-test-backend.ps1  -  Drive HTTP load at the backend to exercise the
                           CPU-based auto-scaling on 'anot-backend-prod'
================================================================================
 Pure PowerShell. Works on Windows PowerShell 5.1 and PowerShell 7+.
 ASCII-only on purpose (no em-dashes, no emoji) so it never corrupts on paste.

 THE GOAL:
   Generate sustained, concurrent HTTP traffic against the backend so the
   EC2 fleet behind the Elastic Beanstalk environment 'anot-backend-prod'
   (id e-g7bj3ndsck) crosses the scale-OUT alarm (CPUUtilization > 70% for
   2 min) and the Auto Scaling Group grows from desired=1 to 2/3. Then watch
   the fleet scale back IN once load stops (CPUUtilization < 30% for 5 min).

   This is the LOAD + OBSERVE companion to enable-eb-autoscaling.ps1, which
   created the bounds (min=1/max=3), the +1/-1 simple-scaling policies, and the
   CPU-high / CPU-low CloudWatch alarms. This script does NOT change any AWS
   configuration; it only sends traffic and reads metrics/activities.

 HOW THE LOAD IS GENERATED:
   A pool of N runspaces (one per -Concurrency) each loops calling
   Invoke-WebRequest against the target URL as fast as it can until the run
   deadline. Per-host connection limits and TLS1.2 are forced inside every
   runspace (PowerShell otherwise caps a host at 2 connections, which would
   silently throttle the load). Each worker keeps its own success/fail/latency
   counters in a synchronized hashtable so the monitor thread can print a live
   running total without contending for a lock.

 HOW SCALING IS OBSERVED (all read-only):
   While the load runs (and during cooldown) the main thread polls every
   -PollIntervalSeconds:
     * describe-auto-scaling-groups : desired / min / max / in-service count
     * describe-scaling-activities  : prints only NEW activities since start
     * cloudwatch get-metric-statistics (AWS/EC2 CPUUtilization, Average) :
       the most recent per-instance CPU datapoint for the ASG
   The scale-OUT alarm needs ~2 min of CPU > 70% before it fires, and the
   metric itself lags ~1-2 min, so a 2-minute run may only START the scale-out;
   keep load on longer (-DurationSeconds 240+) if you want to SEE desired move.

 WHAT THIS SCRIPT DOES (top to bottom):
   PRE-FLIGHT  Tooling + identity checks; resolve the target URL; confirm the
               EB environment and discover its Auto Scaling Group.
   Phase 1     Record the BASELINE: ASG desired/min/max, current CPU, and the
               id of the latest scaling activity (so we only show new ones).
   Phase 2     Generate load for -DurationSeconds with -Concurrency workers,
               polling the ASG + CPU + scaling activities live.
   Phase 3     Report the load result (requests, success/fail, req/s, latency).
   Phase 4     Cooldown: stop load and poll up to -CooldownMinutes for the ASG
               to scale back IN to the minimum, printing CPU + new activities.
   Phase 5     Summary: baseline vs peak vs final desired capacity.

 SAFETY:
   * Read-only against AWS (describe-* / get-metric-statistics only). The only
     "writes" are HTTP GETs to the public endpoint, which is what the service
     is built to serve.
   * -DryRun does every check + discovery and prints the plan WITHOUT sending
     any load.
   * The load step prompts for confirmation unless -Force / -SkipConfirm.

 USAGE:
   powershell -File scripts/load-test-backend.ps1 -DryRun
   powershell -File scripts/load-test-backend.ps1 -DurationSeconds 120 -Concurrency 50
   powershell -File scripts/load-test-backend.ps1 -DurationSeconds 300 -Concurrency 80 -Force
   powershell -File scripts/load-test-backend.ps1 -TargetUrl https://api.anot.health/ -Path /
   powershell -File scripts/load-test-backend.ps1 -UseEbDirect           # hit the raw EB CNAME
   powershell -File scripts/load-test-backend.ps1 -SkipCooldownWait       # do not wait for scale-in
================================================================================
#>

[CmdletBinding()]
param(
    [switch]$Force,
    [switch]$SkipConfirm,
    [switch]$DryRun,
    [ValidateRange(1, 3600)] [int]$DurationSeconds = 120,
    [ValidateRange(1, 1000)] [int]$Concurrency = 50,
    [ValidateRange(1, 300)]  [int]$PollIntervalSeconds = 10,
    [ValidateRange(0, 120)]  [int]$CooldownMinutes = 10,
    [ValidateRange(1, 300)]  [int]$RequestTimeoutSec = 30,
    [string]$TargetUrl,                 # explicit override; else api.anot.health (or EB CNAME)
    [string]$Path = '/',                # path appended to the resolved base URL
    [switch]$UseEbDirect,               # target the raw EB CNAME instead of api.anot.health
    [switch]$SkipCooldownWait           # stop after the load phase; do not wait for scale-in
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

#region ----------------------------- CONFIG ----------------------------------
$AwsAccountId = '625242092266'
$Region       = 'ap-southeast-1'
$EbAppName    = 'anot-backend'
$EbEnvName    = 'anot-backend-prod'
$EbEnvId      = 'e-g7bj3ndsck'

$PublicHost   = 'https://api.anot.health'    # default target (front door)

# CPU metric the scale-out/scale-in alarms watch (per-instance EC2 CPU by ASG).
$MetricName      = 'CPUUtilization'
$MetricNamespace = 'AWS/EC2'
$ScaleUpThreshold   = 70
$ScaleDownThreshold = 30

$ProjectDir  = Split-Path -Parent $PSScriptRoot
$ArtifactDir = Join-Path $ProjectDir 'dist'

$env:AWS_DEFAULT_REGION = $Region
$env:AWS_PAGER = ''                  # disable the AWS CLI v2 pager (silent-fail source)
$script:CurrentPhase = 'startup'
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

function Confirm-Step {
    param([string]$Message)
    if ($DryRun)                 { Write-Step "[DRY-RUN] would prompt: $Message"; return }
    if ($Force -or $SkipConfirm) { Write-Step "$Message (auto-confirmed)"; return }
    $answer = Read-Host "  ?? $Message  [y/N]"
    if ($answer -notmatch '^(y|yes)$') { throw "Aborted by operator at: $Message" }
}

# Single choke point for every AWS CLI call. Captures stdout and stderr WITHOUT
# corrupting JSON: merges with 2>&1 then splits by object type (stdout = strings,
# stderr = ErrorRecord objects). Temporarily relaxes $ErrorActionPreference so a
# native command writing to stderr (even on exit 0) does not raise a terminating
# NativeCommandError before we read the real exit code. Retries with backoff and,
# on failure, throws a detailed, copy-pasteable diagnostic.
function Invoke-Aws {
    [CmdletBinding(PositionalBinding = $false)]
    param(
        [int]$Retries = 1,
        [int]$DelaySeconds = 5,
        [string]$What,
        [Parameter(ValueFromRemainingArguments = $true)][string[]]$CliArgs
    )

    if (-not $CliArgs -or $CliArgs.Count -eq 0) { throw 'Invoke-Aws called with no AWS CLI arguments.' }
    $cmdText = "aws $($CliArgs -join ' ')"
    $label   = if ($What) { $What } else { $cmdText }

    $attempt = 0
    while ($true) {
        $attempt++
        $prevEap = $ErrorActionPreference
        $ErrorActionPreference = 'Continue'
        try {
            $captured = & aws @CliArgs 2>&1
            $code = $LASTEXITCODE
        }
        catch {
            $code     = 9001
            $captured = $_.Exception.Message
        }
        finally {
            $ErrorActionPreference = $prevEap
        }

        $outParts = @()
        $errParts = @()
        foreach ($item in @($captured)) {
            if ($null -eq $item) { continue }
            if ($item -is [System.Management.Automation.ErrorRecord]) {
                $errParts += $item.ToString()
            } else {
                $outParts += [string]$item
            }
        }
        $stdout = ($outParts -join "`n")
        $stderr = (($errParts -join "`n")).Trim()

        if ($code -eq 0) { return $stdout }

        $lines = @(
            "AWS CLI call FAILED on attempt $attempt of $Retries",
            "  what     : $label",
            "  command  : $cmdText",
            "  region   : $Region",
            "  exit code: $code",
            "  time     : $(Get-Date -Format 'yyyy-MM-dd HH:mm:ss')"
        )
        if ($stderr) { $lines += "  aws error: $stderr" }
        else         { $lines += '  aws error: (no stderr output - check credentials / network / pager)' }
        if ($stdout) { $lines += "  aws stdout: $(($stdout -join ' ').Trim())" }
        $detail = ($lines -join "`n")

        if ($attempt -lt $Retries) {
            Write-Warn "$label failed (exit $code); retrying in $DelaySeconds s (attempt $attempt/$Retries)..."
            if ($stderr) { Write-Host "    $stderr" -ForegroundColor DarkRed }
            Start-Sleep -Seconds $DelaySeconds
            continue
        }

        throw $detail
    }
}

# Read the current EB environment object (CNAME/health/status) or $null.
function Get-EbEnvironment {
    $json = Invoke-Aws -Retries 3 -DelaySeconds 5 elasticbeanstalk describe-environments `
        --application-name $EbAppName --environment-names $EbEnvName --output json | ConvertFrom-Json
    if (-not $json.Environments -or @($json.Environments).Count -eq 0) { return $null }
    return @($json.Environments)[0]
}

# Read the EB-managed Auto Scaling Group object by name, or $null if absent.
function Get-Asg {
    param([string]$AsgName)
    if ([string]::IsNullOrEmpty($AsgName)) { return $null }
    $raw = Invoke-Aws -Retries 3 -DelaySeconds 5 -What "describe-auto-scaling-groups $AsgName" `
        autoscaling describe-auto-scaling-groups --auto-scaling-group-names $AsgName --output json
    if (-not $raw) { return $null }
    $obj = $raw | ConvertFrom-Json
    if (-not $obj.AutoScalingGroups -or @($obj.AutoScalingGroups).Count -eq 0) { return $null }
    return @($obj.AutoScalingGroups)[0]
}

# Count ASG instances that are actually InService (the ones serving traffic).
function Get-AsgInService {
    param($Asg)
    if ($null -eq $Asg) { return 0 }
    if (-not ($Asg.PSObject.Properties.Name -contains 'Instances') -or -not $Asg.Instances) { return 0 }
    return @($Asg.Instances | Where-Object { $_.LifecycleState -eq 'InService' }).Count
}

# Read the most recent CPUUtilization datapoint (Average) for the ASG, or $null.
# Looks back over a short window so we always catch the latest 60s datapoint.
function Get-AsgCpu {
    param([string]$AsgName)
    $end   = (Get-Date).ToUniversalTime()
    $start = $end.AddMinutes(-10)
    $endS   = $end.ToString('yyyy-MM-ddTHH:mm:ssZ')
    $startS = $start.ToString('yyyy-MM-ddTHH:mm:ssZ')
    $raw = Invoke-Aws -Retries 2 -DelaySeconds 3 -What 'get-metric-statistics CPUUtilization' `
        cloudwatch get-metric-statistics `
        --namespace $MetricNamespace --metric-name $MetricName `
        --dimensions "Name=AutoScalingGroupName,Value=$AsgName" `
        --start-time $startS --end-time $endS `
        --period 60 --statistics Average --output json
    if (-not $raw) { return $null }
    $obj = $raw | ConvertFrom-Json
    if (-not $obj.Datapoints -or @($obj.Datapoints).Count -eq 0) { return $null }
    $latest = @($obj.Datapoints | Sort-Object { [datetime]$_.Timestamp })[-1]
    return [pscustomobject]@{
        Average   = [math]::Round([double]$latest.Average, 1)
        Timestamp = ([datetime]$latest.Timestamp).ToLocalTime().ToString('HH:mm:ss')
    }
}

# Read recent scaling activities (newest first), normalized to a flat array.
function Get-ScalingActivities {
    param([string]$AsgName, [int]$MaxItems = 20)
    $raw = Invoke-Aws -Retries 2 -DelaySeconds 3 -What 'describe-scaling-activities' `
        autoscaling describe-scaling-activities --auto-scaling-group-name $AsgName `
        --max-items $MaxItems --output json
    if (-not $raw) { return @() }
    $obj = $raw | ConvertFrom-Json
    if (-not $obj.Activities -or @($obj.Activities).Count -eq 0) { return @() }
    return @($obj.Activities)
}

# Print scaling activities not seen before; returns the updated 'seen' set.
function Show-NewActivities {
    param([string]$AsgName, [hashtable]$Seen)
    $acts = Get-ScalingActivities -AsgName $AsgName
    # oldest-first so the log reads chronologically
    foreach ($a in ($acts | Sort-Object { [datetime]$_.StartTime })) {
        if ($Seen.ContainsKey($a.ActivityId)) { continue }
        $Seen[$a.ActivityId] = $true
        $when = ([datetime]$a.StartTime).ToLocalTime().ToString('HH:mm:ss')
        $prog = if ($a.PSObject.Properties.Name -contains 'Progress') { "$($a.Progress)%" } else { '?' }
        Write-Host "    [SCALING] $when  $($a.StatusCode.PadRight(18)) $prog  $($a.Description)" -ForegroundColor Magenta
        if ($a.PSObject.Properties.Name -contains 'Cause' -and $a.Cause) {
            Write-Host "              cause: $($a.Cause)" -ForegroundColor DarkMagenta
        }
    }
    return $Seen
}
#endregion

# ------------------------------------------------------------------------------
# Failure trap: name the phase, show the underlying error, exit non-zero.
# ------------------------------------------------------------------------------
trap {
    Write-Host ''
    Write-Host ('=' * 78) -ForegroundColor Red
    Write-Host '  LOAD TEST FAILED' -ForegroundColor Red
    Write-Host ('=' * 78) -ForegroundColor Red
    Write-Host "  Phase : $script:CurrentPhase" -ForegroundColor Red
    Write-Host "  Time  : $(Get-Date -Format 'yyyy-MM-dd HH:mm:ss')" -ForegroundColor Red
    Write-Host '  Error :' -ForegroundColor Red
    foreach ($l in ("$($_.Exception.Message)" -split "`n")) { Write-Host "    $l" -ForegroundColor Red }
    if ($_.InvocationInfo -and $_.InvocationInfo.PositionMessage) {
        Write-Host '  Where :' -ForegroundColor DarkRed
        foreach ($l in ($_.InvocationInfo.PositionMessage -split "`n")) { Write-Host "    $l" -ForegroundColor DarkRed }
    }
    Write-Host ''
    exit 1
}

# ==============================================================================
# PRE-FLIGHT
# ==============================================================================
Write-Phase 'PRE-FLIGHT: tooling + identity + target + ASG discovery'

if ($DryRun) {
    Write-Warn 'DRY-RUN MODE: discovery + plan only. No HTTP load will be sent.'
} else {
    Write-Step "LIVE MODE: this run will send $Concurrency concurrent requests for ${DurationSeconds}s."
}

Write-Step 'Checking AWS CLI is installed...'
$awsVersion = (& aws --version) 2>&1
if ($LASTEXITCODE -ne 0) { throw 'AWS CLI not found on PATH. Install AWS CLI v2.' }
Write-Step "AWS CLI: $awsVersion"

Write-Step 'Verifying AWS identity (OPERATOR identity, not the app)...'
$identity = Invoke-Aws sts get-caller-identity --output json | ConvertFrom-Json
Write-Step "Authenticated as: $($identity.Arn)"
if ($identity.Account -ne $AwsAccountId) {
    throw "Wrong AWS account: $($identity.Account) (expected $AwsAccountId)."
}

Write-Step "Confirming EB environment '$EbEnvName' ($EbEnvId) exists..."
$envObj = Get-EbEnvironment
if ($null -eq $envObj) { throw "EB environment '$EbEnvName' not found in application '$EbAppName'." }
$EbCname = $envObj.CNAME
Write-Diag "env id : $($envObj.EnvironmentId)"
Write-Diag "cname  : $EbCname"
Write-Diag "health : $($envObj.Health)  status: $($envObj.HealthStatus)"
if ($envObj.Health -ne 'Green') {
    Write-Warn "Environment is currently '$($envObj.Health)', not Green. Proceeding, but results may be noisy."
}

# Resolve the target URL: explicit override wins; else EB CNAME (-UseEbDirect)
# or the public front door (default). Normalize the path onto the base.
if ($TargetUrl) {
    $baseUrl = $TargetUrl.TrimEnd('/')
} elseif ($UseEbDirect) {
    if ([string]::IsNullOrEmpty($EbCname)) { throw 'EB CNAME is unknown; cannot use -UseEbDirect.' }
    $scheme = if ($EbCname -match '^https?://') { '' } else { 'http://' }
    $baseUrl = ("$scheme$EbCname").TrimEnd('/')
} else {
    $baseUrl = $PublicHost.TrimEnd('/')
}
$pathPart = if ($Path.StartsWith('/')) { $Path } else { "/$Path" }
$Url = "$baseUrl$pathPart"
Write-Ok "Target URL: $Url"
if ($UseEbDirect) {
    Write-Warn 'Targeting the EB CNAME directly. If the backend is restricted to CloudFront'
    Write-Warn '(restrict-backend-to-cloudfront.ps1), direct requests may be blocked (403) and'
    Write-Warn 'will NOT reach the instances - use the default api.anot.health front door instead.'
}

Write-Step "Discovering the EB-managed Auto Scaling Group for '$EbEnvName'..."
$resJson = Invoke-Aws -Retries 3 -DelaySeconds 5 -What 'describe-environment-resources' `
    elasticbeanstalk describe-environment-resources --environment-name $EbEnvName --output json | ConvertFrom-Json
$asgList = @($resJson.EnvironmentResources.AutoScalingGroups)
if ($asgList.Count -eq 0) { throw "No Auto Scaling Group found for environment '$EbEnvName'." }
$AsgName = $asgList[0].Name
Write-Ok "EB-managed ASG: $AsgName"

New-Item -ItemType Directory -Force -Path $ArtifactDir | Out-Null
Write-Ok 'Pre-flight checks passed.'

# ==============================================================================
# PHASE 1 - Record the baseline (ASG bounds, CPU, latest activity id)
# ==============================================================================
Write-Phase 'PHASE 1: Record baseline ASG capacity + CPU'

$asg0 = Get-Asg -AsgName $AsgName
if ($null -eq $asg0) { throw "Could not read the Auto Scaling Group '$AsgName'." }
$baseMin     = [int]$asg0.MinSize
$baseMax     = [int]$asg0.MaxSize
$baseDesired = [int]$asg0.DesiredCapacity
$baseInSvc   = Get-AsgInService -Asg $asg0
Write-Diag "MinSize         : $baseMin"
Write-Diag "MaxSize         : $baseMax"
Write-Diag "DesiredCapacity : $baseDesired"
Write-Diag "InService now   : $baseInSvc"

$cpu0 = Get-AsgCpu -AsgName $AsgName
if ($cpu0) { Write-Diag "CPU (latest)    : $($cpu0.Average)% at $($cpu0.Timestamp)" }
else       { Write-Diag 'CPU (latest)    : (no datapoint yet)' }

if ($baseMax -le $baseDesired) {
    Write-Warn "ASG MaxSize ($baseMax) is not above current desired ($baseDesired): there is no room to"
    Write-Warn 'scale OUT. Run enable-eb-autoscaling.ps1 first to set min=1/max=3 + the CPU alarms.'
}

# Seed the 'seen activities' set so Phase 2/4 only print NEW scaling events.
$seenActivities = @{}
foreach ($a in (Get-ScalingActivities -AsgName $AsgName)) { $seenActivities[$a.ActivityId] = $true }
Write-Diag "Recorded $($seenActivities.Count) existing scaling activit(y/ies) as baseline."

$peakDesired = $baseDesired
$peakInSvc   = $baseInSvc
$peakCpu     = if ($cpu0) { $cpu0.Average } else { 0.0 }

# ==============================================================================
# PHASE 2 - Generate load and watch the ASG / CPU / scaling activities
# ==============================================================================
Write-Phase 'PHASE 2: Generate load and monitor scaling'

Write-Step 'Plan:'
Write-Diag "target          : $Url"
Write-Diag "concurrency     : $Concurrency workers"
Write-Diag "duration        : ${DurationSeconds}s"
Write-Diag "poll interval   : every ${PollIntervalSeconds}s"
Write-Diag "scale OUT alarm : CPU > $ScaleUpThreshold% for ~2 min  -> desired +1 (up to max=$baseMax)"
Write-Diag "scale IN alarm  : CPU < $ScaleDownThreshold% for ~5 min -> desired -1 (down to min=$baseMin)"

if ($DryRun) {
    Write-Ok '[DRY-RUN] would now start the load pool and poll the ASG until the deadline.'
} else {
    Confirm-Step "Send $Concurrency concurrent requests to $Url for ${DurationSeconds}s now?"

    # Force TLS1.2 + lift the per-host connection cap in THIS process too (the
    # monitor thread makes HTTPS calls to AWS as well).
    [System.Net.ServicePointManager]::SecurityProtocol = [System.Net.SecurityProtocolType]::Tls12
    [System.Net.ServicePointManager]::DefaultConnectionLimit = [int]::MaxValue

    # Synchronized counters: one set of keys PER worker (single writer per key,
    # so the monitor can read them without locking). Pre-create every key.
    $counters = [System.Collections.Hashtable]::Synchronized(@{})
    for ($i = 0; $i -lt $Concurrency; $i++) {
        $counters["s$i"]  = 0     # successful requests (HTTP < 500)
        $counters["f$i"]  = 0     # failed requests (5xx / timeout / connection error)
        $counters["ms$i"] = [double]0  # cumulative latency in ms (for averaging)
    }

    # Worker: hammer the URL until the shared deadline. Each worker forces TLS1.2
    # and the connection-limit lift inside its OWN runspace (settings are not
    # inherited across runspaces).
    $worker = {
        param($Id, $Url, $Deadline, $TimeoutSec, $Counters)
        [System.Net.ServicePointManager]::SecurityProtocol = [System.Net.SecurityProtocolType]::Tls12
        [System.Net.ServicePointManager]::DefaultConnectionLimit = [int]::MaxValue
        $s = 0; $f = 0; $ms = [double]0
        $sw = [System.Diagnostics.Stopwatch]::new()
        while ((Get-Date) -lt $Deadline) {
            $sw.Restart()
            try {
                $resp = Invoke-WebRequest -Uri $Url -UseBasicParsing -Method GET `
                    -TimeoutSec $TimeoutSec -MaximumRedirection 0 -ErrorAction Stop
                $sw.Stop()
                # Any answered request (incl. 4xx) reached the edge/instance and
                # consumed CPU; only 5xx counts as a failure here.
                if ([int]$resp.StatusCode -ge 500) { $f++ } else { $s++ }
                $ms += $sw.Elapsed.TotalMilliseconds
            }
            catch {
                $sw.Stop()
                # Invoke-WebRequest throws on >=400; recover the real status code.
                $code = 0
                $ex = $_.Exception
                if ($ex.PSObject.Properties.Name -contains 'Response' -and $ex.Response) {
                    try { $code = [int]$ex.Response.StatusCode } catch { $code = 0 }
                }
                if ($code -ge 400 -and $code -lt 500) { $s++ } else { $f++ }
                $ms += $sw.Elapsed.TotalMilliseconds
            }
            $Counters["s$Id"]  = $s
            $Counters["f$Id"]  = $f
            $Counters["ms$Id"] = $ms
        }
    }

    $startTime = Get-Date
    $deadline  = $startTime.AddSeconds($DurationSeconds)

    Write-Step "Spinning up $Concurrency load workers..."
    $pool = [runspacefactory]::CreateRunspacePool(1, $Concurrency)
    $pool.Open()
    $jobs = @()
    for ($i = 0; $i -lt $Concurrency; $i++) {
        $ps = [powershell]::Create()
        $ps.RunspacePool = $pool
        [void]$ps.AddScript($worker).
            AddArgument($i).AddArgument($Url).AddArgument($deadline).
            AddArgument($RequestTimeoutSec).AddArgument($counters)
        $jobs += [pscustomobject]@{ PS = $ps; Handle = $ps.BeginInvoke() }
    }
    Write-Ok "Load started at $($startTime.ToString('HH:mm:ss')); running until $($deadline.ToString('HH:mm:ss'))."

    # Monitor loop: poll until the deadline passes.
    while ((Get-Date) -lt $deadline) {
        Start-Sleep -Seconds $PollIntervalSeconds

        $reqOk = 0; $reqFail = 0
        for ($i = 0; $i -lt $Concurrency; $i++) {
            $reqOk   += [int]$counters["s$i"]
            $reqFail += [int]$counters["f$i"]
        }
        $elapsed   = [math]::Max(1, [int]((Get-Date) - $startTime).TotalSeconds)
        $remaining = [math]::Max(0, [int]($deadline - (Get-Date)).TotalSeconds)
        $rps       = [math]::Round(($reqOk + $reqFail) / $elapsed, 1)

        $asg = Get-Asg -AsgName $AsgName
        $desired = if ($asg) { [int]$asg.DesiredCapacity } else { -1 }
        $inSvc   = Get-AsgInService -Asg $asg
        $cpu     = Get-AsgCpu -AsgName $AsgName
        $cpuTxt  = if ($cpu) { "$($cpu.Average)%" } else { 'n/a' }

        if ($desired -gt $peakDesired) { $peakDesired = $desired }
        if ($inSvc -gt $peakInSvc)     { $peakInSvc = $inSvc }
        if ($cpu -and $cpu.Average -gt $peakCpu) { $peakCpu = $cpu.Average }

        $cpuColor = if ($cpu -and $cpu.Average -ge $ScaleUpThreshold) { 'Red' } else { 'Gray' }
        Write-Host ("  [{0}] load: {1} ok / {2} fail ({3} req/s)  |  ASG desired={4} inService={5}  |  CPU={6}  |  {7}s left" -f `
            (Get-Date).ToString('HH:mm:ss'), $reqOk, $reqFail, $rps, $desired, $inSvc, $cpuTxt, $remaining) -ForegroundColor $cpuColor

        $seenActivities = Show-NewActivities -AsgName $AsgName -Seen $seenActivities
    }

    Write-Step 'Deadline reached; waiting for load workers to drain...'
    foreach ($j in $jobs) {
        try { $j.PS.EndInvoke($j.Handle) | Out-Null } catch { }
        $j.PS.Dispose()
    }
    $pool.Close(); $pool.Dispose()

    # Final tally from the per-worker counters.
    $totalOk = 0; $totalFail = 0; $totalMs = [double]0
    for ($i = 0; $i -lt $Concurrency; $i++) {
        $totalOk   += [int]$counters["s$i"]
        $totalFail += [int]$counters["f$i"]
        $totalMs   += [double]$counters["ms$i"]
    }
    $totalReq  = $totalOk + $totalFail
    $runSecs   = [math]::Max(1, [int]((Get-Date) - $startTime).TotalSeconds)
    $avgRps    = [math]::Round($totalReq / $runSecs, 1)
    $avgLatMs  = if ($totalReq -gt 0) { [math]::Round($totalMs / $totalReq, 1) } else { 0 }
    Write-Ok 'Load phase complete.'
}

# ==============================================================================
# PHASE 3 - Report the load result
# ==============================================================================
Write-Phase 'PHASE 3: Load result'

if ($DryRun) {
    Write-Ok '[DRY-RUN] would report request totals, throughput, and latency here.'
} else {
    Write-Diag "duration        : ${runSecs}s (target ${DurationSeconds}s)"
    Write-Diag "total requests  : $totalReq"
    Write-Diag "served (<500)   : $totalOk"
    Write-Diag "failed (5xx/err): $totalFail"
    Write-Diag "throughput      : $avgRps req/s"
    Write-Diag "avg latency     : ${avgLatMs} ms"
    Write-Diag "peak CPU seen   : $peakCpu%"
    Write-Diag "peak desired    : $peakDesired (baseline $baseDesired)"
    if ($totalReq -eq 0) {
        Write-Warn 'No requests completed. Check the target URL is reachable and not blocked (403/timeout).'
    }
    if ($peakCpu -lt $ScaleUpThreshold) {
        Write-Warn "Peak CPU ($peakCpu%) never reached the scale-OUT threshold ($ScaleUpThreshold%)."
        Write-Warn 'Increase -Concurrency / -DurationSeconds, or hit a heavier endpoint via -Path,'
        Write-Warn 'and remember the CPU metric lags ~1-2 min behind the actual load.'
    }
}

# ==============================================================================
# PHASE 4 - Cooldown: stop load and watch the fleet scale back IN
# ==============================================================================
Write-Phase 'PHASE 4: Cooldown and scale-in verification'

if ($DryRun) {
    Write-Ok "[DRY-RUN] would poll up to ${CooldownMinutes} min for desired to return to min=$baseMin."
} elseif ($SkipCooldownWait) {
    Write-Warn '-SkipCooldownWait set: not waiting for scale-in. Inspect later with:'
    Write-Diag "aws autoscaling describe-scaling-activities --auto-scaling-group-name $AsgName --region $Region"
} elseif ($peakDesired -le $baseMin) {
    Write-Ok "Fleet never scaled out beyond min=$baseMin; nothing to scale back in."
} else {
    Write-Step "Load stopped. CPU must stay < $ScaleDownThreshold% for ~5 min before scale-in fires."
    Write-Step "Polling up to ${CooldownMinutes} min for desired to return to $baseMin..."
    $cooldownDeadline = (Get-Date).AddMinutes($CooldownMinutes)
    $scaledIn = $false
    while ((Get-Date) -lt $cooldownDeadline) {
        Start-Sleep -Seconds $PollIntervalSeconds
        $asg = Get-Asg -AsgName $AsgName
        $desired = if ($asg) { [int]$asg.DesiredCapacity } else { -1 }
        $inSvc   = Get-AsgInService -Asg $asg
        $cpu     = Get-AsgCpu -AsgName $AsgName
        $cpuTxt  = if ($cpu) { "$($cpu.Average)%" } else { 'n/a' }
        $left    = [math]::Max(0, [int]($cooldownDeadline - (Get-Date)).TotalSeconds)
        Write-Host ("  [{0}] cooldown: ASG desired={1} inService={2}  |  CPU={3}  |  {4}s left" -f `
            (Get-Date).ToString('HH:mm:ss'), $desired, $inSvc, $cpuTxt, $left) -ForegroundColor Gray
        $seenActivities = Show-NewActivities -AsgName $AsgName -Seen $seenActivities
        if ($desired -le $baseMin) { $scaledIn = $true; break }
    }
    if ($scaledIn) {
        Write-Ok "Fleet scaled back IN to desired=$baseMin."
    } else {
        Write-Warn "Desired did not return to $baseMin within ${CooldownMinutes} min."
        Write-Warn 'Scale-in needs CPU < 30% for ~5 min plus the policy cooldown; it may still'
        Write-Warn 'happen shortly. Keep watching with describe-scaling-activities.'
    }
}

# ==============================================================================
# PHASE 5 - Summary
# ==============================================================================
Write-Phase 'PHASE 5: Summary'

if ($DryRun) {
    Write-Ok 'DRY-RUN COMPLETE: discovery + plan validated. No load was sent, no AWS changes made.'
    Write-Host ''
    Write-Host '  Planned run:' -ForegroundColor Yellow
    Write-Host "    target      : $Url" -ForegroundColor DarkGray
    Write-Host "    concurrency : $Concurrency" -ForegroundColor DarkGray
    Write-Host "    duration    : ${DurationSeconds}s" -ForegroundColor DarkGray
    Write-Host "    asg         : $AsgName (min=$baseMin max=$baseMax desired=$baseDesired)" -ForegroundColor DarkGray
    Write-Host ''
    return
}

$finalAsg = Get-Asg -AsgName $AsgName
$finalDesired = if ($finalAsg) { [int]$finalAsg.DesiredCapacity } else { -1 }
$finalInSvc   = Get-AsgInService -Asg $finalAsg

Write-Host ''
Write-Host ('=' * 78) -ForegroundColor Green
Write-Host '  LOAD TEST COMPLETE' -ForegroundColor Green
Write-Host ('=' * 78) -ForegroundColor Green
Write-Host "  environment : $EbEnvName ($EbEnvId)" -ForegroundColor Green
Write-Host "  asg         : $AsgName" -ForegroundColor Green
Write-Host "  target      : $Url" -ForegroundColor Green
Write-Host "  requests    : $totalReq total ($totalOk ok / $totalFail fail) at $avgRps req/s, ${avgLatMs} ms avg" -ForegroundColor Green
Write-Host "  desired     : baseline=$baseDesired  peak=$peakDesired  final=$finalDesired" -ForegroundColor Green
Write-Host "  inService   : baseline=$baseInSvc  peak=$peakInSvc  final=$finalInSvc" -ForegroundColor Green
Write-Host "  peak CPU    : $peakCpu%  (scale-out at $ScaleUpThreshold%)" -ForegroundColor Green
Write-Host ''
if ($peakDesired -gt $baseDesired) {
    Write-Ok "Auto-scaling SCALED OUT under load (desired $baseDesired -> $peakDesired)."
} else {
    Write-Warn 'Auto-scaling did NOT scale out during this run (see Phase 3 notes).'
}
Write-Host '  Inspect the full scaling history any time:' -ForegroundColor Yellow
Write-Host "    aws autoscaling describe-scaling-activities --auto-scaling-group-name $AsgName --region $Region" -ForegroundColor DarkGray
Write-Host "    aws autoscaling describe-auto-scaling-groups --auto-scaling-group-names $AsgName --region $Region" -ForegroundColor DarkGray
Write-Host ''
Write-Ok 'Done.'
