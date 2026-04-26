/**
 * BiliGleaner 存储层 - IndexedDB 封装
 */

const DB_NAME = 'BiliGleaner';
const DB_VERSION = 4;

const STORES = {
  TRACKING: 'tracking',
  FOLLOWED: 'followed',
  SETTINGS: 'settings',
  UPDATES: 'updates',
  BLACKLIST: 'blacklist',
};

let dbInstance = null;
let dbOpenPromise = null;

function openDB() {
  if (dbOpenPromise) return dbOpenPromise;
  if (dbInstance) return Promise.resolve(dbInstance);

  dbOpenPromise = new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);

    request.onupgradeneeded = (event) => {
      const db = event.target.result;

      if (!db.objectStoreNames.contains(STORES.BLACKLIST)) {
        db.createObjectStore(STORES.BLACKLIST, { keyPath: 'mid' });
      }

      if (!db.objectStoreNames.contains(STORES.TRACKING)) {
        db.createObjectStore(STORES.TRACKING, { keyPath: 'mid' });
      }

      const trackingStore = event.target.transaction.objectStore(STORES.TRACKING);
      if (trackingStore.indexNames.contains('has_update')) {
        trackingStore.deleteIndex('has_update');
      }
      if (!trackingStore.indexNames.contains('last_view_time')) {
        trackingStore.createIndex('last_view_time', 'last_view_time');
      }

      if (!db.objectStoreNames.contains(STORES.FOLLOWED)) {
        db.createObjectStore(STORES.FOLLOWED, { keyPath: 'mid' });
      }

      if (!db.objectStoreNames.contains(STORES.SETTINGS)) {
        db.createObjectStore(STORES.SETTINGS, { keyPath: 'key' });
      }

      if (!db.objectStoreNames.contains(STORES.UPDATES)) {
        const updatesStore = db.createObjectStore(STORES.UPDATES, { keyPath: 'id' });
        updatesStore.createIndex('is_read', 'is_read');
        updatesStore.createIndex('created', 'created');
        updatesStore.createIndex('mid', 'mid');
      }
    };

    request.onsuccess = async (event) => {
      dbInstance = event.target.result;
      dbInstance.onclose = () => {
        dbInstance = null;
        dbOpenPromise = null;
      };
      resolve(dbInstance);
    };

    request.onerror = (event) => reject(event.target.error);
  }).catch((error) => {
    dbOpenPromise = null;
    throw error;
  });

  return dbOpenPromise;
}

// ========== 通用操作 ==========

async function getAll(storeName) {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(storeName, 'readonly');
    const req = tx.objectStore(storeName).getAll();
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function get(storeName, key) {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(storeName, 'readonly');
    const req = tx.objectStore(storeName).get(key);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function put(storeName, data) {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(storeName, 'readwrite');
    const req = tx.objectStore(storeName).put(data);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function putBatch(storeName, items) {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(storeName, 'readwrite');
    const store = tx.objectStore(storeName);
    for (const item of items) {
      store.put(item);
    }
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

async function del(storeName, key) {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(storeName, 'readwrite');
    const req = tx.objectStore(storeName).delete(key);
    req.onsuccess = () => resolve();
    req.onerror = () => reject(req.error);
  });
}

async function clear(storeName) {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(storeName, 'readwrite');
    const req = tx.objectStore(storeName).clear();
    req.onsuccess = () => resolve();
    req.onerror = () => reject(req.error);
  });
}

