const DB_NAME = 'AnotHealthDB'
const STORE_NAME = 'audioQueue'
const DB_VERSION = 1

let dbPromise = null

function getDb() {
  if (!dbPromise) {
    dbPromise = initDB()
  }
  return dbPromise
}

export async function initDB() {
  if (typeof indexedDB === 'undefined') {
    throw new Error('IndexedDB is not available in this browser')
  }

  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION)

    request.onerror = () => reject(request.error)
    request.onsuccess = () => resolve(request.result)

    request.onupgradeneeded = (event) => {
      const database = event.target.result
      if (!database.objectStoreNames.contains(STORE_NAME)) {
        const store = database.createObjectStore(STORE_NAME, { keyPath: 'id', autoIncrement: true })
        store.createIndex('status', 'status', { unique: false })
        store.createIndex('timestamp', 'timestamp', { unique: false })
      }
    }
  })
}

function withStore(mode, fn) {
  return getDb().then(
    (db) =>
      new Promise((resolve, reject) => {
        const tx = db.transaction([STORE_NAME], mode)
        const store = tx.objectStore(STORE_NAME)
        const request = fn(store)
        request.onsuccess = () => resolve(request.result)
        request.onerror = () => reject(request.error)
        tx.onerror = () => reject(tx.error)
      }),
  )
}

/**
 * Queue audio for upload when offline.
 * @param {Blob} audioBlob
 * @param {number|string|null} patientId
 * @param {number|string} visitId
 * @param {object} metadata - mode, durationSeconds, patientName, type, etc.
 */
export async function addToQueue(audioBlob, patientId, visitId, metadata = {}) {
  if (!audioBlob?.size || !visitId) {return null}

  const item = {
    audioBlob,
    patientId: patientId ?? null,
    visitId,
    metadata,
    mode: metadata.mode || 'primary',
    durationSeconds: metadata.durationSeconds ?? null,
    patientName: metadata.patientName ?? null,
    timestamp: metadata.timestamp || Date.now(),
    status: 'pending',
    retryCount: 0,
  }

  const id = await withStore('readwrite', (store) => store.add(item))
  window.dispatchEvent(new CustomEvent('offline-queue-changed'))
  return id
}

export async function getQueue() {
  return withStore('readonly', (store) => store.getAll())
}

export async function removeFromQueue(id) {
  await withStore('readwrite', (store) => store.delete(id))
  window.dispatchEvent(new CustomEvent('offline-queue-changed'))
}

export async function clearQueue() {
  await withStore('readwrite', (store) => store.clear())
  window.dispatchEvent(new CustomEvent('offline-queue-changed'))
}

export async function updateQueueItemStatus(id, status) {
  const db = await getDb()
  return new Promise((resolve, reject) => {
    const tx = db.transaction([STORE_NAME], 'readwrite')
    const store = tx.objectStore(STORE_NAME)
    const getRequest = store.get(id)

    getRequest.onerror = () => reject(getRequest.error)
    getRequest.onsuccess = () => {
      const item = getRequest.result
      if (!item) {
        resolve(null)
        return
      }
      item.status = status
      const putRequest = store.put(item)
      putRequest.onerror = () => reject(putRequest.error)
      putRequest.onsuccess = () => {
        window.dispatchEvent(new CustomEvent('offline-queue-changed'))
        resolve(item)
      }
    }
  })
}

export async function updateQueueItem(id, patch) {
  const db = await getDb()
  return new Promise((resolve, reject) => {
    const tx = db.transaction([STORE_NAME], 'readwrite')
    const store = tx.objectStore(STORE_NAME)
    const getRequest = store.get(id)

    getRequest.onerror = () => reject(getRequest.error)
    getRequest.onsuccess = () => {
      const item = getRequest.result
      if (!item) {
        resolve(null)
        return
      }
      Object.assign(item, patch)
      const putRequest = store.put(item)
      putRequest.onerror = () => reject(putRequest.error)
      putRequest.onsuccess = () => {
        window.dispatchEvent(new CustomEvent('offline-queue-changed'))
        resolve(item)
      }
    }
  })
}

export async function getQueueCounts() {
  const queue = await getQueue()
  return {
    total: queue.length,
    pending: queue.filter((i) => i.status === 'pending').length,
    uploading: queue.filter((i) => i.status === 'uploading').length,
    uploaded: queue.filter((i) => i.status === 'uploaded').length,
    failed: queue.filter((i) => i.status === 'failed').length,
  }
}

export async function destroyOfflinePhiDatabase() {
  if (typeof indexedDB === 'undefined') {
    return
  }
  try {
    if (dbPromise) {
      const db = await Promise.race([dbPromise, new Promise((r) => setTimeout(r, 100))])
      if (db && typeof db.close === 'function') {
        db.close()
      }
    }
  } catch {
    /* ignore */
  }
  try {
    await clearQueue()
  } catch {
    /* queue may not exist yet */
  }
  dbPromise = null
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve(false), 200)
    try {
      const request = indexedDB.deleteDatabase(DB_NAME)
      request.onsuccess = () => { clearTimeout(timer); resolve(true) }
      request.onerror = () => { clearTimeout(timer); resolve(false) }
      request.onblocked = () => { clearTimeout(timer); resolve(false) }
    } catch {
      clearTimeout(timer)
      resolve(false)
    }
  })
}

export { DB_NAME }
