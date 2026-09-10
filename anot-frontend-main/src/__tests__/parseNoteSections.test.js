import { describe, it, expect } from 'vitest';
import { parseNoteSections } from '../pages/Clinician/ClinicianPortal.jsx';

describe('parseNoteSections - Strict Section Isolation and Formatting', () => {
  it('correctly parses and sanitizes a note with cross-section bleeding', () => {
    const corruptedNote = `CHIEF COMPLAINT:
Dull bilateral headache towards end of day. History of Present Illness: Symptoms associated with prolonged microscope usage. Denies visual aura, nausea, or fever. Vitals: BP 120/76 mmHg, HR 72 bpm, Temp 98.4 F, SpO2 99%. Medications: Ibuprofen 400mg PRN, Acetaminophen 500mg PRN, Artificial tears 1 drop QID PRN. Physical Examination: Normal cranial nerve exam, cervical range of motion full, no temporal artery tenderness. Assessment: 1. Headache, unspecified. 2. Digital / optical eye strain. Plan: 1. Refill Ibuprofen 400mg PRN for headache relief. 2. Follow 20-20-20 screen rule. 3. Follow-up as needed.

HISTORY OF PRESENT ILLNESS (HPI):
Symptoms associated with prolonged microscope usage. Denies visual aura, nausea, or fever. Vitals: BP 120/76 mmHg, HR 72 bpm, Temp 98.4 F, SpO2 99%. Medications: Ibuprofen 400mg PRN, Acetaminophen 500mg PRN, Artificial tears 1 drop QID PRN. Physical Examination: Normal cranial nerve exam, cervical range of motion full, no temporal artery tenderness. Assessment: 1. Headache, unspecified. 2. Digital / optical eye strain. Plan: 1. Refill Ibuprofen 400mg PRN for headache relief. 2. Follow 20-20-20 screen rule. 3. Follow-up as needed.

CURRENT MEDICATIONS:
• Ibuprofen 400mg PRN
• Acetaminophen 500mg PRN
• Artificial tears 1 drop QID PRN. Physical Examination: Normal cranial nerve exam
• cervical range of motion full
• no temporal artery tenderness. Assessment: 1. Headache
• unspecified. 2. Digital / optical eye strain. Plan: 1. Refill Ibuprofen 400mg PRN for headache relief. 2. Follow 20
• 20 screen rule. 3. Follow
• up as needed

VITAL SIGNS:
• Blood Pressure: 120/76 mmHg
• Pulse / Heart Rate: 72 bpm regular
• Temperature: 36.9°C / 98.4°F
• Oxygen Saturation (SpO2): 99% on room air

PHYSICAL EXAMINATION (PE):
Normal cranial nerve exam, cervical range of motion full, no temporal artery tenderness. Assessment: 1. Headache, unspecified. 2. Digital / optical eye strain. Plan: 1. Refill Ibuprofen 400mg PRN for headache relief. 2. Follow 20-20-20 screen rule. 3. Follow-up as needed.

ASSESSMENT & PLAN (A&P):
ASSESSMENT:
1. Headache, unspecified. 2. Digital / optical eye strain. Plan: 1. Refill Ibuprofen 400mg PRN for headache relief. 2. Follow 20-20-20 screen rule. 3. Follow-up as needed.

PLAN:
1. Refill Ibuprofen 400mg PRN for headache relief. 2. Follow 20-20-20 screen rule. 3. Follow-up as needed.

ICD-10 CODES:
R51.9 — Headache, unspecified
I10 — Essential (primary) hypertension
R50.9 — Fever, unspecified

CPT CODES:
99213 — Office or other outpatient visit for evaluation and management of established patient (low-to-moderate complexity)`;

    const sections = parseNoteSections(corruptedNote);
    expect(sections.length).toBeGreaterThan(0);

    const cc = sections.find((s) => s.header === 'CHIEF COMPLAINT');
    expect(cc).toBeDefined();
    expect(cc.content).toBe('Dull bilateral headache towards end of day');
    expect(cc.content).not.toContain('History of Present Illness:');
    expect(cc.content).not.toContain('Vitals:');

    const hpi = sections.find((s) => s.header.includes('HISTORY OF PRESENT ILLNESS'));
    expect(hpi).toBeDefined();
    expect(hpi.content).toBe('Symptoms associated with prolonged microscope usage. Denies visual aura, nausea, or fever');
    expect(hpi.content).not.toContain('Vitals:');
    expect(hpi.content).not.toContain('Medications:');

    const meds = sections.find((s) => s.header.includes('CURRENT MEDICATIONS'));
    expect(meds).toBeDefined();
    expect(meds.content).toContain('• Ibuprofen 400mg PRN');
    expect(meds.content).toContain('• Acetaminophen 500mg PRN');
    expect(meds.content).toContain('• Artificial tears 1 drop QID PRN');
    expect(meds.content).not.toContain('Physical Examination');
    expect(meds.content).not.toContain('cranial nerve');
    expect(meds.content).not.toContain('Assessment:');

    const pe = sections.find((s) => s.header.includes('PHYSICAL EXAMINATION'));
    expect(pe).toBeDefined();
    expect(pe.content).toContain('• Normal cranial nerve exam');
    expect(pe.content).toContain('• Cervical range of motion full');
    expect(pe.content).toContain('• No temporal artery tenderness');
    expect(pe.content).not.toContain('Assessment:');

    const ass = sections.find((s) => s.header === 'ASSESSMENT');
    expect(ass).toBeDefined();
    expect(ass.content).toContain('1. Headache, unspecified.');
    expect(ass.content).toContain('2. Digital / optical eye strain');
    expect(ass.content).not.toContain('Plan:');

    const plan = sections.find((s) => s.header === 'PLAN');
    expect(plan).toBeDefined();
    expect(plan.content).toContain('1. Refill Ibuprofen 400mg PRN for headache relief.');
    expect(plan.content).toContain('2. Follow 20-20-20 screen rule.');
    expect(plan.content).toContain('3. Follow-up as needed.');
  });

  it('correctly parses single-paragraph notes with inline headers', () => {
    const inlineNote = `Patient Barbara McClintock. Chief Complaint: Dull bilateral headache. History of Present Illness: Symptoms associated with microscope usage. Vitals: BP 120/76 mmHg. Medications: Ibuprofen 400mg PRN. Physical Examination: Normal cranial nerve exam. Assessment: 1. Headache. Plan: 1. Refill Ibuprofen.`;

    const sections = parseNoteSections(inlineNote);
    expect(sections.length).toBeGreaterThan(4);

    const cc = sections.find((s) => s.header === 'CHIEF COMPLAINT');
    expect(cc).toBeDefined();
    expect(cc.content).toBe('Dull bilateral headache');

    const hpi = sections.find((s) => s.header.includes('HISTORY OF PRESENT ILLNESS') || s.header === 'HPI');
    expect(hpi).toBeDefined();
    expect(hpi.content).toBe('Symptoms associated with microscope usage');
  });
});
