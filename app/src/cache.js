// Tiny IndexedDB cache for photo lists, keyed by galleryKey(parsed).
// Stores: { key, savedAt, total, photos }.
// Eviction: if on refetch we see a different `total`, the consumer can invalidate.

const DB_NAME = 'mypixhome-gallery-sorter';
const DB_VER = 2;  // v2: shotTime normalized to seconds (was ms in v1)
const STORE = 'galleries';

function openDB() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VER);
    req.onupgradeneeded = () => {
      const db = req.result;
      // Wipe on any upgrade — photo shape may have changed.
      if (db.objectStoreNames.contains(STORE)) {
        db.deleteObjectStore(STORE);
      }
      db.createObjectStore(STORE, { keyPath: 'key' });
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function tx(mode, fn) {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const t = db.transaction(STORE, mode);
    const store = t.objectStore(STORE);
    const result = fn(store);
    t.oncomplete = () => resolve(result);
    t.onerror = () => reject(t.error);
    t.onabort = () => reject(t.error);
  });
}

export async function saveCache(key, photos, total, encBroadcastId) {
  try {
    await tx('readwrite', (store) => {
      store.put({ key, savedAt: Date.now(), total, photos, encBroadcastId });
    });
  } catch {
    // Non-fatal — caching is best-effort.
  }
}

export async function readCache(key) {
  try {
    return await new Promise((resolve, reject) => {
      openDB().then((db) => {
        const t = db.transaction(STORE, 'readonly');
        const req = t.objectStore(STORE).get(key);
        req.onsuccess = () => resolve(req.result || null);
        req.onerror = () => reject(req.error);
      }, reject);
    });
  } catch {
    return null;
  }
}

export async function clearCache(key) {
  try {
    await tx('readwrite', (store) => store.delete(key));
  } catch {
    // ignore
  }
}
