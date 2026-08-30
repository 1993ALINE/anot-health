const { sendHttpError } = require('../utils/errorMessages')
const cloudWatchAudit = require('../utils/logger')
const { auditLog, reportAuditFailure } = require('../utils/auditLogger')
const ehrConnectionsService = require('../services/ehrConnectionsService')
const { getDriver } = require('../services/ehrDrivers')

const listConnections = async (req, res) => {
  try {
    const connections = await ehrConnectionsService.listConnections()
    res.status(200).json({ connections })
  } catch (err) {
    sendHttpError(res, 500, err, { context: 'ehr.listConnections', req })
  }
}

const getConnectionTypes = async (req, res) => {
  try {
    res.status(200).json({ types: ehrConnectionsService.listSupportedTypes() })
  } catch (err) {
    sendHttpError(res, 500, err, { context: 'ehr.getConnectionTypes', req })
  }
}

const createConnection = async (req, res) => {
  try {
    const { ehr_type, name, enabled, credentials, config } = req.body || {}
    if (!ehr_type || !name) {
      return res.status(400).json({ error: 'ehr_type and name are required.' })
    }
    const connection = await ehrConnectionsService.createConnection({ ehr_type, name, enabled, credentials, config })

    void auditLog(req.user, 'EHR_CONNECTION_CREATED', 'ehr_connection', String(connection.id),
      `Created EHR connection "${connection.name}" (${connection.ehr_type})`,
      { req, module_key: 'settings', action_category: 'create', status: 'success' }).catch(reportAuditFailure)
    cloudWatchAudit.logSettingChange(req.user.id, req.user.role, 'ehr_connection_created', null, connection.name, req.clientIp)

    res.status(201).json({ connection })
  } catch (err) {
    if (/No EHR driver registered/.test(err.message)) {
      return res.status(400).json({ error: err.message })
    }
    sendHttpError(res, 500, err, { context: 'ehr.createConnection', req })
  }
}

const updateConnection = async (req, res) => {
  try {
    const { id } = req.params
    const before = await ehrConnectionsService.getConnection(id)
    if (!before) return res.status(404).json({ error: 'EHR connection not found.' })

    const connection = await ehrConnectionsService.updateConnection(id, req.body || {})

    if (before.enabled !== connection.enabled) {
      cloudWatchAudit.logSettingChange(req.user.id, req.user.role, 'ehr_connection_enabled', before.enabled, connection.enabled, req.clientIp)
    }
    void auditLog(req.user, 'EHR_CONNECTION_UPDATED', 'ehr_connection', String(id),
      `Updated EHR connection "${connection.name}"`,
      { req, module_key: 'settings', action_category: 'update', status: 'success' }).catch(reportAuditFailure)

    res.status(200).json({ connection })
  } catch (err) {
    sendHttpError(res, 500, err, { context: 'ehr.updateConnection', req })
  }
}

const deleteConnection = async (req, res) => {
  try {
    const { id } = req.params
    const existing = await ehrConnectionsService.getConnection(id)
    if (!existing) return res.status(404).json({ error: 'EHR connection not found.' })

    await ehrConnectionsService.deleteConnection(id)

    void auditLog(req.user, 'EHR_CONNECTION_DELETED', 'ehr_connection', String(id),
      `Deleted EHR connection "${existing.name}"`,
      { req, module_key: 'settings', action_category: 'delete', status: 'success' }).catch(reportAuditFailure)

    res.status(200).json({ message: 'EHR connection deleted.' })
  } catch (err) {
    sendHttpError(res, 500, err, { context: 'ehr.deleteConnection', req })
  }
}

const testConnection = async (req, res) => {
  try {
    const { id } = req.params
    const connection = await ehrConnectionsService.getConnection(id)
    if (!connection) return res.status(404).json({ error: 'EHR connection not found.' })
    if (!connection.enabled) return res.status(409).json({ error: 'This connection is not enabled.' })
    if (!ehrConnectionsService.hasCompleteCredentials(connection.ehr_type, connection.credentials)) {
      return res.status(409).json({ error: 'This connection is missing required credentials.' })
    }

    const driver = getDriver(connection.ehr_type)
    await driver.testConnection(connection.credentials)
    res.status(200).json({ ok: true })
  } catch (err) {
    sendHttpError(res, 502, err, { context: 'ehr.testConnection', req })
  }
}

module.exports = {
  listConnections,
  getConnectionTypes,
  createConnection,
  updateConnection,
  deleteConnection,
  testConnection,
}
