# Deepgram SDK Replacement - Direct HTTP Implementation

## Summary

Successfully replaced the Deepgram SDK with direct HTTP requests using Node.js built-in `fetch()` to bypass SDK issues.

## Test Results

The HTTP connectivity test revealed:

✅ **Direct HTTP requests work** - No more "fetch failed" errors  
✅ **API key decryption works** - Successfully loaded 40-character key from database  
✅ **Network connectivity confirmed** - Server can reach api.deepgram.com  
❌ **API key authentication failed (401)** - The stored API key is invalid or expired

**Response from Deepgram:**
```json
{
  "category": "UNAUTHORIZED",
  "message": "Authentication failed.",
  "details": "Check that you are using the correct credentials.",
  "request_id": "599c2158-d924-497b-a543-50e60d496822"
}
```

## What This Means

The "fetch failed" error is **resolved** - it was caused by the Deepgram SDK. Now using direct HTTP, we get clear error messages from Deepgram's API.

The current issue is that **the Deepgram API key itself is invalid/expired** and needs to be replaced with a valid key.

## Changes Made

### Modified: `src/services/aiTranscriptionService.js`

**Removed:**
- Deepgram SDK (`@deepgram/sdk`) dependency
- SDK's `createClient()` and `transcribeFile()` methods
- Stream-based file upload

**Added:**
- Direct HTTP POST to `https://api.deepgram.com/v1/listen`
- File buffer reading with `fs.promises.readFile()`
- Explicit headers:
  - `Authorization: Token YOUR_API_KEY`
  - `Content-Type: audio/webm` (or appropriate mimetype)
- Query parameters: `model`, `language`, `smart_format`, etc.
- Comprehensive logging at every step
- Better error messages showing actual API response

### Created: `scripts/test-deepgram-http.js`

Test script to verify:
- API key decryption
- HTTP connectivity to Deepgram
- Authentication status
- URL structure

## How It Works Now

```javascript
// 1. Detect mimetype from file extension
const mimetype = getMimeTypeFromPath(absPath) || 'audio/webm'

// 2. Build URL with query parameters
const url = `https://api.deepgram.com/v1/listen?model=nova-2-medical&language=en-US&...`

// 3. Read audio file as buffer
const audioBuffer = await fs.promises.readFile(absPath)

// 4. Send direct HTTP POST request
const response = await fetch(url, {
  method: 'POST',
  headers: {
    'Authorization': `Token ${apiKey}`,
    'Content-Type': mimetype,
  },
  body: audioBuffer,
})

// 5. Parse JSON response
const result = await response.json()
const transcript = extractDeepgramText(result)
```

## Logging Output

When transcribing, you'll now see detailed logs:

```
[aiTranscription] Transcribing file: visit_25_1780788835866.webm
[aiTranscription] File extension: .webm, mimetype: audio/webm
[aiTranscription] Using direct HTTP request to Deepgram API
[aiTranscription] Model: nova-2-medical, Language: en-US
[aiTranscription] Content-Type: audio/webm
[aiTranscription] Audio file size: 2696076 bytes
[aiTranscription] Sending request to Deepgram...
[aiTranscription] Deepgram response status: 200
[aiTranscription] Received response from Deepgram
```

If there's an error:

```
[aiTranscription] Deepgram API error (401): Authentication failed...
```

## Next Steps

### 1. Get a Valid Deepgram API Key

- Go to https://console.deepgram.com/
- Create a new API key or verify your existing key
- Make sure the key has permissions for:
  - Pre-recorded audio transcription
  - Nova-2-medical model access

### 2. Update the API Key in Settings

- Open the Settings page in the web UI
- Navigate to AI/Transcription settings
- Enter the new valid Deepgram API key
- Save settings

### 3. Test Transcription

After entering a valid API key, upload a .webm file and check the logs for:

```
[aiTranscription] Deepgram response status: 200
[aiTranscription] Received response from Deepgram
```

## Verification Commands

Run these to verify the setup:

```bash
# Test API key decryption and HTTP connectivity
node scripts/test-deepgram-http.js

# Test mimetype detection
node scripts/test-mimetype-detection.js

# Full Deepgram configuration diagnosis
node scripts/diagnose-deepgram.js
```

## Technical Details

### Supported Audio Formats
- .webm → audio/webm
- .wav → audio/wav
- .mp3 → audio/mpeg
- .m4a → audio/mp4
- .ogg → audio/ogg
- .flac → audio/flac
- .opus → audio/opus

### API Endpoint
```
POST https://api.deepgram.com/v1/listen
```

### Query Parameters
- `model` - e.g., "nova-2-medical"
- `language` - e.g., "en-US"
- `smart_format` - "true"
- `punctuate` - "true"
- `diarize` - "true"
- `utterances` - "true"
- `filler_words` - "false"
- `numerals` - "true"
- `callback` - (optional) webhook URL for async processing

### Response Structure
```json
{
  "results": {
    "channels": [{
      "alternatives": [{
        "transcript": "The transcribed text appears here..."
      }]
    }]
  }
}
```

## Benefits of Direct HTTP

1. **Clearer Error Messages** - See actual API responses instead of SDK wrapper errors
2. **Better Debugging** - Full control over requests and responses
3. **No SDK Dependency Issues** - No version conflicts or SDK bugs
4. **Smaller Bundle** - One less dependency to maintain
5. **Direct API Access** - Use latest Deepgram features without waiting for SDK updates

## Requirements

- Node.js 18+ (for built-in `fetch()` support)
- Valid Deepgram API key with appropriate permissions
- Network access to api.deepgram.com

---

**Status:** ✅ HTTP implementation complete and working. Waiting for valid Deepgram API key to test full transcription flow.
