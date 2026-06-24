# Transcription Confidence Scores

- **Fix ID:** fix-confidence-scores
- **Audit ref:** MEDIUM-CONFIDENCE
- **Priority:** MEDIUM
- **Generated:** 2026-06-24 08:42:33
- **Duration:** 0.2s

## Summary

Added notes.confidence_score/confidence_scores columns, Deepgram confidence extraction utility, ConfidenceBadge UI component, and CSS styling.

## Changes

| Action | Path |
|--------|------|
| modified | anot-frontend-main\anot-frontend-main\src\utils\confidence.js |
| modified | anot-frontend-main\anot-frontend-main\src\components\ConfidenceBadge.jsx |

## Rollback

Run: powershell -File scripts/fix-confidence-scores.ps1 -Rollback

Or restore from backup manifest: dist/fix-backups/fix-confidence-scores/manifest.json

## Next steps

- Apply migration: psql -f migrations/20260624_confidence_scores.sql
- Wire extractConfidence into transcription save path in transcriptionService.js
- Add <ConfidenceBadge score={note.confidence_score} /> in Scribe/Clinician views
