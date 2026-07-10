-- Raise stale ffmpeg_max_upload_mb default (was 100) to match nginx/Multer 500 MB ceiling.
-- Only bumps rows still at the old schema default; admin-custom values below 500 are preserved
-- unless they exactly match the legacy default of 100.

ALTER TABLE system_settings
  ALTER COLUMN ffmpeg_max_upload_mb SET DEFAULT 500;

UPDATE system_settings
   SET ffmpeg_max_upload_mb = 500
 WHERE ffmpeg_max_upload_mb = 100;
