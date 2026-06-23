<#
.SYNOPSIS
  Fix for ISSUE-003: Insufficient Input Validation on File Uploads

.DESCRIPTION
  Severity: CRITICAL
  Component: Backend - Audio Upload Endpoints
  Effort: 2-3 hours
  
  Issue: Insufficient validation of file content, MIME types, and potential malicious payloads
  
  Impact: Server crashes from malformed files, storage exhaustion, security vulnerabilities
  
  Fix: Add strict file validation with MIME type checking, file signature verification

.PARAMETER DryRun
  Show what would be fixed without making changes

.PARAMETER Force
  Skip confirmations

.EXAMPLE
  powershell -File fix-ISSUE-003.ps1 -DryRun
  powershell -File fix-ISSUE-003.ps1 -Force
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

$backendPath = ".."

Write-Host "========================================" -ForegroundColor Cyan
Write-Host "FIX ISSUE-003: File Upload Validation" -ForegroundColor Cyan
Write-Host "========================================`n" -ForegroundColor Cyan

# Phase 1: Pre-flight checks
Write-Host "[PHASE 1] Pre-flight checks" -ForegroundColor Cyan

$audioRoutePath = "$backendPath/src/routes/audio.js"
if (Test-Path $audioRoutePath) {
    Write-Host "  [OK] Found audio routes: $audioRoutePath" -ForegroundColor Green
} else {
    throw "Audio route file not found at $audioRoutePath"
}

# Phase 2: Identify problem
Write-Host "`n[PHASE 2] Identifying problem" -ForegroundColor Cyan

$audioRouteContent = Get-Content $audioRoutePath -Raw

if ($audioRouteContent -match "fileFilter") {
    Write-Host "  [WARN] Some file filtering exists, but may be insufficient" -ForegroundColor Yellow
} else {
    Write-Host "  [X] No fileFilter found in multer configuration" -ForegroundColor Red
}

if ($audioRouteContent -match "file-type|magic-bytes") {
    Write-Host "  [OK] File signature verification found" -ForegroundColor Green
} else {
    Write-Host "  [X] No magic bytes verification" -ForegroundColor Red
}

# Phase 3: Apply fix
Write-Host "`n[PHASE 3] Applying fix" -ForegroundColor Cyan

