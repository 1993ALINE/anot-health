import { useState, useMemo, useEffect } from 'react'

const DEFAULT_CATEGORIES = [
  'All',
  'Core Primary Care',
  'Chronic Disease Management (CDM)',
  'Preventive & Life-Stage',
  'Mental Health & Addictions',
  "Women's Health & Perinatal",
  'Virtual Care & Occupational',
  'Other / Custom',
]

const QUICK_SECTIONS = [
  'CHIEF COMPLAINT:',
  'HISTORY OF PRESENT ILLNESS (HPI):',
  'PAST MEDICAL HISTORY:',
  'CURRENT MEDICATIONS & ALLERGIES:',
  'REVIEW OF SYSTEMS (ROS):',
  'VITAL SIGNS:',
  'PHYSICAL EXAMINATION:',
  'ASSESSMENT & PLAN:',
  'PATIENT COUNSELING & PREVENTIVE GUIDANCE:',
  'FOLLOW-UP & RETURN PRECAUTIONS:',
]

/** Extracts detected section headers ending with a colon */
function detectHeaders(text) {
  if (!text) { return [] }
  return String(text)
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l.endsWith(':') && l.length > 2)
    .map((l) => l.slice(0, -1).trim())
}

export default function ClinicianTemplateModal({
  isOpen,
  onClose,
  templates = [],
  onSaveTemplates,
  defaultTemplates = [],
  currentDoctorName = 'Doctor',
  initialAiInstructions = '',
}) {
  const [modalTab, setModalTab] = useState('templates')
  const [aiInstructions, setAiInstructions] = useState(initialAiInstructions || '')
  const [templateList, setTemplateList] = useState(templates)
  const [selectedId, setSelectedId] = useState(templates[0]?.id || 'soap-adult')
  const [activeCategory, setActiveCategory] = useState('All')
  const [searchQuery, setSearchQuery] = useState('')
  const [saving, setSaving] = useState(false)
  const [feedbackMsg, setFeedbackMsg] = useState(null)

  useEffect(() => {
    if (initialAiInstructions) {
      setAiInstructions(initialAiInstructions)
    }
  }, [initialAiInstructions])

  // Keep templateList synced if templates prop changes
  useMemo(() => {
    if (templates && templates.length > 0) {
      setTemplateList(templates)
      if (!templates.some((t) => t.id === selectedId)) {
        setSelectedId(templates[0]?.id || 'soap-adult')
      }
    }
  }, [templates])

  const selectedTemplate = useMemo(() => {
    return templateList.find((t) => t.id === selectedId) || templateList[0] || null
  }, [templateList, selectedId])

  useEffect(() => {
    if (!isOpen) { return undefined }
    const handleKeyDown = (e) => {
      if (e.key === 'Escape') { onClose() }
    }
    window.addEventListener('keydown', handleKeyDown)
    return () => window.removeEventListener('keydown', handleKeyDown)
  }, [isOpen, onClose])

  const filteredTemplates = useMemo(() => {
    return templateList.filter((t) => {
      const matchesCat =
        activeCategory === 'All' ||
        (t.category && t.category.toLowerCase() === activeCategory.toLowerCase()) ||
        (activeCategory === 'Other / Custom' && (!t.category || t.category.includes('Custom') || t.category.includes('Other')))
      const matchesSearch =
        !searchQuery ||
        t.name?.toLowerCase().includes(searchQuery.toLowerCase()) ||
        t.id?.toLowerCase().includes(searchQuery.toLowerCase())
      return matchesCat && matchesSearch
    })
  }, [templateList, activeCategory, searchQuery])

  if (!isOpen) { return null }

  const handleUpdateCurrent = (field, value) => {
    setTemplateList((prev) =>
      prev.map((t) => {
        if (t.id === selectedId) {
          return { ...t, [field]: value, isCustom: true }
        }
        return t
      })
    )
  }

  const handleInsertSection = (header) => {
    if (!selectedTemplate) { return }
    const current = selectedTemplate.content || ''
    const addition = current.endsWith('\n') ? `${header}\n\n` : `\n\n${header}\n\n`
    handleUpdateCurrent('content', current + addition)
  }

  const handleCreateNew = () => {
    const newId = `custom-template-${Date.now().toString().slice(-6)}`
    const newTmpl = {
      id: newId,
      name: 'Custom Clinical Note Template',
      category: activeCategory !== 'All' ? activeCategory : 'Core Primary Care',
      icon: '📝',
      color: '#E3F2FD',
      accent: '#1D68CD',
      isCustom: true,
      content:
        'CHIEF COMPLAINT:\n\n\nHISTORY OF PRESENT ILLNESS (HPI):\n\n\nVITAL SIGNS:\n\n\nPHYSICAL EXAMINATION:\n\n\nASSESSMENT & PLAN:\n\n\nFOLLOW-UP:\n',
    }
    setTemplateList((prev) => [newTmpl, ...prev])
    setSelectedId(newId)
    setFeedbackMsg({ type: 'info', text: 'New custom template created. Edit sections and click Save.' })
  }

  const handleDuplicate = () => {
    if (!selectedTemplate) { return }
    const dupId = `custom-${selectedTemplate.id}-${Date.now().toString().slice(-4)}`
    const duplicated = {
      ...selectedTemplate,
      id: dupId,
      name: `${selectedTemplate.name} (Copy)`,
      isCustom: true,
    }
    setTemplateList((prev) => [duplicated, ...prev])
    setSelectedId(dupId)
    setFeedbackMsg({ type: 'info', text: `Created copy: "${duplicated.name}".` })
  }

  const handleDelete = (idToDelete) => {
    const target = templateList.find((t) => t.id === idToDelete)
    if (!target) { return }
    if (!window.confirm(`Are you sure you want to remove "${target.name}"?`)) {
      return
    }
    const updated = templateList.filter((t) => t.id !== idToDelete)
    setTemplateList(updated)
    if (selectedId === idToDelete) {
      setSelectedId(updated[0]?.id || '')
    }
    setFeedbackMsg({ type: 'info', text: `Removed "${target.name}". Click Save to persist changes.` })
  }

  const handleResetToDefault = () => {
    if (!selectedTemplate) { return }
    const orig = defaultTemplates.find((d) => d.id === selectedTemplate.id)
    if (!orig) {
      alert('This is a custom template with no system default.')
      return
    }
    if (window.confirm(`Reset "${selectedTemplate.name}" back to the standard Canadian primary care guidelines structure?`)) {
      handleUpdateCurrent('content', orig.content)
      handleUpdateCurrent('name', orig.name)
      if (orig.category) { handleUpdateCurrent('category', orig.category) }
      setFeedbackMsg({ type: 'info', text: 'Reset to clinical system default.' })
    }
  }

  const handleSaveAll = async () => {
    setSaving(true)
    setFeedbackMsg(null)
    try {
      await onSaveTemplates(templateList, aiInstructions)
      setFeedbackMsg({ type: 'success', text: '✓ Templates and Claude directives successfully saved to your provider profile!' })
      setTimeout(() => {
        setFeedbackMsg(null)
      }, 3500)
    } catch (err) {
      setFeedbackMsg({ type: 'error', text: err?.message || 'Failed to save templates.' })
    } finally {
      setSaving(false)
    }
  }

  const detectedSections = detectHeaders(selectedTemplate?.content || '')

  return (
    <div
      className="sm-modal-overlay"
      onClick={onClose}
      role="dialog"
      aria-modal="true"
      aria-labelledby="sm-tmpl-modal-title"
    >
      <div className="sm-template-manager-modal" onClick={(e) => e.stopPropagation()}>
        {/* Header */}
        <div className="sm-modal__header sm-tmpl-header">
          <div className="sm-modal__title-group">
            <div className="sm-tmpl-badge-title">
              <span className="sm-tmpl-main-icon">📋</span>
              <h3 id="sm-tmpl-modal-title">Clinical Note Template Studio</h3>
              <span className="sm-tmpl-provider-pill">Dr. {currentDoctorName}</span>
            </div>
            <p className="sm-tmpl-subhead">
              Customize headings, structure, and clinical prompts for your individual provider profile.
              The AI scribe structures all generated notes according to your saved sections.
            </p>
          </div>
          <button type="button" className="sm-btn-close-modal" onClick={onClose} aria-label="Close modal">
            ✕
          </button>
        </div>

        {/* Status Alert Banner */}
        {feedbackMsg && (
          <div className={`sm-tmpl-banner sm-tmpl-banner--${feedbackMsg.type}`}>
            <span>{feedbackMsg.text}</span>
          </div>
        )}

        {/* Tab Switcher */}
        <div style={{ display: 'flex', gap: 10, padding: '10px 24px', borderBottom: '1px solid var(--border, #e2e8f0)', background: '#f8fafc' }}>
          <button
            type="button"
            className={`sm-tmpl-cat-pill ${modalTab === 'templates' ? 'sm-tmpl-cat-pill--active' : ''}`}
            style={{ borderRadius: 8, padding: '8px 16px', fontSize: 13, fontWeight: 700, cursor: 'pointer' }}
            onClick={() => setModalTab('templates')}
          >
            📋 Note Templates ({templateList.length})
          </button>
          <button
            type="button"
            className={`sm-tmpl-cat-pill ${modalTab === 'claude_directives' ? 'sm-tmpl-cat-pill--active' : ''}`}
            style={{ borderRadius: 8, padding: '8px 16px', fontSize: 13, fontWeight: 700, cursor: 'pointer' }}
            onClick={() => setModalTab('claude_directives')}
          >
            🤖 Claude Note Directives {aiInstructions?.trim() ? '✓' : ''}
          </button>
        </div>

        {/* Tab 2: Claude Directives View */}
        {modalTab === 'claude_directives' ? (
          <div style={{ padding: '24px', overflowY: 'auto', flex: 1, display: 'flex', flexDirection: 'column', gap: 16 }}>
            <div style={{ background: '#f0fdf4', border: '1px solid #bbf7d0', borderRadius: 10, padding: '16px 20px' }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 6 }}>
                <span style={{ fontSize: 20 }}>🤖</span>
                <strong style={{ fontSize: 16, color: '#166534' }}>Attending Clinician Claude Directives</strong>
                <span style={{ marginLeft: 'auto', fontSize: 11, fontWeight: 700, color: '#15803d', background: '#dcfce7', padding: '2px 8px', borderRadius: 12 }}>
                  Active Prompt Layer
                </span>
              </div>
              <p style={{ margin: 0, fontSize: 13, color: '#166534', lineHeight: 1.5 }}>
                Instruct Claude on exactly how to formulate and present your clinical notes. These instructions take immediate effect on all draft generations and dictation processing for your visits.
              </p>
            </div>

            <div>
              <label style={{ display: 'block', fontWeight: 700, fontSize: 14, marginBottom: 8, color: 'var(--text-main, #0f172a)' }}>
                Your Custom Claude Prompt Directives:
              </label>
              <textarea
                className="sm-tmpl-textarea"
                rows={10}
                style={{ width: '100%', minHeight: 180, boxSizing: 'border-box', fontFamily: 'inherit', fontSize: 14, lineHeight: 1.6 }}
                placeholder="e.g. Always structure the Assessment & Plan by numbered clinical problem with explicit diagnostic reasoning and follow-up timeline. Keep HPI strictly under 3 sentences. Emphasize patient lifestyle counseling."
                value={aiInstructions}
                onChange={(e) => setAiInstructions(e.target.value)}
              />
            </div>

            <div>
              <span style={{ fontSize: 12, fontWeight: 700, color: '#64748b', display: 'block', marginBottom: 8 }}>
                Quick Add Directive Suggestions:
              </span>
              <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8 }}>
                {[
                  { label: 'Numbered A&P by Problem', text: 'Format Assessment & Plan as numbered clinical problems with distinct diagnostics, therapy, and follow-up plans.' },
                  { label: 'Concise HPI (under 3 sentences)', text: 'Keep the History of Present Illness (HPI) strictly under 3 concise sentences focusing only on acute onset and primary symptoms.' },
                  { label: 'Lifestyle Counseling Focus', text: 'Document all patient lifestyle, nutrition, and exercise counseling in detail under the Assessment & Plan.' },
                  { label: 'Standard Chronic Disease CDM Layout', text: 'For chronic disease follow-up, list each chronic condition with glycemic/BP control status, adherence, and medication titration.' },
                ].map((s) => (
                  <button
                    key={s.label}
                    type="button"
                    className="sm-tmpl-section-btn"
                    style={{ fontSize: 12, padding: '6px 12px' }}
                    onClick={() => {
                      setAiInstructions((prev) => {
                        const trimmed = (prev || '').trim()
                        return trimmed ? `${trimmed}\n\n${s.text}` : s.text
                      })
                    }}
                  >
                    + {s.label}
                  </button>
                ))}
              </div>
            </div>

            <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 12, marginTop: 'auto', paddingTop: 16, borderTop: '1px solid var(--border, #e2e8f0)' }}>
              <button type="button" className="sm-btn-cancel-clean" onClick={onClose}>
                Cancel
              </button>
              <button
                type="button"
                className="sm-btn-save-tmpl"
                onClick={handleSaveAll}
                disabled={saving}
              >
                {saving ? 'Saving...' : '💾 Save Directives to Profile'}
              </button>
            </div>
          </div>
        ) : (
        /* Body Layout */
        <div className="sm-tmpl-body">
          {/* Left Column: Template Roster */}
          <div className="sm-tmpl-sidebar">
            <div className="sm-tmpl-sidebar__actions">
              <button
                type="button"
                className="sm-btn-new-tmpl"
                onClick={handleCreateNew}
                title="Create a new custom template"
              >
                <span>+</span> New Custom Template
              </button>
            </div>

            <div className="sm-tmpl-search-wrap">
              <span className="sm-tmpl-search-icon">🔍</span>
              <input
                type="text"
                className="sm-tmpl-search-input"
                placeholder="Search templates..."
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
              />
              {searchQuery && (
                <button
                  type="button"
                  className="sm-tmpl-search-clear"
                  onClick={() => setSearchQuery('')}
                  aria-label="Clear search"
                >
                  ✕
                </button>
              )}
            </div>

            {/* Category Filter Pills */}
            <div className="sm-tmpl-categories-row">
              {DEFAULT_CATEGORIES.map((cat) => (
                <button
                  key={cat}
                  type="button"
                  className={`sm-tmpl-cat-pill ${activeCategory === cat ? 'sm-tmpl-cat-pill--active' : ''}`}
                  onClick={() => setActiveCategory(cat)}
                >
                  {cat}
                </button>
              ))}
            </div>

            {/* Template List */}
            <div className="sm-tmpl-roster">
              {filteredTemplates.length === 0 ? (
                <div className="sm-tmpl-empty-roster">No templates match filter.</div>
              ) : (
                filteredTemplates.map((t) => {
                  const isSelected = t.id === selectedId
                  const isCustom = t.isCustom || !defaultTemplates.some((d) => d.id === t.id)
                  return (
                    <div
                      key={t.id}
                      className={`sm-tmpl-item ${isSelected ? 'sm-tmpl-item--active' : ''}`}
                      onClick={() => setSelectedId(t.id)}
                      role="button"
                      tabIndex={0}
                      aria-pressed={isSelected}
                      aria-label={`Select template ${t.name}`}
                      onKeyDown={(e) => {
                        if (e.key === 'Enter' || e.key === ' ') {
                          e.preventDefault()
                          setSelectedId(t.id)
                        }
                      }}
                    >
                      <div className="sm-tmpl-item__icon">{t.icon || '📄'}</div>
                      <div className="sm-tmpl-item__content">
                        <div className="sm-tmpl-item__name-row">
                          <span className="sm-tmpl-item__name">{t.name}</span>
                          {isCustom && <span className="sm-tmpl-badge-custom">Custom</span>}
                        </div>
                        <span className="sm-tmpl-item__category">{t.category || 'Core Primary Care'}</span>
                      </div>
                      {isCustom && (
                        <button
                          type="button"
                          className="sm-tmpl-item__btn-del"
                          onClick={(e) => {
                            e.stopPropagation()
                            handleDelete(t.id)
                          }}
                          title="Delete custom template"
                          aria-label={`Delete template "${t.name}"`}
                        >
                          🗑
                        </button>
                      )}
                    </div>
                  )
                })
              )}
            </div>
          </div>

          {/* Right Column: Template Editor */}
          <div className="sm-tmpl-editor-panel">
            {selectedTemplate ? (
              <div className="sm-tmpl-form">
                {/* Meta Inputs */}
                <div className="sm-tmpl-form-grid">
                  <div className="sm-tmpl-field">
                    <label className="sm-tmpl-label">Template Name *</label>
                    <input
                      type="text"
                      className="sm-tmpl-input"
                      value={selectedTemplate.name || ''}
                      onChange={(e) => handleUpdateCurrent('name', e.target.value)}
                      placeholder="e.g. SOAP Note — Adult (Standard / Episodic)"
                    />
                  </div>
                  <div className="sm-tmpl-field">
                    <label className="sm-tmpl-label">Category</label>
                    <select
                      className="sm-tmpl-select"
                      value={selectedTemplate.category || 'Core Primary Care'}
                      onChange={(e) => handleUpdateCurrent('category', e.target.value)}
                    >
                      {DEFAULT_CATEGORIES.filter((c) => c !== 'All').map((c) => (
                        <option key={c} value={c}>{c}</option>
                      ))}
                    </select>
                  </div>
                </div>

                {/* Quick Section Insert Bar */}
                <div className="sm-tmpl-quick-sections">
                  <span className="sm-tmpl-quick-title">Quick Insert Section Header:</span>
                  <div className="sm-tmpl-quick-chips">
                    {QUICK_SECTIONS.map((sec) => (
                      <button
                        key={sec}
                        type="button"
                        className="sm-tmpl-chip-insert"
                        onClick={() => handleInsertSection(sec)}
                        title={`Insert ${sec} at end of template`}
                      >
                        + {sec.replace(':', '')}
                      </button>
                    ))}
                  </div>
                </div>

                {/* Content Editor */}
                <div className="sm-tmpl-content-field">
                  <div className="sm-tmpl-content-header">
                    <label className="sm-tmpl-label">Note Sections & Structure (Markdown / Text)</label>
                    <span className="sm-tmpl-hint">
                      Each line ending with a colon (<code>:</code>) is treated as a clinical section header.
                    </span>
                  </div>
                  <textarea
                    className="sm-tmpl-textarea"
                    rows={12}
                    value={selectedTemplate.content || ''}
                    onChange={(e) => handleUpdateCurrent('content', e.target.value)}
                    placeholder="Enter template section headers and prompts..."
                    spellCheck="false"
                  />
                </div>

                {/* Detected Sections Live Preview */}
                <div className="sm-tmpl-detected-box">
                  <div className="sm-tmpl-detected-header">
                    <span className="sm-tmpl-detected-icon">⚡</span>
                    <strong>Detected AI Sections ({detectedSections.length})</strong>
                    <span className="sm-tmpl-detected-note">— Generated notes will follow this layout:</span>
                  </div>
                  <div className="sm-tmpl-detected-pills">
                    {detectedSections.length === 0 ? (
                      <span className="sm-tmpl-detected-empty">No section headers detected. Add lines ending with a colon (e.g. <code>CHIEF COMPLAINT:</code>).</span>
                    ) : (
                      detectedSections.map((sec, idx) => (
                        <span key={sec} className="sm-tmpl-section-pill">
                          <span className="sm-tmpl-sec-num">{idx + 1}</span> {sec}
                        </span>
                      ))
                    )}
                  </div>
                </div>
              </div>
            ) : (
              <div className="sm-tmpl-no-selection">Select a template on the left to edit its structure.</div>
            )}

            {/* Bottom Actions Bar */}
            <div className="sm-tmpl-footer">
              <div className="sm-tmpl-footer-left">
                {defaultTemplates.some((d) => d.id === selectedTemplate?.id) && (
                  <button
                    type="button"
                    className="sm-btn-secondary-clean"
                    onClick={handleResetToDefault}
                    title="Revert this template to standard Canadian clinical guidelines"
                  >
                    ↺ Reset to Default
                  </button>
                )}
                {selectedTemplate && (
                  <button
                    type="button"
                    className="sm-btn-secondary-clean"
                    onClick={handleDuplicate}
                    title="Make a copy of this template"
                  >
                    Duplicate
                  </button>
                )}
              </div>

              <div className="sm-tmpl-footer-right">
                <button
                  type="button"
                  className="sm-btn-cancel-clean"
                  onClick={onClose}
                >
                  Cancel
                </button>
                <button
                  type="button"
                  className="sm-btn-save-tmpl"
                  onClick={handleSaveAll}
                  disabled={saving}
                >
                  {saving ? 'Saving...' : '💾 Save Templates to Profile'}
                </button>
              </div>
            </div>
          </div>
        </div>
        )}
      </div>
    </div>
  )
}
