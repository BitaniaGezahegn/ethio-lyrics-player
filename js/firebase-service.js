/**
 * Firebase Auth & Cloud Firestore Integration Service
 * Configured for Ethio Lyrics Player with Cloudflare R2 integration
 */
import { initializeApp } from 'https://www.gstatic.com/firebasejs/10.14.1/firebase-app.js';
import { makeArtistId, makeAlbumId, isSingleAlbumName } from './catalog-schema.js';
import { 
  getAuth, 
  signInWithPopup, 
  signInWithRedirect, 
  getRedirectResult,
  GoogleAuthProvider, 
  signOut, 
  onAuthStateChanged 
} from 'https://www.gstatic.com/firebasejs/10.14.1/firebase-auth.js';
import { 
  initializeFirestore,
  getFirestore, 
  collection, 
  getDocs, 
  getDoc,
  doc, 
  setDoc, 
  updateDoc,
  addDoc, 
  deleteDoc, 
  query, 
  where,
  limit,
  orderBy, 
  serverTimestamp,
  onSnapshot,
  arrayUnion,
  arrayRemove,
  runTransaction
} from 'https://www.gstatic.com/firebasejs/10.14.1/firebase-firestore.js';

export const firebaseConfig = {
  apiKey: "AIzaSyDf0VvlUp1edtOjSJXZfyOeN75eYXrROsk",
  authDomain: "ethio-lyrics-player.firebaseapp.com",
  projectId: "ethio-lyrics-player",
  storageBucket: "ethio-lyrics-player.firebasestorage.app",
  messagingSenderId: "750847163095",
  appId: "1:750847163095:web:98aaa0a74d5a315ef48e92",
  measurementId: "G-06S2GTN3HL"
};

export const ADMIN_EMAIL = 'bitaniagezahegn3@gmail.com';
export const R2_PUBLIC_BASE = 'https://pub-be2150892c704dc9b69b81b3d76f7984.r2.dev';

let app = null;
let auth = null;
let db = null;
let googleProvider = null;

try {
  app = initializeApp(firebaseConfig);
  auth = getAuth(app);
  try {
    db = initializeFirestore(app, { experimentalAutoDetectLongPolling: true });
  } catch (fsErr) {
    db = getFirestore(app);
  }
  googleProvider = new GoogleAuthProvider();
  googleProvider.setCustomParameters({ prompt: 'select_account' });
} catch (err) {
  console.warn('Firebase initialization error (possibly offline):', err);
}

let serverTimeOffsetMs = 0;
let lastCalibrationMeta = { offset: 0, rtt: 0, method: 'none', timestamp: 0 };

