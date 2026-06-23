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