async function count(storeName) {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(storeName, 'readonly');
    const req = tx.objectStore(storeName).count();
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

// ========== 追踪列表操作 ==========

export async function getTrackedUps() {
  return getAll(STORES.TRACKING);
}

export async function getTrackedUp(mid) {
  return get(STORES.TRACKING, String(mid));
}

export async function getUpdatedUps() {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORES.UPDATES, 'readonly');
    const index = tx.objectStore(STORES.UPDATES).index('is_read');
    const req = index.getAll(0);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

export async function getUpdateFeed() {
  return getAll(STORES.UPDATES);
}

export async function getUnreadUpdateCount() {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORES.UPDATES, 'readonly');
    const index = tx.objectStore(STORES.UPDATES).index('is_read');
    const req = index.count(0);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

export async function addUpdateEntries(entries) {
  if (entries.length === 0) return;
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORES.UPDATES, 'readwrite');
    const store = tx.objectStore(STORES.UPDATES);
    for (const entry of entries) {
      const getReq = store.get(entry.id);
      getReq.onsuccess = () => {
        const existing = getReq.result;
        store.put(existing?.is_read === 1 ? { ...entry, is_read: 1 } : entry);
      };
      getReq.onerror = () => reject(getReq.error);
    }
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

export async function removeUpdatesByMid(mid) {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORES.UPDATES, 'readwrite');
    const store = tx.objectStore(STORES.UPDATES);
    const index = store.index('mid');
    const req = index.openCursor(String(mid));
    req.onsuccess = (e) => {
      const cursor = e.target.result;
      if (cursor) {
        cursor.delete();
        cursor.continue();
      }
    };
    req.onerror = () => reject(req.error);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

export async function removeUpdatesWithoutTrackedUps() {
  const trackedUps = await getAll(STORES.TRACKING);
  const trackedMids = new Set(trackedUps.map(up => String(up.mid)));
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORES.UPDATES, 'readwrite');
    const store = tx.objectStore(STORES.UPDATES);
    let removed = 0;
    const req = store.openCursor();
    req.onsuccess = (e) => {
      const cursor = e.target.result;
      if (cursor) {
        if (!trackedMids.has(String(cursor.value.mid))) {
          cursor.delete();
          removed++;
        }
        cursor.continue();
      }
    };
    req.onerror = () => reject(req.error);
    tx.oncomplete = () => resolve(removed);
    tx.onerror = () => reject(tx.error);
  });
}

export async function upsertTrackedUp(upData) {
  const existing = await get(STORES.TRACKING, String(upData.mid));
  const merged = {
    ...existing,
    ...upData,
    mid: String(upData.mid),
  };
  return put(STORES.TRACKING, merged);
}

export async function upsertTrackedUpsBatch(upList) {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORES.TRACKING, 'readwrite');
    const store = tx.objectStore(STORES.TRACKING);
    for (const upData of upList) {
      const mid = String(upData.mid);
      const req = store.get(mid);
      req.onsuccess = () => {
        const existing = req.result;
        const merged = {
          ...existing,
          ...upData,
          mid,
        };
        if (existing?.source === 'manual') {
          merged.source = 'manual';
        }
        store.put(merged);
      };
      req.onerror = () => reject(req.error);
    }
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

export async function removeTrackedUp(mid) {
  return del(STORES.TRACKING, String(mid));
}

export async function removeTrackedUpsByMids(mids) {
  const normalized = [...new Set(mids.map(mid => String(mid)))];
  if (normalized.length === 0) return 0;
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORES.TRACKING, 'readwrite');
    const store = tx.objectStore(STORES.TRACKING);
    for (const mid of normalized) {
      store.delete(mid);
    }
    tx.oncomplete = () => resolve(normalized.length);
    tx.onerror = () => reject(tx.error);
  });
}

export async function markAsRead(id) {
  const entry = await get(STORES.UPDATES, id);
  if (entry) {
    entry.is_read = 1;
    return put(STORES.UPDATES, entry);
  }
}

export async function markAsUnread(id) {
  const entry = await get(STORES.UPDATES, id);
  if (entry) {
    entry.is_read = 0;
    return put(STORES.UPDATES, entry);
  }
}

export async function markAllAsRead() {
  const all = await getAll(STORES.UPDATES);
  const unread = all.filter(e => e.is_read === 0);
  if (unread.length > 0) {
    const updated = unread.map(e => ({ ...e, is_read: 1 }));
    return putBatch(STORES.UPDATES, updated);
  }
}

export async function getTrackingCount() {
  return count(STORES.TRACKING);
}

