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
  addDoc, 
  deleteDoc, 
  query, 
  orderBy, 
  serverTimestamp,
  onSnapshot
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
  }
};
