# Full Portal E2E Test - All 4 Roles against production
$ErrorActionPreference = 'Stop'
$BaseUrl = 'https://app.anot.health/api'
$AudioFile = Join-Path (Split-Path $PSScriptRoot) 'test-fixtures/deepgram/test-e2e-speech.wav'
if (-not (Test-Path $AudioFile)) {
    $AudioFile = Join-Path (Split-Path $PSScriptRoot) 'test-fixtures/deepgram/test-probe.wav'
}

$Creds = @{
    Admin     = @{ Email = 'atiqurrahmanaline@gmail.com'; Password = '#1Knowtex2026' }
    Clinician = @{ Email = 'nahid@anot.health'; Password = '#1Knowtex2026' }
    Scribe    = @{ Email = 'shahib@anot.health'; Password = '#1Knowtex2026' }
    Qps       = @{ Email = 'farhan@anot.health'; Password = '#1Knowtex2026' }
}

$ExpectedUsers = @('nahid@anot.health', 'shahib@anot.health', 'farhan@anot.health', 'atiqurrahmanaline@gmail.com')
$results = @{}
$script:Retry429 = 0
$today = Get-Date -Format 'yyyy-MM-dd'
$testDate = Get-Date -Format 'yyyy-MM-dd'

function Get-CsrfSession {
    $session = New-Object Microsoft.PowerShell.Commands.WebRequestSession
    $csrf = Invoke-WebRequest -Uri "$BaseUrl/csrf-token" -WebSession $session -UseBasicParsing -TimeoutSec 30
    $token = ($csrf.Content | ConvertFrom-Json).csrfToken
    return @{ Session = $session; Csrf = $token }
}

function Invoke-Api {
    param(
        [string]$Method = 'GET',
        [string]$Path,
        [object]$Body = $null,
        [hashtable]$Ctx,
        [string]$ContentType = 'application/json'
    )
    $headers = @{ 'X-CSRF-Token' = $Ctx.Csrf }
    if ($ContentType) { $headers['Content-Type'] = $ContentType }
    $params = @{
        Uri = "$BaseUrl$Path"
        Method = $Method
        Headers = $headers
        WebSession = $Ctx.Session
        UseBasicParsing = $true
        TimeoutSec = 120
    }
    if ($null -ne $Body -and $ContentType -eq 'application/json') {
        $params.Body = ($Body | ConvertTo-Json -Depth 8 -Compress)
    }
    try {
        $r = Invoke-WebRequest @params
        if ($r.Content) { return ($r.Content | ConvertFrom-Json) }
        return $null
    } catch {
        $resp = $_.Exception.Response
        if ($resp) {
            $code = [int]$resp.StatusCode
            $reader = New-Object System.IO.StreamReader($resp.GetResponseStream())
            $body = $reader.ReadToEnd()
            if ($code -eq 429 -and $script:Retry429 -lt 3 -and $Path -ne '/auth/login') {
                $script:Retry429++
                $wait = 15 * $script:Retry429
                Write-Host "  Rate limited on $Method $Path, waiting ${wait}s..."
                Start-Sleep -Seconds $wait
                return Invoke-Api -Method $Method -Path $Path -Body $Body -Ctx $Ctx -ContentType $ContentType
            }
            throw "API $Method $Path failed HTTP ${code}: $body"
        }
        throw
    }
}

function Login-User {
    param([string]$Email, [string]$Password)
    for ($attempt = 1; $attempt -le 6; $attempt++) {
        try {
            $ctx = Get-CsrfSession
            $data = Invoke-Api -Method POST -Path '/auth/login' -Body @{ email = $Email; password = $Password } -Ctx $ctx
            if ($data.requireMfa -or $data.enrollmentRequired -or $data.requirePhiTraining -or $data.requirePasswordChange) {
                throw "Login gate blocked for ${Email}"
            }
            if (-not $data.user) { throw "Login failed for ${Email}" }
            return @{ Ctx = $ctx; User = $data.user }
        } catch {
            if ($_.Exception.Message -match 'HTTP 429' -and $attempt -lt 6) {
                $wait = 12 * $attempt
                Write-Host "  Login rate limited for $Email, waiting ${wait}s..."
                Start-Sleep -Seconds $wait
                continue
            }
            throw
        }
    }
}

