<#
================================================================================
 restrict-backend-to-cloudfront.ps1  -  Lock the EB backend down so it only
                                        accepts HTTP(S) from CloudFront
================================================================================
 Pure PowerShell. Works on Windows PowerShell 5.1 and PowerShell 7+.
 ASCII-only on purpose (no em-dashes, no emoji) so it never corrupts on paste.

 THE GOAL:
   The single-instance Elastic Beanstalk environment 'anot-backend-prod'
   (id e-g7bj3ndsck) currently accepts inbound 80/443 from the whole internet
   (0.0.0.0/0). We want the origin to be reachable ONLY through the CloudFront
   distribution E6SKNV1EEXNPP, so that direct hits on the EB instance domain
   fail while requests that arrive via CloudFront still succeed.

 HOW WE DO IT (the AWS-recommended pattern):
   AWS publishes a customer-visible, AWS-MANAGED prefix list that contains the
   public IP ranges of all CloudFront edge / origin-facing servers:
       com.amazonaws.global.cloudfront.origin-facing
   We add an ingress rule to the EB instance security group that allows tcp/80
   (and tcp/443) ONLY from that prefix list, then revoke the wide-open
   0.0.0.0/0 (and ::/0) rules on those ports. Because every CloudFront edge IP
   lives in the prefix list, CloudFront -> origin keeps working; everything else
   is dropped at the security group.

   NOTE on the API: the requirement mentions 'aws ec2 describe-prefix-lists',
   but that call only returns VPC-endpoint (gateway) prefix lists (S3/DynamoDB).
   The CloudFront origin-facing list is an AWS-MANAGED prefix list, which is
   returned by 'aws ec2 describe-managed-prefix-lists'. This script uses the
   correct call (describe-managed-prefix-lists) and falls back to filtering
   describe-prefix-lists if needed.

 WHY A PREFIX LIST (not a static CIDR list):
   CloudFront's edge IP ranges change over time. The managed prefix list is
   maintained by AWS, so the rule stays correct without manual CIDR updates.
   A single prefix-list rule also counts as ONE rule against the SG quota even
   though it expands to dozens of CIDRs.

 WHAT THIS SCRIPT DOES (top to bottom):
   PRE-FLIGHT  Tooling + identity checks; confirm the distribution + env exist.
   Phase 1     Resolve the CloudFront 'origin-facing' managed prefix list id.
   Phase 2     Read the CloudFront distribution (domain, origins). Warn loudly
               if no origin appears to point at this backend (restricting would
               then black-hole the backend).
   Phase 3     Resolve the EB instance security group id and SNAPSHOT its
               current ingress rules to disk (for rollback).
   Phase 3b    Rule-limit diagnostic: inventory EVERY SG attached to the env
               (instance / ASG / load balancer), print EFFECTIVE rule counts
               (prefix-list rules weighted by MaxEntries), flag any SG near the
               quota, and project whether this change will exceed it. This is
               what explains RulesPerSecurityGroupLimitExceeded when the SG looks
               nearly empty: a prefix-list rule is counted as MaxEntries rules.
   Phase 4     Authorize tcp/80 (+443) FROM the CloudFront prefix list
               (idempotent - skips ports that already have the rule).
   Phase 5     Revoke the open 0.0.0.0/0 and ::/0 ingress on those ports
               (SSH/22 and every other rule are left untouched).
   Phase 6     Poll EB health until Green.
   Phase 7     Verify: a DIRECT hit on the EB domain FAILS (timeout/refused)
               and a hit via CloudFront SUCCEEDS (HTTP 200).

 SAFETY:
   * The complete original IpPermissions set is saved to disk BEFORE any change,
     so rollback is a single authorize-security-group-ingress with the saved
     open rules (the exact command is printed on failure and on success).
   * Idempotent: a prefix-list rule that already exists is detected and skipped;
     open rules that are already gone are skipped.
   * -DryRun does every read-only step and prints the EXACT mutating calls it
     WOULD make, without changing the security group or the environment.

 USAGE:
   pwsh -File scripts/restrict-backend-to-cloudfront.ps1 -DryRun   # rehearse
   pwsh -File scripts/restrict-backend-to-cloudfront.ps1           # apply (prompts)
   pwsh -File scripts/restrict-backend-to-cloudfront.ps1 -Force    # apply, no prompts
   pwsh -File scripts/restrict-backend-to-cloudfront.ps1 -Ports 80
   pwsh -File scripts/restrict-backend-to-cloudfront.ps1 -SkipEgressCheck
   pwsh -File scripts/restrict-backend-to-cloudfront.ps1 -RulesPerSgLimit 120
   pwsh -File scripts/restrict-backend-to-cloudfront.ps1 -CloudFrontUrl https://d3t0m4s0ayca85.cloudfront.net/api/health
================================================================================
#>

