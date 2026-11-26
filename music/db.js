// 모든 데이터는 이 기기 브라우저의 IndexedDB에 저장된다(서버 없음).
const open = new Promise((res, rej) => {
  const r = indexedDB.open('music-library', 1);
  r.onupgradeneeded = () => {
    const db = r.result;
    db.createObjectStore('tracks', { keyPath: 'id' });
    db.createObjectStore('playlists', { keyPath: 'id' });
    db.createObjectStore('blobs'); // 음원·커버 파일. key = 문자열 id
  };
  r.onsuccess = () => res(r.result);
  r.onerror = () => rej(r.error);
});

function req(store, mode, fn) {
  return open.then(db => new Promise((res, rej) => {
    const tx = db.transaction(store, mode);
    const r = fn(tx.objectStore(store));
    tx.oncomplete = () => res(r && r.result);
    tx.onerror = tx.onabort = () => rej(tx.error);
  }));
}

export const all = store => req(store, 'readonly', s => s.getAll());
export const get = (store, key) => req(store, 'readonly', s => s.get(key));
export const put = (store, val, key) => req(store, 'readwrite', s => s.put(val, key));
export const del = (store, key) => req(store, 'readwrite', s => s.delete(key));
export const uid = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
