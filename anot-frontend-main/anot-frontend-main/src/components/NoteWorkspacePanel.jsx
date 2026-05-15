import { useState } from 'react'

export default function NoteWorkspacePanel({
  title,
  badges = null,
  children,
  className = '',
  defaultExpanded = false,
  allowExpand = true,
}) {
  const [expanded, setExpanded] = useState(defaultExpanded)

  return (
    <div
      className={`sf-panel sf-note-panel${expanded ? ' sf-note-panel--expanded' : ''}${className ? ` ${className}` : ''}`.trim()}
    >
      <div className="sf-panel-head">
        <span className="sf-panel-title">{title}</span>
        <div className="sf-panel-head__actions">
          {badges}
          {allowExpand ? (
            <button
              type="button"
              className="sf-panel-expand-btn"
              onClick={() => setExpanded((v) => !v)}
              aria-pressed={expanded}
              title={expanded ? 'Restore panel size' : 'Expand panel'}
            >
              {expanded ? '⊟' : '⊞'}
            </button>
          ) : null}
        </div>
      </div>
      <div className="sf-panel-body sf-note-panel__body">{children}</div>
    </div>
  )
}