if ($DryRun) {
    Write-Host "[DRY-RUN] Would make the following changes:" -ForegroundColor Yellow
    Write-Host "  1. Create file validation middleware" -ForegroundColor Yellow
    Write-Host "  2. Add strict MIME type checking" -ForegroundColor Yellow
    Write-Host "  3. Add file size limits enforcement" -ForegroundColor Yellow
    Write-Host "  4. Add magic bytes verification" -ForegroundColor Yellow
} else {
    if (-not $Force -and -not $SkipConfirm) {
        $confirm = Read-Host "Create file validation middleware? (y/n)"
        if ($confirm -ne 'y') {
            Write-Host "Aborted by user" -ForegroundColor Yellow
            exit 0
        }
    }
    
    # Create file validation middleware
    $middlewarePath = "$backendPath/src/middleware/fileValidation.js"
    $middlewareContent = @'
/**
 * File Upload Validation Middleware
 * ISSUE-003 Fix: Enhanced file upload security
 */

const multer = require('multer');

// Allowed MIME types for audio files
const ALLOWED_AUDIO_MIMES = [
  'audio/webm',
  'audio/wav',
  'audio/wave',
  'audio/x-wav',
  'audio/mp4',
  'audio/mpeg',
  'audio/mp3',
  'audio/ogg',
  'audio/x-m4a'
];

// Maximum file size: 100MB
const MAX_FILE_SIZE = 100 * 1024 * 1024;

// Magic bytes for audio file verification
const AUDIO_SIGNATURES = {
  'audio/webm': [[0x1A, 0x45, 0xDF, 0xA3]], // WebM
  'audio/wav': [[0x52, 0x49, 0x46, 0x46]], // WAV (RIFF)
  'audio/mp4': [[0x00, 0x00, 0x00, null, 0x66, 0x74, 0x79, 0x70]], // MP4
  'audio/mpeg': [[0xFF, 0xFB], [0xFF, 0xF3], [0xFF, 0xF2], [0x49, 0x44, 0x33]], // MP3
  'audio/ogg': [[0x4F, 0x67, 0x67, 0x53]] // OGG
};

/**
 * Verify file signature (magic bytes)
 * @param {Buffer} buffer - File buffer
 * @param {string} mimetype - Expected MIME type
 * @returns {boolean}
 */
function verifyFileSignature(buffer, mimetype) {
  const signatures = AUDIO_SIGNATURES[mimetype] || AUDIO_SIGNATURES[mimetype.split('/')[0]];
  
  if (!signatures) {
    return false;
  }
  
  return signatures.some(signature => {
    return signature.every((byte, index) => {
      if (byte === null) return true; // Skip wildcard bytes
      return buffer[index] === byte;
    });
  });
}

/**
 * Multer file filter for audio files
 */
const audioFileFilter = (req, file, cb) => {
  // Check MIME type
  if (!ALLOWED_AUDIO_MIMES.includes(file.mimetype)) {
    return cb(
      new Error(`Invalid file type: ${file.mimetype}. Allowed types: ${ALLOWED_AUDIO_MIMES.join(', ')}`),
      false
    );
  }
  
  cb(null, true);
};

/**
 * Validate uploaded file after multer processing
 * Verifies file signature (magic bytes)
 */
const validateUploadedFile = async (req, res, next) => {
  try {
    if (!req.file) {
      return res.status(400).json({ error: 'No file uploaded' });
    }
    
    const { buffer, mimetype, size } = req.file;
    
    // Verify file size
    if (size > MAX_FILE_SIZE) {
      return res.status(400).json({ 
        error: `File too large. Maximum size: ${MAX_FILE_SIZE / (1024 * 1024)}MB` 
      });
    }
    
    // Verify file signature (magic bytes)
    if (!verifyFileSignature(buffer, mimetype)) {
      return res.status(400).json({ 
        error: 'File signature does not match MIME type. Possible file corruption or spoofing.' 
      });
    }
    
    // Additional validation passed
    req.fileValidated = true;
    next();
  } catch (error) {
    console.error('File validation error:', error);
    res.status(500).json({ error: 'File validation failed' });
  }
};

/**
 * Configure multer with security settings
 */
const createSecureUpload = (storage) => {
  return multer({
    storage: storage,
    fileFilter: audioFileFilter,
    limits: {
      fileSize: MAX_FILE_SIZE,
      files: 1
    }
  });
};

module.exports = {
  audioFileFilter,
  validateUploadedFile,
  createSecureUpload,
  ALLOWED_AUDIO_MIMES,
  MAX_FILE_SIZE
};
'@
    
    # Create middleware directory if needed
    $middlewareDir = "$backendPath/src/middleware"
    if (-not (Test-Path $middlewareDir)) {
        New-Item -Path $middlewareDir -ItemType Directory -Force | Out-Null
    }
    
    Set-Content -Path $middlewarePath -Value $middlewareContent -Encoding UTF8
    Write-Host "  [OK] File validation middleware created" -ForegroundColor Green
    
    Write-Host "`n  Manual update required:" -ForegroundColor Yellow
    Write-Host "  Update audio.js to use the new validation middleware:" -ForegroundColor Yellow
    Write-Host "  " -ForegroundColor Cyan
    Write-Host "  const { createSecureUpload, validateUploadedFile } = require('../middleware/fileValidation');" -ForegroundColor Cyan
    Write-Host "  " -ForegroundColor Cyan
    Write-Host "  // Replace existing multer configuration with:" -ForegroundColor Cyan
    Write-Host "  const upload = createSecureUpload(storage);" -ForegroundColor Cyan
    Write-Host "  " -ForegroundColor Cyan
    Write-Host "  // Add validateUploadedFile middleware to upload routes:" -ForegroundColor Cyan
    Write-Host "  router.post('/upload', " -ForegroundColor Cyan
    Write-Host "    upload.single('audio'), " -ForegroundColor Cyan
    Write-Host "    validateUploadedFile,  // Add this" -ForegroundColor Cyan
    Write-Host "    audioController.uploadAudio" -ForegroundColor Cyan
    Write-Host "  );" -ForegroundColor Cyan
}

# Phase 4: Verify fix
Write-Host "`n[PHASE 4] Verifying fix" -ForegroundColor Cyan

if (-not $DryRun) {
    if (Test-Path "$backendPath/src/middleware/fileValidation.js") {
        Write-Host "  [OK] File validation middleware created" -ForegroundColor Green
    }
    
    Write-Host "`n  Manual verification needed:" -ForegroundColor Yellow
    Write-Host "    1. Update audio.js to use new middleware" -ForegroundColor Yellow
    Write-Host "    2. Test uploading valid audio files" -ForegroundColor Yellow
    Write-Host "    3. Test uploading invalid files (should be rejected)" -ForegroundColor Yellow
}

# Phase 5: Test
Write-Host "`n[PHASE 5] Testing" -ForegroundColor Cyan

Write-Host "  Test scenarios:" -ForegroundColor Yellow
Write-Host "    1. Upload valid audio file (should succeed)" -ForegroundColor Yellow
Write-Host "    2. Upload non-audio file with .mp3 extension (should fail)" -ForegroundColor Yellow
Write-Host "    3. Upload file `>100MB (should fail)" -ForegroundColor Yellow
Write-Host "    4. Upload file with mismatched MIME type (should fail)" -ForegroundColor Yellow
Write-Host "    5. Upload malformed audio file (should fail)" -ForegroundColor Yellow

Write-Host "`n========================================" -ForegroundColor Green
Write-Host "[SUCCESS] ISSUE-003 fix prepared" -ForegroundColor Green
Write-Host "========================================`n" -ForegroundColor Green

Write-Host "Next steps:" -ForegroundColor Cyan
Write-Host "  1. Update audio.js to use new validation middleware" -ForegroundColor White
Write-Host "  2. Test all upload scenarios" -ForegroundColor White
Write-Host "  3. Commit changes: git add src/middleware/fileValidation.js src/routes/audio.js" -ForegroundColor White
Write-Host "  4. Create commit: git commit -m 'fix: add comprehensive file upload validation (ISSUE-003)'" -ForegroundColor White
