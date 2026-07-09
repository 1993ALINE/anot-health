# Google Play Internal Testing Upload Checklist

## Before You Start
- [ ] AAB file ready: `C:\Users\Administrator\Desktop\anot-scribe\build\app\outputs\bundle\release\app-release.aab`
- [ ] File size: 68.6 MB ✅
- [ ] Version: v1.2.2+5 ✅
- [ ] Google Play Developer account login ready

## Step-by-Step Upload

### 1. Open Google Play Console
- [ ] Go to: https://play.google.com/console
- [ ] Login with your Google Developer account
- [ ] Verify you're logged in

### 2. Select App
- [ ] Find app: 'Anot Scribe'
- [ ] Package name: com.mashikurrahman.anot_scribe
- [ ] Click to open app

### 3. Navigate to Internal Testing
- [ ] Left menu: 'Testing'
- [ ] Click: 'Internal testing'
- [ ] Page should show 'Create new release' button

### 4. Create New Release
- [ ] Click: 'Create new release' button
- [ ] Upload dialog appears

### 5. Upload AAB File
- [ ] Click: 'Upload' or 'Choose files'
- [ ] Navigate to: `C:\Users\Administrator\Desktop\anot-scribe\build\app\outputs\bundle\release\`
- [ ] Select: `app-release.aab`
- [ ] Click 'Open' or 'Choose'
- [ ] File uploads (takes 30 seconds - 1 minute)

### 6. Verify App Details
- [ ] Version shows: v1.2.2+5
- [ ] Size shows: ~68.6 MB
- [ ] Status: 'Ready'
- [ ] No errors shown

### 7. Review Release
- [ ] Click: 'Review release' button
- [ ] Check release notes (optional, can leave blank)
- [ ] Verify all details correct

### 8. Start Rollout
- [ ] Click: 'Start rollout to Internal testing'
- [ ] Confirmation message appears
- [ ] Build now in Internal testing

### 9. Get Shareable Link
- [ ] Go back to: 'Internal testing' tab
- [ ] Find newly uploaded build (v1.2.2+5)
- [ ] Copy shareable link
- [ ] Link format: `https://play.google.com/apps/testing/com.mashikurrahman.anot_scribe`

### 10. Document Results
- [ ] Shareable link: ___________________
- [ ] Upload completed: Date _______ Time _______
- [ ] Status in Play Console: [LIVE / PROCESSING / ERROR]
- [ ] Ready to share with doctors: YES / NO

---

## Troubleshooting

### If Upload Fails
- Check file is valid AAB (not APK)
- Verify file size is under 150 MB limit ✅
- Check internet connection
- Try different browser (Chrome recommended)
- Clear browser cache and retry

### If Version Conflict
- Verify version code is higher than previous builds
- Current version: v1.2.2+5 (version code: 5)
- Check existing builds in Play Console

### If Processing Takes Long
- Normal processing: 1-5 minutes
- Long processing: up to 30 minutes
- Check 'Release' tab for status updates
- Refresh page periodically

---

## Post-Upload Actions

### After Successful Upload
- [ ] Test the internal testing link yourself
- [ ] Verify app downloads and installs
- [ ] Check version in app: should show v1.2.2
- [ ] Add internal testers if needed
- [ ] Share link with doctors: `https://play.google.com/apps/testing/com.mashikurrahman.anot_scribe`

### Internal Tester Setup (if needed)
- [ ] Go to: Testing → Internal testing → Testers tab
- [ ] Add email addresses of testers
- [ ] Save changes
- [ ] Share testing link with testers

---

## Important Notes

- **Internal Testing**: Only invited testers can access
- **Link Expiry**: Testing links don't expire
- **Update Time**: Changes appear within minutes
- **No Review**: Internal testing bypasses Google review
- **Instant Updates**: Can upload new versions anytime
- **Doctor Access**: Doctors need to accept invitation via link

---

## Success Criteria

✅ **Upload Successful When:**
1. AAB appears in Internal testing releases
2. Build version shows: v1.2.2+5
3. Status: "Live" in Play Console
4. Shareable link generated and working
5. Link opens invitation page for testers

---

**Date Completed**: _____________

**Uploaded By**: _____________

**Shareable Link**: _______________________________________________

**Notes**: ___________________________________________________________

____________________________________________________________________
