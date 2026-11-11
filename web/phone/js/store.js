let database;

function openDb() {
  if (database) return Promise.resolve(database);
  return new Promise((resolve, reject) => {
    const request = indexedDB.open("marker-phone", 1);
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains("entries")) db.createObjectStore("entries", { keyPath: "entry.id" });
      if (!db.objectStoreNames.contains("meta")) db.createObjectStore("meta");
    };
    request.onsuccess = () => {
      database = request.result;
      resolve(database);
    };
    request.onerror = () => reject(request.error);
  });
}

function requestResult(request) {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

export async function loadBook() {
  const db = await openDb();
  const me = await requestResult(db.transaction("meta").objectStore("meta").get("me"));
  const entries = await requestResult(db.transaction("entries").objectStore("entries").getAll());
  return { me: me || null, entries: entries || [] };
}

export async function saveMe(me) {
  const db = await openDb();
  await new Promise((resolve, reject) => {
    const tx = db.transaction("meta", "readwrite");
    tx.objectStore("meta").put(me, "me");
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

export async function addEntries(envelopes) {
  const db = await openDb();
  const current = await requestResult(db.transaction("entries").objectStore("entries").getAll());
  const seen = new Set((current || []).map((item) => item.entry.id));
  const fresh = envelopes.filter((item) => item?.entry?.id && !seen.has(item.entry.id));
  if (!fresh.length) return 0;
  await new Promise((resolve, reject) => {
    const tx = db.transaction("entries", "readwrite");
    const store = tx.objectStore("entries");
    for (const item of fresh) store.put(item);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
  return fresh.length;
}

export async function replaceBook(me, entries) {
  const db = await openDb();
  await new Promise((resolve, reject) => {
    const tx = db.transaction(["meta", "entries"], "readwrite");
    tx.objectStore("meta").put(me, "me");
    const store = tx.objectStore("entries");
    store.clear();
    for (const item of entries) store.put(item);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}