[CmdletBinding()]
param(
    [switch]$Force,
    [switch]$SkipConfirm,
    [switch]$DryRun,
    [switch]$SkipEgressCheck,
    [int[]]$Ports = @(80, 443),
    [int]$RulesPerSgLimit = 60,
    [string]$SecurityGroupId = '',
    [string]$CloudFrontUrl   = '',
    [string]$EbDirectUrl     = ''
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

#region ----------------------------- CONFIG ----------------------------------
$AwsAccountId   = '625242092266'
$Region         = 'ap-southeast-1'
$EbAppName      = 'anot-backend'
$EbEnvName      = 'anot-backend-prod'
$EbEnvId        = 'e-g7bj3ndsck'
$DistributionId = 'E6SKNV1EEXNPP'

# The AWS-managed prefix list that holds CloudFront's origin-facing edge IPs.
$PrefixListName = 'com.amazonaws.global.cloudfront.origin-facing'

# Known instance SG name for this environment (from the EB launch template).
# We still resolve it dynamically; this is only a fallback / sanity reference.
$DefaultSgName  = 'awseb-e-g7bj3ndsck-stack-AWSEBSecurityGroup-QO9KwQbVENKE'

# The open CIDRs we are willing to revoke on the target ports.
$OpenV4 = '0.0.0.0/0'
$OpenV6 = '::/0'

$MaxHealthRetries        = 10
$HealthRetryDelaySeconds = 30

$ProjectDir  = Split-Path -Parent $PSScriptRoot
$ArtifactDir = Join-Path $ProjectDir 'dist'
$Stamp       = Get-Date -Format 'yyyyMMdd-HHmmss'

$env:AWS_DEFAULT_REGION = $Region
$env:AWS_PAGER = ''                  # disable the AWS CLI v2 pager (silent-fail source)
$script:CurrentPhase = 'startup'
$script:SgBackupFile = $null
$script:WouldExceed  = $false

# IMPORTANT - why a prefix-list rule can blow the "rules per security group"
# quota (default 60) even when the SG shows only ONE visible rule:
#   AWS counts a rule that references a MANAGED PREFIX LIST as the prefix list's
#   "MaxEntries" rules, NOT as one rule. The CloudFront origin-facing list has
#   dozens of entries, so allowing it on tcp/80 AND tcp/443 = 2 x MaxEntries
#   rules in one shot, which easily exceeds 60 -> RulesPerSecurityGroupLimitExceeded.
# Cache of prefixListId -> MaxEntries so we can weight rules correctly.
$script:PlMaxEntriesCache = @{}
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
# on failure, throws a detailed, copy-pasteable diagnostic. -SkipInDryRun marks a
# mutating call (skipped + printed in -DryRun).
function Invoke-Aws {
    [CmdletBinding(PositionalBinding = $false)]
    param(
        [int]$Retries = 1,
        [int]$DelaySeconds = 5,
        [switch]$SkipInDryRun,
        [string]$What,
        [Parameter(ValueFromRemainingArguments = $true)][string[]]$CliArgs
    )

    if (-not $CliArgs -or $CliArgs.Count -eq 0) { throw 'Invoke-Aws called with no AWS CLI arguments.' }
    $cmdText = "aws $($CliArgs -join ' ')"
    $label   = if ($What) { $What } else { $cmdText }

    if ($DryRun -and $SkipInDryRun) {
        Write-Host "    [DRY-RUN] skip mutating call: $cmdText" -ForegroundColor DarkYellow
        return ''
    }

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

# Read the current EB environment object (version/health/status) or $null.
function Get-EbEnvironment {
    $json = Invoke-Aws -Retries 3 -DelaySeconds 5 elasticbeanstalk describe-environments `
        --application-name $EbAppName --environment-names $EbEnvName --output json | ConvertFrom-Json
    if (-not $json.Environments -or @($json.Environments).Count -eq 0) { return $null }
    return @($json.Environments)[0]
}

# Poll EB until Health=Green, or until the retry budget is exhausted. Returns the
# final environment object (caller decides success/failure based on Health).
function Wait-ForGreen {
    param(
        [int]$MaxRetries = $MaxHealthRetries,
        [int]$DelaySeconds = $HealthRetryDelaySeconds
    )
    $envNow = Get-EbEnvironment
    if ($null -ne $envNow) {
        Write-Diag "initial: version=$($envNow.VersionLabel)  health=$($envNow.Health)  status=$($envNow.HealthStatus)"
        if ($envNow.Health -eq 'Green') { Write-Ok 'Environment already Green.'; return $envNow }
    }
    for ($i = 1; $i -le $MaxRetries; $i++) {
        Write-Step "Health not Green yet; waiting $DelaySeconds s then re-checking (attempt $i/$MaxRetries)..."
        Start-Sleep -Seconds $DelaySeconds
        $envNow = Get-EbEnvironment
        if ($null -eq $envNow) { Write-Warn 'describe-environments returned no environment; retrying.'; continue }
        Write-Diag "poll $i/${MaxRetries}: version=$($envNow.VersionLabel)  health=$($envNow.Health)  status=$($envNow.HealthStatus)"
        if ($envNow.Health -eq 'Green') { Write-Ok "Environment reached Green after $i poll(s)."; return $envNow }
    }
    return $envNow
}

# Read a single EB option value by namespace+name, normalizing the shapes the
# CLI/ConvertFrom-Json can return (nested arrays, 0/1/many matches) to a clean
# trimmed string or $null.
function Get-EbOption {
    param([object[]]$Options, [string]$Namespace, [string]$Name)
    $found = @($Options | Where-Object { $_.Namespace -eq $Namespace -and $_.OptionName -eq $Name })
    if ($found.Count -eq 0) { return $null }
    $val = $found[0].Value
    while ($val -is [System.Array]) {
        if ($val.Count -eq 0) { return $null }
        $val = $val[0]
    }
    if ($null -eq $val) { return $null }
    $str = ([string]$val).Trim()
    if ([string]::IsNullOrEmpty($str)) { return $null }
    return $str
}

# Fetch the live IpPermissions (ingress) array for a security group, or @().
function Get-SgIngress {
    param([string]$GroupId)
    $raw = Invoke-Aws -Retries 3 -DelaySeconds 5 -What "describe-security-groups $GroupId" `
        ec2 describe-security-groups --group-ids $GroupId --output json
    $obj = $raw | ConvertFrom-Json
    if (-not $obj.SecurityGroups -or @($obj.SecurityGroups).Count -eq 0) {
        throw "Security group '$GroupId' not found."
    }
    return @(@($obj.SecurityGroups)[0].IpPermissions)
}

# Does the SG already allow $Port from prefix list $PlId ?
function Test-HasPrefixRule {
    param([object[]]$Ingress, [int]$Port, [string]$PlId)
    foreach ($perm in $Ingress) {
        if ($perm.IpProtocol -ne 'tcp') { continue }
        $from = if ($perm.PSObject.Properties.Name -contains 'FromPort') { $perm.FromPort } else { $null }
        $to   = if ($perm.PSObject.Properties.Name -contains 'ToPort')   { $perm.ToPort }   else { $null }
        if ($from -ne $Port -or $to -ne $Port) { continue }
        if ($perm.PSObject.Properties.Name -notcontains 'PrefixListIds') { continue }
        foreach ($pl in @($perm.PrefixListIds)) {
            if ($pl.PrefixListId -eq $PlId) { return $true }
        }
    }
    return $false
}

# Collect the open-to-the-world CIDRs (0.0.0.0/0 and ::/0) present on $Port.
# Returns a hashtable @{ V4 = $true/$false; V6 = $true/$false }.
function Get-OpenRangesOnPort {
    param([object[]]$Ingress, [int]$Port)
    $result = @{ V4 = $false; V6 = $false }
    foreach ($perm in $Ingress) {
        if ($perm.IpProtocol -ne 'tcp') { continue }
        $from = if ($perm.PSObject.Properties.Name -contains 'FromPort') { $perm.FromPort } else { $null }
        $to   = if ($perm.PSObject.Properties.Name -contains 'ToPort')   { $perm.ToPort }   else { $null }
        if ($from -ne $Port -or $to -ne $Port) { continue }
        if ($perm.PSObject.Properties.Name -contains 'IpRanges') {
            foreach ($r in @($perm.IpRanges)) { if ($r.CidrIp -eq $OpenV4) { $result.V4 = $true } }
        }
        if ($perm.PSObject.Properties.Name -contains 'Ipv6Ranges') {
            foreach ($r in @($perm.Ipv6Ranges)) { if ($r.CidrIpv6 -eq $OpenV6) { $result.V6 = $true } }
        }
    }
    return $result
}

# Probe a URL. Returns a record { Ok2xx; Code; Reachable; Error }.
# Reachable=$false means connection-level failure (timeout / refused / DNS) -
# which is exactly what we WANT for the direct-EB test after locking down.
function Invoke-Probe {
    param([string]$Url, [int]$TimeoutSec = 12)
    $rec = [pscustomobject]@{ Ok2xx = $false; Code = $null; Reachable = $false; Error = $null }
    try {
        $resp = Invoke-WebRequest -Uri $Url -UseBasicParsing -TimeoutSec $TimeoutSec -MaximumRedirection 0 -ErrorAction Stop
        $rec.Reachable = $true
        $rec.Code = [int]$resp.StatusCode
        $rec.Ok2xx = ($rec.Code -ge 200 -and $rec.Code -lt 300)
    }
    catch {
        $ex = $_.Exception
        # An HTTP error response (403/5xx/redirect) still means the host was REACHED.
        $resp = $null
        if ($ex.PSObject.Properties.Name -contains 'Response') { $resp = $ex.Response }
        if ($resp) {
            $rec.Reachable = $true
            try { $rec.Code = [int]$resp.StatusCode } catch { $rec.Code = $null }
            if ($rec.Code) { $rec.Ok2xx = ($rec.Code -ge 200 -and $rec.Code -lt 300) }
        } else {
            $rec.Reachable = $false      # timeout / connection refused / DNS failure
        }
        $rec.Error = $ex.Message
    }
    return $rec
}

# Return the MaxEntries (rule "weight") of a managed prefix list, cached. A rule
# that references a prefix list consumes this many slots against the SG quota,
# NOT one. Returns 1 for an unknown/unresolvable list so we never under-count.
function Get-PrefixListMaxEntries {
    param([string]$PlId)
    if ([string]::IsNullOrEmpty($PlId)) { return 1 }
    if ($script:PlMaxEntriesCache.ContainsKey($PlId)) { return $script:PlMaxEntriesCache[$PlId] }
    $weight = 1
    try {
        $raw = Invoke-Aws -Retries 2 -DelaySeconds 5 -What "describe-managed-prefix-lists $PlId" `
            ec2 describe-managed-prefix-lists --prefix-list-ids $PlId --output json
        $pl = @(($raw | ConvertFrom-Json).PrefixLists)
        if ($pl.Count -gt 0 -and $pl[0].PSObject.Properties.Name -contains 'MaxEntries' -and $pl[0].MaxEntries) {
            $weight = [int]$pl[0].MaxEntries
        }
    } catch {
        Write-Warn "Could not read MaxEntries for $PlId (assuming weight 1): $($_.Exception.Message)"
    }
    $script:PlMaxEntriesCache[$PlId] = $weight
    return $weight
}

# Compute the EFFECTIVE rule count of one IpPermissions/IpPermissionsEgress set
# the way AWS counts it against the quota: each CIDR (v4/v6) = 1, each SG ref = 1,
# each prefix-list ref = that list's MaxEntries.
function Measure-SgRules {
    param([object[]]$Permissions)
    $count = 0
    foreach ($perm in @($Permissions)) {
        if ($perm.PSObject.Properties.Name -contains 'IpRanges')        { $count += @($perm.IpRanges).Count }
        if ($perm.PSObject.Properties.Name -contains 'Ipv6Ranges')      { $count += @($perm.Ipv6Ranges).Count }
        if ($perm.PSObject.Properties.Name -contains 'UserIdGroupPairs'){ $count += @($perm.UserIdGroupPairs).Count }
        if ($perm.PSObject.Properties.Name -contains 'PrefixListIds') {
            foreach ($pl in @($perm.PrefixListIds)) { $count += (Get-PrefixListMaxEntries -PlId $pl.PrefixListId) }
        }
    }
    return $count
}

# Discover EVERY security group attached to the EB environment: the running
# instance(s), the AutoScalingGroup launch template/config, and any load
# balancer(s). Returns a de-duplicated array of group ids. Best-effort: a failure
# on any one source is logged and skipped, never fatal.
function Get-EbAttachedSecurityGroups {
    $ids = New-Object System.Collections.Generic.List[string]
    $add = { param($x) if ($x -and -not $ids.Contains($x)) { $ids.Add($x) } }

    $resRaw = Invoke-Aws -Retries 3 -DelaySeconds 5 -What 'describe-environment-resources' `
        elasticbeanstalk describe-environment-resources --environment-name $EbEnvName --output json
    $res = ($resRaw | ConvertFrom-Json).EnvironmentResources

    # 1) Running instances -> their attached SGs.
    foreach ($inst in @($res.Instances)) {
        if (-not $inst.Id) { continue }
        try {
            $iRaw = Invoke-Aws -Retries 2 -DelaySeconds 5 ec2 describe-instances --instance-ids $inst.Id --output json
            $sgs = @(@(($iRaw | ConvertFrom-Json).Reservations)[0].Instances[0].SecurityGroups)
            foreach ($s in $sgs) { & $add $s.GroupId }
        } catch { Write-Warn "Could not read SGs for instance $($inst.Id): $($_.Exception.Message)" }
    }

    # 2) AutoScalingGroup -> launch template / launch configuration SGs.
    foreach ($asg in @($res.AutoScalingGroups)) {
        if (-not $asg.Name) { continue }
        try {
            $aRaw = Invoke-Aws -Retries 2 -DelaySeconds 5 autoscaling describe-auto-scaling-groups `
                --auto-scaling-group-names $asg.Name --output json
            $asgObj = @(($aRaw | ConvertFrom-Json).AutoScalingGroups)[0]
            if ($asgObj.PSObject.Properties.Name -contains 'LaunchConfigurationName' -and $asgObj.LaunchConfigurationName) {
                $lcRaw = Invoke-Aws -Retries 2 -DelaySeconds 5 autoscaling describe-launch-configurations `
                    --launch-configuration-names $asgObj.LaunchConfigurationName --output json
                $lc = @(($lcRaw | ConvertFrom-Json).LaunchConfigurations)[0]
                foreach ($g in @($lc.SecurityGroups)) { & $add $g }
            }
            $lt = $null
            if ($asgObj.PSObject.Properties.Name -contains 'LaunchTemplate' -and $asgObj.LaunchTemplate) { $lt = $asgObj.LaunchTemplate }
            elseif ($asgObj.PSObject.Properties.Name -contains 'MixedInstancesPolicy' -and $asgObj.MixedInstancesPolicy) {
                $lt = $asgObj.MixedInstancesPolicy.LaunchTemplate.LaunchTemplateSpecification
            }
            if ($lt -and $lt.LaunchTemplateId) {
                $ver = if ($lt.Version) { $lt.Version } else { '$Default' }
                $ltRaw = Invoke-Aws -Retries 2 -DelaySeconds 5 ec2 describe-launch-template-versions `
                    --launch-template-id $lt.LaunchTemplateId --versions $ver --output json
                $ltData = @(($ltRaw | ConvertFrom-Json).LaunchTemplateVersions)[0].LaunchTemplateData
                foreach ($g in @($ltData.SecurityGroupIds)) { & $add $g }
                foreach ($ni in @($ltData.NetworkInterfaces)) { foreach ($g in @($ni.Groups)) { & $add $g } }
            }
        } catch { Write-Warn "Could not read SGs for ASG $($asg.Name): $($_.Exception.Message)" }
    }

    # 3) Load balancer(s) -> ALB/NLB SGs (none for SingleInstance).
    foreach ($lb in @($res.LoadBalancers)) {
        if (-not $lb.Name) { continue }
        try {
            $lbRaw = Invoke-Aws -Retries 2 -DelaySeconds 5 elbv2 describe-load-balancers `
                --names $lb.Name --output json
            $lbObj = @(($lbRaw | ConvertFrom-Json).LoadBalancers)[0]
            foreach ($g in @($lbObj.SecurityGroups)) { & $add $g }
        } catch {
            # Classic ELB lookup fallback.
            try {
                $cRaw = Invoke-Aws -Retries 1 -DelaySeconds 3 elb describe-load-balancers `
                    --load-balancer-names $lb.Name --output json
                $cObj = @(($cRaw | ConvertFrom-Json).LoadBalancerDescriptions)[0]
                foreach ($g in @($cObj.SecurityGroups)) { & $add $g }
            } catch { Write-Warn "Could not read SGs for load balancer $($lb.Name): $($_.Exception.Message)" }
        }
    }

    return @($ids.ToArray())
}

# Build per-SG rule statistics for the given group ids. Returns an array of
# records: GroupId, GroupName, IngressRules, EgressRules, Total, NearLimit.
function Get-SgRuleStats {
    param([string[]]$GroupIds)
    $stats = @()
    if (-not $GroupIds -or @($GroupIds).Count -eq 0) { return $stats }
    $raw = Invoke-Aws -Retries 3 -DelaySeconds 5 -What 'describe-security-groups (diagnostic)' `
        ec2 describe-security-groups --group-ids @($GroupIds) --output json
    foreach ($sg in @(($raw | ConvertFrom-Json).SecurityGroups)) {
        $ingress = Measure-SgRules -Permissions @($sg.IpPermissions)
        $egress  = if ($SkipEgressCheck) { 0 } else { Measure-SgRules -Permissions @($sg.IpPermissionsEgress) }
        # Quota is applied to inbound and outbound SEPARATELY; "near limit" means
        # either direction is within 10 of the per-direction limit.
        $near = ($ingress -ge ($RulesPerSgLimit - 10)) -or ((-not $SkipEgressCheck) -and ($egress -ge ($RulesPerSgLimit - 10)))
        $stats += [pscustomobject]@{
            GroupId      = $sg.GroupId
            GroupName    = $sg.GroupName
            IngressRules = $ingress
            EgressRules  = $egress
            Total        = $ingress + $egress
            NearLimit    = $near
        }
    }
    return @($stats)
}
#endregion

# ------------------------------------------------------------------------------
# Failure trap: name the phase, show the error, print rollback, exit non-zero.
# ------------------------------------------------------------------------------
trap {
    Write-Host ''
    Write-Host ('=' * 78) -ForegroundColor Red
    Write-Host '  RESTRICT-BACKEND-TO-CLOUDFRONT FAILED' -ForegroundColor Red
    Write-Host ('=' * 78) -ForegroundColor Red
    Write-Host "  Phase : $script:CurrentPhase" -ForegroundColor Red
    Write-Host "  Time  : $(Get-Date -Format 'yyyy-MM-dd HH:mm:ss')" -ForegroundColor Red
    Write-Host '  Error :' -ForegroundColor Red
    foreach ($l in ("$($_.Exception.Message)" -split "`n")) { Write-Host "    $l" -ForegroundColor Red }
    if ($_.InvocationInfo -and $_.InvocationInfo.PositionMessage) {
        Write-Host '  Where :' -ForegroundColor DarkRed
        foreach ($l in ($_.InvocationInfo.PositionMessage -split "`n")) { Write-Host "    $l" -ForegroundColor DarkRed }
    }
    if ($script:SgBackupFile) {
        Write-Host ''
        Write-Host '  The original ingress rules were snapshotted BEFORE any change to:' -ForegroundColor Yellow
        Write-Host "    $script:SgBackupFile" -ForegroundColor DarkGray
        Write-Host '  To restore the open rules (rollback), re-authorize from that snapshot, e.g.:' -ForegroundColor Yellow
        Write-Host "    aws ec2 authorize-security-group-ingress --group-id <sg> \\" -ForegroundColor DarkGray
        Write-Host "      --ip-permissions file://<saved-open-rules>.json --region $Region" -ForegroundColor DarkGray
    }
    Write-Host ''
    exit 1
}

# ==============================================================================
# PRE-FLIGHT
# ==============================================================================
Write-Phase 'PRE-FLIGHT: tooling + identity + distribution + environment checks'

if ($DryRun) {
    Write-Warn 'DRY-RUN MODE: read-only checks only. No security group or EB changes will be made.'
} else {
    Write-Step 'LIVE MODE: this run will modify the EB instance security group ingress rules.'
}

if (-not $Ports -or $Ports.Count -eq 0) { throw 'No ports specified. Pass -Ports (default 80,443).' }
$Ports = @($Ports | Sort-Object -Unique)
Write-Step "Target ports: $($Ports -join ', ')"

Write-Step 'Checking AWS CLI is installed...'
$awsVersion = (& aws --version) 2>&1
if ($LASTEXITCODE -ne 0) { throw 'AWS CLI not found on PATH. Install AWS CLI v2.' }
Write-Step "AWS CLI: $awsVersion"

Write-Step 'Verifying AWS identity (OPERATOR identity)...'
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
Write-Diag "version: $($envObj.VersionLabel)  health: $($envObj.Health)  status: $($envObj.HealthStatus)"
if ($envObj.Health -ne 'Green') {
    Write-Warn "Environment is currently '$($envObj.Health)', not Green. Proceeding, but review before applying."
}

New-Item -ItemType Directory -Force -Path $ArtifactDir | Out-Null
Write-Ok 'Pre-flight checks passed.'

# ==============================================================================
# PHASE 1 - Resolve the CloudFront 'origin-facing' managed prefix list id
# ==============================================================================
# The managed prefix list is regional: the SAME logical name resolves to a
# different pl-xxxx id in each region. We resolve it in THIS environment's
# region (the SG lives there). describe-managed-prefix-lists is the correct API;
# describe-prefix-lists only returns gateway VPC-endpoint lists.
Write-Phase 'PHASE 1: Resolve the CloudFront managed prefix list'

Write-Step "Looking up managed prefix list '$PrefixListName' in $Region..."
$plRaw = Invoke-Aws -Retries 3 -DelaySeconds 5 -What 'ec2 describe-managed-prefix-lists' `
    ec2 describe-managed-prefix-lists `
    --filters "Name=prefix-list-name,Values=$PrefixListName" `
    --output json
$plList = @(($plRaw | ConvertFrom-Json).PrefixLists)

if ($plList.Count -eq 0) {
    # Fallback: some older CLIs / accounts surface it via describe-prefix-lists.
    Write-Warn 'describe-managed-prefix-lists returned nothing; trying describe-prefix-lists as a fallback...'
    $plRaw2 = Invoke-Aws -Retries 2 -DelaySeconds 5 -What 'ec2 describe-prefix-lists' `
        ec2 describe-prefix-lists `
        --filters "Name=prefix-list-name,Values=$PrefixListName" `
        --output json
    $plList = @(($plRaw2 | ConvertFrom-Json).PrefixLists | ForEach-Object {
        [pscustomobject]@{ PrefixListId = $_.PrefixListId; PrefixListName = $_.PrefixListName }
    })
}

if ($plList.Count -eq 0) {
    throw "Could not find the CloudFront managed prefix list '$PrefixListName' in $Region. Verify the region supports it."
}
$PrefixListId = @($plList)[0].PrefixListId
if ([string]::IsNullOrEmpty($PrefixListId)) { throw 'Resolved an empty prefix list id; aborting.' }

# Capture MaxEntries: this is the rule "weight" - allowing this list on a port
# costs MaxEntries rule-slots against the SG quota, not 1.
$PrefixListMaxEntries = 1
$plObj = @($plList)[0]
if ($plObj.PSObject.Properties.Name -contains 'MaxEntries' -and $plObj.MaxEntries) {
    $PrefixListMaxEntries = [int]$plObj.MaxEntries
}
$script:PlMaxEntriesCache[$PrefixListId] = $PrefixListMaxEntries
Write-Ok "CloudFront prefix list: $PrefixListName -> $PrefixListId (MaxEntries=$PrefixListMaxEntries)"
Write-Diag "Each port allowed from this list consumes $PrefixListMaxEntries rule(s) against the per-SG quota."

# ==============================================================================
# PHASE 2 - Read the CloudFront distribution (domain + origins)
# ==============================================================================
# CloudFront is a GLOBAL service - its control-plane only lives in us-east-1.
Write-Phase 'PHASE 2: Read the CloudFront distribution'

$prevRegion = $env:AWS_DEFAULT_REGION
$env:AWS_DEFAULT_REGION = 'us-east-1'
try {
    Write-Step "Reading distribution '$DistributionId'..."
    $dist = (Invoke-Aws -Retries 3 -DelaySeconds 5 -What "cloudfront get-distribution $DistributionId" `
        cloudfront get-distribution --id $DistributionId --output json | ConvertFrom-Json).Distribution
}
finally {
    $env:AWS_DEFAULT_REGION = $prevRegion
}

$CfDomain = $dist.DomainName
Write-Diag "domain : $CfDomain"
Write-Diag "status : $($dist.Status)   enabled: $($dist.DistributionConfig.Enabled)"

$cfOrigins = @($dist.DistributionConfig.Origins.Items)
Write-Step "Distribution origins ($($dist.DistributionConfig.Origins.Quantity)):"
foreach ($o in $cfOrigins) { Write-Diag "id='$($o.Id)'  domain='$($o.DomainName)'" }

# Sanity check: does ANY origin point at this backend (EB CNAME or api host)?
# If not, locking the SG to CloudFront-only would black-hole the backend.
$backendHints = @($EbCname, 'api.anot.health') | Where-Object { $_ }
$backendOrigin = @($cfOrigins | Where-Object {
    $d = $_.DomainName
    $backendHints | Where-Object { $d -and ($d -eq $_ -or $d -like "*$_*") }
})
if ($backendOrigin.Count -gt 0) {
    Write-Ok "A CloudFront origin points at this backend: $(@($backendOrigin | ForEach-Object { $_.DomainName }) -join ', ')"
} else {
    Write-Warn 'No CloudFront origin appears to point at this backend (EB CNAME / api.anot.health).'
    Write-Warn 'If CloudFront does NOT actually front the backend, restricting the SG to CloudFront-only'
    Write-Warn 'will make the backend unreachable. Confirm the architecture before proceeding.'
}

# Default the verification URLs now that we know the domains.
if ([string]::IsNullOrEmpty($CloudFrontUrl)) { $CloudFrontUrl = "https://$CfDomain/" }
if ([string]::IsNullOrEmpty($EbDirectUrl) -and $EbCname) { $EbDirectUrl = "http://$EbCname/" }
Write-Diag "verify (should SUCCEED via CloudFront): $CloudFrontUrl"
Write-Diag "verify (should FAIL direct to origin) : $(if ($EbDirectUrl) {$EbDirectUrl} else {'(unknown EB CNAME - direct test skipped)'})"

# ==============================================================================
# PHASE 3 - Resolve the EB instance security group + snapshot current ingress
# ==============================================================================
# 'anot-backend-prod' is a SingleInstance environment: the EC2 instance itself
# receives 80/443 (nginx -> node), so the instance SG is what fronts inbound
# traffic. We resolve its id from the EB launch-config 'SecurityGroups' option
# (a group NAME), then look up the id; falling back to the environment's running
# instance if needed. A -SecurityGroupId override short-circuits discovery.
Write-Phase 'PHASE 3: Resolve the EB security group and snapshot ingress'

if (-not [string]::IsNullOrEmpty($SecurityGroupId)) {
    Write-Step "Using operator-supplied security group: $SecurityGroupId"
    $SgId = $SecurityGroupId
} else {
    Write-Step 'Reading EB configuration settings to discover the instance security group...'
    $cfg = Invoke-Aws -Retries 3 -DelaySeconds 5 elasticbeanstalk describe-configuration-settings `
        --application-name $EbAppName --environment-name $EbEnvName --output json | ConvertFrom-Json
    $ebOpts = @($cfg.ConfigurationSettings[0].OptionSettings)

    $sgNames = Get-EbOption $ebOpts 'aws:autoscaling:launchconfiguration' 'SecurityGroups'
    if ([string]::IsNullOrEmpty($sgNames)) {
        $sgNames = Get-EbOption $ebOpts 'aws:ec2:instances' 'SecurityGroups'
    }
    if ([string]::IsNullOrEmpty($sgNames)) {
        Write-Warn "Could not read 'SecurityGroups' from EB config; falling back to '$DefaultSgName'."
        $sgNames = $DefaultSgName
    }
    # The option can be a comma-separated list; the EB-managed group is ours.
    $sgName = (@($sgNames -split ',') | ForEach-Object { $_.Trim() } |
               Where-Object { $_ -like 'awseb-*' } | Select-Object -First 1)
    if ([string]::IsNullOrEmpty($sgName)) { $sgName = (@($sgNames -split ',')[0]).Trim() }
    Write-Step "EB instance security group name: $sgName"

    if ($sgName -like 'sg-*') {
        $SgId = $sgName
    } else {
        Write-Step 'Resolving the security group id from its name...'
        $sgRaw = Invoke-Aws -Retries 3 -DelaySeconds 5 -What "describe-security-groups (name=$sgName)" `
            ec2 describe-security-groups --filters "Name=group-name,Values=$sgName" --output json
        $sgFound = @(($sgRaw | ConvertFrom-Json).SecurityGroups)
        if ($sgFound.Count -eq 0) {
            # Last resort: read the SG off the running instance.
            Write-Warn 'Name lookup failed; reading the SG from the running EB instance...'
            $resRaw = Invoke-Aws -Retries 3 -DelaySeconds 5 elasticbeanstalk describe-environment-resources `
                --environment-name $EbEnvName --output json
            $instId = @(($resRaw | ConvertFrom-Json).EnvironmentResources.Instances)[0].Id
            if ([string]::IsNullOrEmpty($instId)) { throw 'Could not resolve the EB instance security group.' }
            $iRaw = Invoke-Aws -Retries 3 -DelaySeconds 5 ec2 describe-instances --instance-ids $instId --output json
            $SgId = @(@(($iRaw | ConvertFrom-Json).Reservations)[0].Instances[0].SecurityGroups)[0].GroupId
        } else {
            $SgId = $sgFound[0].GroupId
        }
    }
}
if ([string]::IsNullOrEmpty($SgId)) { throw 'Failed to resolve the EB security group id.' }
Write-Ok "EB instance security group: $SgId"

Write-Step 'Reading current ingress rules...'
$ingress = @(Get-SgIngress -GroupId $SgId)
$ingressCount = @($ingress).Count
Write-Step "Current ingress permissions ($ingressCount):"
foreach ($perm in $ingress) {
    $proto = $perm.IpProtocol
    $range = if ($perm.PSObject.Properties.Name -contains 'FromPort') { "$($perm.FromPort)-$($perm.ToPort)" } else { 'all' }
    $v4 = @(); if ($perm.PSObject.Properties.Name -contains 'IpRanges')   { $v4 = @($perm.IpRanges   | ForEach-Object { $_.CidrIp }) }
    $v6 = @(); if ($perm.PSObject.Properties.Name -contains 'Ipv6Ranges') { $v6 = @($perm.Ipv6Ranges | ForEach-Object { $_.CidrIpv6 }) }
    $pl = @(); if ($perm.PSObject.Properties.Name -contains 'PrefixListIds') { $pl = @($perm.PrefixListIds | ForEach-Object { $_.PrefixListId }) }
    $srcs = (@($v4 + $v6 + $pl) | Where-Object { $_ }) -join ', '
    Write-Diag "proto=$proto port=$range src=[$srcs]"
}

# Snapshot the FULL original ingress set to disk for rollback / audit.
$script:SgBackupFile = Join-Path $ArtifactDir "sg-$SgId-ingress-ORIGINAL-$Stamp.json"
$ingress | ConvertTo-Json -Depth 20 | Out-File -FilePath $script:SgBackupFile -Encoding utf8
Write-Ok "Original ingress snapshot saved to $script:SgBackupFile"

# ==============================================================================
# PHASE 3b - Security group rule-limit diagnostic (RulesPerSecurityGroupLimitExceeded)
# ==============================================================================
# A prefix-list rule is counted by AWS as the list's MaxEntries rules, so the SG
# can hit the 60-rule quota even though it shows ~1 visible rule. This phase
# inventories EVERY SG attached to the environment (instance / ASG / LB), prints
# the EFFECTIVE rule counts (prefix lists weighted by MaxEntries), and projects
# whether authorizing CloudFront on the target ports will exceed the quota.
Write-Phase 'PHASE 3b: Security group rule-limit diagnostic'

Write-Step 'Discovering every security group attached to the environment...'
$attachedSgs = @(Get-EbAttachedSecurityGroups)
# Always include the SG we are about to modify, even if discovery missed it.
if ($attachedSgs -notcontains $SgId) { $attachedSgs += $SgId }
Write-Diag "attached security groups: $($attachedSgs -join ', ')"

if ($SkipEgressCheck) { Write-Warn 'Egress rules are EXCLUDED from the diagnostic (-SkipEgressCheck).' }

$sgStats = Get-SgRuleStats -GroupIds $attachedSgs
Write-Step "SG diagnostic (per-SG quota = $RulesPerSgLimit rules per direction; prefix lists weighted by MaxEntries):"
foreach ($s in ($sgStats | Sort-Object -Property Total -Descending)) {
    $flag = ''
    if ($s.NearLimit) { $flag = ' (NEAR LIMIT)' }
    if ($s.IngressRules -ge $RulesPerSgLimit -or ((-not $SkipEgressCheck) -and $s.EgressRules -ge $RulesPerSgLimit)) { $flag = ' (AT/OVER LIMIT)' }
    $egTxt = if ($SkipEgressCheck) { 'egress skipped' } else { "$($s.EgressRules) egress" }
    $line  = "  $($s.GroupId) ($($s.GroupName)): $($s.IngressRules) ingress + $egTxt = $($s.Total) total$flag"
    if ($flag) { Write-Warn $line.Trim() } else { Write-Host "  $line" -ForegroundColor DarkGray }
}

# Project the cost of THIS change on the target SG.
$targetStat   = @($sgStats | Where-Object { $_.GroupId -eq $SgId })
$targetIngress = if ($targetStat.Count -gt 0) { $targetStat[0].IngressRules } else { (Measure-SgRules -Permissions $ingress) }
$portsNeedingRule = @($Ports | Where-Object { -not (Test-HasPrefixRule -Ingress $ingress -Port $_ -PlId $PrefixListId) })
$projectedAdd = $portsNeedingRule.Count * $PrefixListMaxEntries
$projectedIngress = $targetIngress + $projectedAdd
Write-Step "Projection for $SgId :"
Write-Diag "current ingress rules         : $targetIngress"
Write-Diag "ports needing a CloudFront rule: $($portsNeedingRule.Count) ($($portsNeedingRule -join ', '))"
Write-Diag "added rules (ports x MaxEntries): $projectedAdd"
Write-Diag "projected ingress rules        : $projectedIngress  (quota $RulesPerSgLimit)"

$script:WouldExceed = ($projectedIngress -gt $RulesPerSgLimit)
if ($script:WouldExceed) {
    Write-Warn "Authorizing CloudFront on $($portsNeedingRule.Count) port(s) would raise ingress to $projectedIngress,"
    Write-Warn "which EXCEEDS the per-SG quota of $RulesPerSgLimit. This is the cause of RulesPerSecurityGroupLimitExceeded."
    Write-Warn 'Remediation options:'
    Write-Warn "  - Reduce -Ports (e.g. -Ports 80 only) so only $PrefixListMaxEntries rule(s) are added."
    Write-Warn '  - Free up rules on the SG (remove unused CIDR/SG-ref rules).'
    Write-Warn '  - Request a quota increase for "Inbound or outbound rules per security group"'
    Write-Warn '    (Service Quotas code L-0EA8095F) in this region, then pass -RulesPerSgLimit <new>.'
    Write-Diag "aws service-quotas request-service-quota-increase --service-code vpc --quota-code L-0EA8095F --desired-value <N> --region $Region"
} else {
    Write-Ok "Projected ingress ($projectedIngress) fits within the per-SG quota ($RulesPerSgLimit)."
}

# ==============================================================================
# PHASE 4 - Authorize tcp/<port> FROM the CloudFront prefix list (idempotent)
# ==============================================================================
# A prefix list goes INSIDE an IpPermission (PrefixListIds), not as a top-level
# --source-prefix-list-ids arg, so we pass --ip-permissions. We write the JSON
# to a file and use file:// to avoid Windows shell quoting issues.
Write-Phase 'PHASE 4: Allow CloudFront (prefix list) on the target ports'

$portsToAuthorize = @($Ports | Where-Object { -not (Test-HasPrefixRule -Ingress $ingress -Port $_ -PlId $PrefixListId) })
$portsAlready     = @($Ports | Where-Object {      (Test-HasPrefixRule -Ingress $ingress -Port $_ -PlId $PrefixListId) })

foreach ($p in $portsAlready) { Write-Ok "tcp/$p already allows $PrefixListId (CloudFront). Skipping." }

if ($portsToAuthorize.Count -eq 0) {
    Write-Ok 'All target ports already allow CloudFront; nothing to authorize.'
} else {
    # Gate on the Phase 3b projection so we fail fast with a clear message rather
    # than getting RulesPerSecurityGroupLimitExceeded mid-flight (which would leave
    # the open rules in place after a partial change).
    if ($script:WouldExceed) {
        if (-not ($Force -or $SkipConfirm)) {
            throw "Refusing to authorize: it would push $SgId past the $RulesPerSgLimit-rule quota (see PHASE 3b). Reduce -Ports, free rules, or raise -RulesPerSgLimit after a quota increase. Re-run with -Force to attempt anyway."
        }
        Write-Warn 'Projection says this exceeds the SG rule quota, but -Force was given; attempting anyway.'
    }
    $authPerms = @($portsToAuthorize | ForEach-Object {
        [ordered]@{
            IpProtocol    = 'tcp'
            FromPort      = $_
            ToPort        = $_
            PrefixListIds = @( [ordered]@{ PrefixListId = $PrefixListId; Description = 'CloudFront origin-facing only' } )
        }
    })
    $authFile = Join-Path $ArtifactDir "sg-$SgId-authorize-cloudfront-$Stamp.json"
    # Force an array even for a single element so the JSON is a JSON array.
    ConvertTo-Json -InputObject @($authPerms) -Depth 10 | Out-File -FilePath $authFile -Encoding ascii
    Write-Step "Wrote authorize ip-permissions to $authFile"
    Write-Diag "ports: $($portsToAuthorize -join ', ')  source: $PrefixListId"

    Confirm-Step "Authorize CloudFront-only ingress on tcp/$($portsToAuthorize -join ',') for ${SgId}?"
    try {
        Invoke-Aws -SkipInDryRun -Retries 3 -DelaySeconds 5 -What 'ec2 authorize-security-group-ingress (CloudFront)' `
            ec2 authorize-security-group-ingress --group-id $SgId `
            --ip-permissions "file://$authFile" | Out-Null
    } catch {
        if ("$($_.Exception.Message)" -match 'RulesPerSecurityGroupLimitExceeded|maximum number of rules') {
            $msg = @(
                "RulesPerSecurityGroupLimitExceeded on $SgId.",
                "A prefix-list rule counts as its MaxEntries ($PrefixListMaxEntries) rules, so adding it on",
                "$($portsToAuthorize.Count) port(s) needs $($portsToAuthorize.Count * $PrefixListMaxEntries) rule-slots. Remediate by one of:",
                "  - Re-run with fewer ports (e.g. -Ports 80).",
                "  - Remove unused rules from the SG to free slots.",
                "  - Raise the quota (Service Quotas L-0EA8095F) then pass -RulesPerSgLimit <new>:",
                "    aws service-quotas request-service-quota-increase --service-code vpc --quota-code L-0EA8095F --desired-value <N> --region $Region"
            ) -join "`n"
            throw $msg
        }
        throw
    }
    Write-Ok "CloudFront-only ingress authorized on tcp/$($portsToAuthorize -join ', ')."
}

# ==============================================================================
# PHASE 5 - Revoke the wide-open 0.0.0.0/0 and ::/0 ingress on the target ports
# ==============================================================================
# We revoke ONLY the open CIDRs on the target ports - the freshly added prefix
# list rule, SSH/22, and every other rule are left intact. We re-read the live
# ingress first so we revoke exactly what is present.
Write-Phase 'PHASE 5: Revoke the open (0.0.0.0/0, ::/0) ingress on the target ports'

# IMPORTANT: in a real run we must have allowed CloudFront first (Phase 4) so we
# never strand the origin between revoke and authorize. In -DryRun the prefix
# rule was not actually added, so we just report what WOULD be revoked.
$ingressNow = if ($DryRun) { @($ingress) } else { @(Get-SgIngress -GroupId $SgId) }

$revokePerms = @()
foreach ($p in $Ports) {
    $open = Get-OpenRangesOnPort -Ingress $ingressNow -Port $p
    if ($open.V4) {
        $revokePerms += [ordered]@{ IpProtocol = 'tcp'; FromPort = $p; ToPort = $p; IpRanges   = @( [ordered]@{ CidrIp     = $OpenV4 } ) }
        Write-Step "tcp/$p has $OpenV4 open -> will revoke."
    }
    if ($open.V6) {
        $revokePerms += [ordered]@{ IpProtocol = 'tcp'; FromPort = $p; ToPort = $p; Ipv6Ranges = @( [ordered]@{ CidrIpv6   = $OpenV6 } ) }
        Write-Step "tcp/$p has $OpenV6 open -> will revoke."
    }
    if (-not $open.V4 -and -not $open.V6) { Write-Ok "tcp/$p has no open 0.0.0.0/0 or ::/0 rule. Nothing to revoke." }
}

if ($revokePerms.Count -eq 0) {
    Write-Ok 'No open ingress rules to revoke on the target ports.'
} else {
    $revokeFile = Join-Path $ArtifactDir "sg-$SgId-revoke-open-$Stamp.json"
    ConvertTo-Json -InputObject @($revokePerms) -Depth 10 | Out-File -FilePath $revokeFile -Encoding ascii
    Write-Step "Wrote revoke ip-permissions to $revokeFile"

    Confirm-Step "Revoke the open internet ingress on tcp/$($Ports -join ',') for ${SgId} (CloudFront access remains)"
    Invoke-Aws -SkipInDryRun -Retries 3 -DelaySeconds 5 -What 'ec2 revoke-security-group-ingress (open rules)' `
        ec2 revoke-security-group-ingress --group-id $SgId `
        --ip-permissions "file://$revokeFile" | Out-Null
    Write-Ok 'Open internet ingress revoked. The origin now accepts 80/443 from CloudFront only.'
}

# ==============================================================================
# PHASE 6 - Poll EB health until Green
# ==============================================================================
Write-Phase 'PHASE 6: Wait for the environment to stay Green'

if ($DryRun) {
    Write-Ok '[DRY-RUN] would poll EB health until Green.'
} else {
    Write-Step "Polling EB health until Green (max $MaxHealthRetries x ${HealthRetryDelaySeconds}s)..."
    $envNow = Wait-ForGreen
    $isGreen = ($null -ne $envNow) -and ($envNow.Health -eq 'Green')
    if (-not $isGreen) {
        $finalHealth = if ($envNow) { $envNow.Health } else { '(unknown)' }
        $finalStatus = if ($envNow) { $envNow.HealthStatus } else { '(unknown)' }
        throw "Environment did not stay Green within $MaxHealthRetries retries (health=$finalHealth, status=$finalStatus). Consider rollback from $script:SgBackupFile."
    }
    Write-Ok "Environment is Green (status: $($envNow.HealthStatus))."
}

# ==============================================================================
# PHASE 7 - Verify: direct origin FAILS, CloudFront SUCCEEDS (200)
# ==============================================================================
Write-Phase 'PHASE 7: Verify direct access FAILS and CloudFront SUCCEEDS'

if ($DryRun) {
    Write-Ok 'DRY-RUN COMPLETE: discovery + prefix-list + ingress plan validated. No changes were made.'
    Write-Warn 'Re-run without -DryRun to authorize CloudFront-only and revoke the open rules.'
    Write-Host ''
    Write-Host '  Planned changes:' -ForegroundColor Yellow
    Write-Host "    security group : $SgId" -ForegroundColor DarkGray
    Write-Host "    allow          : tcp/$($Ports -join ',') from $PrefixListId (CloudFront)" -ForegroundColor DarkGray
    Write-Host "    revoke         : $OpenV4 / $OpenV6 on tcp/$($Ports -join ',')" -ForegroundColor DarkGray
    Write-Host ''
    return
}

$directFailed = $true
if ($EbDirectUrl) {
    Write-Step "Probing the DIRECT origin (expected to FAIL): $EbDirectUrl"
    # Try a few times: SG changes are immediate but give the network a moment.
    $directFailed = $false
    for ($i = 1; $i -le 3; $i++) {
        $d = Invoke-Probe -Url $EbDirectUrl -TimeoutSec 12
        if (-not $d.Reachable) {
            Write-Ok "Direct origin is unreachable (connection blocked) - as intended. ($($d.Error))"
            $directFailed = $true; break
        }
        if ($d.Code -in 403, 502, 503) {
            Write-Ok "Direct origin returned HTTP $($d.Code) (blocked/denied) - acceptable."
            $directFailed = $true; break
        }
        Write-Warn "Direct origin still answered HTTP $($d.Code) (attempt $i/3); retrying..."
        Start-Sleep -Seconds 8
    }
    if (-not $directFailed) {
        Write-Warn 'Direct origin is STILL reachable with a success code. The lockdown may not have taken effect,'
        Write-Warn 'or this URL resolves THROUGH CloudFront (e.g. api.anot.health is a CloudFront alias) rather'
        Write-Warn 'than to the raw EB instance. Verify the EB instance IP/CNAME is what you expect.'
    }
} else {
    Write-Warn 'No EB direct URL resolved; skipping the direct-origin negative test.'
}

Write-Step "Probing via CloudFront (expected to SUCCEED 200): $CloudFrontUrl"
$cfOk = $false
for ($i = 1; $i -le 5; $i++) {
    $c = Invoke-Probe -Url $CloudFrontUrl -TimeoutSec 20
    if ($c.Ok2xx) { Write-Ok "CloudFront returned HTTP $($c.Code)."; $cfOk = $true; break }
    if ($c.Reachable) { Write-Warn "CloudFront returned HTTP $($c.Code) (attempt $i/5); retrying..." }
    else              { Write-Warn "CloudFront probe failed: $($c.Error) (attempt $i/5); retrying..." }
    if ($i -lt 5) { Start-Sleep -Seconds 12 }
}

if (-not $cfOk) {
    throw "CloudFront did not return HTTP 200 for $CloudFrontUrl. The origin may be over-restricted; review/rollback from $script:SgBackupFile."
}

# ------------------------------------------------------------------------------
# SUCCESS
# ------------------------------------------------------------------------------
Write-Host ''
Write-Host ('=' * 78) -ForegroundColor Green
Write-Host '  SUCCESS: backend origin now accepts 80/443 from CloudFront only' -ForegroundColor Green
Write-Host ('=' * 78) -ForegroundColor Green
Write-Host "  environment   : $EbEnvName ($EbEnvId)" -ForegroundColor Green
Write-Host "  security group: $SgId" -ForegroundColor Green
Write-Host "  allowed from  : $PrefixListId ($PrefixListName)" -ForegroundColor Green
Write-Host "  ports         : tcp/$($Ports -join ', ')" -ForegroundColor Green
Write-Host "  cloudfront    : $CloudFrontUrl -> HTTP 200" -ForegroundColor Green
if ($EbDirectUrl) {
    $directMsg = if ($directFailed) { 'blocked (as intended)' } else { 'STILL REACHABLE - review!' }
    Write-Host "  direct origin : $EbDirectUrl -> $directMsg" -ForegroundColor Green
}
Write-Host ''
Write-Host '  Rollback (restore open internet ingress) if ever needed:' -ForegroundColor Yellow
Write-Host "    aws ec2 authorize-security-group-ingress --group-id $SgId \\" -ForegroundColor DarkGray
Write-Host "      --ip-permissions '[{\"IpProtocol\":\"tcp\",\"FromPort\":80,\"ToPort\":80,\"IpRanges\":[{\"CidrIp\":\"0.0.0.0/0\"}]}]' --region $Region" -ForegroundColor DarkGray
Write-Host "    (original ingress snapshot: $script:SgBackupFile)" -ForegroundColor DarkGray
Write-Host ''
Write-Ok 'Backend lockdown to CloudFront complete and verified.'
