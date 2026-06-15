# Clinician Onboarding Guide

**Anot Health** · Version 1.0 · June 16, 2026

Welcome to Anot Health. This guide gets you from your first login to recording visits, reviewing
AI-generated notes, and finalizing documentation — with a few important privacy reminders along the
way.

Anot Health helps you capture a visit by recording audio, transcribing it automatically, and drafting
a structured clinical note for you to review. **You remain in control:** the AI produces a draft, and
nothing is final until you review and approve it.

---

## 1. How to Log In (First Time)

1. Open the application URL your administrator gave you (e.g. `https://app.anot.health`).
2. Enter your **email** and the **temporary password** your administrator shared.
3. **Change your password.** On first login you'll be required to set a new password with at least
   **12 characters**, including an uppercase letter, a lowercase letter, a number, and a special
   character. (Common or default passwords are rejected.)
4. **Acknowledge PHI awareness training.** Before you can reach your dashboard, you'll see a short PHI
   awareness training prompt. Read and acknowledge it — this is a HIPAA requirement and is recorded.
5. You're in. Your session lasts **8 hours** before you'll need to sign in again.

> Keep your password private and never share your account. If you ever suspect someone else accessed
> it, tell your administrator and email **support@anot.health** right away.

---

## 2. How to Record a Note

1. From your dashboard, **start a visit** (select or create the patient, choose the visit type).
2. Allow **microphone access** when your browser asks.
3. Press **Record** to capture the encounter audio. You can pause/stop as needed; multiple recordings
   for one visit are kept in order.
4. **End / save** the visit when you're done. The audio is uploaded securely (encrypted in transit
   and stored encrypted).

Tips for best results: record in a reasonably quiet room, speak naturally, and confirm the recording
indicator is active before the conversation starts.

---

## 3. How Transcription Works (Deepgram)

- After the audio is saved, it's sent securely to **Deepgram**, our speech-to-text partner (covered
  by a signed Business Associate Agreement), using a medical-tuned model.
- Transcription usually completes shortly after the recording is uploaded. For larger recordings it
  may take a little longer.
- If transcription doesn't appear, use the **Transcribe / Refresh** action, or check with your
  administrator (the most common cause is an API key/quota issue on the account).

---

## 4. How AI Note Generation Works (Claude / Anthropic)

- Once a transcript exists, Anot Health sends it to **Anthropic's Claude** (also under a signed BAA,
  with zero data retention) to generate a **draft clinical note**.
- The draft uses a consistent structure:
  - **Chief Complaint**
  - **History of Present Illness (HPI)**
  - **Physical Examination (PE)**
  - **Imaging**
  - **Assessment & Plan (A&P)**
- The AI only uses what's in the transcript and writes "Not mentioned" where information is missing —
  it does **not** invent clinical details.

> **Always review the draft.** AI output is a starting point, not a final record. You are responsible
> for the accuracy of any note you finalize.

---

## 5. How to Review, Edit, and Approve

1. Open the visit's note. You'll see the **transcript** and the **AI draft**.
2. **Edit** the note to correct, add, or remove anything as your clinical judgment requires.
3. When it's accurate and complete, **finalize/submit** the note.

If a note has already been finalized and you need changes, use **Request edit** so the change is
tracked. All edits and submissions are recorded in the audit trail.

---

## 6. How to Upload to EHR (Manual Process)

> **Important — current behavior:** The **"Upload to EHR"** action in Anot Health **marks a finalized
> note as uploaded** (recording when and by whom). It does **not** automatically transmit the note
> into your external EHR system.

So the practical workflow is:

1. Finalize the note in Anot Health.
2. **Manually copy** the finalized note into your EHR (or follow your clinic's established process).
3. Mark the note **Uploaded to EHR** in Anot Health so the team knows it's been transferred.

Only finalized (submitted/graded) notes can be marked as uploaded. If your organization later enables
a direct EHR integration, this guide will be updated.

---

## 7. HIPAA Reminder

- Everything you record and document is **Protected Health Information (PHI)**. Access only what you
  need for the patient in front of you ("minimum necessary").
- **Encounter audio is automatically deleted after 90 days.** Transcripts and finalized notes are
  retained as part of the clinical record.
- Don't copy PHI to personal devices, personal email, or messaging apps. Lock your screen when you
  step away, and log out on shared devices.
- If you suspect a privacy or security problem (lost device, shared password, suspicious login, data
  sent to the wrong place), **report it immediately** — don't try to fix it quietly. See the PHI
  training (`PHI_TRAINING_ACKNOWLEDGMENT.md`) for details.

---

## 8. Support

- **Support:** support@anot.health
- **Urgent / Security:** admin@anot.health
- **Privacy / Compliance:** privacy@anot.health

You can also use the in-app support option to send a message to the team.
