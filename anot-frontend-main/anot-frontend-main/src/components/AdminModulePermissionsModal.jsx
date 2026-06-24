import { useCallback, useMemo, useState } from 'react'
import {
    ADMIN_DEFAULT_MODULE_KEYS_FOR_ADMIN,
    ADMIN_GRANTABLE_MODULE_KEYS,
    ADMIN_PORTAL_MODULES,
} from '../auth/roles'
import './adminModulePermissionsModal.css'

function toggleKeyInDraft(draft, key, on) {
    const set = new Set(draft)
    if (on) { set.add(key) }
    else { set.delete(key) }
    return ADMIN_GRANTABLE_MODULE_KEYS.filter((k) => set.has(k))
}

function computeModuleDraft(user) {
    if (user.admin_modules === null || user.admin_modules === undefined) {
        return [...ADMIN_DEFAULT_MODULE_KEYS_FOR_ADMIN]
    }
    if (Array.isArray(user.admin_modules)) {
        return ADMIN_GRANTABLE_MODULE_KEYS.filter((k) => user.admin_modules.includes(k))
    }
    return [...ADMIN_DEFAULT_MODULE_KEYS_FOR_ADMIN]
}

function AdminModulePermissionsModalBody({ user, onClose, onSave, saving }) {
    const [draft, setDraft] = useState(() => computeModuleDraft(user))
    const [error, setError] = useState('')

    const selectedCount = draft.length
    const allSelected = useMemo(
        () => selectedCount === ADMIN_GRANTABLE_MODULE_KEYS.length
            && ADMIN_GRANTABLE_MODULE_KEYS.every((k) => draft.includes(k)),
        [draft, selectedCount],
    )
    const noneSelected = selectedCount === 0

    const onToggleKey = useCallback((key, on) => {
        setDraft((prev) => toggleKeyInDraft(prev, key, on))
    }, [])

    const selectAll = useCallback(() => setDraft([...ADMIN_GRANTABLE_MODULE_KEYS]), [])
    const removeAll = useCallback(() => setDraft([]), [])

    const handleSave = useCallback(async () => {
        setError('')
        try {
            await onSave(draft)
        } catch (e) {
            setError(e?.message || 'Save failed.')
        }
    }, [draft, onSave])

    return (
        <div
            className="adm-modperm-overlay"
            role="presentation"
            onClick={(e) => {
                if (e.target === e.currentTarget && !saving) { onClose() }
            }}
        >
            <div
                className="adm-modperm-dialog"
                role="dialog"
                aria-modal="true"
                aria-labelledby="adm-modperm-title"
            >
                <header className="adm-modperm-head">
                    <div className="adm-modperm-head__icon" aria-hidden>🔐</div>
                    <div className="adm-modperm-head__text">
                        <h2 id="adm-modperm-title" className="adm-modperm-title">Module permissions</h2>
                        <p className="adm-modperm-sub">
                            {user.name}
                            <span className="adm-modperm-sub__sep">·</span>
                            <span className="adm-modperm-sub__email">{user.email}</span>
                        </p>
                    </div>
                    <button
                        type="button"
                        className="adm-modperm-close"
                        aria-label="Close"
                        disabled={saving}
                        onClick={onClose}
                    >
                        ✕
                    </button>
                </header>

                <div className="adm-modperm-toolbar">
                    <div className="adm-modperm-bulk">
                        <button type="button" className="adm-modperm-bulk__btn" onClick={selectAll} disabled={saving || allSelected}>
                            Select all
                        </button>
                        <button type="button" className="adm-modperm-bulk__btn adm-modperm-bulk__btn--ghost" onClick={removeAll} disabled={saving || noneSelected}>
                            Remove all
                        </button>
                    </div>
                    <div className="adm-modperm-summary">
                        <span className="adm-modperm-summary__k">Enabled</span>
                        <span className="adm-modperm-summary__v">
                            {selectedCount} / {ADMIN_GRANTABLE_MODULE_KEYS.length}
                        </span>
                    </div>
                </div>

                <div className="adm-modperm-body">
                    <ul className="adm-modperm-grid" aria-label="Portal modules">
                        {ADMIN_PORTAL_MODULES.map(({ key, icon, label }) => {
                            const on = draft.includes(key)
                            return (
                                <li key={key} className={`adm-modperm-card ${on ? 'adm-modperm-card--on' : ''}`}>
                                    <div className="adm-modperm-card__row">
                                        <div className="adm-modperm-card__icon" aria-hidden>{icon}</div>
                                        <div className="adm-modperm-card__text">
                                            <div className="adm-modperm-card__label">{label}</div>
                                        </div>
                                        <label className="adm-modperm-switch">
                                            <input
                                                type="checkbox"
                                                checked={on}
                                                onChange={(e) => onToggleKey(key, e.target.checked)}
                                            />
                                            <span className="adm-modperm-switch__track" />
                                        </label>
                                    </div>
                                </li>
                            )
                        })}
                    </ul>
                </div>

                {error && <div className="adm-modperm-err">{error}</div>}

                <footer className="adm-modperm-foot">
                    <button type="button" className="adm-modperm-btn adm-modperm-btn--ghost" onClick={onClose} disabled={saving}>
                        Cancel
                    </button>
                    <button
                        type="button"
                        className="adm-modperm-btn adm-modperm-btn--primary"
                        onClick={() => void handleSave()}
                        disabled={saving}
                    >
                        {saving ? 'Saving…' : 'Save & apply'}
                    </button>
                </footer>
            </div>
        </div>
    )
}

export default function AdminModulePermissionsModal({
    open,
    user,
    onClose,
    onSave,
    saving,
}) {
    if (!open || !user) { return null }

    return (
        <AdminModulePermissionsModalBody
            key={user.id}
            user={user}
            onClose={onClose}
            onSave={onSave}
            saving={saving}
        />
    )
}
