/* Persistent key-value storage for uploaded data.
   Backed by IndexedDB (gigabyte-scale quota, fine for large Savant exports);
   falls back to localStorage (~5MB) when IndexedDB is unavailable. */
(function (global) {
  "use strict";

  var DB_NAME = "dkmlb";
  var STORE_NAME = "kv";
  var hasIDB = typeof indexedDB !== "undefined";
  var dbPromise = null;

  function openDB() {
    if (dbPromise) return dbPromise;
    dbPromise = new Promise(function (resolve, reject) {
      var req = indexedDB.open(DB_NAME, 1);
      req.onupgradeneeded = function () {
        req.result.createObjectStore(STORE_NAME);
      };
      req.onsuccess = function () { resolve(req.result); };
      req.onerror = function () { reject(req.error); };
    });
    return dbPromise;
  }

  function idbSet(key, value) {
    return openDB().then(function (db) {
      return new Promise(function (resolve, reject) {
        var tx = db.transaction(STORE_NAME, "readwrite");
        tx.objectStore(STORE_NAME).put(value, key);
        tx.oncomplete = function () { resolve(); };
        tx.onerror = function () { reject(tx.error); };
      });
    });
  }

  function idbGet(key) {
    return openDB().then(function (db) {
      return new Promise(function (resolve, reject) {
        var tx = db.transaction(STORE_NAME, "readonly");
        var req = tx.objectStore(STORE_NAME).get(key);
        req.onsuccess = function () { resolve(req.result); };
        req.onerror = function () { reject(req.error); };
      });
    });
  }

  function idbDel(key) {
    return openDB().then(function (db) {
      return new Promise(function (resolve, reject) {
        var tx = db.transaction(STORE_NAME, "readwrite");
        tx.objectStore(STORE_NAME).delete(key);
        tx.oncomplete = function () { resolve(); };
        tx.onerror = function () { reject(tx.error); };
      });
    });
  }

  function lsSet(key, value) {
    return new Promise(function (resolve, reject) {
      try { localStorage.setItem(key, JSON.stringify(value)); resolve(); }
      catch (e) { reject(e); }
    });
  }

  function lsGet(key) {
    return new Promise(function (resolve) {
      var raw = localStorage.getItem(key);
      if (raw === null) return resolve(undefined);
      try { resolve(JSON.parse(raw)); } catch (e) { resolve(undefined); }
    });
  }

  function lsDel(key) {
    localStorage.removeItem(key);
    return Promise.resolve();
  }

  global.Store = {
    backend: hasIDB ? "IndexedDB" : "localStorage",
    set: hasIDB ? idbSet : lsSet,
    get: hasIDB ? idbGet : lsGet,
    del: hasIDB ? idbDel : lsDel
  };
})(window);
