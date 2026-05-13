const express = require('express')
const router  = express.Router()
const {
  getNoteByVisit,
  getMyNotes,
  getAllNotes,
  getClinicianNotes,
  getMyGrades,
  saveDraft,
  submitNote,
  requestEdit,
  submitGrade,
} = require('../controllers/noteController')
const { protect, restrict } = require('../middleware/auth')

router.use(protect)

// ─── NOTE ROUTES ──────────────────────────────────────────────────────────────

router.get('/',               restrict('admin', 'super_admin', 'qps'), getAllNotes)
router.get('/my',             restrict('scribe'),        getMyNotes)
router.get('/clinician',      restrict('clinician'),     getClinicianNotes)
router.get('/my-grades',      restrict('scribe'),        getMyGrades)
router.get('/visit/:visitId',                            getNoteByVisit)
router.post('/draft',         restrict('scribe'),        saveDraft)
router.put('/:id/submit',     restrict('scribe'),        submitNote)
router.put('/:id/request-edit', restrict('clinician'),   requestEdit)
router.post('/grade',         restrict('qps'),           submitGrade)

module.exports = router