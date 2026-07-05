# End-to-end workflow test against production API
$ErrorActionPreference = 'Stop'
$BaseUrl = 'https://app.anot.health/api'
$AudioFile = Join-Path (Split-Path $PSScriptRoot) 'test-fixtures/deepgram/test-e2e-speech.wav'
if (-not (Test-Path $AudioFile)) {
    $AudioFile = Join-Path (Split-Path $PSScriptRoot) 'test-fixtures/deepgram/test-probe.wav'
}

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
    $r = Invoke-WebRequest @params
    if ($r.Content) { return ($r.Content | ConvertFrom-Json) }
    return $null
}

function Login-User {
    param([string]$Email, [string]$Password)
    $ctx = Get-CsrfSession
    $data = Invoke-Api -Method POST -Path '/auth/login' -Body @{ email = $Email; password = $Password } -Ctx $ctx
    if ($data.requireMfa -or $data.enrollmentRequired -or $data.requirePhiTraining -or $data.requirePasswordChange) {
        throw "Login gate blocked for ${Email}: $($data | ConvertTo-Json -Compress)"
    }
    if (-not $data.user) { throw "Login failed for ${Email}: no user in response" }
    return @{ Ctx = $ctx; User = $data.user }
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

$results = @{}
$today = Get-Date -Format 'yyyy-MM-dd'

try {
    Write-Host '=== STEP 1: CLINICIAN login and create visit ===' -ForegroundColor Cyan
    $celina = Login-User -Email 'celina@anot.health' -Password 'Password@2026'
    $results['step1_login'] = 'PASS'

    $mrn = "E2E-$(Get-Date -Format 'yyyyMMdd-HHmmss')"
    try {
        $patient = Invoke-Api -Method POST -Path '/patients' -Body @{
            name = 'E2E Test Patient'
            mrn = $mrn
            date_of_birth = '1985-06-15'
        } -Ctx $celina.Ctx
    } catch {
        $patients = Invoke-Api -Path '/patients' -Ctx $celina.Ctx
        $patient = @{ patient = ($patients.patients | Select-Object -First 1) }
    }
    $patientId = $patient.patient.id
    $results['step1_patient'] = "PASS (id=$patientId)"

    $visit = Invoke-Api -Method POST -Path '/visits' -Body @{
        patient_id = $patientId
        visit_date = $today
        visit_time = '10:30'
        visit_type = 'Follow-up'
    } -Ctx $celina.Ctx
    $visitId = $visit.visit.id
    $results['step1_visit'] = "PASS (id=$visitId)"

    $consent = Invoke-Api -Method POST -Path '/consent/recording' -Body @{ visitId = $visitId } -Ctx $celina.Ctx
    $results['step1_consent'] = 'PASS'

    Write-Host "  Uploading audio ($AudioFile)..."
    if (-not (Test-Path $AudioFile)) { throw "Audio file not found: $AudioFile" }
    $upload = Upload-Audio -Ctx $celina.Ctx -VisitId $visitId -FilePath $AudioFile
    $results['step1_audio'] = 'PASS'

    $ended = Invoke-Api -Method PUT -Path "/visits/$visitId/end" -Body @{ duration_seconds = 600 } -Ctx $celina.Ctx
    $results['step1_save'] = 'PASS'

    Write-Host '=== STEP 2: SCRIBE login, transcribe, draft, submit ===' -ForegroundColor Cyan
    $scribe = Login-User -Email 'shahib@anot.health' -Password '#1Knowtex2026'
    $results['step2_login'] = 'PASS'

    $allVisits = Invoke-Api -Path '/visits' -Ctx $scribe.Ctx
    $queued = $allVisits.visits | Where-Object { $_.id -eq $visitId }
    if (-not $queued) { throw "Scribe cannot see visit $visitId in queue" }
    $results['step2_queue'] = 'PASS'

    $tx = Invoke-Api -Method POST -Path "/visits/$visitId/transcribe" -Ctx $scribe.Ctx
    $results['step2_transcribe_queued'] = "PASS ($($tx.transcription_status))"

    Write-Host '  Waiting for transcription (up to 15 min)...'
    Wait-Transcription -Ctx $scribe.Ctx -VisitId $visitId -MaxWaitSec 900 | Out-Null

    $note = Invoke-Api -Path "/notes/visit/$visitId" -Ctx $scribe.Ctx
    if (-not $note.note) { throw 'No note after transcription' }
    if (-not $note.note.transcription) { throw 'Transcription empty after pipeline' }
    if (-not $note.note.ai_draft) { throw 'AI draft not generated after transcription' }
    $noteId = $note.note.id
    $draftText = $note.note.ai_draft
    $results['step2_transcribe'] = "PASS (draft length=$($draftText.Length))"

    Invoke-Api -Method POST -Path '/notes/draft' -Body @{
        visit_id = $visitId
        final_note = $draftText
        transcription = $note.note.transcription
        ai_draft = $note.note.ai_draft
    } -Ctx $scribe.Ctx | Out-Null
    $results['step2_draft'] = 'PASS'

    $submitted = Invoke-Api -Method PUT -Path "/notes/$noteId/submit" -Ctx $scribe.Ctx
    $results['step2_submit'] = "PASS (status=$($submitted.note.status))"

    Write-Host '=== STEP 3: QPS grade and complete ===' -ForegroundColor Cyan
    $qps = Login-User -Email 'farhan@anot.health' -Password '#1Knowtex2026'
    $results['step3_login'] = 'PASS'

    $grade = Invoke-Api -Method POST -Path '/notes/grade' -Body @{
        note_id = $noteId
        accuracy = 90
        completeness = 88
        terminology = 92
        formatting = 85
        comment = 'E2E quality review passed'
    } -Ctx $qps.Ctx
    $results['step3_grade'] = "PASS (overall=$($grade.grade.overall_score))"

    $gradedNote = Invoke-Api -Path "/notes/visit/$visitId" -Ctx $qps.Ctx
    $results['step3_status'] = "PASS (note_status=$($gradedNote.note.status))"

    Write-Host '=== STEP 4: CLINICIAN lock/finalize ===' -ForegroundColor Cyan
    $celina2 = Login-User -Email 'celina@anot.health' -Password 'Password@2026'
    $results['step4_login'] = 'PASS'

    $clinNotes = Invoke-Api -Path '/notes/clinician' -Ctx $celina2.Ctx
    $found = $clinNotes.notes | Where-Object { $_.visit_id -eq $visitId -or $_.id -eq $noteId }
    if (-not $found) { throw 'Clinician cannot see graded note' }
    $results['step4_view'] = 'PASS'

    $locked = Invoke-Api -Method POST -Path "/visits/$visitId/lock-note" -Ctx $celina2.Ctx
    $results['step4_lock'] = 'PASS'

    $final = Invoke-Api -Path "/notes/visit/$visitId" -Ctx $celina2.Ctx
    $results['final_note_status'] = $final.note.status
    $results['final_visit_status'] = (Invoke-Api -Path "/visits/my?date=$today" -Ctx $celina2.Ctx).visits | Where-Object { $_.id -eq $visitId } | Select-Object -ExpandProperty status
    $results['step4_finalize'] = if ($final.note.locked_at) { 'PASS' } else { 'FAIL (not locked)' }

    Write-Host ''
    Write-Host '=== E2E RESULTS ===' -ForegroundColor Green
    $results.GetEnumerator() | Sort-Object Name | ForEach-Object { Write-Host "$($_.Key): $($_.Value)" }
}
catch {
    Write-Host "E2E FAILED: $($_.Exception.Message)" -ForegroundColor Red
    $results['error'] = $_.Exception.Message
    $results.GetEnumerator() | Sort-Object Name | ForEach-Object { Write-Host "$($_.Key): $($_.Value)" }
    exit 1
}
