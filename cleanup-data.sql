-- ANOT Health: Delete all non-admin data
-- KEEPS: admin users, audit logs, settings

-- Delete notes
DELETE FROM notes WHERE id > 0;

-- Delete visits
DELETE FROM visits WHERE id > 0;

-- Delete patients
DELETE FROM patients WHERE id > 0;

-- Delete audio files (soft delete - mark as deleted)
UPDATE audio_files SET deleted_at = NOW() WHERE id > 0;

-- Delete all non-admin users
DELETE FROM users WHERE role NOT IN ('admin', 'super_admin');

-- Reset sequences
ALTER SEQUENCE patients_id_seq RESTART WITH 1;
ALTER SEQUENCE visits_id_seq RESTART WITH 1;
ALTER SEQUENCE notes_id_seq RESTART WITH 1;
ALTER SEQUENCE users_id_seq RESTART WITH 100;
ALTER SEQUENCE audio_files_id_seq RESTART WITH 1;

-- Verify deletion
SELECT 'Patients remaining:' as check_type, COUNT(*) as count FROM patients
UNION ALL
SELECT 'Visits remaining:', COUNT(*) FROM visits
UNION ALL
SELECT 'Notes remaining:', COUNT(*) FROM notes
UNION ALL
SELECT 'Admin users:', COUNT(*) FROM users WHERE role IN ('admin', 'super_admin')
UNION ALL
SELECT 'Total users:', COUNT(*) FROM users;
