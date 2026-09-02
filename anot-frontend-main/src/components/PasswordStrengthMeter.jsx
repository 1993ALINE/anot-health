import { getPasswordStrength, getPasswordChecks, MIN_LENGTH } from '../utils/passwordPolicy'

const RULES = [
  { key: 'length', label: `At least ${MIN_LENGTH} characters` },
  { key: 'uppercase', label: 'One uppercase letter' },
  { key: 'lowercase', label: 'One lowercase letter' },
  { key: 'number', label: 'One number' },
  { key: 'special', label: 'One special character' },
]

/**
 * Live password strength indicator + rule checklist.
 * Self-contained inline styles so it renders consistently across every portal.
 *
 * @param {string} password   Current password value.
 * @param {boolean} showChecklist Show the per-rule checklist (default true).
 */
export default function PasswordStrengthMeter({ password = '', showChecklist = true }) {
  if (!password) {return null}

  const strength = getPasswordStrength(password)
  const checks = getPasswordChecks(password)

  return (
    <div style={{ marginTop: 8 }} aria-live="polite">
      <div
        style={{
          display: 'flex',
          gap: 4,
          marginBottom: 6,
        }}
      >
        {[0, 1, 2, 3, 4].map((i) => (
          <span
            key={i}
            style={{
              flex: 1,
              height: 4,
              borderRadius: 999,
              background: i <= strength.score ? strength.color : '#E5E7EB',
              transition: 'background 0.2s ease',
            }}
          />
        ))}
      </div>
      <div
        style={{
          fontSize: 12,
          fontWeight: 600,
          color: strength.color,
          marginBottom: showChecklist ? 8 : 0,
        }}
      >
        Password strength: {strength.label}
      </div>

      {showChecklist && (
        <ul
          style={{
            listStyle: 'none',
            margin: 0,
            padding: 0,
            display: 'grid',
            gridTemplateColumns: '1fr 1fr',
            gap: '2px 12px',
          }}
        >
          {RULES.map((rule) => {
            const ok = checks[rule.key]
            return (
              <li
                key={rule.key}
                style={{
                  fontSize: 11.5,
                  display: 'flex',
                  alignItems: 'center',
                  gap: 6,
                  color: ok ? '#16A34A' : '#6B7280',
                }}
              >
                <span aria-hidden style={{ fontSize: 12 }}>{ok ? '✓' : '○'}</span>
                {rule.label}
              </li>
            )
          })}
        </ul>
      )}
    </div>
  )
}