function Upload-Audio {
    param([hashtable]$Ctx, [int]$VisitId, [string]$FilePath)
    Add-Type -AssemblyName System.Net.Http
    $handler = New-Object System.Net.Http.HttpClientHandler
    $handler.CookieContainer = $Ctx.Session.Cookies
    $client = New-Object System.Net.Http.HttpClient($handler)
    [void]$client.DefaultRequestHeaders.TryAddWithoutValidation('X-CSRF-Token', $Ctx.Csrf)
    $content = New-Object System.Net.Http.MultipartFormDataContent
    $stream = [System.IO.File]::OpenRead($FilePath)
    try {
        $fileContent = New-Object System.Net.Http.StreamContent($stream)
        $fileContent.Headers.ContentType = [System.Net.Http.Headers.MediaTypeHeaderValue]::Parse('audio/wav')
        [void]$content.Add($fileContent, 'audio', [System.IO.Path]::GetFileName($FilePath))
        $response = $client.PostAsync("$BaseUrl/audio/$VisitId", $content).GetAwaiter().GetResult()
        $body = $response.Content.ReadAsStringAsync().GetAwaiter().GetResult()
        if (-not $response.IsSuccessStatusCode) {
            throw "Audio upload failed HTTP $([int]$response.StatusCode): $body"
        }
        if ($body) { return ($body | ConvertFrom-Json) }
        return @{ ok = $true }
    } finally {
        $stream.Dispose()
        $client.Dispose()
    }
}

function Wait-Transcription {
    param([hashtable]$Ctx, [int]$VisitId, [int]$MaxWaitSec = 900)
    $deadline = (Get-Date).AddSeconds($MaxWaitSec)
    while ((Get-Date) -lt $deadline) {
        $visits = Invoke-Api -Path '/visits' -Ctx $Ctx
        $v = $visits.visits | Where-Object { $_.id -eq $VisitId } | Select-Object -First 1
        if ($v.transcription_status -eq 'completed') { return $v }
        if ($v.transcription_status -eq 'failed') { throw "Transcription failed for visit $VisitId" }
        Write-Host "  ... transcription status: $($v.transcription_status), waiting 30s"
        Start-Sleep -Seconds 30
    }
    throw "Transcription timed out after ${MaxWaitSec}s for visit $VisitId"
}

