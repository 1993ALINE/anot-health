# Fixed Button Loading States in Scribe Portal

## Changes Made

Fixed the "Save Draft" and "Upload to EMR" buttons in the Scribe portal to have independent loading states with correct loading text.

## Problem

Both buttons shared a single `saving` state variable, which meant:
- Both buttons would be disabled when either was clicked
- The "Save Draft" button incorrectly showed "Uploading..." when saving
- Users couldn't distinguish which operation was in progress

## Solution

Created separate state variables for each button operation:

### 1. Separate State Variables

**Before:**
```javascript
const [saving, setSaving] = useState(false)
```

**After:**
```javascript
const [savingDraft, setSavingDraft] = useState(false)
const [uploadingToEMR, setUploadingToEMR] = useState(false)
```

### 2. Updated `saveDraft` Function

```javascript
const saveDraft = async () => {
  try {
    setSavingDraft(true)  // ← Changed from setSaving
    // ... save logic ...
  } finally {
    setSavingDraft(false)  // ← Changed from setSaving
  }
}
```

### 3. Updated `uploadToEMR` Function

```javascript
const uploadToEMR = async () => {
  try {
    setUploadingToEMR(true)  // ← Changed from setSaving
    // ... upload logic ...
  } finally {
    setUploadingToEMR(false)  // ← Changed from setSaving
  }
}
```

### 4. Updated Button Components

**Before:**
```jsx
<button onClick={saveDraft} disabled={saving}>
  {saving ? 'Saving...' : 'Save Draft'}
</button>
<button onClick={uploadToEMR} disabled={saving}>
  {saving ? 'Uploading...' : 'Upload to EMR'}
</button>
```

**After:**
```jsx
<button onClick={saveDraft} disabled={savingDraft}>
  {savingDraft ? 'Saving...' : 'Save Draft'}
</button>
<button onClick={uploadToEMR} disabled={uploadingToEMR}>
  {uploadingToEMR ? 'Uploading...' : 'Upload to EMR'}
</button>
```

## File Modified

**`anot-frontend-main/anot-frontend-main/src/pages/Scribe/index.jsx`**

- Lines 198-199: Added separate state variables
- Lines 465-486: Updated `saveDraft` function to use `savingDraft` state
- Lines 488-502: Updated `uploadToEMR` function to use `uploadingToEMR` state
- Lines 1477-1478: Updated button rendering to use respective states

## Benefits

✅ **Independent loading states** - Each button tracks its own loading state  
✅ **Correct loading text** - "Save Draft" shows "Saving...", "Upload to EMR" shows "Uploading..."  
✅ **Better UX** - Users can see exactly which operation is in progress  
✅ **No interference** - Buttons don't affect each other's state  

## Button Behavior

### Save Draft Button

**States:**
- Default: "Save Draft" (enabled)
- Loading: "Saving..." (disabled)
- After completion: "Save Draft" (enabled)

**When clicked:**
1. Button text changes to "Saving..."
2. Button becomes disabled
3. Draft is saved to server
4. Button returns to "Save Draft" and becomes enabled

### Upload to EMR Button

**States:**
- Default: "Upload to EMR" (enabled)
- Loading: "Uploading..." (disabled)
- After completion: Hidden (note is submitted)

**When clicked:**
1. Button text changes to "Uploading..."
2. Button becomes disabled
3. Note is saved and submitted to clinician
4. Success message appears: "✓ Note submitted — clinician has been notified"
5. Buttons are hidden (replaced with success message)

## Testing

### Test Save Draft

1. ✅ Open a note in edit mode
2. ✅ Edit the final note text
3. ✅ Click "Save Draft"
4. ✅ Verify button shows "Saving..." and is disabled
5. ✅ Verify "Upload to EMR" button remains enabled
6. ✅ After save completes, verify button returns to "Save Draft"

### Test Upload to EMR

1. ✅ Open a note in edit mode
2. ✅ Edit the final note text
3. ✅ Click "Upload to EMR"
4. ✅ Verify button shows "Uploading..." and is disabled
5. ✅ Verify "Save Draft" button remains enabled
6. ✅ After upload completes, verify success message appears

### Test Independence

1. ✅ Click "Save Draft" quickly multiple times
2. ✅ Verify only one request is made (button is disabled during save)
3. ✅ Verify "Upload to EMR" button remains clickable during save
4. ✅ Verify each button only affects its own loading state

---

**Status:** ✅ Complete. Each button now has independent loading states with correct loading text ("Saving..." for Save Draft, "Uploading..." for Upload to EMR).
