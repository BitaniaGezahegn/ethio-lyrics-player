/**
 * Local Sync Service (Offline LAN & In-Browser BroadcastChannel Dual Engine)
 *
 * Implements full parity with FirebaseService for "Listen Together" party rooms,
 * but operates 100% offline without internet or external cloud services.
 *
 * Architecture:
 *   1. Primary Engine: Native WebSocket connection to Local Sync Hub Server (Node.js)
 *      - Sub-millisecond room sync, timeline anchor propagation, and presence.
 *      - Audio relay streaming for friends on Wi-Fi/Hotspot.
 *   2. Fallback Engine: Browser BroadcastChannel ('ethio-local-sync')
 *      - Instant zero-setup sync across multiple tabs/windows on the same machine.
 *      - Used when testing or running dual-screen DJ setups.
 */

import { WebRtcHostHub, WebRtcGuestClient } from './webrtc-p2p.js';

let socket = null;
let broadcastChannel = null;
let webrtcHost = null;
let webrtcGuest = null;
let activeRoomData = null;
let currentParticipant = null;
let isHost = false;

// Subscriptions
const roomListeners = new Set();
const participantListeners = new Set();
const reactionListeners = new Set();

// Time sync state
let serverTimeOffsetMs = 0;
let lastCalibrationMeta = { offset: 0, rtt: 0, method: 'none', timestamp: 0 };

// Auto-detect transport: 'websocket' | 'broadcast_channel'
let activeTransport = 'none';

function getWsUrl() {
  const loc = window.location;
  // If served over HTTP/HTTPS, use host; if file:// or standalone, fallback to localhost:3000
  const host = loc.host && loc.protocol.startsWith('http') ? loc.host : 'localhost:3000';
  const proto = loc.protocol === 'https:' ? 'wss:' : 'ws:';
  return `${proto}//${host}/ws`;
}

function getHttpApiBase() {
  const loc = window.location;
  if (loc.host && loc.protocol.startsWith('http')) {
    return `${loc.protocol}//${loc.host}`;
  }
  return 'http://localhost:3000';
}

