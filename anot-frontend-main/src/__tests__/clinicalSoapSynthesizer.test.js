import { describe, it, expect } from 'vitest';
import { formatClinicalDictationToSOAP, extractVitals, formatVitalsSection } from '../utils/clinicalSoapSynthesizer.js';

describe('clinicalSoapSynthesizer - Vitals & Headache Tests', () => {
  describe('extractVitals and formatVitalsSection', () => {
    it('extracts blood pressure, temperature, pulse, and oxygen saturation accurately', () => {
      const transcript = 'Patient presents today. Blood pressure is 128/82 mmHg, heart rate is 76 bpm, temperature 98.6 F, oxygen saturation 99% on room air, respirations 16.';
      const vitals = extractVitals(transcript);

      expect(vitals.bp).toBe('128/82 mmHg');
      expect(vitals.hr).toBe('76 bpm regular');
      expect(vitals.temp).toBe('37.0°C / 98.6°F');
      expect(vitals.spo2).toBe('99% on room air');
      expect(vitals.rr).toBe('16/min');

      const formatted = formatVitalsSection(vitals);
      expect(formatted).toContain('• Blood Pressure: 128/82 mmHg');
      expect(formatted).toContain('• Pulse / Heart Rate: 76 bpm regular');
      expect(formatted).toContain('• Temperature: 37.0°C / 98.6°F');
      expect(formatted).toContain('• Oxygen Saturation (SpO2): 99% on room air');
      expect(formatted).toContain('• Respiratory Rate: 16/min');
    });

    it('extracts temperature in Celsius and alternative phrasing', () => {
      const transcript = 'Vitals taken: T 37.5 C, BP 130/85, pulse 80, SpO2 97%.';
      const vitals = extractVitals(transcript);

      expect(vitals.bp).toBe('130/85 mmHg');
      expect(vitals.temp).toBe('37.5°C / 99.5°F');
      expect(vitals.hr).toBe('80 bpm regular');
      expect(vitals.spo2).toBe('97% on room air');
    });
  });

  describe('Headache Documentation Synthesis', () => {
    it('synthesizes a headache note with specific neurological/HEENT exam, headache ICD-10, and not generic consultation', () => {
      const transcript = 'The patient complains of severe throbbing headache with photophobia and nausea for the past 2 days. BP is 120/80, temp is 98.4 F, SpO2 is 98%. Sensation intact, cranial nerves II-XII intact, no focal neurological deficits, supple neck.';
      
      const note = formatClinicalDictationToSOAP(transcript, '', 'Follow-up', {
        patientName: 'Jane Doe',
        dob: '1985-05-15',
        mrn: 'MRN12345',
        clinicianName: 'Dr. Smith',
      });

      // Must have VITAL SIGNS: section containing BP, Temp, SpO2
      expect(note).toContain('VITAL SIGNS:');
      expect(note).toContain('• Blood Pressure: 120/80 mmHg');
      expect(note).toContain('• Temperature: 36.9°C / 98.4°F');
      expect(note).toContain('• Oxygen Saturation (SpO2): 98% on room air');

      // Assessment must NOT be the generic fallback
      expect(note).not.toContain('Clinical Consultation & Evaluation');
      expect(note).not.toContain('Clinical Consultation and Evaluation');

      // Must correctly identify Headache / Migraine
      expect(note).toMatch(/Headache|Migraine/i);
      expect(note).toMatch(/R51\.9|G43\.909/);

      // Must include headache physical exam findings
      expect(note).toMatch(/Cranial nerves II-XII grossly intact|neurologic/i);

      // Must include headache red flags / return precautions in plan
      expect(note).toMatch(/thunderclap|neck stiffness|warning signs/i);
    });
  });

  describe('Medications Extraction & Reconciliation', () => {
    it('extracts all medications and includes CURRENT MEDICATIONS section in SOAP note', () => {
      const transcript = `
Patient Arthur Pendelton presents for bilateral knee pain and hypertension management.
Vitals: BP 134/82 mmHg, HR 72 bpm.
Medications: Lisinopril 20mg once daily, Atorvastatin 20mg at bedtime, Tylenol 500mg PRN.
Physical Exam: Bilateral knee tenderness.
Plan:
1. ORDER: Request bilateral hyaluronic acid injections.
2. Refill Lisinopril 20mg oral daily for blood pressure control.
3. Follow up in 6 weeks.
      `.trim();

      const note = formatClinicalDictationToSOAP(transcript, '', 'Follow-up', {
        patientName: 'Arthur Pendelton',
        mrn: 'MRN-30M-1234',
      });

      expect(note).toContain('CURRENT MEDICATIONS:');
      expect(note).toContain('• Lisinopril 20mg once daily');
      expect(note).toContain('• Atorvastatin 20mg at bedtime');
      expect(note).toContain('• Tylenol 500mg PRN');
      expect(note).toContain('Refill Lisinopril 20mg oral daily for blood pressure control');
    });

    it('strictly prevents cross-section bleeding and cleans inline dictation', () => {
      const rawTranscript = `Patient Barbara McClintock, 45-year-old female presenting with headache. Chief Complaint: Dull bilateral headache towards end of day. History of Present Illness: Symptoms associated with prolonged microscope usage. Denies visual aura, nausea, or fever. Vitals: BP 120/76 mmHg, HR 72 bpm, Temp 98.4 F, SpO2 99%. Medications: Ibuprofen 400mg PRN, Acetaminophen 500mg PRN, Artificial tears 1 drop QID PRN. Physical Examination: Normal cranial nerve exam, cervical range of motion full, no temporal artery tenderness. Assessment: 1. Headache, unspecified. 2. Digital / optical eye strain. Plan: 1. Refill Ibuprofen 400mg PRN for headache relief. 2. Follow 20-20-20 screen rule. 3. Follow-up as needed.`;

      const soap = formatClinicalDictationToSOAP(rawTranscript, '', 'Follow-up', {
        patientName: 'Barbara McClintock',
        patientAge: '45 yrs',
      });

      // Chief Complaint must NOT contain subsequent sections
      expect(soap).toMatch(/CHIEF COMPLAINT:\s*\nDull bilateral headache towards end of day\b/);

      // HPI must NOT contain vitals or medications
      expect(soap).toMatch(/HISTORY OF PRESENT ILLNESS \(HPI\):\s*\nSymptoms associated with prolonged microscope usage\. Denies visual aura, nausea, or fever/);

      // Current medications must only contain the 3 drugs, not physical exam
      expect(soap).toContain('• Ibuprofen 400mg PRN');
      expect(soap).toContain('• Acetaminophen 500mg PRN');
      expect(soap).toContain('• Artificial tears 1 drop QID PRN');

      // Physical exam must not contain assessment
      expect(soap).toContain('• Normal cranial nerve exam');

      // Assessment must be properly grouped
      expect(soap).toMatch(/1\. Headache, unspecified\.\s*\n2\. Digital \/ optical eye strain/);
    });
  });

  describe('Personal Information & Non-Clinical Dictation Synthesis', () => {
    it('synthesizes a complete administrative intake note when only personal information is dictated', () => {
      const personalDictation = 'Patient name is Robert Miller, 54 years old, born August 12 1970, lives at 45 Elm Street, phone number 555-1234, married with two children, works as an accountant.';

      const note = formatClinicalDictationToSOAP(personalDictation, '', 'Follow-up');

      // Chief complaint must indicate intake & personal information documentation
      expect(note).toContain('CHIEF COMPLAINT:\nPatient Intake & Personal Information Documentation');

      // HPI must contain all personal details
      expect(note).toContain('Robert Miller');
      expect(note).toContain('54-year-old');
      expect(note).toContain('August 12 1970');
      expect(note).toContain('45 Elm Street');
      expect(note).toContain('555-1234');
      expect(note).toContain('accountant');
      expect(note).toContain('married with two children');
      expect(note).toContain('No acute medical symptoms, active complaints, or physical distress were dictated');

      // Physical examination deferred for administrative intake
      expect(note).toContain('Not documented this encounter / deferred for administrative intake.');

      // Assessment & Plan for administrative documentation
      expect(note).toContain('Encounter for administrative intake and personal demographic record documentation (Z02.89).');
      expect(note).toContain('Personal demographic profile and registration record updated in EHR.');

      // Proper coding
      expect(note).toContain('Z02.89 — Encounter for other administrative examinations');
      expect(note).toContain('99212 — Office or other outpatient visit');
    });

    it('preserves non-clinical dictation without loss even when arbitrary text is spoken', () => {
      const arbitraryDictation = 'Patient is checking in for registration verification. Updated emergency contact is Sarah Miller at 555-8899.';
      const note = formatClinicalDictationToSOAP(arbitraryDictation, '', 'Follow-up');

      expect(note).toContain('CHIEF COMPLAINT:');
      expect(note).toContain('Sarah Miller');
      expect(note).toContain('555-8899');
    });
  });
});