export const FirebaseService = {
  get isInitialized() {
    return !!(app && auth && db);
  },

  getCurrentUser() {
    return auth ? auth.currentUser : null;
  },

  isAdmin(user = null) {
    const u = user || this.getCurrentUser();
    if (!u || !u.email) return false;
    return u.email.trim().toLowerCase() === ADMIN_EMAIL.toLowerCase();
  },

  onAuthChanged(callback) {
    if (!auth) {
      callback(null, false);
      return () => {};
    }
    return onAuthStateChanged(auth, (user) => {
      const admin = this.isAdmin(user);
      callback(user, admin);
    });
  },

  async checkRedirectResult() {
    if (!auth) return null;
    try {
      const result = await getRedirectResult(auth);
      return result ? result.user : null;
    } catch (err) {
      console.warn('Firebase redirect result check error:', err);
      return null;
    }
  },

  async loginWithGoogle() {
    if (!auth) throw new Error('Firebase Auth not available (check internet connection).');
    try {
      const result = await signInWithPopup(auth, googleProvider);
      return result.user;
    } catch (popupErr) {
      console.warn('Popup login failed:', popupErr?.code || popupErr?.message);
      const redirectFallbackCodes = [
        'auth/popup-blocked',
        'auth/cancelled-popup-request',
        'auth/internal-error',
        'auth/operation-not-supported-in-this-environment'
      ];
      if (redirectFallbackCodes.includes(popupErr?.code)) {
        try {
          console.info('Attempting redirect Google Sign-In fallback...');
          await signInWithRedirect(auth, googleProvider);
          return null;
        } catch (redirectErr) {
          if (redirectErr?.code === 'auth/internal-error' || redirectErr?.code === 'auth/network-request-failed') {
            throw new Error('Google Sign-In scripts (apis.google.com) are blocked by Firefox Tracking Protection, resistFingerprinting, an ad-blocker, or network firewall. Turn off tracking protection for this site (shield icon in address bar) and retry.');
          }
          throw redirectErr;
        }
      }
      throw popupErr;
    }
  },

  async logout() {
    if (!auth) return;
    await signOut(auth);
  },

  // -------------------------------------------------------------
  // Cloudflare R2 Direct Media Upload (via Pages Function /api/upload)
  // -------------------------------------------------------------
  async uploadMediaToR2(fileOrBlob, { kind = 'audio', fileName = 'media.bin', onProgress = null } = {}) {
    if (!fileOrBlob) throw new Error('No file provided for upload.');
    const user = this.getCurrentUser();
    if (!user) {
      throw new Error('Please sign in with Google first to upload media to Cloudflare R2.');
    }

    const idToken = await user.getIdToken();
    const resolvedName = fileName || fileOrBlob.name || (kind === 'cover' ? 'cover.jpg' : 'track.mp3');
    const mimeType = fileOrBlob.type || (kind === 'cover' ? 'image/jpeg' : 'audio/mpeg');

    return new Promise((resolve, reject) => {
      const xhr = new XMLHttpRequest();
      xhr.open('POST', '/api/upload', true);
      xhr.setRequestHeader('Authorization', `Bearer ${idToken}`);
      xhr.setRequestHeader('Content-Type', mimeType);
      xhr.setRequestHeader('X-Upload-Kind', kind);
      xhr.setRequestHeader('X-File-Name', encodeURIComponent(resolvedName));

      xhr.upload.onprogress = (evt) => {
        if (evt.lengthComputable && typeof onProgress === 'function') {
          onProgress(Math.min(99, Math.round((evt.loaded / evt.total) * 100)));
        }
      };

      xhr.onload = () => {
        let parsed = null;
        try { parsed = JSON.parse(xhr.responseText || '{}'); } catch (e) {}
        if (xhr.status >= 200 && xhr.status < 300 && parsed && parsed.url) {
          if (typeof onProgress === 'function') onProgress(100);
          resolve(parsed.url);
        } else {
          const msg = (parsed && parsed.error) ? parsed.error : `R2 upload failed (HTTP ${xhr.status})`;
          reject(new Error(msg));
        }
      };

      xhr.onerror = () => reject(new Error('Network error while uploading to Cloudflare R2.'));
      xhr.send(fileOrBlob);
    });
  },

  async deleteMediaFromR2(urlsOrKeys) {
    const user = this.getCurrentUser();
    if (!user) throw new Error('Must be signed in to delete media from R2.');
    const idToken = await user.getIdToken();
    const items = (Array.isArray(urlsOrKeys) ? urlsOrKeys : [urlsOrKeys]).filter(Boolean);
    const r2Items = items.filter(u => typeof u === 'string' && (u.includes('r2.dev') || u.includes('.r2.') || u.startsWith('tracks/') || u.startsWith('covers/')));
    if (r2Items.length === 0) return { ok: true, deleted: [] };

    const res = await fetch('/api/upload', {
      method: 'DELETE',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${idToken}`
      },
      body: JSON.stringify({ urls: r2Items })
    });
    if (!res.ok) {
      const errData = await res.json().catch(() => ({}));
      throw new Error(errData.error || `R2 delete failed (${res.status})`);
    }
    return await res.json();
  },

  // -------------------------------------------------------------
  // Normalized Artists & Albums Collections
  // -------------------------------------------------------------
  async getArtists() {
    if (!db) return [];
    try {
      const snapshot = await getDocs(collection(db, 'artists'));
      const list = [];
      snapshot.forEach(docSnap => list.push({ id: docSnap.id, ...docSnap.data() }));
      return list;
    } catch (e) {
      console.warn('Could not fetch artists collection:', e);
      return [];
    }
  },

  async saveArtist(artistData) {
    if (!db || !artistData) return null;
    const name = (artistData.name || 'Unknown Artist').trim();
    const nameEn = (artistData.nameEn || name).trim();
    const id = artistData.id || makeArtistId(name, nameEn);
    try {
      const payload = {
        name,
        nameEn,
        cover: artistData.cover || 'brand/elm-default-cover.svg',
        updatedAt: serverTimestamp()
      };
      if (Array.isArray(artistData.genres) && artistData.genres.length > 0) {
        payload.genres = artistData.genres;
      }
      await setDoc(doc(db, 'artists', id), payload, { merge: true });
      return { id, ...payload };
    } catch (e) {
      console.warn('saveArtist skipped (offline or rules):', e?.message || e);
      return null;
    }
  },

  async getAlbums() {
    if (!db) return [];
    try {
      const snapshot = await getDocs(collection(db, 'albums'));
      const list = [];
      snapshot.forEach(docSnap => list.push({ id: docSnap.id, ...docSnap.data() }));
      return list;
    } catch (e) {
      console.warn('Could not fetch albums collection:', e);
      return [];
    }
  },

  async saveAlbum(albumData) {
    if (!db || !albumData) return null;
    const title = (albumData.title || 'Single').trim();
    if (isSingleAlbumName(title)) return null;
    const artistName = (albumData.artistName || albumData.artist || 'Unknown Artist').trim();
    const artistId = albumData.artistId || makeArtistId(artistName, albumData.artistEn);
    const id = albumData.id || makeAlbumId(artistId, title);
    try {
      const payload = {
        title,
        artistId,
        artistName,
        year: albumData.year ? String(albumData.year).trim() : '',
        cover: albumData.cover || 'brand/elm-default-cover.svg',
        genre: albumData.genre || '',
        isSingle: false,
        updatedAt: serverTimestamp()
      };
      await setDoc(doc(db, 'albums', id), payload, { merge: true });
      return { id, ...payload };
    } catch (e) {
      console.warn('saveAlbum skipped (offline or rules):', e?.message || e);
      return null;
    }
  },

  // -------------------------------------------------------------
  // Public Tracks (Global Catalog)
  // -------------------------------------------------------------
  async getPublicTracks() {
    if (!db) return [];
    try {
      const colRef = collection(db, 'public_tracks');
      const q = query(colRef, orderBy('createdAt', 'desc'));
      const snapshot = await getDocs(q);
      const tracks = [];
      snapshot.forEach(docSnap => {
        tracks.push({
          id: docSnap.id,
          ...docSnap.data()
        });
      });
      return tracks;
    } catch (err) {
      console.warn('Failed to fetch public tracks from Firestore:', err);
      // Fallback: try unordered fetch if index is pending
      try {
        const colRef = collection(db, 'public_tracks');
        const snapshot = await getDocs(colRef);
        const tracks = [];
        snapshot.forEach(docSnap => {
          tracks.push({ id: docSnap.id, ...docSnap.data() });
        });
        return tracks;
      } catch (innerErr) {
        console.error('Firestore getDocs fallback error:', innerErr);
        return [];
      }
    }
  },

  async publishTrack(trackData) {
    if (!db) throw new Error('Firestore not initialized');
    const trackId = trackData.id || `pub_${Date.now()}`;
    const docRef = doc(db, 'public_tracks', trackId);

    const artist = trackData.artist || 'Unknown Artist';
    const artistEn = trackData.artistEn || artist;
    const album = trackData.album || 'Single';
    const artistId = trackData.artistId || makeArtistId(artist, artistEn);
    const albumId = trackData.albumId || makeAlbumId(artistId, album);

    const payload = {
      title: trackData.title || 'Untitled',
      titleEn: trackData.titleEn || trackData.title || 'Untitled',
      artist,
      artistEn,
      artistId,
      album,
      albumId,
      genre: trackData.genre || '',
      trackNumber: trackData.trackNumber ? Number(trackData.trackNumber) : null,
      year: trackData.year || new Date().getFullYear().toString(),
      cover: trackData.cover || 'brand/elm-default-cover.svg',
      discCenter: trackData.discCenter || trackData.cover || 'brand/elm-default-cover.svg',
      duration: trackData.duration || 180,
      lrc: trackData.lrc || '',
      audioUrl: trackData.audioUrl || '',
      localSourceTrackId: trackData.localSourceTrackId || null,
      publishedBy: trackData.publishedBy || ADMIN_EMAIL,
      createdAt: serverTimestamp(),
      updatedAt: serverTimestamp()
    };

    await setDoc(docRef, payload, { merge: true });
    // Best-effort normalized entity sync
    this.saveArtist({ id: artistId, name: artist, nameEn: artistEn, cover: payload.cover, genres: payload.genre ? [payload.genre] : [] });
    if (!isSingleAlbumName(album)) {
      this.saveAlbum({ id: albumId, title: album, artistId, artistName: artist, year: payload.year, cover: payload.cover, genre: payload.genre });
    }
    return { id: trackId, ...payload };
  },

  async deletePublicTrack(trackOrId) {
    if (!db) throw new Error('Firestore not initialized');
    const trackId = typeof trackOrId === 'string' ? trackOrId : trackOrId?.id;
    let trackObj = typeof trackOrId === 'object' && trackOrId !== null ? trackOrId : null;

    if (!trackObj && trackId) {
      try {
        const snap = await getDoc(doc(db, 'public_tracks', trackId));
        if (snap.exists()) {
          trackObj = snap.data();
        }
      } catch (e) {
        console.warn('Could not fetch public track before deletion:', e);
      }
    }

    // Delete associated R2 audio and custom cover from Cloudflare R2
    if (trackObj) {
      const toDelete = [];
      if (trackObj.audioUrl && (trackObj.audioUrl.includes('r2.dev') || trackObj.audioUrl.includes('.r2.'))) {
        toDelete.push(trackObj.audioUrl);
      }
      if (trackObj.cover && trackObj.cover.includes('r2.dev') && !trackObj.cover.includes('weleta_cover')) {
        toDelete.push(trackObj.cover);
      }
      if (toDelete.length > 0) {
        try {
          await this.deleteMediaFromR2(toDelete);
          console.info('Deleted R2 assets for public track:', toDelete);
        } catch (r2Err) {
          console.warn('R2 media deletion warning (will continue Firestore deletion):', r2Err);
        }
      }
    }

    if (trackId) {
      const docRef = doc(db, 'public_tracks', trackId);
      await deleteDoc(docRef);
    }
    return true;
  },

  // -------------------------------------------------------------
  // Community Submissions & Metadata Review Pipeline
  // -------------------------------------------------------------
  async submitForReview(submission) {
    if (!db) throw new Error('Firestore not initialized');
    const colRef = collection(db, 'submissions');
    const user = this.getCurrentUser();

    const artist = submission.artist || 'Unknown Artist';
    const artistEn = submission.artistEn || artist;
    const album = submission.album || 'Single';
    const artistId = submission.artistId || makeArtistId(artist, artistEn);
    const albumId = submission.albumId || makeAlbumId(artistId, album);

    const payload = {
      type: submission.type || (submission.targetTrackId ? 'metadata_edit' : 'new_song'),
      targetTrackId: submission.targetTrackId || submission.originalTrackId || null,
      originalTitle: submission.originalTitle || null,
      originalArtist: submission.originalArtist || null,
      title: submission.title || 'Untitled',
      titleEn: submission.titleEn || submission.title || 'Untitled',
      artist,
      artistEn,
      artistId,
      album,
      albumId,
      genre: submission.genre || '',
      trackNumber: submission.trackNumber ? Number(submission.trackNumber) : null,
      year: submission.year || new Date().getFullYear().toString(),
      cover: submission.cover || 'brand/elm-default-cover.svg',
      lrc: submission.lrc || '',
      audioUrl: submission.audioUrl || '',
      audioFileName: submission.audioFileName || '',
      localSourceTrackId: submission.localSourceTrackId || null,
      contributorNote: submission.contributorNote || '',
      submittedByEmail: user ? user.email : 'Anonymous Visitor',
      submittedByName: user ? user.displayName || 'Visitor' : 'Visitor',
      submittedAt: serverTimestamp(),
      status: 'pending' // pending | approved | rejected
    };

    const docRef = await addDoc(colRef, payload);
    return { id: docRef.id, ...payload };
  },

  async getSubmissions() {
    if (!db) return [];
    try {
      const colRef = collection(db, 'submissions');
      const q = query(colRef, orderBy('submittedAt', 'desc'));
      const snapshot = await getDocs(q);
      const items = [];
      snapshot.forEach(docSnap => {
        items.push({ id: docSnap.id, ...docSnap.data() });
      });
      return items;
    } catch (e) {
      console.warn('Submissions query failed, trying without order:', e);
      const colRef = collection(db, 'submissions');
      const snapshot = await getDocs(colRef);
      const items = [];
      snapshot.forEach(docSnap => items.push({ id: docSnap.id, ...docSnap.data() }));
      return items;
    }
  },

  async approveSubmission(submission, customAudioUrl = null) {
    if (!db) throw new Error('Firestore not initialized');

    // If this submission is an edit of an existing catalog track, update that track directly!
    const targetId = submission.targetTrackId || submission.originalTrackId;
    if (submission.type === 'metadata_edit' && targetId) {
      const docRef = doc(db, 'public_tracks', targetId);
      const updateData = {
        title: submission.title,
        titleEn: submission.titleEn || submission.title,
        artist: submission.artist,
        artistEn: submission.artistEn || submission.artist,
        album: submission.album || 'Single',
        year: submission.year || '2024',
        lrc: submission.lrc || '',
        updatedAt: serverTimestamp()
      };
      if (submission.cover && submission.cover !== 'brand/elm-default-cover.svg') {
        updateData.cover = submission.cover;
        updateData.discCenter = submission.cover;
      }
      if (customAudioUrl) {
        updateData.audioUrl = customAudioUrl;
      }
      await setDoc(docRef, updateData, { merge: true });
      await deleteDoc(doc(db, 'submissions', submission.id));
      return { id: targetId, ...updateData };
    }

    // Otherwise, publish as a new public catalog track
    const trackPayload = {
      title: submission.title,
      titleEn: submission.titleEn || submission.title,
      artist: submission.artist,
      artistEn: submission.artistEn || submission.artist,
      artistId: submission.artistId || '',
      album: submission.album || 'Single',
      albumId: submission.albumId || '',
      genre: submission.genre || '',
      trackNumber: submission.trackNumber || null,
      year: submission.year || '2024',
      cover: submission.cover || 'brand/elm-default-cover.svg',
      discCenter: submission.discCenter || submission.cover || 'brand/elm-default-cover.svg',
      duration: submission.duration || 180,
      lrc: submission.lrc || '',
      audioUrl: customAudioUrl || submission.audioUrl || '',
      localSourceTrackId: submission.localSourceTrackId || null,
      publishedBy: `Approved from ${submission.submittedByEmail || 'Community'}`
    };

    const published = await this.publishTrack(trackPayload);
    // Delete from submissions queue
    await deleteDoc(doc(db, 'submissions', submission.id));
    return published;
  },

  async rejectSubmission(submissionOrId) {
    if (!db) throw new Error('Firestore not initialized');
    const submissionId = typeof submissionOrId === 'string' ? submissionOrId : submissionOrId?.id;
    let subObj = typeof submissionOrId === 'object' && submissionOrId !== null ? submissionOrId : null;

    if (!subObj && submissionId) {
      try {
        const snap = await getDoc(doc(db, 'submissions', submissionId));
        if (snap.exists()) subObj = snap.data();
      } catch (e) {}
    }

    if (subObj) {
      const toDelete = [];
      if (subObj.audioUrl && (subObj.audioUrl.includes('r2.dev') || subObj.audioUrl.includes('.r2.'))) {
        toDelete.push(subObj.audioUrl);
      }
      if (subObj.cover && subObj.cover.includes('r2.dev') && !subObj.cover.includes('weleta_cover')) {
        toDelete.push(subObj.cover);
      }
      if (toDelete.length > 0) {
        try {
          await this.deleteMediaFromR2(toDelete);
        } catch (e) {
          console.warn('R2 deletion warning during submission rejection:', e);
        }
      }
    }

    if (submissionId) {
      await deleteDoc(doc(db, 'submissions', submissionId));
    }
    return true;
  },

  // -------------------------------------------------------------
  // Cross-Device User Sync (Favorites, History, Playlists & State)
  // -------------------------------------------------------------
  async getUserSync(userId) {
    if (!db || !userId) return null;
    try {
      const docRef = doc(db, 'user_sync', userId);
      const snap = await getDoc(docRef);
      if (snap.exists()) {
        return snap.data();
      }
      return null;
    } catch (e) {
      console.warn('Failed to fetch user sync data:', e);
      return null;
    }
  },

  async saveUserSync(userId, syncData) {
    if (!db || !userId) return;
    try {
      const docRef = doc(db, 'user_sync', userId);
      await setDoc(docRef, {
        ...syncData,
        updatedAt: serverTimestamp()
      }, { merge: true });
    } catch (e) {
      console.warn('Failed to save user sync data:', e);
    }
  },

  subscribeUserSync(userId, callback) {
    if (!db || !userId) return () => {};
    try {
      const docRef = doc(db, 'user_sync', userId);
      return onSnapshot(docRef, (docSnap) => {
        if (docSnap.exists()) {
          callback(docSnap.data());
        }
      }, (err) => {
        console.warn('User sync subscription error:', err);
      });
    } catch (e) {
      console.warn('subscribeUserSync error:', e);
      return () => {};
    }
  },

  // -------------------------------------------------------------
  // Universal NTP/Server Time Calibration for Zero-Drift Listen Together
  // -------------------------------------------------------------
  async calibrateServerTime({ samples = 5, forceHttp = false } = {}) {
    if (!forceHttp && db) {
      try {
        let clientId = sessionStorage.getItem('ethio_clock_client_id');
        if (!clientId) {
          clientId = 'clk_' + Math.random().toString(36).slice(2, 11);
          try { sessionStorage.setItem('ethio_clock_client_id', clientId); } catch (e) {}
        }
        const ref = doc(db, 'clock_sync', clientId);
        const results = [];
        for (let i = 0; i < samples; i++) {
          const t0 = Date.now();
          const p0 = performance.now();
          await setDoc(ref, { t: serverTimestamp(), clientId }, { merge: false });
          const rtt = performance.now() - p0;
          const snap = await getDoc(ref);
          const serverMs = snap.data()?.t?.toMillis?.();
          if (serverMs) {
            // NTP offset: serverTime - (localStartTime + rtt/2)
            results.push({ rtt, offset: serverMs - (t0 + (rtt / 2)) });
          }
        }
        if (results.length > 0) {
          // Sort by lowest round-trip time (NTP best practice)
          results.sort((a, b) => a.rtt - b.rtt);
          const best = results[0];
          serverTimeOffsetMs = Math.round(best.offset);
          lastCalibrationMeta = { offset: serverTimeOffsetMs, rtt: Math.round(best.rtt), method: 'firestore', timestamp: Date.now() };
          console.log(`[Listen Together] High-precision Firestore clock offset: ${serverTimeOffsetMs}ms (best RTT: ${Math.round(best.rtt)}ms)`);
          return serverTimeOffsetMs;
        }
      } catch (err) {
        console.warn('Firestore server time calibration error, falling back to HTTP Date header:', err);
      }
    }
    return this._httpDateFallback();
  },

  async _httpDateFallback() {
    try {
      const samples = [];
      for (let i = 0; i < 3; i++) {
        const t0 = performance.now();
        const res = await fetch(window.location.href, { method: 'HEAD', cache: 'no-store' });
        const t1 = performance.now();
        const serverDateHeader = res.headers.get('date');
        if (serverDateHeader) {
          const rtt = Math.max(1, t1 - t0);
          const serverEpoch = new Date(serverDateHeader).getTime() + (rtt / 2);
          samples.push({ rtt, offset: serverEpoch - Date.now() });
        }
      }
      if (samples.length > 0) {
        samples.sort((a, b) => a.rtt - b.rtt);
        serverTimeOffsetMs = Math.round(samples[0].offset);
        lastCalibrationMeta = { offset: serverTimeOffsetMs, rtt: Math.round(samples[0].rtt), method: 'http', timestamp: Date.now() };
        console.log(`[Listen Together] HTTP Date clock offset: ${serverTimeOffsetMs}ms (RTT: ${Math.round(samples[0].rtt)}ms)`);
      } else {
        lastCalibrationMeta = { offset: 0, rtt: 0, method: 'local', timestamp: Date.now() };
      }
    } catch (e) {
      console.warn('Server time calibration fallback error:', e);
      lastCalibrationMeta = { offset: 0, rtt: 0, method: 'local', timestamp: Date.now() };
    }
    return serverTimeOffsetMs;
  },

  getCalibrationMeta() {
    return { ...lastCalibrationMeta };
  },

  getClockOffset() {
    return serverTimeOffsetMs;
  },

  getBestRtt() {
    return lastCalibrationMeta?.rtt || 0;
  },

  getServerNow() {
    return Date.now() + serverTimeOffsetMs;
  },

  getServerTimeOffset() {
    return serverTimeOffsetMs;
  },

  // -------------------------------------------------------------
  // Listen Together (Party Room & Synced Playback Engine v2)
  // -------------------------------------------------------------
  generateRoomCode() {
    const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
    let code = '';
    for (let i = 0; i < 4; i++) {
      code += chars.charAt(Math.floor(Math.random() * chars.length));
    }
    return `ETHIO-${code}`;
  },

  async createListenRoom(hostInfo, trackData, playbackState = 'paused', positionSec = 0, initialRate = 1.0) {
    if (!db) throw new Error('Firestore not initialized');
    const roomCode = this.generateRoomCode();
    const docRef = doc(db, 'listen_rooms', roomCode);

    const roomPayload = {
      schemaVersion: 2,
      roomCode: roomCode,
      hostId: hostInfo.id,
      hostName: hostInfo.name || 'Party Host',
      hostAvatar: hostInfo.avatar || '',
      isActive: true,
      currentTrack: trackData ? {
        id: trackData.id || ('track_' + Date.now()),
        title: trackData.title || 'Untitled',
        artist: trackData.artist || 'Unknown Artist',
        album: trackData.album || 'Single',
        year: trackData.year || '2024',
        cover: trackData.cover || 'brand/elm-default-cover.svg',
        audioUrl: trackData.audioUrl || '',
        lrc: trackData.lrc || ''
      } : null,
      playback: {
        trackId: trackData ? trackData.id : null,
        state: playbackState,
        positionSec: Number(positionSec) || 0,
        anchorServerMs: this.getServerNow(),
        rate: Number(initialRate) || 1.0,
        epoch: 1
      },
      createdAt: serverTimestamp(),
      updatedAt: serverTimestamp()
    };

    await setDoc(docRef, roomPayload);

    // Register host into participants subcollection
    try {
      const hostPRef = doc(db, 'listen_rooms', roomCode, 'participants', hostInfo.id);
      await setDoc(hostPRef, {
        id: hostInfo.id,
        name: hostInfo.name || 'Party Host',
        avatar: hostInfo.avatar || '',
        isHost: true,
        joinedAt: Date.now(),
        lastSeen: serverTimestamp(),
        driftMs: 0
      });
    } catch (e) {
      console.warn('Register host participant subcollection error:', e);
    }

    return roomPayload;
  },

  async getListenRoom(roomCode) {
    if (!db || !roomCode) return null;
    try {
      const cleanCode = roomCode.trim().toUpperCase();
      const docRef = doc(db, 'listen_rooms', cleanCode);
      const snap = await getDoc(docRef);
      if (snap.exists()) {
        const data = snap.data();
        if (data.isActive !== false) return data;
      }
      return null;
    } catch (e) {
      console.warn('getListenRoom error:', e);
      return null;
    }
  },

  async joinListenRoom(roomCode, participant) {
    if (!db || !roomCode) throw new Error('Invalid room code');
    const cleanCode = roomCode.trim().toUpperCase();
    const docRef = doc(db, 'listen_rooms', cleanCode);
    const snap = await getDoc(docRef);
    if (!snap.exists() || snap.data().isActive === false) {
      throw new Error(`Room ${cleanCode} does not exist or has ended.`);
    }

    const currentData = snap.data();
    if (currentData.schemaVersion && currentData.schemaVersion < 2) {
      throw new Error(`Room ${cleanCode} was created with an older version. Ask the host to refresh.`);
    }

    // Register into participants subcollection
    const pRef = doc(db, 'listen_rooms', cleanCode, 'participants', participant.id);
    await setDoc(pRef, {
      id: participant.id,
      name: participant.name || 'Friend',
      avatar: participant.avatar || '',
      isHost: false,
      joinedAt: Date.now(),
      lastSeen: serverTimestamp(),
      driftMs: 0
    }, { merge: true });

    return currentData;
  },

  async publishPlaybackAnchor(roomCode, anchorPayload, extraDocUpdates = {}) {
    if (!db || !roomCode) return;
    try {
      const cleanCode = roomCode.trim().toUpperCase();
      const docRef = doc(db, 'listen_rooms', cleanCode);
      await updateDoc(docRef, {
        playback: {
          trackId: anchorPayload.trackId || null,
          state: anchorPayload.state || 'paused',
          positionSec: Number(anchorPayload.positionSec) || 0,
          anchorServerMs: Number(anchorPayload.anchorServerMs) || this.getServerNow(),
          rate: Number(anchorPayload.rate) || 1.0,
          epoch: Number(anchorPayload.epoch) || 1
        },
        ...extraDocUpdates,
        updatedAt: serverTimestamp()
      });
    } catch (e) {
      console.warn('publishPlaybackAnchor error:', e);
    }
  },

  async heartbeatPresence(roomCode, participantId, driftMs = 0) {
    if (!db || !roomCode || !participantId) return;
    try {
      const cleanCode = roomCode.trim().toUpperCase();
      const pRef = doc(db, 'listen_rooms', cleanCode, 'participants', participantId);
      await setDoc(pRef, {
        lastSeen: serverTimestamp(),
        driftMs: Math.round(Number(driftMs) || 0)
      }, { merge: true });
    } catch (e) {
      console.warn('heartbeatPresence error:', e);
    }
  },

  subscribeParticipants(roomCode, callback) {
    if (!db || !roomCode) return () => {};
    try {
      const cleanCode = roomCode.trim().toUpperCase();
      const colRef = collection(db, 'listen_rooms', cleanCode, 'participants');
      return onSnapshot(colRef, (snap) => {
        const list = [];
        snap.forEach((d) => list.push({ id: d.id, ...d.data() }));
        callback(list);
      }, (err) => {
        console.warn('subscribeParticipants error:', err);
      });
    } catch (e) {
      console.warn('subscribeParticipants setup error:', e);
      return () => {};
    }
  },

  async claimHost(roomCode, newHostParticipant, expectedOldHostId = null) {
    if (!db || !roomCode || !newHostParticipant) return false;
    const cleanCode = roomCode.trim().toUpperCase();
    const roomRef = doc(db, 'listen_rooms', cleanCode);
    try {
      return await runTransaction(db, async (txn) => {
        const roomSnap = await txn.get(roomRef);
        if (!roomSnap.exists()) return false;
        const data = roomSnap.data();
        if (data.isActive === false) return false;
        if (expectedOldHostId && data.hostId !== expectedOldHostId && data.hostId !== newHostParticipant.id) {
          return false;
        }
        const curPb = data.playback || {};
        const newEpoch = (curPb.epoch || 1) + 1;
        txn.update(roomRef, {
          hostId: newHostParticipant.id,
          hostName: newHostParticipant.name || 'Party Host',
          hostAvatar: newHostParticipant.avatar || '',
          'playback.epoch': newEpoch,
          updatedAt: serverTimestamp()
        });
        const newHPRef = doc(db, 'listen_rooms', cleanCode, 'participants', newHostParticipant.id);
        txn.set(newHPRef, { isHost: true, lastSeen: serverTimestamp() }, { merge: true });
        return true;
      });
    } catch (err) {
      console.warn('claimHost transaction error:', err);
      return false;
    }
  },

  async endListenRoom(roomCode) {
    if (!db || !roomCode) return;
    try {
      const cleanCode = roomCode.trim().toUpperCase();
      const docRef = doc(db, 'listen_rooms', cleanCode);
      await updateDoc(docRef, {
        isActive: false,
        updatedAt: serverTimestamp()
      });
    } catch (e) {
      console.warn('endListenRoom error:', e);
    }
  },

  async leaveListenRoom(roomCode, participantId) {
    if (!db || !roomCode || !participantId) return;
    try {
      const cleanCode = roomCode.trim().toUpperCase();
      const pRef = doc(db, 'listen_rooms', cleanCode, 'participants', participantId);
      await deleteDoc(pRef).catch(() => {});

      const roomRef = doc(db, 'listen_rooms', cleanCode);
      const roomSnap = await getDoc(roomRef);
      if (!roomSnap.exists()) return;
      const room = roomSnap.data();

      if (room.hostId === participantId) {
        // Host leaving: pick next oldest participant
        const pCol = collection(db, 'listen_rooms', cleanCode, 'participants');
        const pSnap = await getDocs(pCol);
        const remaining = [];
        pSnap.forEach((d) => remaining.push({ id: d.id, ...d.data() }));
        if (remaining.length === 0) {
          await updateDoc(roomRef, { isActive: false, updatedAt: serverTimestamp() });
        } else {
          remaining.sort((a, b) => (a.joinedAt || 0) - (b.joinedAt || 0));
          const next = remaining[0];
          await this.claimHost(cleanCode, next, participantId);
        }
      }
    } catch (e) {
      console.warn('leaveListenRoom error:', e);
    }
  },

  async sendRoomReaction(roomCode, reaction) {
    if (!db || !roomCode) return;
    try {
      const cleanCode = roomCode.trim().toUpperCase();
      const colRef = collection(db, 'listen_rooms', cleanCode, 'reactions');
      const now = Date.now();
      await addDoc(colRef, {
        type: reaction.type,
        from: reaction.from || 'Friend',
        fromId: reaction.fromId || '',
        ts: now,
        expireAt: now + 3600000 // 1 hr TTL for optional Firestore TTL policy
      });
    } catch (e) {
      console.warn('sendRoomReaction error:', e);
    }
  },

  subscribeReactions(roomCode, joinTimestamp, callback) {
    if (!db || !roomCode) return () => {};
    try {
      const cleanCode = roomCode.trim().toUpperCase();
      const colRef = collection(db, 'listen_rooms', cleanCode, 'reactions');
      const startTs = Number(joinTimestamp) || Date.now() - 3000;
      const q = query(colRef, where('ts', '>=', startTs), orderBy('ts', 'asc'), limit(50));
      return onSnapshot(q, (snap) => {
        snap.docChanges().forEach((change) => {
          if (change.type === 'added') {
            callback({ id: change.doc.id, ...change.doc.data() });
          }
        });
      }, (err) => {
        console.warn('subscribeReactions error:', err);
      });
    } catch (e) {
      console.warn('subscribeReactions setup error:', e);
      return () => {};
    }
  },

  subscribeListenRoom(roomCode, callback) {
    if (!db || !roomCode) return () => {};
    try {
      const cleanCode = roomCode.trim().toUpperCase();
      const docRef = doc(db, 'listen_rooms', cleanCode);
      return onSnapshot(docRef, (docSnap) => {
        if (docSnap.exists()) {
          callback(docSnap.data());
        } else {
          callback(null);
        }
      }, (err) => {
        console.warn('Listen room subscription error:', err);
      });
    } catch (e) {
      console.warn('subscribeListenRoom error:', e);
      return () => {};
    }
  }
};
