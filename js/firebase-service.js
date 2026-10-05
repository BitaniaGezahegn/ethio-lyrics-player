/**
 * Firebase Auth & Cloud Firestore Integration Service
 * Configured for Ethio Lyrics Player with Cloudflare R2 integration
 */
import { initializeApp } from 'https://www.gstatic.com/firebasejs/10.13.0/firebase-app.js';
import { 
  getAuth, 
  signInWithPopup, 
  signInWithRedirect, 
  getRedirectResult,
  GoogleAuthProvider, 
  signOut, 
  onAuthStateChanged 
} from 'https://www.gstatic.com/firebasejs/10.13.0/firebase-auth.js';
import { 
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
} from 'https://www.gstatic.com/firebasejs/10.13.0/firebase-firestore.js';

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
  db = getFirestore(app);
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
      console.warn('Popup login failed, attempting redirect login...', popupErr);
      if (popupErr.code === 'auth/popup-blocked' || popupErr.code === 'auth/cancelled-popup-request') {
        return await signInWithRedirect(auth, googleProvider);
      }
      throw popupErr;
    }
  },

  async logout() {
    if (!auth) return;
    await signOut(auth);
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

    const payload = {
      title: trackData.title || 'Untitled',
      titleEn: trackData.titleEn || trackData.title || 'Untitled',
      artist: trackData.artist || 'Unknown Artist',
      artistEn: trackData.artistEn || trackData.artist || 'Unknown Artist',
      album: trackData.album || 'Single',
      year: trackData.year || new Date().getFullYear().toString(),
      cover: trackData.cover || 'assets/weleta_cover.jpg',
      discCenter: trackData.discCenter || trackData.cover || 'assets/abinet_portrait.jpg',
      duration: trackData.duration || 180,
      lrc: trackData.lrc || '',
      audioUrl: trackData.audioUrl || '',
      publishedBy: trackData.publishedBy || ADMIN_EMAIL,
      createdAt: serverTimestamp(),
      updatedAt: serverTimestamp()
    };

    await setDoc(docRef, payload, { merge: true });
    return { id: trackId, ...payload };
  },

  async deletePublicTrack(trackId) {
    if (!db) throw new Error('Firestore not initialized');
    const docRef = doc(db, 'public_tracks', trackId);
    await deleteDoc(docRef);
    return true;
  },

  // -------------------------------------------------------------
  // Community Submissions (Queue awaiting Admin Approval)
  // -------------------------------------------------------------
  async submitForReview(submission) {
    if (!db) throw new Error('Firestore not initialized');
    const colRef = collection(db, 'submissions');
    const user = this.getCurrentUser();

    const payload = {
      title: submission.title || 'Untitled',
      titleEn: submission.titleEn || submission.title || 'Untitled',
      artist: submission.artist || 'Unknown Artist',
      artistEn: submission.artistEn || submission.artist || 'Unknown Artist',
      album: submission.album || 'Single',
      year: submission.year || new Date().getFullYear().toString(),
      cover: submission.cover || 'assets/weleta_cover.jpg',
      lrc: submission.lrc || '',
      audioUrl: submission.audioUrl || '',
      audioFileName: submission.audioFileName || '',
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
    const trackPayload = {
      title: submission.title,
      titleEn: submission.titleEn || submission.title,
      artist: submission.artist,
      artistEn: submission.artistEn || submission.artist,
      album: submission.album || 'Single',
      year: submission.year || '2024',
      cover: submission.cover || 'assets/weleta_cover.jpg',
      discCenter: submission.discCenter || submission.cover || 'assets/abinet_portrait.jpg',
      duration: submission.duration || 180,
      lrc: submission.lrc || '',
      audioUrl: customAudioUrl || submission.audioUrl || '',
      publishedBy: `Approved from ${submission.submittedByEmail || 'Community'}`
    };

    const published = await this.publishTrack(trackPayload);
    // Delete from submissions queue
    await deleteDoc(doc(db, 'submissions', submission.id));
    return published;
  },

  async rejectSubmission(submissionId) {
    if (!db) throw new Error('Firestore not initialized');
    await deleteDoc(doc(db, 'submissions', submissionId));
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
        cover: trackData.cover || 'assets/weleta_cover.jpg',
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
