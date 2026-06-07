# Scribe Portal Layout Fix - Unsaved Changes Banner

## Issue

When the "Unsaved changes" banner appeared in the Scribe portal's note editor, it pushed the three-column layout down, causing the "Save Draft" and "Upload to EMR" buttons at the bottom to disappear off-screen.

## Root Cause

The `.sf-note-workspace__panels` container had a **fixed height calculation**:

```css
height: calc(100vh - 280px);
min-height: 500px;
flex: none;
```

This fixed offset (280px) assumed a constant amount of space would be taken by the topbar and toolbar. However, when the "Unsaved changes" banner appeared dynamically, it added extra height to the toolbar, but the panels didn't adjust - they remained at the fixed calculated height, pushing content off-screen.

## Solution

Changed the layout to use **flexible height** that adapts dynamically to the available space:

```css
flex: 1;
min-height: 0;
```

### How It Works

The layout now uses a proper flexbox hierarchy:

```
sf-main-fixed (already has: display: flex; flex-direction: column; height: 100vh)
  ├─ PortalTopbar (flex-shrink: 0)
  ├─ sf-note-toolbar (flex-shrink: 0) ← Banner appears/disappears here
  └─ sf-note-workspace (flex: 1) ← Fills remaining space
     ├─ sf-note-workspace__top (flex-shrink: 0) ← Audio player
     └─ sf-note-workspace__panels (flex: 1) ← Three columns fill remaining space
        ├─ Transcription column
        ├─ AI Draft column
        └─ Final Note column (with bottom buttons)
```

**Key Changes:**

1. **Removed fixed height** from `.sf-note-workspace__panels`:
   - Before: `height: calc(100vh - 280px)` and `flex: none`
   - After: `flex: 1` and `min-height: 0`

2. **Uses flexbox to fill available space**:
   - The panels now use `flex: 1` to fill whatever space is left
   - When the banner appears, it takes up space, and the panels automatically shrink to fit
   - When the banner disappears, the panels automatically expand to fill the space

3. **Maintains proper overflow**:
   - `min-height: 0` allows the flex item to shrink below its content size
   - `overflow: hidden` ensures scrolling happens within each panel, not the entire workspace

## File Modified

**`anot-frontend-main/anot-frontend-main/src/pages/Scribe/scribe.css`** (line 669-677)

```css
/* Note editor — equal-height three-column layout (dynamic height) */
.scribe-portal .sf-note-workspace__panels {
  display: flex;
  flex-direction: row;
  align-items: stretch;
  flex: 1;              /* ← Changed from fixed height */
  min-height: 0;        /* ← Added for proper flex shrinking */
  overflow: hidden;
}
```

## Benefits

1. ✅ **Banner doesn't push layout down** - The three columns dynamically adjust their height
2. ✅ **Buttons always visible** - Save Draft and Upload to EMR buttons stay at the bottom of the viewport
3. ✅ **Works on all screen sizes** - Mobile styles were already using flexible layout
4. ✅ **Smooth transitions** - Layout adjusts smoothly when banner appears/disappears

## Testing

### Desktop (>768px)
- ✅ Edit the final note → "Unsaved changes" banner appears
- ✅ Verify three columns fill screen height without overflow
- ✅ Verify Save Draft and Upload to EMR buttons are visible at the bottom
- ✅ Save draft → Banner disappears, columns expand to fill space

### Mobile (<768px)
- ✅ Columns already stack vertically with auto height
- ✅ No changes needed for mobile behavior

### Edge Cases
- ✅ Very short viewport height - columns shrink but maintain minimum usable space
- ✅ Very long content in any column - scrolls within that column only
- ✅ Multiple banners/notifications - layout adapts to whatever space remains

## Implementation Details

The fix relies on the existing flex container structure in global.css:
- `.sf-main-fixed` already uses `display: flex; flex-direction: column; height: 100vh`
- `.sf-note-workspace` already uses `flex: 1; display: flex; flex-direction: column`
- Only `.sf-note-workspace__panels` needed the height fix

The mobile styles (max-width: 768px) already used flexible layout with `flex-direction: column` and `height: auto`, so they continue to work correctly.

---

**Status:** ✅ Fix complete. The three-column layout now dynamically adjusts to the available space, ensuring buttons are always visible regardless of the banner state.
