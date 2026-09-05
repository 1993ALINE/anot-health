# Anot Health — Clinician Workflow Specification

**Version 1.0 · September 2026**

This document details the end-to-end clinical workflow for clinicians (physicians, nurse practitioners, physician assistants) using the Anot Health ambient AI documentation platform. It covers the complete operational lifecycle from authentication and patient encounter recording to AI note synthesis, scribe collaboration, note locking, and EHR export.

---

## 1. Workflow Architecture & Lifecycle

```mermaid
flowchart TD
    subgraph Auth["1. Access & Compliance"]
        A[Clinician Login] --> B{First Login / Temp PW?}
        B -- Yes --> C[Mandatory Password Change]
        B -- No --> D{Privacy Training Acknowledged?}
        C --> D
        D -- No --> E[HIPAA & PIPEDA / PHIPA Training Modal]
        E --> F[Acknowledge & Sign Compliance]
        D -- Yes --> G[Clinician Dashboard]
        F --> G
    end

    subgraph Encounter["2. Encounter Setup & Recording"]
        G --> H[Select Scheduled Patient OR New Visit\nMRN (US) / PHN (Canada)]
        H --> I[Select Note Template & Verify Patient Consent]
        I --> J[Start Ambient Recording]
        J --> K[Encounter in Progress\n- Live Mic Audio Meter\n- Keep-Alive Audio Worker\n- Dictation Scratchpad & Macros (°C / °F)]
        K --> L[Stop Encounter Recording]
    end

    subgraph Pipeline["3. Audio & AI Processing"]
        L --> M[Upload Audio to S3\n*Offline Queue Fallback if Disconnected*]
        M --> N[Deepgram Speech-to-Text Transcription]
        N --> O[Anthropic Claude AI Note Synthesis\n- SOAP / H&P Structure\n- ICD-10-CM / ICD-10-CA Codes]
    end

    subgraph Review["4. Review & Approval"]
        O --> P{Workflow Model}
        P -- Scribe-Assisted --> Q[Scribe Reviews & Refines AI Draft]
        Q --> R[Note Status: Scribe Draft Ready]
        P -- Direct Clinician --> R
        R --> S[Clinician Review & Direct In-Place Edit]
        S --> T[Lock Note / Final Approval]
    end

    subgraph EHR["5. EHR / EMR Finalization"]
        T --> U[1-Click Copy Full Note / Section to Clipboard]
        U --> V[Paste into Clinic EHR / EMR System\n(Universal Clipboard Workflow)]
        V --> W[Mark Uploaded to EHR / EMR in Anot]
    end
```

---

## 2. Detailed Step-by-Step Clinical Workflow

### Phase 1: Authentication & Dual-Jurisdiction Compliance Gating

1. **Sign-In:**
   * Clinician navigates to `https://app.anot.health/login`.
   * Enters verified clinical email and password.
2. **Credential Hardening:**
   * Accounts flagged with `force_password_change` must configure a new compliant password (minimum 12 characters with uppercase, lowercase, numeric, and special characters).
3. **Privacy Training Gate (HIPAA & PIPEDA / PHIPA):**
   * If the clinician has not acknowledged the active training revision, access is paused with a temporary token until the clinician reviews the privacy policy and acknowledges compliance (`POST /api/auth/acknowledge-phi-training`).
   * **US Clinicians:** Covers HIPAA Security & Privacy Rules and minimum necessary PHI disclosure.
   * **Canadian Clinicians:** Covers PIPEDA, provincial privacy legislation (Ontario PHIPA, Alberta HIA, BC PIPA, Quebec Law 25), and "Circle of Care" information handling.
4. **Session Issued:**
   * Clinician receives a secure 8-hour JWT session carrying role `clinician` and is routed to `/clinician`.

---

### Phase 2: Encounter Setup & Patient Selection

From the **Clinician Portal** (`src/pages/Clinician/ClinicianPortal.jsx`):

1. **Schedule & Patient Queue:**
   * Clinician reviews the daily appointment schedule retrieved via `GET /api/visits/date/:date`.
   * The list shows patient name, MRN / PHN, appointment time, and current encounter status (`scheduled`, `in-progress`, `draft`, `locked`).
2. **Patient Selection or Instant Visit Creation:**
   * **Scheduled Visit:** Select an existing patient from the daily queue.
   * **Instant Encounter / New Patient:** Enter Patient Name, Date of Birth / Age, and MRN / Canadian PHN / Health Card Number directly. The system automatically creates a patient record (`POST /api/patients`) and links the new visit (`POST /api/visits`).
     * *Canadian Identifiers:* Ontario OHIP # (10 digits + version), Alberta PHN (9 digits), British Columbia PHN (10 digits), Quebec RAMQ, etc.
