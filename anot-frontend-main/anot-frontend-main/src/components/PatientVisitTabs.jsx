import { memo } from 'react'

/**
 * Switch between multiple visits for the same patient (e.g. Visit 1 | Visit 2).
 */
function PatientVisitTabs({ visits, activeVisitId, onSelect, getLabel, className = '' }) {
  if (!visits || visits.length <= 1) return null

  return (
    <div className={`patient-visit-tabs${className ? ` ${className}` : ''}`} role="tablist" aria-label="Patient visits">
      {visits.map((v, i) => {
        const isActive = v.id === activeVisitId
        const label = getLabel ? getLabel(v, i + 1, visits.length) : `Visit ${i + 1}`
        return (
          <button
            key={v.id}
            type="button"
            role="tab"
            aria-selected={isActive}
            className={`patient-visit-tabs__tab${isActive ? ' is-active' : ''}`}
            onClick={() => onSelect(v)}
          >
            {label}
          </button>
        )
      })}
    </div>
  )
}

export default memo(PatientVisitTabs)