/**
 * 裁剪追踪列表：移除 last_view_time 超出指定天数的 UP 主
 * 手动添加的 UP 主不会被裁剪
 * @param {number} days - 保留天数
 * @returns {number} 被移除的数量
 */
export async function pruneTrackedUpsByTimeRange(days) {
  const cutoff = Math.floor(Date.now() / 1000) - days * 24 * 3600;
  const all = await getAll(STORES.TRACKING);
  const toRemove = all.filter(up =>
    up.source !== 'manual' && up.last_view_time && up.last_view_time < cutoff
  );
  if (toRemove.length === 0) return 0;

  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORES.TRACKING, 'readwrite');
    const store = tx.objectStore(STORES.TRACKING);
    for (const up of toRemove) {
      store.delete(up.mid);
    }
    tx.oncomplete = () => resolve(toRemove.length);
    tx.onerror = () => reject(tx.error);
  });
}

/**
 * 清理超出时间范围的视频动态
 * @param {number} days - 保留天数
 * @returns {number} 被清理的条目数
 */
export async function pruneUpdatesByTimeRange(days) {
  const cutoff = Math.floor(Date.now() / 1000) - days * 24 * 3600;
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORES.UPDATES, 'readwrite');
    const store = tx.objectStore(STORES.UPDATES);
    const index = store.index('created');
    const range = IDBKeyRange.upperBound(cutoff);
    let count = 0;
    const req = index.openCursor(range);
    req.onsuccess = (e) => {
      const cursor = e.target.result;
      if (cursor) {
        cursor.delete();
        count++;
        cursor.continue();
      }
    };
    tx.oncomplete = () => resolve(count);
    tx.onerror = () => reject(tx.error);
  });
}

// ========== 黑名单操作 ==========

export async function getBlacklist() {
  return getAll(STORES.BLACKLIST);
}

export async function isBlacklisted(mid) {
  const result = await get(STORES.BLACKLIST, String(mid));
  return !!result;
}

export async function addToBlacklist(mid, name = '', face = '') {
  return put(STORES.BLACKLIST, { mid: String(mid), name, face, added_at: Date.now() });
}

export async function removeFromBlacklist(mid) {
  return del(STORES.BLACKLIST, String(mid));
}

// ========== 统计查询 ==========

/**
 * 按 UP 主 mid 统计未读视频数量
 * @returns {Object} { mid: unreadCount, ... }
 */
export async function getUnreadCountsByMid() {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORES.UPDATES, 'readonly');
    const index = tx.objectStore(STORES.UPDATES).index('is_read');
    const req = index.getAll(0);
    req.onsuccess = () => {
      const counts = {};
      for (const entry of req.result) {
        counts[entry.mid] = (counts[entry.mid] || 0) + 1;
      }
      resolve(counts);
    };
    req.onerror = () => reject(req.error);
  });
}

// ========== 关注缓存操作 ==========

export async function getFollowedCache() {
  return getAll(STORES.FOLLOWED);
}

export async function isFollowed(mid) {
  const result = await get(STORES.FOLLOWED, String(mid));
  return !!result;
}

export async function updateFollowedCache(mids) {
  const items = mids.map(mid => ({ mid: String(mid) }));
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORES.FOLLOWED, 'readwrite');
    const store = tx.objectStore(STORES.FOLLOWED);
    store.clear();
    for (const item of items) {
      store.put(item);
    }
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

export async function addToFollowedCache(mid) {
  return put(STORES.FOLLOWED, { mid: String(mid) });
}

export async function clearAllData() {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const storeNames = Object.values(STORES);
    const tx = db.transaction(storeNames, 'readwrite');

    for (const storeName of storeNames) {
      tx.objectStore(storeName).clear();
    }

    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

// ========== 设置操作 ==========

export async function getSetting(key, defaultValue = null) {
  const result = await get(STORES.SETTINGS, key);
  return result ? result.value : defaultValue;
}

export async function setSetting(key, value) {
  return put(STORES.SETTINGS, { key, value });
}
