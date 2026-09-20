-- Adds ai_note_instructions column to users table for clinician-specific custom Claude prompt commands
ALTER TABLE users ADD COLUMN IF NOT EXISTS ai_note_instructions TEXT;
COMMENT ON COLUMN users.ai_note_instructions IS 'Clinician-specific custom instructions and commands for Claude note generation';
