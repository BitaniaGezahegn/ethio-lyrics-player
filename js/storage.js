/**
 * IndexedDB Persistent Storage for Songs, Audio Blobs, and LRC Lyrics
 */
const DB_NAME = 'EthioLyricsDB';
const DB_VERSION = 1;
const STORE_NAME = 'tracks';

function openDB() {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);
    request.onupgradeneeded = (e) => {
      const db = e.target.result;
      if (!db.objectStoreNames.contains(STORE_NAME)) {
        db.createObjectStore(STORE_NAME, { keyPath: 'id' });
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

export const Storage = {
  async getAllTracks() {
    try {
      const db = await openDB();
      return new Promise((resolve, reject) => {
        const tx = db.transaction(STORE_NAME, 'readonly');
        const store = tx.objectStore(STORE_NAME);
        const req = store.getAll();
        req.onsuccess = () => resolve(req.result || []);
        req.onerror = () => reject(req.error);
      });
    } catch (e) {
      console.warn('IndexedDB getAllTracks error:', e);
      return [];
    }
  },

  async getTrack(id) {
    try {
      const db = await openDB();
      return new Promise((resolve, reject) => {
        const tx = db.transaction(STORE_NAME, 'readonly');
        const store = tx.objectStore(STORE_NAME);
        const req = store.get(id);
        req.onsuccess = () => resolve(req.result || null);
        req.onerror = () => reject(req.error);
      });
    } catch (e) {
      console.warn('IndexedDB getTrack error:', e);
      return null;
    }
  },

  async saveTrack(track) {
    try {
      const db = await openDB();
      return new Promise((resolve, reject) => {
        const tx = db.transaction(STORE_NAME, 'readwrite');
        const store = tx.objectStore(STORE_NAME);
        // Ensure object is clean for IndexedDB
        const item = {
          id: track.id,
          title: track.title || 'Untitled Track',
          titleEn: track.titleEn || track.title || 'Untitled Track',
          artist: track.artist || 'Unknown Artist',
          artistEn: track.artistEn || track.artist || 'Unknown Artist',
          album: track.album || 'My Album',
          year: track.year || new Date().getFullYear().toString(),
          cover: track.cover || 'assets/weleta_cover.jpg',
          discCenter: track.discCenter || 'assets/abinet_portrait.jpg',
          duration: track.duration || 180,
          lrc: track.lrc || '',
          audioBlob: track.audioBlob || null,
          updatedAt: Date.now()
        };
        const req = store.put(item);
        req.onsuccess = () => resolve(item);
        req.onerror = () => reject(req.error);
      });
    } catch (e) {
      console.warn('IndexedDB saveTrack error:', e);
      return null;
    }
  },

  async deleteTrack(id) {
    try {
      const db = await openDB();
      return new Promise((resolve, reject) => {
        const tx = db.transaction(STORE_NAME, 'readwrite');
        const store = tx.objectStore(STORE_NAME);
        const req = store.delete(id);
        req.onsuccess = () => resolve(true);
        req.onerror = () => reject(req.error);
      });
    } catch (e) {
      console.warn('IndexedDB deleteTrack error:', e);
      return false;
    }
  },

  getLastTrackId() {
    try {
      return localStorage.getItem('ethio_lyrics_active_track_id') || null;
    } catch (e) {
      return null;
    }
  },

  setLastTrackId(id) {
    try {
      if (id) {
        localStorage.setItem('ethio_lyrics_active_track_id', id);
      } else {
        localStorage.removeItem('ethio_lyrics_active_track_id');
      }
    } catch (e) {}
  }
};
