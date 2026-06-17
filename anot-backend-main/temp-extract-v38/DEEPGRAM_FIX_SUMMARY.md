# Deepgram Transcription Fix - Summary

## Issues Fixed

### 1. Deepgram API Key Not Being Loaded
**Problem:** The backend showed "[aiTranscription] Deepgram not configured" even though the API key was stored in the database.

**Root Cause:** The JWT_SECRET environment variable changed since the API key was encrypted, causing AES-GCM decryption to fail silently.

**Solution:** Added comprehensive error logging to identify decryption failures:
- `settingsEncryption.js` - Now logs when decryption fails
- `aiSettings.js` - Added detailed diagnostic logging showing exactly why Deepgram isn't being used
- Created `scripts/diagnose-deepgram.js` - Diagnostic script to check Deepgram configuration

**Action Required:** Re-enter the Deepgram API key in the settings UI to re-encrypt it with the current JWT_SECRET.

### 2. WebM Files Failing with "fetch failed"
**Problem:** .webm audio files were failing to transcribe with generic "fetch failed" errors.

**Root Cause:** The Deepgram SDK wasn't being explicitly told the mimetype for .webm files, causing issues with audio format detection.

**Solution:** Modified `aiTranscriptionService.js`:
1. Added `getMimeTypeFromPath()` function to detect mimetype from file extension
2. Explicitly sets `mimetype: "audio/webm"` in Deepgram API options for .webm files
3. Added support for multiple audio formats (.wav, .mp3, .m4a, .ogg, .flac, .opus)
4. Added comprehensive logging throughout the transcription process
5. Now uses the configured `deepgram_model` from settings (e.g., "nova-3-medical")

## Changes Made

### Files Modified

#### `src/utils/settingsEncryption.js`
- Added error logging in `decryptString()` function
- Shows clear error message when decryption fails

#### `src/services/aiSettings.js`
- Enhanced `rowToRuntime()` with diagnostic logging
- Shows when decryption succeeds/fails
- Added warning when encrypted key exists but decryption fails
- Added `loadAiSettings()` logging (cache vs fresh load)
- Enhanced `useDeepgram()` to log why it returns false
- Added cache invalidation logging

#### `src/services/aiTranscriptionService.js`
- Added `path` module import
- Added `getMimeTypeFromPath()` function
- Modified `transcribeWithDeepgram()` to:
  - Detect and log file extension and mimetype
  - Explicitly set mimetype in Deepgram options
  - Use configured model from settings
  - Add comprehensive logging at each step
  - Better error messages with file details

### Files Created

#### `scripts/diagnose-deepgram.js`
Diagnostic script that checks:
- Encryption key configuration
- Database settings
- Decryption status
- Whether Deepgram will be used
- Provides clear action items to fix issues

Usage: `node scripts/diagnose-deepgram.js`

## Testing

To verify the fix works:

1. **Re-enter API Key:**
   ```
   1. Go to Settings in the web UI
   2. Re-enter the Deepgram API key
   3. Enable Deepgram transcription
   4. Set model to "nova-3-medical" (or keep "nova-2-medical")
   5. Save settings
   ```

2. **Test Transcription:**
   - Upload a .webm audio file
   - Check server logs for:
     ```
     [aiTranscription] Transcribing file: visit_XX_XXXXXXXXX.webm
     [aiTranscription] File extension: .webm, mimetype: audio/webm
     [aiTranscription] Using explicit mimetype: audio/webm
     [aiTranscription] Deepgram options: { model: 'nova-3-medical', mimetype: 'audio/webm' }
     ```

3. **Run Diagnostic:**
   ```bash
   node scripts/diagnose-deepgram.js
   ```
   Should show "✓ Deepgram is properly configured"

## Supported Audio Formats

The transcription service now explicitly supports:
- .webm (audio/webm)
- .wav (audio/wav)
- .mp3 (audio/mpeg)
- .m4a (audio/mp4)
- .ogg (audio/ogg)
- .flac (audio/flac)
- .opus (audio/opus)

Other formats will still be sent to Deepgram with auto-detection.

## Configuration

The Deepgram model is now read from `system_settings.deepgram_model` in the database. To use nova-3-medical:

1. Update via Settings UI (preferred), or
2. Direct database update:
   ```sql
   UPDATE system_settings 
   SET deepgram_model = 'nova-3-medical' 
   WHERE id = 1;
   ```

## Notes

- FFmpeg preprocessing is NOT required for .webm files
- Deepgram nova-2-medical and nova-3-medical both support .webm natively
- The SDK automatically handles streaming the file to Deepgram
- No file conversion or preprocessing is performed
