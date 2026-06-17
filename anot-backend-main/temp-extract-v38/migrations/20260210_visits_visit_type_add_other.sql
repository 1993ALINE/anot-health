-- Allow "Other" visit type (matches Clinician UI).
ALTER TABLE visits DROP CONSTRAINT IF EXISTS visits_visit_type_check;
ALTER TABLE visits ADD CONSTRAINT visits_visit_type_check CHECK (
  visit_type::text = ANY (
    ARRAY[
      'Follow-up'::text,
      'New Patient'::text,
      'Virtual Visit'::text,
      'Other'::text
    ]
  )
);
