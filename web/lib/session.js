// Tab-local form state. IndexedDB contains folder handles only, keyed by the
// tab's random session ID; no reader contents, sign-in URLs or private keys.
export const SESSION_KEY = 'kobold.setup.v1',
  SESSION_TTL = 4 * 60 * 60 * 1000;
const fields = [
  'ip',
  'ports',
  'hostname',
  'tag',
  'owner',
  'extra-deny',
  'original-policy',
];
export function cleanSession(value, now = Date.now()) {
  if (
    value?.schema !== 1 ||
    !Number.isFinite(value.savedAt) ||
    value.savedAt > now ||
    now - value.savedAt > SESSION_TTL ||
    !/^[a-f0-9]{32}$/.test(value.id)
  )
    return null;
  const form = {};
  for (const key of fields)
    if (typeof value.form?.[key] === 'string' && value.form[key].length <= 1000000)
      form[key] = value.form[key];
  return {
    schema: 1,
    id: value.id,
    savedAt: value.savedAt,
    form,
    rewrite: value.rewrite === true,
    page: ['overview', 'reader', 'network', 'install', 'recovery'].includes(value.page)
      ? value.page
      : 'overview',
    policyText:
      typeof value.policyText === 'string' && value.policyText.length <= 1000000
        ? value.policyText
        : null,
    policyConfirmed: value.policyConfirmed === true,
    backupName:
      typeof value.backupName === 'string' &&
      /^kobold-(?:skipped-)?[a-f0-9-]{36}$/.test(value.backupName)
        ? value.backupName
        : null,
    skipped: value.skipped === true,
    syncConfirmed: value.syncConfirmed === true,
  };
}
export function tabSession(storage, now = () => Date.now()) {
  let id;
  try {
    const saved = cleanSession(JSON.parse(storage.getItem(SESSION_KEY)), now());
    id = saved?.id ?? crypto.randomUUID().replaceAll('-', '');
  } catch {
    id = crypto.randomUUID().replaceAll('-', '');
  }
  return {
    load() {
      try {
        return cleanSession(JSON.parse(storage.getItem(SESSION_KEY)), now());
      } catch {
        return null;
      }
    },
    save(value) {
      const clean = cleanSession({ ...value, schema: 1, id, savedAt: now() }, now());
      try {
        storage.setItem(SESSION_KEY, JSON.stringify(clean));
        return true;
      } catch {
        return false;
      }
    },
    clear() {
      try {
        storage.removeItem(SESSION_KEY);
      } catch {}
    },
    get id() {
      return id;
    },
  };
}
export async function folderRecord(id, value, remove = false) {
  if (typeof indexedDB === 'undefined')
    throw Error('Folder-session storage unavailable');
  const db = await new Promise((resolve, reject) => {
    const r = indexedDB.open('kobold-tab-folders', 1);
    r.onupgradeneeded = () => r.result.createObjectStore('folders', { keyPath: 'id' });
    r.onsuccess = () => resolve(r.result);
    r.onerror = () => reject(r.error);
    r.onblocked = () =>
      reject(Error('Close older setup tabs to resume folder access.'));
  });
  try {
    return await new Promise((resolve, reject) => {
      const tx = db.transaction('folders', value || remove ? 'readwrite' : 'readonly'),
        store = tx.objectStore('folders');
      let result;
      const request = remove
        ? store.delete(id)
        : value
          ? store.put({ id, ...value, savedAt: Date.now() })
          : store.get(id);
      request.onsuccess = () => {
        result = request.result;
      };
      tx.oncomplete = () =>
        resolve(
          result?.savedAt && Date.now() - result.savedAt > SESSION_TTL ? null : result,
        );
      tx.onerror = () => reject(tx.error);
      tx.onabort = () => reject(tx.error ?? Error('Session storage interrupted'));
      if (value) {
        const cursor = store.openCursor();
        cursor.onsuccess = () => {
          const c = cursor.result;
          if (c) {
            if (Date.now() - c.value.savedAt > SESSION_TTL) c.delete();
            c.continue();
          }
        };
      }
    });
  } finally {
    db.close();
  }
}
export async function folderPermission(handles, request = false) {
  for (const handle of [handles?.reader, handles?.backup]) {
    if (!handle?.queryPermission) return false;
    let permission = await handle.queryPermission({ mode: 'readwrite' });
    if (permission !== 'granted' && request)
      permission = await handle.requestPermission({ mode: 'readwrite' });
    if (permission !== 'granted') return false;
  }
  return true;
}
