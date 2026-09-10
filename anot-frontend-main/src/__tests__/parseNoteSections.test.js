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

    const pe = sections.find((s) => s.header.includes('PHYSICAL EXAMINATION') || s.header === 'PE');
    expect(pe).toBeDefined();
    expect(pe.content).toContain('Normal cranial nerve exam');

    const plan = sections.find((s) => s.header.includes('PLAN'));
    expect(plan).toBeDefined();
    expect(plan.content).toContain('Refill Ibuprofen');
  });

  it('accurately preserves Physical Examination (PE) and Plan in AI generated SOAP notes', () => {
    const aiNote = `CHIEF COMPLAINT:
Right knee pain and swelling after athletic activity.

HISTORY OF PRESENT ILLNESS (HPI):
The patient is a 45-year-old presenting with acute right knee pain following a tennis match yesterday. Reports localized swelling and discomfort with weight bearing. Denies numbness or tingling.

CURRENT MEDICATIONS:
• Lisinopril 10mg daily
• Multivitamin 1 tab daily

VITAL SIGNS:
• Blood Pressure: 124/80 mmHg
• Pulse / Heart Rate: 68 bpm regular
• Oxygen Saturation (SpO2): 99% on room air

PHYSICAL EXAMINATION (PE):
• Right Knee: Mild effusion present along the suprapatellar pouch. Tenderness to palpation along the medial joint line. McMurray test mildly positive for medial discomfort. Range of motion: Flexion to 115 degrees (limited by discomfort), full extension to 0 degrees.
• Left Knee: Normal inspection, no effusion, full range of motion, stable ligaments.
• Distal neurovascular exam intact bilaterally.

ASSESSMENT:
1. Acute medial joint line pain of right knee, suspected medial meniscus strain.
2. Controlled essential hypertension.

PLAN:
1. Plain radiographs (X-ray) of right knee, 3 views (standing AP, lateral, sunrise).
2. Conservative management: RICE protocol (Rest, Ice 20 min TID, Compression wrap, Elevation).
3. Meloxicam 7.5mg PO daily with food for 10 days for inflammation.
4. Physical therapy referral for knee stabilization and quad strengthening.
5. Follow-up in clinic in 2 weeks or sooner if severe pain or inability to bear weight.

ICD-10 CODES:
M25.561 — Pain in right knee
I10 — Essential (primary) hypertension

CPT CODES:
99213 — Office visit, established patient, moderate complexity`;

    const sections = parseNoteSections(aiNote);
    expect(sections.length).toBe(9);

    const pe = sections.find((s) => s.header.includes('PHYSICAL EXAMINATION'));
    expect(pe).toBeDefined();
    expect(pe.content).toContain('Right Knee: Mild effusion');
    expect(pe.content).toContain('McMurray test mildly positive');
    expect(pe.content).toContain('Left Knee: Normal inspection');
    expect(pe.content).toContain('Distal neurovascular exam intact');

    const plan = sections.find((s) => s.header === 'PLAN');
    expect(plan).toBeDefined();
    expect(plan.content).toContain('1. Plain radiographs (X-ray)');
    expect(plan.content).toContain('2. Conservative management: RICE protocol');
    expect(plan.content).toContain('3. Meloxicam 7.5mg PO daily');
    expect(plan.content).toContain('4. Physical therapy referral');
    expect(plan.content).toContain('5. Follow-up in clinic in 2 weeks');

    const ass = sections.find((s) => s.header === 'ASSESSMENT');
    expect(ass).toBeDefined();
    expect(ass.content).toContain('1. Acute medial joint line pain');
    expect(ass.content).toContain('2. Controlled essential hypertension');
  });

  it('correctly parses notes with ASSESSMENT & PLAN (A&P) combined header', () => {
    const apNote = `CHIEF COMPLAINT:
Follow-up hypertension

VITAL SIGNS:
• Blood Pressure: 128/82 mmHg

ASSESSMENT & PLAN (A&P):
1. Essential hypertension - well controlled on current regimen. Continue Lisinopril 20mg daily.
2. Routine health maintenance due. Order screening lipid panel and CMP.
3. Follow-up in 6 months.`;

    const sections = parseNoteSections(apNote);
    const apSection = sections.find((s) => s.header.includes('ASSESSMENT & PLAN') || s.header.includes('A&P'));
    expect(apSection).toBeDefined();
    expect(apSection.content).toContain('Essential hypertension');
    expect(apSection.content).toContain('Routine health maintenance');
    expect(apSection.content).toContain('Follow-up in 6 months');
  });
});
