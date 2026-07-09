# Generate e2e-final-recording-1.wav and e2e-final-recording-2.wav (10+ min each)
# Uses Windows SAPI for doctor-patient dialogue, then Node to loop to target duration.
$ErrorActionPreference = 'Stop'
$ScriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$OutDir = Join-Path (Split-Path $ScriptDir) 'test-fixtures\final-e2e'
$DurationSec = 660  # 11 minutes minimum
New-Item -ItemType Directory -Force -Path $OutDir | Out-Null

Add-Type -AssemblyName System.Speech
$synth = New-Object System.Speech.Synthesis.SpeechSynthesizer
$synth.Rate = 0

$Conversations = @(
    @{
        Name = 'e2e-final-recording-1-source.wav'
        Text = @"
Doctor: Good morning. I am Doctor Martinez. What brings you in today?
Patient: Good morning doctor. I have chest pain and shortness of breath.
Doctor: When did the chest pain start?
Patient: It started about two days ago. It gets worse when I walk upstairs.
Doctor: Can you describe the pain? Is it sharp, dull, or pressure-like?
Patient: It feels like pressure in the center of my chest, and I feel short of breath.
Doctor: Do you have any medical history we should know about?
Patient: Yes, I have hypertension and type two diabetes.
Doctor: What medications are you currently taking?
Patient: I take lisinopril ten milligrams daily, metformin five hundred milligrams twice daily, and aspirin eighty one milligrams.
Doctor: Any allergies to medications?
Patient: No known drug allergies.
Doctor: Let me check your vital signs. Blood pressure one forty over ninety, heart rate ninety two, respiratory rate twenty two, oxygen saturation ninety four percent on room air, temperature ninety eight point six.
Doctor: On cardiac exam I hear regular rate and rhythm, no murmurs. Lungs have faint crackles at the bases bilaterally.
Doctor: My assessment is possible unstable angina given chest pain and shortness of breath with cardiac risk factors including hypertension and diabetes.
Doctor: Plan: order electrocardiogram, cardiac enzymes including troponin, chest x-ray, start aspirin and nitroglycerin as needed, admit for observation and cardiology consult.
Patient: Thank you doctor. I am worried but I understand.
Doctor: We will monitor you closely and get those tests done right away.
"@
    },
    @{
        Name = 'e2e-final-recording-2-source.wav'
        Text = @"
Doctor: Hello, I am Doctor Patel. How have you been since we last spoke?
Patient: Not great doctor. I have a persistent cough and fever.
Doctor: How long have you had these symptoms?
Patient: About five days now. The cough is getting worse and I had a fever of one hundred and two last night.
Doctor: Any sputum production? Color?
Patient: Yes, yellowish sputum, especially in the morning.
Doctor: Tell me about your medical history.
Patient: I have asthma and seasonal allergies. I use an albuterol inhaler as needed.
Doctor: Current medications?
Patient: Albuterol inhaler, fluticasone nasal spray, and cetirizine for allergies.
Doctor: Vital signs today: temperature one hundred and one point four, blood pressure one twenty two over seventy eight, heart rate eighty eight, respiratory rate twenty four, oxygen saturation ninety six percent.
Doctor: Lung exam reveals decreased breath sounds at the right lower lobe with crackles and dullness to percussion.
Doctor: Assessment: clinical picture consistent with possible community acquired pneumonia. Differential includes viral bronchitis but fever and focal findings suggest bacterial pneumonia.
Doctor: Plan: order chest x-ray, complete blood count, basic metabolic panel, start empiric antibiotics azithromycin, continue bronchodilator, follow up in forty eight to seventy two hours or sooner if worsening.
Patient: Should I be concerned about the fever?
Doctor: We will treat the infection and monitor your symptoms. Return immediately if breathing gets worse or fever persists beyond forty eight hours.
"@
    }
)

foreach ($conv in $Conversations) {
    $sourcePath = Join-Path $OutDir $conv.Name
    Write-Host "Generating speech: $($conv.Name)" -ForegroundColor Cyan
    $synth.SetOutputToWaveFile($sourcePath)
    $synth.Speak($conv.Text)
    $synth.SetOutputToDefaultAudioDevice()
    $info = Get-Item $sourcePath
    Write-Host "  Source duration file: $([math]::Round($info.Length / 1MB, 2)) MB"
}

# Loop each source to 11+ minutes via Node
$nodeScript = Join-Path $ScriptDir 'generate-load-test-audio.js'
foreach ($i in 1..2) {
    $source = Join-Path $OutDir "e2e-final-recording-$i-source.wav"
    $target = Join-Path $OutDir "e2e-final-recording-$i.wav"
    Write-Host "Looping to ${DurationSec}s: e2e-final-recording-$i.wav" -ForegroundColor Cyan

    # Inline loop using node one-liner from generate-load-test-audio logic
    node -e @"
const fs=require('fs');const path=require('path');
function readWavPcm(filePath){const buf=fs.readFileSync(filePath);let offset=12,fmt=null,dataOffset=null,dataSize=0;while(offset+8<=buf.length){const id=buf.toString('ascii',offset,offset+4);const size=buf.readUInt32LE(offset+4);const chunkStart=offset+8;if(id==='fmt ')fmt=buf.subarray(chunkStart,chunkStart+size);if(id==='data'){dataOffset=chunkStart;dataSize=size;break}offset=chunkStart+size+(size%2)}const numChannels=fmt.readUInt16LE(2);const sampleRate=fmt.readUInt32LE(4);const bitsPerSample=fmt.readUInt16LE(14);const pcm=buf.subarray(dataOffset,dataOffset+dataSize);return{fmt,pcm,sampleRate,numChannels,bitsPerSample}}
function writeWav(outPath,fmt,pcm){const dataSize=pcm.length;const buffer=Buffer.alloc(44+dataSize);buffer.write('RIFF',0);buffer.writeUInt32LE(36+dataSize,4);buffer.write('WAVE',8);buffer.write('fmt ',12);buffer.writeUInt32LE(16,16);fmt.copy(buffer,20);buffer.write('data',36);buffer.writeUInt32LE(dataSize,40);pcm.copy(buffer,44);fs.writeFileSync(outPath,buffer)}
const src='$($source -replace '\\','/')';const out='$($target -replace '\\','/')';const dur=$DurationSec;
const{fmt,pcm,sampleRate,numChannels,bitsPerSample}=readWavPcm(src);
const bps=sampleRate*numChannels*(bitsPerSample/8);const targetBytes=Math.ceil(dur*bps);
const loops=Math.ceil(targetBytes/pcm.length);let combined=Buffer.concat(Array(loops).fill(pcm));
if(combined.length>targetBytes)combined=combined.subarray(0,targetBytes);
writeWav(out,fmt,combined);
const sec=Math.round(combined.length/bps);
console.log('  Written '+out+' (~'+sec+'s, '+(fs.statSync(out).size/1024/1024).toFixed(2)+' MB)');
"@
}

Write-Host "Done. Output directory: $OutDir" -ForegroundColor Green
