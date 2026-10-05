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

  async hasTrack(id) {
    const item = await this.getTrack(id);
    return !!item;
  },

  async downloadTrackForOffline(track, onProgress = null) {
    try {
      if (onProgress) onProgress('downloading_audio');
      let audioBlob = null;
      if (track.audioUrl) {
        const res = await fetch(track.audioUrl);
        if (!res.ok) throw new Error(`HTTP error ${res.status} fetching audio`);
        audioBlob = await res.blob();
      }

      if (onProgress) onProgress('downloading_cover');
      let cover = track.cover || 'assets/weleta_cover.jpg';
      let discCenter = track.discCenter || cover;

      // Convert remote cover to blob data if remote
      if (cover.startsWith('http')) {
        try {
          const cRes = await fetch(cover);
          const cBlob = await cRes.blob();
          cover = await new Promise((res) => {
            const reader = new FileReader();
            reader.onloadend = () => res(reader.result);
            reader.readAsDataURL(cBlob);
          });
          discCenter = cover;
        } catch (imgErr) {
          console.warn('Cover image fetch fallback:', imgErr);
        }
      }

      const offlineTrack = {
        ...track,
        audioBlob: audioBlob,
        cover: cover,
        discCenter: discCenter,
        isDownloaded: true,
        downloadedAt: Date.now()
      };

      await this.saveTrack(offlineTrack);
      if (onProgress) onProgress('complete');
      return offlineTrack;
    } catch (err) {
      console.error('downloadTrackForOffline error:', err);
      if (onProgress) onProgress('error');
      throw err;
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
  },

  // Favorites Storage
  getFavorites() {
    try {
      const data = localStorage.getItem('ethio_lyrics_favorites');
      return data ? JSON.parse(data) : [];
    } catch (e) {
      return [];
    }
  },

  setFavorites(favoritesList) {
    try {
      localStorage.setItem('ethio_lyrics_favorites', JSON.stringify(favoritesList || []));
    } catch (e) {}
  },

  isFavorite(trackId) {
    if (!trackId) return false;
    const favs = this.getFavorites();
    return favs.includes(trackId);
  },

  toggleFavorite(trackId) {
    if (!trackId) return false;
    let favs = this.getFavorites();
    const index = favs.indexOf(trackId);
    let isNowFav = false;
    if (index > -1) {
      favs.splice(index, 1);
      isNowFav = false;
    } else {
      favs.unshift(trackId);
      isNowFav = true;
    }
    this.setFavorites(favs);
    return isNowFav;
  },

  // Recently Played Storage
  getRecentlyPlayed() {
    try {
      const data = localStorage.getItem('ethio_lyrics_recent');
      return data ? JSON.parse(data) : [];
    } catch (e) {
      return [];
    }
  },

  setRecentlyPlayed(recentList) {
    try {
      localStorage.setItem('ethio_lyrics_recent', JSON.stringify(recentList || []));
    } catch (e) {}
  },

  addRecentlyPlayed(trackId) {
    if (!trackId) return;
    let recent = this.getRecentlyPlayed();
    recent = recent.filter(id => id !== trackId);
    recent.unshift(trackId);
    if (recent.length > 30) recent = recent.slice(0, 30);
    this.setRecentlyPlayed(recent);
  },

  // Playlists Storage & Management
  getPlaylists() {
    try {
      const data = localStorage.getItem('ethio_lyrics_playlists');
      if (data) {
        return JSON.parse(data);
      }
      // Initialize with a default favorite mix if first time
      const starterPlaylists = [
        {
          id: 'playlist_vibes',
          title: 'Ethio Chill & Tizita',
          description: 'Soothing Ethiopian melodies and acoustic vibes with synchronized lyrics.',
          cover: 'assets/weleta_cover.jpg',
          gradient: 'linear-gradient(135deg, #833ab4, #fd1d1d, #fcb045)',
          trackIds: [],
          createdAt: Date.now(),
          updatedAt: Date.now()
        }
      ];
      this.setPlaylists(starterPlaylists);
      return starterPlaylists;
    } catch (e) {
      return [];
    }
  },

  setPlaylists(playlists) {
    try {
      localStorage.setItem('ethio_lyrics_playlists', JSON.stringify(playlists || []));
    } catch (e) {}
  },

  getPlaylist(playlistId) {
    if (!playlistId) return null;
    const all = this.getPlaylists();
    return all.find(p => p.id === playlistId) || null;
  },

  createPlaylist(title, description = '', cover = null) {
    const playlists = this.getPlaylists();
    const gradients = [
      'linear-gradient(135deg, #ec4899, #8b5cf6, #3b82f6)',
      'linear-gradient(135deg, #e5b95a, #d97706, #b45309)',
      'linear-gradient(135deg, #10b981, #059669, #047857)',
      'linear-gradient(135deg, #6366f1, #a855f7, #ec4899)',
      'linear-gradient(135deg, #f43f5e, #fb923c, #facc15)'
    ];
    const randomGrad = gradients[Math.floor(Math.random() * gradients.length)];
    const newPlaylist = {
      id: 'playlist_' + Date.now() + '_' + Math.random().toString(36).substr(2, 5),
      title: (title || 'New Playlist').trim(),
      description: (description || '').trim(),
      cover: cover || '',
      gradient: randomGrad,
      trackIds: [],
      createdAt: Date.now(),
      updatedAt: Date.now()
    };
    playlists.unshift(newPlaylist);
    this.setPlaylists(playlists);
    return newPlaylist;
  },

  updatePlaylist(playlistId, updates = {}) {
    const playlists = this.getPlaylists();
    const idx = playlists.findIndex(p => p.id === playlistId);
    if (idx === -1) return null;
    playlists[idx] = {
      ...playlists[idx],
      ...updates,
      updatedAt: Date.now()
    };
    this.setPlaylists(playlists);
    return playlists[idx];
  },

  deletePlaylist(playlistId) {
    let playlists = this.getPlaylists();
    playlists = playlists.filter(p => p.id !== playlistId);
    this.setPlaylists(playlists);
    return true;
  },

  addTrackToPlaylist(playlistId, trackId) {
    if (!playlistId || !trackId) return false;
    const playlists = this.getPlaylists();
    const playlist = playlists.find(p => p.id === playlistId);
    if (!playlist) return false;
    if (!playlist.trackIds) playlist.trackIds = [];
    if (!playlist.trackIds.includes(trackId)) {
      playlist.trackIds.push(trackId);
      playlist.updatedAt = Date.now();
      this.setPlaylists(playlists);
      return true;
    }
    return false; // Already present
  },

  removeTrackFromPlaylist(playlistId, trackId) {
    if (!playlistId || !trackId) return false;
    const playlists = this.getPlaylists();
    const playlist = playlists.find(p => p.id === playlistId);
    if (!playlist || !playlist.trackIds) return false;
    playlist.trackIds = playlist.trackIds.filter(id => id !== trackId);
    playlist.updatedAt = Date.now();
    this.setPlaylists(playlists);
    return true;
  },

  isTrackInPlaylist(playlistId, trackId) {
    if (!playlistId || !trackId) return false;
    const playlist = this.getPlaylist(playlistId);
    return !!(playlist && playlist.trackIds && playlist.trackIds.includes(trackId));
  },

  // Playback Mode Persistence
  getShuffleState() {
    try {
      return localStorage.getItem('ethio_lyrics_shuffle') === 'true';
    } catch (e) {
      return false;
    }
  },

  setShuffleState(val) {
    try {
      localStorage.setItem('ethio_lyrics_shuffle', val ? 'true' : 'false');
    } catch (e) {}
  },

  getRepeatState() {
    try {
      return localStorage.getItem('ethio_lyrics_repeat') || 'off'; // 'off' | 'all' | 'one'
    } catch (e) {
      return 'off';
    }
  },

  setRepeatState(val) {
    try {
      localStorage.setItem('ethio_lyrics_repeat', val || 'off');
    } catch (e) {}
  },

  // Participant Identity for Listen Together
  getParticipant(currentUser = null) {
    if (currentUser) {
      return {
        id: currentUser.uid,
        name: currentUser.displayName || 'Google User',
        avatar: currentUser.photoURL || ''
      };
    }
    let pId = localStorage.getItem('ethio_lyrics_guest_id');
    if (!pId) {
      pId = 'guest_' + Math.random().toString(36).substr(2, 9);
      localStorage.setItem('ethio_lyrics_guest_id', pId);
    }
    let pName = localStorage.getItem('ethio_lyrics_guest_name');
    if (!pName) {
      pName = 'Music Lover ' + Math.floor(100 + Math.random() * 900);
      localStorage.setItem('ethio_lyrics_guest_name', pName);
    }
    return {
      id: pId,
      name: pName,
      avatar: ''
    };
  },

  setParticipantName(name) {
    if (!name) return;
    try {
      localStorage.setItem('ethio_lyrics_guest_name', name.trim());
    } catch (e) {}
  }
};

