// Must stay in sync with DB constraint `visits_visit_type_check` (see migrations/).
const ALLOWED_VISIT_TYPES = ['Follow-up', 'New Patient', 'Virtual Visit', 'Other']

module.exports = { ALLOWED_VISIT_TYPES }
