const tebraDriver = require('./tebraDriver')

const DRIVERS = {
  tebra: tebraDriver,
}

/** @returns the driver module for an ehr_type, or throws a clear error for unregistered types. */
function getDriver(ehrType) {
  const driver = DRIVERS[ehrType]
  if (!driver) {
    throw new Error(`No EHR driver registered for type "${ehrType}".`)
  }
  return driver
}

/** Public list for the "add connection" type picker: [{ ehrType, label, credentialFields }] */
function listSupportedTypes() {
  return Object.values(DRIVERS).map((driver) => ({
    ehrType: driver.ehrType,
    label: driver.label,
    credentialFields: driver.credentialFields.map(({ key, label, secret }) => ({ key, label, secret })),
  }))
}

module.exports = { getDriver, listSupportedTypes }