3. **Clinical Documentation Template:**
   * Select the appropriate clinical structure:
     * **SOAP Note — Adult (Standard)**
     * **SOAP Note — Pediatric**
     * **Comprehensive Physical Exam (H&P)**
     * **Musculoskeletal / Orthopedic Exam**
     * **Cardiology / Chest Pain Consult**
     * **Annual Wellness / Preventive Visit**
     * **Telehealth / Virtual Encounter**
4. **Patient Consent Verification:**
   * Verbal recording consent is obtained from the patient and recorded in the audit trail (`consentAPI.recordPatientConsent`).
   * *Canadian Standard:* Complies with Canadian Medical Protective Association (CMPA) guidelines regarding recording clinical encounters.

---

### Phase 3: Ambient Encounter Recording

1. **Start Recording:**
   * Clinician clicks **"Start Recording"** / **"Record Encounter"**.
   * Browser requests microphone permission (if not already granted).
   * Web Audio API initializes echo cancellation, automatic gain control, and noise suppression.
2. **Active Encounter Monitoring:**
   * **Visual Audio Meter:** Real-time microphone level meter ensures speech is being captured clearly.
   * **Keep-Alive Background Worker:** Ensures audio capture continues without interruption if the clinician switches browser tabs or the device screen dims.
   * **Live Preview:** Interim speech recognition presents a live transcript for reference.
   * **Dictation Scratchpad & Macros:** Clinicians can type quick notes or insert custom SmartPhrases during the visit:
     * `.vitals` — Normal vitals with dual Canadian metric (°C) and US imperial (°F) units: `BP 120/80 mmHg, HR 72 bpm regular, Temp 37.0°C / 98.6°F, RR 16/min, SpO2 99%`
     * `.normexam` — Comprehensive normal physical exam
     * `.kneemsk` — Musculoskeletal exam template
     * `.rx_nsaid` — Standard medication and care plan
     * `.ortho` — Orthopedic surgery referral and MRI order
     * `.followup` — 2-week return precautions
3. **Pause & Resume:**
   * Clinicians can pause the recording during sensitive procedures, physical exams, or private conversations, and resume when ready.

---

### Phase 4: Stop Recording & AI Note Pipeline

1. **Stop & Audio Finalization:**
   * Clinician clicks **"■ Stop Recording"**.
   * The audio stream stops, keep-alive worker terminates, and the audio payload is packaged into a compressed WebM/Opus audio blob.
2. **Secure Upload & Storage:**
   * The audio uploads over TLS to Amazon S3 (`anot-audio-625242092266`).
   * **Offline Queue Fallback:** If internet connectivity drops, the browser automatically queues the audio in local IndexedDB storage. As soon as connectivity restores, the audio is uploaded automatically.
   * **Retention Policy:** Encounter audio in S3 is automatically purged after 90 days in compliance with HIPAA and Canadian data-minimization rules.
3. **Speech-to-Text (Deepgram):**
   * Backend triggers Deepgram medical STT model (`POST /api/visits/:id/transcribe`).
   * Raw transcription segments with timestamps are generated and saved to the note.
4. **Anthropic Claude AI Note Generation:**
   * Transcript and visit metadata are fed to Anthropic Claude.
   * Generates a structured clinical draft formatted by section:
     * **Chief Complaint (CC)**
     * **History of Present Illness (HPI)**
     * **Physical Examination (PE)**
     * **Imaging & Diagnostic Data**
     * **Assessment & Plan (A&P)**
     * **Suggested Diagnostic Codes:** Dual support for **ICD-10-CM** (US) and **ICD-10-CA** (Canada).

---

### Phase 5: Review Models (Direct vs. Scribe-Assisted)

Anot Health supports two operational models:

| Model | Workflow Description |
| :--- | :--- |
| **Scribe-Assisted (Hybrid)** | The AI draft is routed to an assigned human medical scribe (`ScribePortal.jsx`). The scribe proofreads against the transcript, corrects clinical nuances, and submits the note as **"Scribe draft ready"** for clinician sign-off. |
| **Direct Clinician** | The clinician immediately reviews the AI-generated SOAP note in the **Active Encounter Review** pane without waiting for a scribe. |

---

