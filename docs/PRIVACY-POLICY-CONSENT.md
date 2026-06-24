## User Consent Management

Anot Health tracks explicit user consent for:

| Consent type | Purpose |
|--------------|---------|
| privacy_policy | Acceptance of Privacy Policy version |
| terms_of_service | Acceptance of Terms of Service |
| phi_processing | Authorization to process PHI for clinical documentation |
| marketing | Optional marketing communications |

Consent records include version, timestamp, IP address, and user agent for audit purposes.
Users may revoke optional consents via the account settings API (`POST /api/consent/me`).

Data retention: consent records are retained for the life of the account plus 7 years per HIPAA audit requirements.