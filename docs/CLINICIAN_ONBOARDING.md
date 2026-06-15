# Clinician Onboarding Guide

**Anot Health** · Version 1.1 · June 16, 2026

Welcome to Anot Health. This guide gets you from your first login to recording visits, reviewing the
AI-assisted note, and signing it off — with a few important privacy reminders along the way.

**How it works:** you **record** the encounter; Anot transcribes the audio and an AI drafts a
structured note; your **scribe team** refines that draft; and **you review, edit, and lock** the
final note. **You remain in control** — nothing is final until you lock it.

> **A note on this guide:** labels and steps below match the current build. Where a feature you might
> expect isn't available yet, it's called out honestly so you're not left looking for it.

---

## 1. First Login (Important!)

1. Go to **https://app.anot.health**.
2. Enter your **email** (e.g. `name@anot.health`).
3. Enter the **temporary password** your administrator gave you.
4. **Change Password modal** appears.
   - Enter a new password: **12+ characters**, with an **uppercase** letter, a **lowercase** letter,
     a **number**, and a **symbol**. Common/default passwords are rejected.
   - Example shape (don't reuse this one): `MyClinic@2026`
   - Click to **change your password**.
5. **PHI Training modal** appears.
   - Read the HIPAA/PHI awareness training carefully. It covers:
     - What **PHI** (Protected Health Information) is
     - How Anot handles PHI securely
     - **Your responsibilities** as a clinician
     - The **90-day audio retention** policy
   - **Acknowledge** it and proceed. (This is a HIPAA requirement and is recorded.)
6. You're now in your **dashboard**. ✅

> Keep your password private and never share your account. Your session lasts **8 hours** before you
> need to sign in again. If you ever suspect someone else accessed your account, tell your
> administrator and email **support@anot.health** right away.

---

## 2. Recording a Clinical Note

1. From your **schedule/dashboard**, open the encounter (select or create the patient / visit).
2. Click **Record Encounter** (or **Record Now** on an overdue visit).
3. Allow **microphone access** when your browser asks.
4. Speak naturally. The on-screen indicator shows **Recording live…** and a running timer.
5. You can **pause** and resume, and add an **Additional Recording** to the same visit if needed —
   recordings are kept in order.
6. Click **■ Stop** when you're done.
7. The audio **uploads securely** (encrypted in transit and at rest). If your connection drops, the
   recording is saved in the tab and **retries automatically** — keep the tab open until it finishes.

> **Heads-up:** the transcript does **not** appear live while you speak. Transcription runs **after**
> the audio uploads (see the next section). Record in a reasonably quiet room and confirm the
> recording indicator is active before the conversation starts.

---

## 3. Deepgram Transcription

- After the audio uploads, it's sent securely to **Deepgram**, our speech-to-text partner (covered
  by a signed Business Associate Agreement), using a medical-tuned model.
- This is **automatic** and **asynchronous** — it usually completes shortly after upload; larger
  recordings take a little longer. The visit shows a transcription status badge as it progresses.
- The transcript may contain small errors; these get refined in the note (next steps).
- If the transcript doesn't appear, check with your administrator — the most common cause is an API
  key/quota issue on the account.

---

## 4. Claude AI Note Generation

- Once a transcript exists, Anot sends it to **Anthropic's Claude** (also under a signed BAA, with
  zero data retention) to generate a **draft clinical note**.
- The draft uses a consistent structure:
  - **Chief Complaint**
  - **History of Present Illness (HPI)**
  - **Physical Examination (PE)**
  - **Imaging**
  - **Assessment & Plan (A&P)**
- The AI only uses what's in the transcript and writes **"Not mentioned"** where information is
  missing — it does **not** invent clinical details.
- Your **scribe team** works from this AI draft to prepare the note you'll review. In the clinician
  view this appears as the **"Scribe draft"** (alongside the **"Transcript"** tab).
- If AI generation is unavailable, you may see an **"AI draft unavailable"** placeholder — the scribe
  can still draft from the transcript.

> **Always review the draft.** AI output is a starting point, not a final record. You are responsible
> for the accuracy of any note you finalize.

---

## 5. Reviewing & Editing the Note

1. Open the visit's note from your **Notes** screen (the status will read something like **Scribe
   draft ready**). You'll see the **Scribe draft** and the **Transcript** tabs.
2. **Review** the scribe-prepared note for accuracy and completeness.
3. **Edit** directly when needed:
   - Fix any transcription errors carried into the note
   - Add missing clinical information
   - Adjust clinical language and rewrite sections as your judgment requires
4. Double-check accuracy and completeness before finalizing.

---

## 6. Approving (Locking) the Note

1. When the note is accurate and complete, choose to **Lock Note**.
2. A confirmation appears: locking **marks the note as completed and approved**, and **the scribe can
   no longer edit it**.
3. Confirm **Lock Note**. The note's status updates to reflect completion.

This is your sign-off. Treat locking as final approval of the clinical content.

---

## 7. Uploading to EHR (Manual Process)

> **Important:** Anot does **not** automatically transmit notes into your external EHR. The
> **"Upload to EHR"** action in Anot only **marks a finalized note as uploaded** (recording when and
> by whom) for your team's tracking.

In the standard workflow, your **scribe team** marks the note **Uploaded to EHR** in Anot after it's
finalized. The actual transfer into your EHR is a **manual** step done by whoever owns that in your
clinic:

1. Open the finalized/locked note and review the content.
2. **Manually copy** the note text into your EHR (or follow your clinic's established process /
   export it per your clinic's policy).
3. Log into your EHR, find the patient record, create the note entry, paste the content, and submit.
4. Back in Anot, the note is marked **Uploaded to EHR** so the team knows it's been transferred.

> If your organization later enables a direct EHR integration, this guide will be updated.

---

## 8. Audio & Data Privacy

- Everything you record and document is **Protected Health Information (PHI)**. Access only what you
  need for the patient in front of you ("minimum necessary").
- **Encounter audio is automatically deleted after 90 days.** Transcripts and finalized notes are
  retained securely (encrypted) as part of the clinical record.
- Don't copy PHI to personal devices, personal email, or messaging apps. Lock your screen when you
  step away, and log out on shared devices.
- You can request deletion of your data — contact **privacy@anot.health**.
- If you suspect a privacy or security problem (lost device, shared password, suspicious login, data
  sent to the wrong place), **report it immediately** — don't try to fix it quietly. See the PHI
  training (`PHI_TRAINING_ACKNOWLEDGMENT.md`) for details.

---

## 9. Getting Help

- **System issues / general support:** use the in-app support/contact option, or email
  **support@anot.health**.
- **HIPAA / privacy questions:** **privacy@anot.health**
- **Urgent / security:** **admin@anot.health**
- **Feedback / feature requests:** **feedback@anot.health**

---

## 10. Settings & Preferences

- Open your **profile** from the sidebar to view your account.
- **Change your password anytime** from the login screen flow or by asking your administrator to
  reset it.
- Ask your administrator to update your contact details (name, email, phone, specialty), since staff
  records are managed in the Admin portal.

---

## 11. Keyboard Shortcuts

The current build keeps shortcuts minimal:

- **`t`** — on the **schedule** screen, jump back to **Today**.

> Dedicated record/approve/edit shortcuts (e.g. R/A/E) and a global help shortcut are **not available
> yet**. Use the on-screen buttons described above. This section will be updated if shortcuts are
> added.