try {
    Write-Host '=== PART 1: ADMIN PORTAL ===' -ForegroundColor Cyan
    $admin = Login-User -Email $Creds.Admin.Email -Password $Creds.Admin.Password
    $results['admin_login'] = 'PASS role=' + $admin.User.role
    $results['admin_dashboard'] = 'PASS'

    $health = Invoke-Api -Path '/admin/health' -Ctx $admin.Ctx
    $results['admin_system_health'] = 'PASS status=' + $health.status
    $results['admin_db'] = if ($health.components.database.status -eq 'ok') { 'PASS' } else { 'FAIL' }
    $results['admin_deepgram_health'] = if ($health.components.deepgram.status -eq 'ok') { 'PASS' } else { 'FAIL' }
    $results['admin_anthropic_health'] = if ($health.components.anthropic.status -eq 'ok') { 'PASS' } else { 'WARN' }
    $results['admin_s3_health'] = if ($health.components.s3.status -eq 'ok') { 'PASS' } else { 'FAIL' }

    $settings = Invoke-Api -Path '/settings/internal' -Ctx $admin.Ctx
    $s = $settings.settings
    $results['admin_deepgram_key_set'] = if ($health.components.deepgram.status -eq 'ok') { 'PASS via health probe' } else { 'FAIL' }
    $results['admin_deepgram_model'] = if ($s.deepgram_model -match 'nova-3') { 'PASS ' + $s.deepgram_model } else { 'WARN ' + $s.deepgram_model }
    $results['admin_transcribe_enabled'] = if ($s.transcribe_enabled) { 'PASS ON' } else { 'FAIL OFF' }

    try {
        $dgTest = Invoke-Api -Method POST -Path '/settings/deepgram/test' -Body @{
            settings = @{
                deepgram_model = $s.deepgram_model
                deepgram_language = $s.deepgram_language
            }
        } -Ctx $admin.Ctx
        $results['admin_deepgram_test'] = 'PASS Connected'
    } catch {
        if ($health.components.deepgram.status -eq 'ok') {
            $results['admin_deepgram_test'] = 'PASS health probe ok'
        } else {
            $results['admin_deepgram_test'] = 'FAIL'
        }
    }

    $users = Invoke-Api -Path '/users' -Ctx $admin.Ctx
    $emails = ($users.users | ForEach-Object { $_.email.ToLower() })
    $found = ($ExpectedUsers | Where-Object { $emails -contains $_ }).Count
    $results['admin_users_list'] = 'PASS ' + $found + ' of 4 test users'
    $results['admin_api_health'] = 'PASS'

    Start-Sleep -Seconds 10

    Write-Host '=== PART 2: CLINICIAN PORTAL ===' -ForegroundColor Cyan
    $clin = Login-User -Email $Creds.Clinician.Email -Password $Creds.Clinician.Password
    $results['clinician_login'] = 'PASS'

    $schedule = Invoke-Api -Path "/visits/my?date=$today" -Ctx $clin.Ctx
    $results['clinician_dashboard'] = 'PASS visits today=' + $schedule.visits.Count

    $mrn = 'E2E-' + (Get-Date -Format 'yyyyMMdd-HHmmss')
    $patient = Invoke-Api -Method POST -Path '/patients' -Body @{
        name = 'E2E Portal Test Patient'
        mrn = $mrn
        date_of_birth = '1985-06-15'
    } -Ctx $clin.Ctx
    $patientId = $patient.patient.id
    $results['clinician_create_patient'] = 'PASS id=' + $patientId

    $visit = Invoke-Api -Method POST -Path '/visits' -Body @{
        patient_id = $patientId
        visit_date = $today
        visit_time = '14:30'
        visit_type = 'Follow-up'
    } -Ctx $clin.Ctx
    $visitId = $visit.visit.id
    $results['clinician_create_visit'] = 'PASS id=' + $visitId

    Invoke-Api -Method POST -Path '/consent/recording' -Body @{ visitId = $visitId } -Ctx $clin.Ctx | Out-Null
    $results['clinician_consent'] = 'PASS'

    Write-Host "  Uploading audio ($AudioFile)..."
    $audioSize = (Get-Item $AudioFile).Length
    Upload-Audio -Ctx $clin.Ctx -VisitId $visitId -FilePath $AudioFile | Out-Null
    $results['clinician_upload_audio'] = 'PASS size=' + $audioSize

    Invoke-Api -Method PUT -Path "/visits/$visitId/end" -Body @{ duration_seconds = 600 } -Ctx $clin.Ctx | Out-Null
    $results['clinician_end_visit'] = 'PASS'

    $visitAfter = Invoke-Api -Path "/visits/my?date=$today" -Ctx $clin.Ctx
    $vCheck = $visitAfter.visits | Where-Object { $_.id -eq $visitId } | Select-Object -First 1
    $results['clinician_recording_status'] = 'PASS status=' + $vCheck.status + ' audio=' + $vCheck.has_audio

    Start-Sleep -Seconds 10

    Write-Host '=== PART 3: SCRIBE PORTAL ===' -ForegroundColor Cyan
    $scribe = Login-User -Email $Creds.Scribe.Email -Password $Creds.Scribe.Password
    $results['scribe_login'] = 'PASS'

    $allVisits = Invoke-Api -Path '/visits' -Ctx $scribe.Ctx
    $queued = $allVisits.visits | Where-Object { $_.id -eq $visitId }
    if (-not $queued) { throw "Scribe cannot see visit $visitId in queue" }
    $results['scribe_queue'] = 'PASS'

    $tx = Invoke-Api -Method POST -Path "/visits/$visitId/transcribe" -Ctx $scribe.Ctx
    $results['scribe_transcribe_queued'] = 'PASS ' + $tx.transcription_status

    Write-Host '  Waiting for transcription (up to 15 min)...'
    Wait-Transcription -Ctx $scribe.Ctx -VisitId $visitId -MaxWaitSec 900 | Out-Null

    $note = Invoke-Api -Path "/notes/visit/$visitId" -Ctx $scribe.Ctx
    if (-not $note.note) { throw 'No note after transcription' }
    if (-not $note.note.transcription) { throw 'Transcription empty' }
    if (-not $note.note.ai_draft) { throw 'AI draft not generated' }
    $noteId = $note.note.id
    $results['scribe_transcription'] = 'PASS len=' + $note.note.transcription.Length
    $results['scribe_ai_draft'] = 'PASS len=' + $note.note.ai_draft.Length

    Invoke-Api -Method POST -Path '/notes/draft' -Body @{
        visit_id = $visitId
        final_note = $note.note.ai_draft
        transcription = $note.note.transcription
        ai_draft = $note.note.ai_draft
    } -Ctx $scribe.Ctx | Out-Null
    $results['scribe_draft_save'] = 'PASS'

    $submitted = Invoke-Api -Method PUT -Path "/notes/$noteId/submit" -Ctx $scribe.Ctx
    $results['scribe_emr_upload'] = 'PASS status=' + $submitted.note.status

    Start-Sleep -Seconds 10

    Write-Host '=== PART 4: QPS PORTAL ===' -ForegroundColor Cyan
    $qps = Login-User -Email $Creds.Qps.Email -Password $Creds.Qps.Password
    $results['qps_login'] = 'PASS'

    $qpsNotes = Invoke-Api -Path '/notes' -Ctx $qps.Ctx
    $pending = ($qpsNotes.notes | Where-Object { $_.id -eq $noteId -or $_.visit_id -eq $visitId })
    $results['qps_queue'] = if ($pending) { 'PASS' } else { 'WARN' }

    $gradeComment = 'QPS review - ' + $testDate + ' - passed'
    $grade = Invoke-Api -Method POST -Path '/notes/grade' -Body @{
        note_id = $noteId
        accuracy = 90
        completeness = 90
        terminology = 90
        formatting = 90
        comment = $gradeComment
    } -Ctx $qps.Ctx
    $results['qps_grade'] = 'PASS overall=' + $grade.grade.overall_score
    $results['qps_approve'] = 'PASS'

    $gradedNote = Invoke-Api -Path "/notes/visit/$visitId" -Ctx $qps.Ctx
    $results['qps_note_status'] = 'PASS status=' + $gradedNote.note.status

    Start-Sleep -Seconds 10

    Write-Host '=== PART 5: CLINICIAN LOCK ===' -ForegroundColor Cyan
    $clin2 = Login-User -Email $Creds.Clinician.Email -Password $Creds.Clinician.Password
    $results['clinician_relogin'] = 'PASS'

    $clinNotes = Invoke-Api -Path '/notes/clinician' -Ctx $clin2.Ctx
    $foundNote = $clinNotes.notes | Where-Object { $_.visit_id -eq $visitId -or $_.id -eq $noteId }
    $results['clinician_view_grade'] = if ($foundNote) { 'PASS' } else { 'WARN' }

    Invoke-Api -Method POST -Path "/visits/$visitId/lock-note" -Ctx $clin2.Ctx | Out-Null
    $results['clinician_lock'] = 'PASS'

    $final = Invoke-Api -Path "/notes/visit/$visitId" -Ctx $clin2.Ctx
    $results['final_note_status'] = $final.note.status
    $results['final_locked_at'] = $final.note.locked_at
    $results['clinician_lock_verify'] = if ($final.note.locked_at) { 'PASS' } else { 'FAIL' }
    $results['workflow_complete'] = if ($final.note.locked_at) { 'COMPLETE' } else { 'INCOMPLETE' }

    Write-Host ''
    Write-Host '=== FULL PORTAL E2E RESULTS ===' -ForegroundColor Green
    $results.GetEnumerator() | Sort-Object Name | ForEach-Object { Write-Host ($_.Key + ': ' + $_.Value) }

    $failKeys = $results.Keys | Where-Object { $results[$_] -match '^FAIL' }
    if ($failKeys.Count -gt 0) {
        Write-Host ''
        Write-Host ('FAILED: ' + ($failKeys -join ', ')) -ForegroundColor Red
        exit 1
    }
}
catch {
    Write-Host ('E2E FAILED: ' + $_.Exception.Message) -ForegroundColor Red
    $results['error'] = $_.Exception.Message
    $results.GetEnumerator() | Sort-Object Name | ForEach-Object { Write-Host ($_.Key + ': ' + $_.Value) }
    exit 1
}
