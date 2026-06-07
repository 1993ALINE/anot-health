# Transcription Panel Header Layout Update

## Changes Made

Updated the Transcription panel header in the Scribe portal to show both the "Transcribe audio" button and the status badge together in the same row.

## Layout Structure

### Before

```
TRANSCRIPTION                                [Status Badge]
─────────────────────────────────────────────────────────
[Transcribe audio button]
[Transcript text area...]
```

The button was inside the panel body, below the header.

### After

```
TRANSCRIPTION    [Transcribe audio button]    [Status Badge]
─────────────────────────────────────────────────────────
[Transcript text area...]
```

Both the button and status badge are now in the header row.

## Implementation Details

### File Modified: `anot-frontend-main/anot-frontend-main/src/pages/Scribe/index.jsx`

**Changed lines 1361-1382:**

1. **Moved button to header** - The "Transcribe audio" button is now passed to the `badges` prop instead of being in the panel body

2. **Combined elements** - Used a React Fragment (`<>...</>`) to group both the button and status badge

3. **Styling** - Added inline styles to the button for proper sizing in the header:
   - `fontSize: '13px'` - Matches header size
   - `padding: '6px 14px'` - Compact padding for header
   - `marginRight: '8px'` - Space between button and status badge

### Code Structure

```jsx
<NoteWorkspacePanel
  title="Transcription"
  badges={
    <>
      {!isDone && !txComplete && (
        <button
          type="button"
          className="btn btn-navy"
          style={{ fontSize: '13px', padding: '6px 14px', marginRight: '8px' }}
          disabled={transcribeSubmitting || !selectedRec?.id}
          onClick={runTranscribe}
        >
          {transcribeSubmitting ? 'Starting…' : 'Transcribe audio'}
        </button>
      )}
      <span className={`badge ${txBadge.cls}`}>{txBadge.label}</span>
    </>
  }
>
  {/* Panel content - textarea, etc. */}
</NoteWorkspacePanel>
```

## Behavior

### Button Visibility

The "Transcribe audio" button is **conditionally shown** when:
- The note is not done (`!isDone`)
- AND transcription is not complete (`!txComplete`)

When the note is submitted or transcription is completed, the button is hidden, leaving only the status badge in the header.

### Status Badge

The status badge is **always visible** and shows:
- **Processing** (blue badge) - While transcription is running
- **Completed** (green badge) - When transcription is done
- **Failed** (gray badge) - If transcription failed
- **Idle** (amber badge) - Default state

## Benefits

✅ **Cleaner layout** - No button taking up space in the panel body  
✅ **Better UX** - Status and action are together in the header  
✅ **More space** - Panel body has more room for the transcript  
✅ **Consistent design** - Matches the AI Draft panel pattern  

## Visual Flow

```
┌─ TRANSCRIPTION ──────── [Transcribe audio] ── Completed ─┐
│                                                            │
│  [Transcript text area fills available space]             │
│                                                            │
└────────────────────────────────────────────────────────────┘
```

The header now shows:
1. **Title** (left) - "TRANSCRIPTION"
2. **Action** (center) - "Transcribe audio" button (when applicable)
3. **Status** (right) - Status badge (always visible)

## Testing

### Verify the following:

1. ✅ Open a note in edit mode
2. ✅ Verify Transcription panel header shows:
   - Title on the left
   - "Transcribe audio" button in the middle (if transcription not complete)
   - Status badge on the right
3. ✅ Click "Transcribe audio" - should start transcription
4. ✅ Verify status changes to "Processing" (blue)
5. ✅ When complete, button should hide, leaving only "Completed" badge
6. ✅ For submitted notes, verify only the status badge shows (no button)

---

**Status:** ✅ Complete. The Transcription panel header now shows both the action button and status badge together in a single row.
