import { cleanAiDraftForDisplay } from '../utils/aiDraftFormat'
import ScribeFinalNoteEditor from './ScribeFinalNoteEditor'

/**
 * Read-only AI draft body for note workspace panels (all roles).
 */
export default function AiDraftReadonly({
  aiDraft,
  loading = false,
  editorClassName = 'scribe-ai-draft-readonly',
}) {
  if (loading) {
    return <div style={{ padding: 12, color: '#64748B', fontSize: 13 }}>Loading...</div>
  }

  if (!aiDraft || !String(aiDraft).trim()) {
    return (
      <div style={{ padding: 16, color: '#64748B', fontSize: 13, lineHeight: 1.7 }}>
        <div style={{ fontWeight: 500, color: '#1E293B', marginBottom: 4 }}>AI draft pending</div>
        <div>Will appear after transcription is processed.</div>
      </div>
    )
  }

  if (String(aiDraft).startsWith('[AI draft unavailable')) {
    return (
      <div
        className="scribe-ai-draft-unavailable"
        style={{ padding: '12px 14px', fontSize: 13, lineHeight: 1.75, color: '#64748b' }}
      >
        {aiDraft}
      </div>
    )
  }

  return (
    <ScribeFinalNoteEditor
      value={cleanAiDraftForDisplay(aiDraft)}
      onChange={() => {}}
      readOnly
      className={editorClassName}
    />
  )
}
