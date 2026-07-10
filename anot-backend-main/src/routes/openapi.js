const express = require('express')
const fs = require('fs')
const path = require('path')
const router = express.Router()
const { protect, restrict } = require('../middleware/auth')

router.get('/openapi.yaml', protect, restrict('admin', 'super_admin'), (req, res) => {
  const specPath = path.join(__dirname, '../../../../docs/openapi.yaml')
  if (!fs.existsSync(specPath)) {
    return res.status(404).json({ error: 'OpenAPI spec not found.' })
  }
  res.type('text/yaml').send(fs.readFileSync(specPath, 'utf8'))
})

router.get('/docs', protect, restrict('admin', 'super_admin'), (req, res) => {
  res.redirect('https://editor.swagger.io/?url=' + encodeURIComponent(`${req.protocol}://${req.get('host')}/api/openapi.yaml`))
})

module.exports = router