### Phase 6: Clinician Verification, Edit & Note Locking

1. **Structured Note Review:**
   * Clinician reviews the draft side-by-side with the encounter transcript.
   * Clinician can toggle between section view and full note view.
2. **In-Place Editing:**
   * Click **Edit Note** to adjust any wording, add clinical context, or refine recommendations.
   * Option to click **Regenerate AI Draft** if the clinician wishes to re-prompt the AI model.
3. **Locking & Sign-Off:**
   * Once validated for clinical accuracy, the clinician clicks **"Lock Note"** (`POST /api/visits/:id/lock-note`).
   * **Immutability:** Once locked:
     * Scribes and assistants can no longer modify the content.
     * The record is timestamped with the clinician's signature metadata.
     * Status updates to `locked` / `uploaded`.

---

### Phase 7: Universal EHR / EMR Transfer & Export (1-Click Clipboard)

> [!NOTE]
> Anot Health operates without requiring direct EHR API integrations or vendor locks. Finalized notes are formatted cleanly so clinicians or scribes can copy and paste them directly into any EHR or EMR system in use at the clinic.

1. **One-Click Export:**
   * Clinician or scribe clicks **"Copy Section"** or **"Copy Full Note"** to copy sanitized clinical text directly to the system clipboard.
2. **Transfer into Clinic EHR / EMR:**
   * Switch to the facility's existing Electronic Health Record / Electronic Medical Record software.
   * Paste the note into the patient's encounter chart.
3. **Audit Closure:**
   * In Anot Health, the note is confirmed as **Uploaded to EHR** (`POST /api/notes/:id/upload-ehr`), recording `ehr_uploaded_at` and `ehr_uploaded_by` to track documentation completion across the care team.

---

## 3. Visit & Note State Machine

```
[scheduled] ──► [in-progress] ──► [recording-uploaded] ──► [draft] ──► [submitted] ──► [locked] ──► [uploaded]
      │               │                     │                │            │            │
  New Visit     Mic Recording         Audio saved to    AI generates  Scribe submits Clinician signs Note copied
   Created         Active               S3 bucket        SOAP note      to doctor    & locks note   to EHR/EMR
```

---

## 4. Clinician Productivity Features

* **`t`** — Jump back to **Today's Schedule** from any schedule date view.
* **SmartPhrases (`.macro`)** — Type shortcut prefix in the scratchpad (e.g. `.vitals`, `.normexam`) for instant text expansion.
* **Dual Metric / Imperial Units** — Standard Celsius (°C) and Fahrenheit (°F) support across documentation.
* **Continuous Audio Visualizer** — Instant feedback on speech pickup to prevent dead recordings.
* **Offline Audio Resilience** — Recording never lost due to clinic Wi-Fi drops.

---

## 5. Canadian & US Regulatory & Privacy Framework

| Requirement | United States (HIPAA) | Canada (PIPEDA & Provincial Acts) |
| :--- | :--- | :--- |
| **Primary Legislation** | Health Insurance Portability and Accountability Act (HIPAA) | Personal Information Protection and Electronic Documents Act (PIPEDA) |
| **Provincial Health Acts** | N/A (State health privacy laws) | Ontario: **PHIPA**<br>Alberta: **HIA**<br>British Columbia: **PIPA / FIPPA**<br>Quebec: **Law 25** |
| **Patient Identifiers** | Medical Record Number (MRN), SSN (rare) | Provincial Health Number (PHN), OHIP (Ontario), RAMQ (Quebec), MSP (BC), AHCIP (Alberta) |
| **Clinical Coding** | ICD-10-CM, CPT, HCPCS | **ICD-10-CA** (CIHI), **CCI** (Interventions), Provincial Fee Codes (OHIP Schedule of Benefits, MSP Fee Guide) |
| **Consent Standard** | HIPAA Notice of Privacy Practices | CMPA guidelines, express consent for recording, implied consent within "Circle of Care" |
| **Data Encryption** | AES-256 (At Rest), TLS 1.3 (In Transit) | AES-256 (At Rest), TLS 1.3 (In Transit) |
| **Audio Retention** | 90-Day automated deletion lifecycle | 90-Day automated deletion lifecycle |
| **AI Partner Governance** | Anthropic BAA (Zero Retention) | Anthropic BAA (Zero Retention, no model training on PHI) |
| **Data Residency** | AWS US Regions (us-east-1, etc.) | AWS Canada Central (`ca-central-1` Montreal / Calgary) deployment compatible |