export const LocalSyncService = {
  get isInitialized() {
    return true;
  },

  get activeTransport() {
    return activeTransport;
  },

  get isP2pActive() {
    return activeTransport === 'webrtc_p2p';
  },

  get p2pConnectedCount() {
    return webrtcHost ? webrtcHost.connectedCount : (webrtcGuest && webrtcGuest.isConnected ? 1 : 0);
  },

  /**
   * Check if local hub server is running.
   */
  async checkServerAvailable() {
    try {
      const base = getHttpApiBase();
      // If we are on a remote host (e.g. pages.dev) and not on a LAN IP/localhost, don't check relative /api/time
      const host = window.location.hostname || '';
      const isRemoteHost = host && !host.match(/^(localhost|127\.0\.0\.1|192\.168\.|10\.|172\.)/);
      if (isRemoteHost && base.includes('pages.dev')) {
        return false;
      }

      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), 800);
      const res = await fetch(`${base}/api/time`, {
        method: 'GET',
        cache: 'no-store',
        signal: controller.signal,
      });
      clearTimeout(timeoutId);
      if (!res.ok) return false;
      const contentType = res.headers.get('content-type') || '';
      if (!contentType.includes('application/json')) return false;
      const data = await res.json();
      return Boolean(data && data.serverTime);
    } catch (e) {
      return false;
    }
  },

  /**
   * Fetch LAN IP addresses and active rooms from local hub server.
   */
  async fetchLanInfo() {
    try {
      const res = await fetch(`${getHttpApiBase()}/api/lan-info`, { cache: 'no-store' });
      if (!res.ok) throw new Error('Failed to fetch LAN info');
      const contentType = res.headers.get('content-type') || '';
      if (!contentType.includes('application/json')) throw new Error('Not JSON');
      return await res.json();
    } catch (e) {
      return { port: 3000, addresses: [{ interface: 'local', address: 'localhost' }], rooms: [] };
    }
  },

  /**
   * High-Precision NTP Clock Calibration (< 2ms local latency).
   */
  async calibrateServerTime({ samples = 5 } = {}) {
    const isServerOnline = await this.checkServerAvailable();

    if (isServerOnline) {
      try {
        const results = [];
        const base = getHttpApiBase();

        for (let i = 0; i < samples; i++) {
          const t0 = performance.now();
          const localStart = Date.now();
          const res = await fetch(`${base}/api/time`, { cache: 'no-store' });
          const t1 = performance.now();
          const rtt = Math.max(0.5, t1 - t0);
          const data = await res.json();

          if (data && data.serverTime) {
            // NTP offset formula: serverTime - (localStart + rtt / 2)
            const offset = data.serverTime - (localStart + (rtt / 2));
            results.push({ rtt, offset });
          }
        }

        if (results.length > 0) {
          results.sort((a, b) => a.rtt - b.rtt);
          const best = results[0];
          serverTimeOffsetMs = Math.round(best.offset);
          lastCalibrationMeta = {
            offset: serverTimeOffsetMs,
            rtt: Math.round(best.rtt),
            method: 'local-ntp',
            timestamp: Date.now(),
          };
          console.log(`[LocalSync] NTP offset calibrated: ${serverTimeOffsetMs}ms (RTT: ${best.rtt.toFixed(1)}ms)`);
          return serverTimeOffsetMs;
        }
      } catch (err) {
        console.warn('[LocalSync] HTTP NTP calibration fallback:', err);
      }
    }

    // Single-machine or BroadcastChannel fallback: offset is 0ms
    serverTimeOffsetMs = 0;
    lastCalibrationMeta = { offset: 0, rtt: 0, method: 'same-machine', timestamp: Date.now() };
    return 0;
  },

  getServerNow() {
    return Date.now() + serverTimeOffsetMs;
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

  /**
   * Upload track audio blob to local server for offline streaming to friends.
   */
  async uploadLocalAudio(trackId, audioBlob) {
    if (!audioBlob || !trackId) return null;
    try {
      const base = getHttpApiBase();
      const res = await fetch(`${base}/api/stream/upload/${encodeURIComponent(trackId)}`, {
        method: 'POST',
        headers: { 'Content-Type': audioBlob.type || 'audio/mpeg' },
        body: audioBlob,
      });
      if (res.ok) {
        console.log(`[LocalSync] Track "${trackId}" uploaded to local audio relay.`);
        return `${base}/api/stream/audio/${encodeURIComponent(trackId)}`;
      }
    } catch (e) {
      console.warn('[LocalSync] Audio relay upload skipped (server offline or standalone):', e.message);
    }
    return null;
  },

  /**
   * Get direct streaming URL for an audio track on local hub.
   */
  getStreamAudioUrl(trackId) {
    return `${getHttpApiBase()}/api/stream/audio/${encodeURIComponent(trackId)}`;
  },

  // ---------------------------------------------------------------------------
  // Room Creation & Joining
  // ---------------------------------------------------------------------------

  async createListenRoom(hostInfo, trackData, playbackState = 'paused', positionSec = 0, initialRate = 1.0) {
    currentParticipant = { ...hostInfo, isHost: true };
    isHost = true;

    const roomCode = this.generateRoomCode();
    const serverNow = this.getServerNow();

    const roomPayload = {
      schemaVersion: 2,
      roomCode,
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
        lrc: trackData.lrc || '',
      } : null,
      playback: {
        trackId: trackData ? trackData.id : null,
        state: playbackState,
        positionSec: Number(positionSec) || 0,
        anchorServerMs: serverNow,
        rate: Number(initialRate) || 1.0,
        epoch: 1,
      },
      participants: [{
        id: hostInfo.id,
        name: hostInfo.name || 'Party Host',
        avatar: hostInfo.avatar || '',
        isHost: true,
        joinedAt: Date.now(),
        driftMs: 0,
      }],
      createdAt: Date.now(),
      updatedAt: Date.now(),
    };

    activeRoomData = roomPayload;

    // Connect transport
    await this._connectTransport(roomCode, true, {
      hostInfo,
      currentTrack: roomPayload.currentTrack,
      playbackState,
      positionSec,
      rate: initialRate,
    });

    return roomPayload;
  },

  async joinListenRoom(roomCode, participant) {
    currentParticipant = { ...participant, isHost: false };
    isHost = false;

    const cleanCode = (roomCode || '').trim().toUpperCase();

    return new Promise(async (resolve, reject) => {
      const timeoutId = setTimeout(() => {
        reject(new Error('Connection timed out. Check that host is online on the same Wi-Fi.'));
      }, 5000);

      try {
        await this._connectTransport(cleanCode, false, { participant });

        // Wait for room_joined or snapshot
        const onJoinSuccess = (room) => {
          clearTimeout(timeoutId);
          resolve(room);
        };

        const tempListener = (room) => {
          if (room && room.roomCode === cleanCode) {
            roomListeners.delete(tempListener);
            onJoinSuccess(room);
          }
        };

        roomListeners.add(tempListener);
      } catch (err) {
        clearTimeout(timeoutId);
        reject(err);
      }
    });
  },

  // ---------------------------------------------------------------------------
  // Room Subscriptions & Pub/Sub
  // ---------------------------------------------------------------------------

  subscribeListenRoom(roomCode, callback) {
    roomListeners.add(callback);
    if (activeRoomData) {
      setTimeout(() => callback(activeRoomData), 0);
    }
    return () => roomListeners.delete(callback);
  },

  subscribeParticipants(roomCode, callback) {
    participantListeners.add(callback);
    if (activeRoomData && activeRoomData.participants) {
      setTimeout(() => callback(activeRoomData.participants), 0);
    }
    return () => participantListeners.delete(callback);
  },

  subscribeReactions(roomCode, sinceMs, callback) {
    reactionListeners.add(callback);
    return () => reactionListeners.delete(callback);
  },

  async publishPlaybackAnchor(roomCode, anchor, meta = {}) {
    if (!activeRoomData) return;

    activeRoomData.playback = {
      trackId: anchor.trackId || meta.currentTrack?.id || activeRoomData.currentTrack?.id || null,
      state: anchor.state || 'paused',
      positionSec: Number(anchor.positionSec) || 0,
      anchorServerMs: Number(anchor.anchorServerMs) || this.getServerNow(),
      rate: Number(anchor.rate) || 1.0,
      epoch: Number(anchor.epoch) || (activeRoomData.playback?.epoch || 1) + 1,
    };

    if (meta.currentTrack) {
      activeRoomData.currentTrack = meta.currentTrack;
    }

    activeRoomData.updatedAt = Date.now();

    // Broadcast anchor
    if (activeTransport === 'websocket' && socket && socket.readyState === WebSocket.OPEN) {
      socket.send(JSON.stringify({
        type: 'publish_anchor',
        anchor: activeRoomData.playback,
        currentTrack: activeRoomData.currentTrack,
      }));
    } else if (activeTransport === 'webrtc_p2p' && webrtcHost) {
      webrtcHost.broadcastAnchor(activeRoomData.playback, activeRoomData.currentTrack);
    } else if (broadcastChannel) {
      broadcastChannel.postMessage({
        type: 'anchor_update',
        roomCode,
        playback: activeRoomData.playback,
        currentTrack: activeRoomData.currentTrack,
      });
    }

    // Local notification
    roomListeners.forEach(cb => cb(activeRoomData));
  },

  async heartbeatPresence(roomCode, participantId, driftMs = 0) {
    if (activeTransport === 'websocket' && socket && socket.readyState === WebSocket.OPEN) {
      socket.send(JSON.stringify({
        type: 'presence_heartbeat',
        roomCode,
        driftMs,
      }));
    } else if (broadcastChannel) {
      broadcastChannel.postMessage({
        type: 'presence_ping',
        roomCode,
        participantId,
        driftMs,
      });
    }
  },

  async sendReaction(roomCode, reaction) {
    const rx = {
      id: 'rx_' + Date.now() + '_' + Math.random().toString(36).slice(2, 7),
      type: reaction.type || '❤️',
      from: currentParticipant?.name || 'Listener',
      timestamp: Date.now(),
    };

    if (activeTransport === 'websocket' && socket && socket.readyState === WebSocket.OPEN) {
      socket.send(JSON.stringify({
        type: 'send_reaction',
        roomCode,
        emoji: reaction.type,
      }));
    } else if (activeTransport === 'webrtc_p2p') {
      if (webrtcHost) webrtcHost.broadcast({ type: 'reaction', reaction: rx });
      else if (webrtcGuest) webrtcGuest.sendReaction(rx);
    } else if (broadcastChannel) {
      broadcastChannel.postMessage({
        type: 'reaction',
        roomCode,
        reaction: rx,
      });
    }

    reactionListeners.forEach(cb => cb(rx));
  },

  async claimHost(roomCode, participant) {
    isHost = true;
    if (currentParticipant) currentParticipant.isHost = true;
    if (activeRoomData) {
      activeRoomData.hostId = participant.id;
      activeRoomData.hostName = participant.name;
    }
    return true;
  },

  async leaveListenRoom(roomCode, participantId) {
    if (activeTransport === 'websocket' && socket && socket.readyState === WebSocket.OPEN) {
      socket.send(JSON.stringify({ type: 'leave_room', roomCode }));
      socket.close();
    }
    if (broadcastChannel) {
      broadcastChannel.postMessage({ type: 'participant_left', roomCode, participantId });
    }
    if (webrtcHost) { webrtcHost.destroy(); webrtcHost = null; }
    if (webrtcGuest) { webrtcGuest.destroy(); webrtcGuest = null; }
    this._cleanup();
  },

  async endListenRoom(roomCode) {
    if (activeTransport === 'websocket' && socket && socket.readyState === WebSocket.OPEN) {
      socket.send(JSON.stringify({ type: 'leave_room', roomCode }));
      socket.close();
    }
    if (broadcastChannel) {
      broadcastChannel.postMessage({ type: 'room_ended', roomCode });
    }
    if (webrtcHost) { webrtcHost.destroy(); webrtcHost = null; }
    if (webrtcGuest) { webrtcGuest.destroy(); webrtcGuest = null; }
    this._cleanup();
  },

  // ---------------------------------------------------------------------------
  // Direct Phone-to-Phone WebRTC P2P (No Server / No PC Needed)
  // ---------------------------------------------------------------------------

  async createP2pHostRoom(hostInfo, trackData, playbackState = 'paused', positionSec = 0, initialRate = 1.0) {
    this._cleanup();
    activeTransport = 'webrtc_p2p';
    isHost = true;
    currentParticipant = { ...hostInfo, isHost: true };

    const roomCode = this.generateRoomCode();
    activeRoomData = {
      schemaVersion: 2,
      roomCode,
      hostId: hostInfo.id,
      hostName: hostInfo.name || 'Party Host',
      hostAvatar: hostInfo.avatar || '',
      isActive: true,
      currentTrack: trackData,
      playback: {
        trackId: trackData ? trackData.id : null,
        state: playbackState,
        positionSec: Number(positionSec) || 0,
        anchorServerMs: Date.now(),
        rate: Number(initialRate) || 1.0,
        epoch: 1,
      },
      participants: [{
        id: hostInfo.id,
        name: hostInfo.name || 'Party Host',
        avatar: hostInfo.avatar || '',
        isHost: true,
        joinedAt: Date.now(),
        driftMs: 0,
      }],
      createdAt: Date.now(),
      updatedAt: Date.now(),
    };

    webrtcHost = new WebRtcHostHub({ hostInfo });

    webrtcHost.callbacks.onGuestJoined = (peer) => {
      activeRoomData.participants.push({
        id: peer.id,
        name: peer.name,
        isHost: false,
        joinedAt: Date.now(),
        driftMs: 0,
      });
      participantListeners.forEach(cb => cb(activeRoomData.participants));

      // Send initial anchor to newly joined guest
      peer.dc.send(JSON.stringify({
        type: 'anchor_update',
        playback: activeRoomData.playback,
        currentTrack: activeRoomData.currentTrack,
      }));

      // Stream current track audio to newly joined friend if audio is available
      if (typeof this.p2pAudioBlobGetter === 'function' && activeRoomData.currentTrack) {
        const currentBlob = this.p2pAudioBlobGetter(activeRoomData.currentTrack.id);
        if (currentBlob) {
          this.broadcastP2pAudio(activeRoomData.currentTrack.id, currentBlob);
        }
      }
    };

    webrtcHost.callbacks.onGuestLeft = (guestId) => {
      activeRoomData.participants = activeRoomData.participants.filter(p => p.id !== guestId);
      participantListeners.forEach(cb => cb(activeRoomData.participants));
    };

    webrtcHost.callbacks.onPresence = (guests) => {
      participantListeners.forEach(cb => cb(activeRoomData.participants));
    };

    webrtcHost.callbacks.onReaction = (rx) => {
      reactionListeners.forEach(cb => cb(rx));
    };

    return activeRoomData;
  },

  async createP2pInvite() {
    if (!webrtcHost) throw new Error('P2P Host Hub not started.');
    return await webrtcHost.createGuestInvite();
  },

  async acceptP2pAnswer(answerCompactCode) {
    if (!webrtcHost) throw new Error('P2P Host Hub not started.');
    return await webrtcHost.acceptGuestAnswer(answerCompactCode);
  },

  async joinP2pRoom(offerCompactCode, participantInfo) {
    this._cleanup();
    activeTransport = 'webrtc_p2p';
    isHost = false;
    currentParticipant = { ...participantInfo, isHost: false };

    webrtcGuest = new WebRtcGuestClient({ participant: participantInfo });

    webrtcGuest.callbacks.onConnected = () => {
      console.log('[LocalSyncService] Direct P2P Link open!');
      if (typeof this.onP2pGuestConnected === 'function') {
        this.onP2pGuestConnected();
      }
    };

    webrtcGuest.callbacks.onAnchor = (playback, currentTrack) => {
      if (!activeRoomData) {
        activeRoomData = {
          schemaVersion: 2,
          roomCode: 'P2P-PARTY',
          hostId: 'dj_host',
          hostName: 'DJ Host',
          isActive: true,
          currentTrack,
          playback,
          participants: [
            { id: 'dj_host', name: 'DJ Host', isHost: true },
            { id: participantInfo.id, name: participantInfo.name, isHost: false },
          ],
        };
      }
      activeRoomData.playback = playback;
      if (currentTrack) activeRoomData.currentTrack = currentTrack;
      roomListeners.forEach(cb => cb(activeRoomData));
    };

    webrtcGuest.callbacks.onTrackReceived = (trackId, blob) => {
      if (typeof this.onP2pTrackReceived === 'function') {
        this.onP2pTrackReceived(trackId, blob);
      }
    };

    webrtcGuest.callbacks.onReaction = (rx) => {
      reactionListeners.forEach(cb => cb(rx));
    };

    const result = await webrtcGuest.joinWithOffer(offerCompactCode);
    return result;
  },

  async broadcastP2pAudio(trackId, audioBlob, onProgress = null) {
    if (webrtcHost) {
      return await webrtcHost.broadcastAudioBlob(trackId, audioBlob, onProgress);
    }
  },

  getP2pGuestAudioBlob(trackId) {
    if (webrtcGuest) {
      return webrtcGuest.getAudioBlob(trackId);
    }
    return null;
  },

  // ---------------------------------------------------------------------------
  // Internal Transport Negotiation & Handshake
  // ---------------------------------------------------------------------------

  async _connectTransport(roomCode, asHost, payload) {
    this._cleanup();

    const isServerOnline = await this.checkServerAvailable();

    if (isServerOnline) {
      try {
        await this._connectWebSocket(roomCode, asHost, payload);
        activeTransport = 'websocket';
        console.log('[LocalSync] Connected via High-Speed Local WebSocket');
        return;
      } catch (wsErr) {
        console.warn('[LocalSync] WebSocket connection failed, falling back to BroadcastChannel:', wsErr);
      }
    }

    // Fallback to BroadcastChannel (Same-device multi-tab mode)
    this._connectBroadcastChannel(roomCode, asHost, payload);
    activeTransport = 'broadcast_channel';
    console.log('[LocalSync] Connected via In-Browser BroadcastChannel (Multi-Tab Mode)');
  },

  _connectWebSocket(roomCode, asHost, payload) {
    return new Promise((resolve, reject) => {
      const wsUrl = getWsUrl();
      socket = new WebSocket(wsUrl);

      socket.onopen = () => {
        if (asHost) {
          socket.send(JSON.stringify({
            type: 'create_room',
            roomCode,
            hostInfo: payload.hostInfo,
            currentTrack: payload.currentTrack,
            playbackState: payload.playbackState,
            positionSec: payload.positionSec,
            rate: payload.rate,
          }));
        } else {
          socket.send(JSON.stringify({
            type: 'join_room',
            roomCode,
            participant: payload.participant,
          }));
        }
        resolve();
      };

      socket.onerror = (err) => {
        reject(err);
      };

      socket.onmessage = (event) => {
        try {
          const msg = JSON.parse(event.data);
          this._handleWsMessage(msg);
        } catch (e) {
          console.warn('[LocalSync] WS message parse error:', e);
        }
      };

      socket.onclose = () => {
        console.log('[LocalSync] WebSocket connection closed');
      };
    });
  },

  _handleWsMessage(msg) {
    switch (msg.type) {
      case 'room_created':
      case 'room_joined':
        activeRoomData = msg.room;
        roomListeners.forEach(cb => cb(activeRoomData));
        if (msg.room.participants) {
          participantListeners.forEach(cb => cb(msg.room.participants));
        }
        break;

      case 'anchor_update':
        if (!activeRoomData) return;
        activeRoomData.playback = msg.playback;
        if (msg.currentTrack) activeRoomData.currentTrack = msg.currentTrack;
        roomListeners.forEach(cb => cb(activeRoomData));
        break;

      case 'participants_update':
        if (activeRoomData) activeRoomData.participants = msg.participants;
        participantListeners.forEach(cb => cb(msg.participants));
        break;

      case 'reaction':
        reactionListeners.forEach(cb => cb(msg.reaction));
        break;

      case 'host_promoted':
        isHost = true;
        if (currentParticipant) currentParticipant.isHost = true;
        if (activeRoomData) activeRoomData.hostId = currentParticipant.id;
        roomListeners.forEach(cb => cb(activeRoomData));
        break;

      case 'error':
        alert(msg.error || 'Local room error');
        break;
    }
  },

  _connectBroadcastChannel(roomCode, asHost, payload) {
    if (typeof BroadcastChannel === 'undefined') return;

    broadcastChannel = new BroadcastChannel('ethio_party_sync_' + roomCode);

    broadcastChannel.onmessage = (e) => {
      const data = e.data;
      if (!data) return;

      if (data.type === 'anchor_update') {
        if (!activeRoomData) activeRoomData = { roomCode, schemaVersion: 2 };
        activeRoomData.playback = data.playback;
        if (data.currentTrack) activeRoomData.currentTrack = data.currentTrack;
        roomListeners.forEach(cb => cb(activeRoomData));
      } else if (data.type === 'reaction') {
        reactionListeners.forEach(cb => cb(data.reaction));
      } else if (data.type === 'room_ended') {
        alert('The host has ended this local session.');
        this._cleanup();
      }
    };

    if (!asHost) {
      // Ask host for state snapshot
      broadcastChannel.postMessage({ type: 'request_snapshot', roomCode });
    }
  },

  _cleanup() {
    activeRoomData = null;
    currentParticipant = null;
    isHost = false;
    activeTransport = 'none';

    if (socket) {
      try { socket.close(); } catch (e) {}
      socket = null;
    }
    if (broadcastChannel) {
      try { broadcastChannel.close(); } catch (e) {}
      broadcastChannel = null;
    }
  },

  generateRoomCode() {
    const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
    let code = '';
    for (let i = 0; i < 4; i++) {
      code += chars.charAt(Math.floor(Math.random() * chars.length));
    }
    return `ETHIO-${code}`;
  },
};
