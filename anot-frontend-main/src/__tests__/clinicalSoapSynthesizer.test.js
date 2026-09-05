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
});
